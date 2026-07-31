import * as path from "node:path";
import type { BaseContext, FsmStrategy, StateRef } from "./types.js";
import { isPlainObject, readJsonSafe, writeJsonAtomic } from "./util.js";

export interface StorageRecord {
  state: string | null;
  data: Record<string, unknown>;
  /** Epoch ms after which the record is discarded. */
  expiresAtMs?: number;
}

export interface Storage {
  get(key: string): Promise<StorageRecord | undefined>;
  set(key: string, value: StorageRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional: release resources (flush to disk, close connections). */
  close?(): Promise<void>;
}

/** Compose an FSM key. `bot` namespaces storages shared by several bots. */
export function storageKey(
  roomId: string,
  userId: string,
  options?: { strategy?: FsmStrategy; namespace?: string },
): string {
  const strategy = options?.strategy ?? "user_in_room";
  const scope =
    strategy === "room"
      ? roomId
      : strategy === "user"
        ? userId
        : strategy === "global"
          ? "global"
          : `${roomId}:${userId}`;
  return options?.namespace ? `${options.namespace}|${scope}` : scope;
}

function isExpired(record: StorageRecord): boolean {
  return record.expiresAtMs !== undefined && record.expiresAtMs <= Date.now();
}

function cloneRecord(record: StorageRecord): StorageRecord {
  const copy: StorageRecord = { state: record.state, data: { ...record.data } };
  if (record.expiresAtMs !== undefined) copy.expiresAtMs = record.expiresAtMs;
  return copy;
}

/** In-memory FSM storage. State is lost on restart. */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, StorageRecord>();

  constructor(private readonly maxEntries = 100_000) {}

  async get(key: string): Promise<StorageRecord | undefined> {
    const value = this.map.get(key);
    if (!value) return undefined;
    if (isExpired(value)) {
      this.map.delete(key);
      return undefined;
    }
    return cloneRecord(value);
  }

  async set(key: string, value: StorageRecord): Promise<void> {
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, cloneRecord(value));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Drop expired records. Safe to call periodically. */
  prune(): number {
    let removed = 0;
    for (const [key, record] of this.map) {
      if (isExpired(record)) {
        this.map.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * FSM storage persisted to a single JSON file.
 *
 * Writes are debounced and atomic, so a crash cannot leave a truncated file.
 * Suited to single-process bots; use a Redis-backed {@link Storage} for
 * multi-process deployments.
 */
export class JsonFileStorage implements Storage {
  private readonly file: string;
  private readonly map = new Map<string, StorageRecord>();
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    fileOrDirectory: string,
    private readonly options: { flushIntervalMs?: number; fileName?: string } = {},
  ) {
    this.file = fileOrDirectory.endsWith(".json")
      ? fileOrDirectory
      : path.join(fileOrDirectory, options.fileName ?? "fsm.json");
    const loaded = readJsonSafe<Record<string, StorageRecord>>(this.file);
    if (loaded && isPlainObject(loaded)) {
      for (const [key, record] of Object.entries(loaded)) {
        if (!isPlainObject(record)) continue;
        const state = typeof record.state === "string" ? record.state : null;
        const data = isPlainObject(record.data) ? record.data : {};
        const entry: StorageRecord = { state, data };
        if (typeof record.expiresAtMs === "number") entry.expiresAtMs = record.expiresAtMs;
        if (!isExpired(entry)) this.map.set(key, entry);
      }
    }
  }

  async get(key: string): Promise<StorageRecord | undefined> {
    const value = this.map.get(key);
    if (!value) return undefined;
    if (isExpired(value)) {
      this.map.delete(key);
      this.scheduleFlush();
      return undefined;
    }
    return cloneRecord(value);
  }

  async set(key: string, value: StorageRecord): Promise<void> {
    this.map.set(key, cloneRecord(value));
    this.scheduleFlush();
  }

  async delete(key: string): Promise<void> {
    if (this.map.delete(key)) this.scheduleFlush();
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Write pending changes to disk immediately. */
  flush(): void {
    if (!this.dirty) return;
    const snapshot: Record<string, StorageRecord> = {};
    for (const [key, record] of this.map) {
      if (!isExpired(record)) snapshot[key] = record;
    }
    writeJsonAtomic(this.file, snapshot);
    this.dirty = false;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.flush();
      } catch {
        // Keep `dirty` set so the next change retries the write.
      }
    }, this.options.flushIntervalMs ?? 500);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }
}

/**
 * Create a named states group (aiogram's `StatesGroup`).
 *
 * @example
 * const Form = createStates('Form', ['name', 'done'] as const);
 * router.message(Form.name, handler);
 */
export function createStates<const T extends readonly string[]>(
  group: string,
  names: T,
): { readonly [K in T[number]]: StateRef } & { readonly group: string } {
  const out: Record<string, StateRef> = {};
  for (const name of names) {
    const full = `${group}:${name}`;
    const ref = (async (ctx: BaseContext) => (await ctx.state.getState()) === full) as StateRef;
    Object.defineProperty(ref, "group", { value: group, enumerable: true });
    Object.defineProperty(ref, "name", { value: full, enumerable: true });
    out[name] = ref;
  }
  return Object.assign(out, { group }) as {
    readonly [K in T[number]]: StateRef;
  } & { readonly group: string };
}

/** Filter matching any state inside a group created by {@link createStates}. */
export function inStateGroup(group: { group: string }): (ctx: BaseContext) => Promise<boolean> {
  const prefix = `${group.group}:`;
  return async (ctx) => {
    const state = await ctx.state.getState();
    return typeof state === "string" && state.startsWith(prefix);
  };
}

/** Per-user FSM handle bound to a storage key. */
export class FSMContext {
  private readonly key: string;

