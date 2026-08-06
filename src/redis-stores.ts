/**
 * Optional Redis adapters for multi-instance bots.
 *
 * **Not a runtime dependency of aiomatrix.** Pass any client matching {@link RedisLike}
 * (node-redis v4+, ioredis wrapper, mock). The rest of the library works without Redis.
 *
 * @example
 * ```ts
 * import { createClient } from "redis";
 * import { createRedisSharedTokenStores, RedisStorage } from "aiomatrix/redis";
 *
 * const redis = createClient();
 * await redis.connect();
 * const stores = createRedisSharedTokenStores(redis);
 * const bot = await Bot.create({
 *   ...,
 *   callbackAsyncUsedStore: stores.callbackAsyncUsedStore,
 *   callbackAliasStore: stores.callbackAliasStore,
 *   callbackBindStore: stores.callbackBindStore,
 * });
 * const dp = new Dispatcher({ storage: new RedisStorage(redis) });
 * ```
 */

import type { Storage, StorageRecord } from "./fsm.js";
import type { AsyncUsedTokenStore, TtlStringMap } from "./token-store.js";
import { isPlainObject } from "./util.js";

/** Minimal Redis surface used by aiomatrix adapters (node-redis v4+ compatible). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number; NX?: boolean }): Promise<"OK" | null>;
  del(...keys: string[]): Promise<number>;
}

/** Atomic launch nonces for `MiniAppServer` (`asyncNonceStore`). */
export class RedisAsyncNonceStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly options: { prefix?: string; ttlSeconds?: number } = {},
  ) {}

  private key(nonce: string): string {
    return `${this.options.prefix ?? "aio:nonce:"}${nonce}`;
  }

  async tryAdd(nonce: string): Promise<boolean> {
    const ttl = this.options.ttlSeconds ?? 3600;
    const result = await this.redis.set(this.key(nonce), "1", { EX: ttl, NX: true });
    return result === "OK";
  }
}

/**
 * Async claim/revoke store for signed callback / MiniApp query tokens.
 * Required for correct single-use semantics across multiple bot/HTTP processes.
 */
export class RedisAsyncUsedTokenStore implements AsyncUsedTokenStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly options: { prefix?: string; defaultTtlSeconds?: number } = {},
  ) {}

  private key(token: string): string {
    return `${this.options.prefix ?? "aio:used:"}${token}`;
  }

  async tryAdd(key: string, ttlMs?: number): Promise<boolean> {
    const ttlSeconds = Math.max(
      1,
      Math.ceil((ttlMs ?? (this.options.defaultTtlSeconds ?? 86400) * 1000) / 1000),
    );
    const result = await this.redis.set(this.key(key), "1", { EX: ttlSeconds, NX: true });
    return result === "OK";
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.get(this.key(key))) !== null;
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }
}

interface MapEntry {
  v: string;
  e: number;
}

/**
 * Sync {@link TtlStringMap} façade over Redis with a write-through cache.
 * Cross-instance reads warm asynchronously on miss — use {@link getAsync} /
 * {@link prefetch} for strict multi-host short `!cb` resolution.
 */
