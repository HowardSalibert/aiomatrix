/**
 * Shared single-use / blacklist store for signed callback tokens and MiniApp queries.
 *
 * Memory default is process-local. For multiple HTTP instances, inject a Redis
 * (or similar) adapter — see `examples/redis-stores`.
 */
export interface UsedTokenStore {
  has(key: string): boolean;
  /** Record `key` until `ttlMs` elapses (best-effort; adapters may clamp). */
  add(key: string, ttlMs?: number): void;
  /**
   * Atomic add. Return `false` when the key was already present.
   * Registries prefer this over has+add when available.
   */
  tryAdd?(key: string, ttlMs?: number): boolean;
  delete?(key: string): void;
}

/** Bounded in-memory {@link UsedTokenStore}. */
export class MemoryUsedTokenStore implements UsedTokenStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly capacity = 16_384,
    private readonly defaultTtlMs = 24 * 60 * 60 * 1000,
  ) {}

  has(key: string): boolean {
    const expiresAt = this.seen.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.seen.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, ttlMs?: number): void {
    const now = Date.now();
    this.prune(now);
    while (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.seen.set(key, now + (ttlMs ?? this.defaultTtlMs));
  }

  tryAdd(key: string, ttlMs?: number): boolean {
    if (this.has(key)) return false;
    this.add(key, ttlMs);
    return true;
  }

  delete(key: string): void {
    this.seen.delete(key);
  }

  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }
}