  constructor(
    private readonly storage: Storage,
    roomId: string,
    userId: string,
    options?: { strategy?: FsmStrategy; namespace?: string; ttlMs?: number },
    private readonly ttlMs?: number,
  ) {
    this.key = storageKey(roomId, userId, options);
    this.ttlMs = options?.ttlMs ?? ttlMs;
  }

  /** Storage key this context reads and writes. */
  get storageKeyValue(): string {
    return this.key;
  }

  private async load(): Promise<StorageRecord> {
    return (await this.storage.get(this.key)) ?? { state: null, data: {} };
  }

  private async persist(record: StorageRecord): Promise<void> {
    const next: StorageRecord = { state: record.state, data: record.data };
    if (this.ttlMs !== undefined) next.expiresAtMs = Date.now() + this.ttlMs;
    await this.storage.set(this.key, next);
  }

  async getState(): Promise<string | null> {
    return (await this.load()).state;
  }

  async setState(state: StateRef | string | null): Promise<void> {
    const record = await this.load();
    record.state = state === null ? null : typeof state === "string" ? state : state.name;
    await this.persist(record);
  }

  /** Clear both the state and the data bag. */
  async clear(): Promise<void> {
    await this.storage.delete(this.key);
  }

  async getData<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T> {
    return { ...(await this.load()).data } as T;
  }

  async get<T = unknown>(field: string, fallback?: T): Promise<T | undefined> {
    const data = (await this.load()).data;
    return (data[field] as T | undefined) ?? fallback;
  }

  async setData(data: Record<string, unknown>): Promise<void> {
    const record = await this.load();
    record.data = { ...data };
    await this.persist(record);
  }

  async updateData(patch: Record<string, unknown>): Promise<void> {
    const record = await this.load();
    record.data = { ...record.data, ...patch };
    await this.persist(record);
  }

  /** Set state and data in one write. */
  async set(state: StateRef | string | null, data?: Record<string, unknown>): Promise<void> {
    const record = await this.load();
    record.state = state === null ? null : typeof state === "string" ? state : state.name;
    if (data) record.data = { ...record.data, ...data };
    await this.persist(record);
  }
}
