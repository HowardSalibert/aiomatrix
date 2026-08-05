/**
 * Redis adapters for multi-instance MiniApp HTTP and signed callback/query tokens.
 * Requires `redis` (node-redis v4+). Not a dependency of aiomatrix.
 *
 * Use RedisAsyncNonceStore via MiniAppServerOptions.asyncNonceStore /
 * BotCreateOptions.miniApp.asyncNonceStore.
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
