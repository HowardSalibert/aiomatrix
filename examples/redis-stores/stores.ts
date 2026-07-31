/**
 * Redis adapters for multi-instance MiniApp HTTP.
 * Requires `redis` (node-redis v4+). Not a dependency of aiomatrix.
 *
 * Use RedisAsyncNonceStore via MiniAppServerOptions.asyncNonceStore.
 * Used-token store is sync-facing with a local cache; claim uniqueness is
 * SET NX in the background — warm hasAsync() on workers if you need reads.
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

/** Shared claim/revoke store for signed callback / MiniApp query tokens. */
export class RedisUsedTokenStore {
  private readonly local = new Map<string, number>();

  constructor(
    private readonly redis: RedisLike,
    private readonly options: { prefix?: string; defaultTtlSeconds?: number } = {},
  ) {}

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
    void this.tryAdd(key, ttlMs);
  }

  tryAdd(key: string, ttlMs?: number): boolean {
    if (this.has(key)) return false;
    const ttlSeconds = Math.max(
      1,
      Math.ceil((ttlMs ?? (this.options.defaultTtlSeconds ?? 86400) * 1000) / 1000),
    );
    this.local.set(key, Date.now() + ttlSeconds * 1000);
    void this.redis.set(this.key(key), "1", { EX: ttlSeconds, NX: true }).then((result) => {
      if (result !== "OK") {
        // Another instance won; keep local mark so subsequent has() is true.
        this.local.set(key, Date.now() + ttlSeconds * 1000);
      }
    });
    return true;
  }

  delete(key: string): void {
    this.local.delete(key);
    void this.redis.del(this.key(key));
  }

  async hasAsync(key: string): Promise<boolean> {
    if (this.has(key)) return true;
    const hit = (await this.redis.get(this.key(key))) !== null;
    if (hit) {
      const ttl = this.options.defaultTtlSeconds ?? 86400;
      this.local.set(key, Date.now() + ttl * 1000);
    }
    return hit;
  }
}
