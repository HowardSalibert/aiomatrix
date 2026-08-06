/**
 * Shared single-use / blacklist store for signed callback tokens and MiniApp queries.
 *
 * Memory default is process-local. For multiple HTTP instances, inject a Redis
 * (or similar) adapter — see `examples/redis-stores`. Prefer
 * {@link AsyncUsedTokenStore} when claim uniqueness must be atomic across
 * processes (`SET NX`).
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

/**
 * Async single-use store for multi-instance bots / MiniApp HTTP.
 * Implementations should use an atomic primitive (Redis `SET key NX EX`).
 */
export interface AsyncUsedTokenStore {
  tryAdd(key: string, ttlMs?: number): Promise<boolean>;
  has?(key: string): Promise<boolean>;
  delete?(key: string): Promise<void>;
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

/**
 * String map with TTL — used for short `!cb` aliases and optional message binds
 * so stock-client fallbacks survive restarts / multi-instance (share via Redis).
 */
export interface TtlStringMap {
  get(key: string): string | undefined;
  set(key: string, value: string, ttlMs: number): void;
  delete(key: string): void;
}

/** Bounded in-memory {@link TtlStringMap}. */
export class MemoryTtlStringMap implements TtlStringMap {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private readonly capacity = 16_384,
    private readonly defaultTtlMs = 24 * 60 * 60 * 1000,
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, ttlMs?: number): void {
    const now = Date.now();
    this.prune(now);
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: now + (ttlMs ?? this.defaultTtlMs) });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/** Process-local {@link AsyncUsedTokenStore} backed by {@link MemoryUsedTokenStore}. */
export class MemoryAsyncUsedTokenStore implements AsyncUsedTokenStore {
  private readonly inner: MemoryUsedTokenStore;

  constructor(capacity = 16_384, defaultTtlMs = 24 * 60 * 60 * 1000) {
    this.inner = new MemoryUsedTokenStore(capacity, defaultTtlMs);
  }

  async tryAdd(key: string, ttlMs?: number): Promise<boolean> {
    return this.inner.tryAdd(key, ttlMs);
  }

  async has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }

  async delete(key: string): Promise<void> {
    this.inner.delete(key);
  }
}
