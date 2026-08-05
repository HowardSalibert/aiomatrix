/**
 * Redis adapters for multi-instance MiniApp HTTP and signed callback/query tokens.
 * Requires `redis` (node-redis v4+). Not a dependency of aiomatrix.
 *
 * Use RedisAsyncNonceStore via MiniAppServerOptions.asyncNonceStore.
 * Use RedisAsyncUsedTokenStore via BotCreateOptions.callbackAsyncUsedStore /
 * miniApp.asyncQueryUsedStore (awaited SET NX — no race between instances).
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
 * Prefer this over the legacy sync RedisUsedTokenStore.
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

/**
 * @deprecated Prefer {@link RedisAsyncUsedTokenStore}. This sync-facing adapter
 * used a local mark + fire-and-forget Redis SET NX and could return true on two
 * instances for the same key.
 */
export class RedisUsedTokenStore {
  private readonly local = new Map<string, number>();
  private readonly asyncStore: RedisAsyncUsedTokenStore;

  constructor(
    redis: RedisLike,
    private readonly options: { prefix?: string; defaultTtlSeconds?: number } = {},
  ) {
    this.asyncStore = new RedisAsyncUsedTokenStore(redis, options);
  }

  private key(token: string): string {
    return `${this.options.prefix ?? "aio:used:"}${token}`;
  }

  has(key: string): boolean {
    const expiresAt = this.local.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.local.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, ttlMs?: number): void {
    void this.tryAddAsync(key, ttlMs);
  }

  tryAdd(key: string, ttlMs?: number): boolean {
    // Best-effort local gate only — callers needing atomicity must use
    // RedisAsyncUsedTokenStore.tryAdd and await it.
    if (this.has(key)) return false;
    const ttlSeconds = Math.max(
      1,
      Math.ceil((ttlMs ?? (this.options.defaultTtlSeconds ?? 86400) * 1000) / 1000),
    );
    this.local.set(key, Date.now() + ttlSeconds * 1000);
    void this.tryAddAsync(key, ttlMs);
    return true;
  }

  async tryAddAsync(key: string, ttlMs?: number): Promise<boolean> {
    const ok = await this.asyncStore.tryAdd(key, ttlMs);
    if (ok) {
      const ttlSeconds = Math.max(
        1,
        Math.ceil((ttlMs ?? (this.options.defaultTtlSeconds ?? 86400) * 1000) / 1000),
      );
      this.local.set(key, Date.now() + ttlSeconds * 1000);
    }
    return ok;
  }

  delete(key: string): void {
    this.local.delete(key);
    void this.asyncStore.delete(key);
  }

  async hasAsync(key: string): Promise<boolean> {
    if (this.has(key)) return true;
    return this.asyncStore.has(key);
  }
}
