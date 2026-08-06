import { ConfigurationError } from "./errors.js";
import { sleep } from "./util.js";

interface Waiter {
  roomId: string;
  resume: () => void;
  reject: (err: Error) => void;
}

/**
 * Fair dispatch queue: at most one in-flight task per room, and at most
 * `globalLimit` across all rooms.
 *
 * Per-room serialisation keeps message ordering intact and prevents an
 * encrypt/decrypt stampede; the global limit bounds memory and CPU when a
 * homeserver delivers a large backlog in a single sync.
 */
export class DispatchQueue {
  private readonly globalLimit: number;
  private globalActive = 0;
  private readonly roomActive = new Set<string>();
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(globalLimit = 8) {
    this.globalLimit = Math.max(1, globalLimit);
  }

  get activeCount(): number {
    return this.globalActive;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Reject pending waiters and refuse new work. In-flight tasks still finish;
   * callers should check a `stopping` flag after `acquire`.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = this.waiters.splice(0);
    const err = new ConfigurationError("DispatchQueue closed");
    for (const waiter of pending) waiter.reject(err);
  }

  async run<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new ConfigurationError("DispatchQueue closed");
    }
    await this.acquire(roomId);
    try {
      if (this.closed) {
        throw new ConfigurationError("DispatchQueue closed");
      }
      return await fn();
    } finally {
      this.release(roomId);
    }
  }

  /** Wait until the queue empties, or until `timeoutMs` elapses. */
  async drain(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while ((this.globalActive > 0 || this.waiters.length > 0) && Date.now() < deadline) {
      await sleep(25);
    }
    return this.globalActive === 0 && this.waiters.length === 0;
  }

  private canRun(roomId: string): boolean {
    return this.globalActive < this.globalLimit && !this.roomActive.has(roomId);
  }

  private take(roomId: string): void {
    this.globalActive += 1;
    this.roomActive.add(roomId);
  }

  private acquire(roomId: string): Promise<void> {
    if (this.closed) {
      return Promise.reject(new ConfigurationError("DispatchQueue closed"));
    }
    if (this.canRun(roomId)) {
      this.take(roomId);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ roomId, resume: resolve, reject });
    });
  }

  private release(roomId: string): void {
    this.globalActive = Math.max(0, this.globalActive - 1);
    this.roomActive.delete(roomId);
    if (this.closed) return;
    // Fair wake: prefer waiters from a *different* room than the one that just
    // finished, so a noisy room cannot starve others queued behind it.
    const wakeOne = (preferOtherRoom: boolean): boolean => {
      for (let i = 0; i < this.waiters.length; i++) {
        const waiter = this.waiters[i];
        if (!waiter) continue;
        if (preferOtherRoom && waiter.roomId === roomId) continue;
        if (!this.canRun(waiter.roomId)) continue;
        this.waiters.splice(i, 1);
        this.take(waiter.roomId);
        waiter.resume();
        return true;
      }
      return false;
    };
    while (this.globalActive < this.globalLimit) {
      if (!wakeOne(true) && !wakeOne(false)) break;
    }
  }
}

/**
 * Ring buffer of recently seen `(roomId, eventId)` pairs.
 *
 * Homeservers can redeliver a batch after a network hiccup; without dedup the
 * bot would answer the same message twice.
 */
export class EventDeduper {
  private readonly capacity: number;
  private readonly order: string[] = [];
  private readonly set = new Set<string>();
  private head = 0;

  constructor(capacity = 2_048) {
    this.capacity = Math.max(1, capacity);
  }

  /** Returns true when the pair was already seen. */
  seen(roomId: string, eventId: string): boolean {
    const key = `${roomId}\u0000${eventId}`;
    if (this.set.has(key)) return true;
    this.set.add(key);
    this.order.push(key);
    // Amortised O(1) eviction: advance a head pointer instead of shifting.
    if (this.order.length - this.head > this.capacity) {
      const stale = this.order[this.head];
      if (stale !== undefined) this.set.delete(stale);
      this.head += 1;
      if (this.head > this.capacity) {
        this.order.splice(0, this.head);
        this.head = 0;
      }
    }
    return false;
  }

  /** Forget an entry (used when a handler wants an event reprocessed). */
  forget(roomId: string, eventId: string): void {
    this.set.delete(`${roomId}\u0000${eventId}`);
  }

  get size(): number {
    return this.set.size;
  }
}
