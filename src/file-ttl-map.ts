import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncUsedTokenStore, TtlStringMap, UsedTokenStore } from "./token-store.js";
import { isPlainObject, readJsonSafe, readNumber, readString, writeJsonAtomic } from "./util.js";

interface FileMapEntry {
  v: string;
  e: number;
}

interface FileUsedEntry {
  e: number;
}

/**
 * Durable {@link TtlStringMap} for short `!cb` aliases (and optional binds).
 * Survives process restart on a single host; multi-instance bots should still
 * inject a shared Redis map.
 */
export class FileTtlStringMap implements TtlStringMap {
  private readonly filePath: string;
  private readonly capacity: number;
  private readonly cache = new Map<string, FileMapEntry>();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, capacity = 16_384) {
    this.filePath = filePath;
    this.capacity = capacity;
  }

  get(key: string): string | undefined {
    this.ensureLoaded();
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.e <= Date.now()) {
      this.cache.delete(key);
      this.scheduleWrite();
      return undefined;
    }
    return entry.v;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.ensureLoaded();
    this.prune(Date.now());
    while (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { v: value, e: Date.now() + Math.max(1, ttlMs) });
    this.scheduleWrite();
  }

  delete(key: string): void {
    this.ensureLoaded();
    if (this.cache.delete(key)) this.scheduleWrite();
  }

  /** Flush pending writes (tests / shutdown). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.persist();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJsonSafe(this.filePath);
    if (!isPlainObject(raw) || !isPlainObject(raw.entries)) return;
    const now = Date.now();
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!isPlainObject(value)) continue;
      const v = readString(value, "v");
      const e = typeof value.e === "number" ? value.e : 0;
      if (!v || e <= now) continue;
      this.cache.set(key, { v, e });
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.e <= now) this.cache.delete(key);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist();
    }, 50);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    this.prune(Date.now());
    const entries: Record<string, FileMapEntry> = {};
    for (const [key, entry] of this.cache) entries[key] = entry;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeJsonAtomic(this.filePath, { version: 1, entries });
  }
}

/**
 * Durable {@link UsedTokenStore} so single-use / answered callback keys survive
 * restart without Redis.
 */
export class FileUsedTokenStore implements UsedTokenStore {
  private readonly filePath: string;
  private readonly capacity: number;
  private readonly defaultTtlMs: number;
  private readonly seen = new Map<string, number>();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    filePath: string,
    options?: { capacity?: number; defaultTtlMs?: number },
  ) {
    this.filePath = filePath;
    this.capacity = options?.capacity ?? 16_384;
    this.defaultTtlMs = options?.defaultTtlMs ?? 24 * 60 * 60 * 1000;
  }

  has(key: string): boolean {
    this.ensureLoaded();
    const expiresAt = this.seen.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.seen.delete(key);
      this.scheduleWrite();
      return false;
    }
    return true;
  }

  add(key: string, ttlMs?: number): void {
    this.ensureLoaded();
    const now = Date.now();
    this.prune(now);
    while (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.seen.set(key, now + (ttlMs ?? this.defaultTtlMs));
    this.scheduleWrite();
  }

  tryAdd(key: string, ttlMs?: number): boolean {
    if (this.has(key)) return false;
    this.add(key, ttlMs);
    return true;
  }

  delete(key: string): void {
    this.ensureLoaded();
    if (this.seen.delete(key)) this.scheduleWrite();
  }

  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.persist();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJsonSafe(this.filePath);
    if (!isPlainObject(raw) || !isPlainObject(raw.entries)) return;
    const now = Date.now();
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!isPlainObject(value)) continue;
      const e = readNumber(value, "e");
      if (e === undefined || e <= now) continue;
      this.seen.set(key, e);
    }
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist();
    }, 50);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    this.prune(Date.now());
    const entries: Record<string, FileUsedEntry> = {};
    for (const [key, e] of this.seen) entries[key] = { e };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeJsonAtomic(this.filePath, { version: 1, entries });
  }
}

/** Async façade over {@link FileUsedTokenStore} for APIs that expect async used stores. */
export class FileAsyncUsedTokenStore implements AsyncUsedTokenStore {
  private readonly inner: FileUsedTokenStore;

  constructor(filePath: string, options?: { capacity?: number; defaultTtlMs?: number }) {
    this.inner = new FileUsedTokenStore(filePath, options);
  }

  async tryAdd(key: string, ttlMs?: number): Promise<boolean> {
    return this.inner.tryAdd(key, ttlMs);
  }

  async has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }

  async delete(key: string): Promise<void> {
    this.inner.delete?.(key);
  }

  flush(): void {
    this.inner.flush();
  }
}

export interface FileSharedTokenStores {
  callbackUsedStore: FileUsedTokenStore;
  callbackAliasStore: FileTtlStringMap;
  callbackBindStore: FileTtlStringMap;
  miniAppQueryUsedStore: FileUsedTokenStore;
  flush(): void;
}

/** Single-host durable pack for callbacks + MiniApp query used-tokens. */
export function createFileSharedTokenStores(storagePath: string): FileSharedTokenStores {
  const root = storagePath;
  const callbackUsedStore = new FileUsedTokenStore(path.join(root, "callback-used.json"));
  const callbackAliasStore = new FileTtlStringMap(path.join(root, "callback-aliases.json"));
  const callbackBindStore = new FileTtlStringMap(path.join(root, "callback-binds.json"));
  const miniAppQueryUsedStore = new FileUsedTokenStore(path.join(root, "miniapp-query-used.json"));
  return {
    callbackUsedStore,
    callbackAliasStore,
    callbackBindStore,
    miniAppQueryUsedStore,
    flush() {
      callbackUsedStore.flush();
      callbackAliasStore.flush();
      callbackBindStore.flush();
      miniAppQueryUsedStore.flush();
    },
  };
}