export class RedisTtlStringMap implements TtlStringMap {
  private readonly cache = new Map<string, MapEntry>();
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisLike,
    options: { prefix?: string } = {},
  ) {
    this.prefix = options.prefix ?? "aio:map:";
  }

  private redisKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  get(key: string): string | undefined {
    const hit = this.cache.get(key);
    if (hit && hit.e > Date.now()) return hit.v;
    if (hit) this.cache.delete(key);
    void this.prefetch(key);
    return undefined;
  }

  /** Await a remote read (strict multi-host aliases). */
  async getAsync(key: string): Promise<string | undefined> {
    return this.prefetch(key);
  }

  set(key: string, value: string, ttlMs: number): void {
    const e = Date.now() + Math.max(1, ttlMs);
    this.cache.set(key, { v: value, e });
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    void this.redis.set(this.redisKey(key), JSON.stringify({ v: value, e }), {
      EX: ttlSeconds,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
    void this.redis.del(this.redisKey(key));
  }

  async prefetch(key: string): Promise<string | undefined> {
    const raw = await this.redis.get(this.redisKey(key));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as MapEntry;
      if (parsed && typeof parsed.v === "string" && typeof parsed.e === "number") {
        this.cache.set(key, parsed);
        return parsed.e > Date.now() ? parsed.v : undefined;
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }
}

export interface RedisSharedTokenStores {
  callbackAsyncUsedStore: RedisAsyncUsedTokenStore;
  miniAppAsyncQueryUsedStore: RedisAsyncUsedTokenStore;
  asyncNonceStore: RedisAsyncNonceStore;
  callbackAliasStore: RedisTtlStringMap;
  callbackBindStore: RedisTtlStringMap;
  /** For {@link import("./middleware.js").once} multi-instance bots. */
  onceStore: RedisOnceStore;
}

/**
 * Redis `SET NX` store for {@link import("./middleware.js").once}.
 * Pass as `once({ key, store: stores.onceStore })`.
 */
export class RedisOnceStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly options: { prefix?: string; defaultTtlSeconds?: number } = {},
  ) {}

  private key(key: string): string {
    return `${this.options.prefix ?? "aio:once:"}${key}`;
  }

  async tryAdd(key: string, ttlMs?: number): Promise<boolean> {
    const ttlSeconds = Math.max(
      1,
      Math.ceil((ttlMs ?? (this.options.defaultTtlSeconds ?? 86400) * 1000) / 1000),
    );
    const result = await this.redis.set(this.key(key), "1", { EX: ttlSeconds, NX: true });
    return result === "OK";
  }
}

/** One-shot wiring for multi-instance bots (aliases, binds, used tokens, nonces, once). */
export function createRedisSharedTokenStores(
  redis: RedisLike,
  options: { prefix?: string } = {},
): RedisSharedTokenStores {
  const prefix = options.prefix ?? "aio:";
  return {
    callbackAsyncUsedStore: new RedisAsyncUsedTokenStore(redis, {
      prefix: `${prefix}cb:used:`,
    }),
    miniAppAsyncQueryUsedStore: new RedisAsyncUsedTokenStore(redis, {
      prefix: `${prefix}ma:used:`,
    }),
    asyncNonceStore: new RedisAsyncNonceStore(redis, { prefix: `${prefix}nonce:` }),
    callbackAliasStore: new RedisTtlStringMap(redis, { prefix: `${prefix}cb:alias:` }),
    callbackBindStore: new RedisTtlStringMap(redis, { prefix: `${prefix}cb:bind:` }),
    onceStore: new RedisOnceStore(redis, { prefix: `${prefix}once:` }),
  };
}

/**
 * FSM {@link Storage} backed by Redis. Optional — default remains MemoryStorage /
 * JsonFileStorage. Values are JSON; TTL uses Redis `EX` when `expiresAtMs` is set.
 */
export class RedisStorage implements Storage {
  constructor(
    private readonly redis: RedisLike,
    private readonly options: { prefix?: string; defaultTtlSeconds?: number } = {},
  ) {}

  private key(key: string): string {
    return `${this.options.prefix ?? "aio:fsm:"}${key}`;
  }

  async get(key: string): Promise<StorageRecord | undefined> {
    const raw = await this.redis.get(this.key(key));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StorageRecord;
      if (!isPlainObject(parsed) || typeof parsed.state === "undefined") return undefined;
      if (parsed.expiresAtMs !== undefined && parsed.expiresAtMs <= Date.now()) {
        await this.delete(key);
        return undefined;
      }
      return {
        state: parsed.state ?? null,
        data: isPlainObject(parsed.data) ? { ...parsed.data } : {},
        ...(parsed.expiresAtMs !== undefined ? { expiresAtMs: parsed.expiresAtMs } : {}),
      };
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: StorageRecord): Promise<void> {
    const payload: StorageRecord = {
      state: value.state,
      data: { ...value.data },
      ...(value.expiresAtMs !== undefined ? { expiresAtMs: value.expiresAtMs } : {}),
    };
    const encoded = JSON.stringify(payload);
    if (value.expiresAtMs !== undefined) {
      const ttlSeconds = Math.max(1, Math.ceil((value.expiresAtMs - Date.now()) / 1000));
      await this.redis.set(this.key(key), encoded, { EX: ttlSeconds });
      return;
    }
    const fallback = this.options.defaultTtlSeconds;
    if (fallback !== undefined) {
      await this.redis.set(this.key(key), encoded, { EX: Math.max(1, fallback) });
      return;
    }
    await this.redis.set(this.key(key), encoded);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }
}
