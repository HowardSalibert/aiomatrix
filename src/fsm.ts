import type { Context, StateRef } from "./types.js";

export interface Storage {
  get(key: string): Promise<StorageRecord | undefined>;
  set(key: string, value: StorageRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface StorageRecord {
  state: string | null;
  data: Record<string, unknown>;
}

/** In-memory FSM storage keyed by `${roomId}:${userId}`. */
export class MemoryStorage implements Storage {
  private readonly map = new Map<string, StorageRecord>();

  async get(key: string): Promise<StorageRecord | undefined> {
    const v = this.map.get(key);
    return v ? { state: v.state, data: { ...v.data } } : undefined;
  }

  async set(key: string, value: StorageRecord): Promise<void> {
    this.map.set(key, { state: value.state, data: { ...value.data } });
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

export function storageKey(roomId: string, userId: string): string {
  return `${roomId}:${userId}`;
}

/**
 * Create a named states group (aiogram-like StatesGroup).
 *
 * @example
 * const Form = createStates('Form', ['name', 'done'] as const);
 * // Form.name, Form.done are StateRefs usable as filters
 */
export function createStates<const T extends readonly string[]>(
  group: string,
  names: T,
): { readonly [K in T[number]]: StateRef } & { readonly group: string } {
  const out: Record<string, StateRef> = {};
  for (const name of names) {
    const full = `${group}:${name}`;
    const ref = (async (ctx: Context) => {
      const current = await ctx.state.getState();
      return current === full;
    }) as StateRef;
    Object.defineProperty(ref, "group", { value: group, enumerable: true });
    Object.defineProperty(ref, "name", { value: full, enumerable: true });
    out[name] = ref;
  }
  return Object.assign(out, { group }) as {
    readonly [K in T[number]]: StateRef;
  } & { readonly group: string };
}

export class FSMContext {
  constructor(
    private readonly storage: Storage,
    private readonly roomId: string,
    private readonly userId: string,
  ) {}

  private key(): string {
    return storageKey(this.roomId, this.userId);
  }

  private async load(): Promise<StorageRecord> {
    return (await this.storage.get(this.key())) ?? { state: null, data: {} };
  }

  async getState(): Promise<string | null> {
    return (await this.load()).state;
  }

  async setState(state: StateRef | string | null): Promise<void> {
    const rec = await this.load();
    if (state === null) {
      rec.state = null;
    } else if (typeof state === "string") {
      rec.state = state;
    } else {
      rec.state = state.name;
    }
    await this.storage.set(this.key(), rec);
  }

  async clear(): Promise<void> {
    await this.storage.delete(this.key());
  }

  async getData<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T> {
    return { ...(await this.load()).data } as T;
  }

  async updateData(patch: Record<string, unknown>): Promise<void> {
    const rec = await this.load();
    rec.data = { ...rec.data, ...patch };
    await this.storage.set(this.key(), rec);
  }
}
