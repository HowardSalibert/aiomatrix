/**
 * Redis adapters for multi-instance MiniApp HTTP and signed callback/query tokens.
 * Requires `redis` (node-redis v4+). Not a dependency of aiomatrix.
 *
 * Prefer {@link createRedisSharedTokenStores} to wire alias + bind + used + MiniApp
 * query used + nonces in one call.
 */

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
export class RedisAsyncUsedTokenStore {
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
 * Sync TtlStringMap façade over Redis with a write-through cache.
 * Cross-instance reads warm asynchronously on miss — call {@link prefetch}
 * when you need a guaranteed remote hit. Prefer full signed keyboard tokens
 * for strict multi-host callback presses.
 */
export class RedisTtlStringMap {
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
}

/** One-shot wiring for multi-instance bots. */
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
  };
}
