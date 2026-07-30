/**
 * Per-room concurrency 1, global concurrency 8 — prevents encrypt/decrypt stampede.
 */
export class DispatchQueue {
  private readonly globalLimit: number;
  private globalActive = 0;
  private readonly roomActive = new Map<string, number>();
  private readonly waiters: Array<() => void> = [];

  constructor(globalLimit = 8) {
    this.globalLimit = globalLimit;
  }

  async run<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(roomId);
    try {
      return await fn();
    } finally {
      this.release(roomId);
    }
  }

  private canRun(roomId: string): boolean {
    const room = this.roomActive.get(roomId) ?? 0;
    return this.globalActive < this.globalLimit && room < 1;
  }

  private acquire(roomId: string): Promise<void> {
    if (this.canRun(roomId)) {
      this.globalActive += 1;
      this.roomActive.set(roomId, (this.roomActive.get(roomId) ?? 0) + 1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const tryWake = (): void => {
        if (!this.canRun(roomId)) {
          this.waiters.push(tryWake);
          return;
        }
        this.globalActive += 1;
        this.roomActive.set(roomId, (this.roomActive.get(roomId) ?? 0) + 1);
        resolve();
      };
      this.waiters.push(tryWake);
    });
  }

  private release(roomId: string): void {
    this.globalActive = Math.max(0, this.globalActive - 1);
    const room = (this.roomActive.get(roomId) ?? 1) - 1;
    if (room <= 0) this.roomActive.delete(roomId);
    else this.roomActive.set(roomId, room);

    const pending = this.waiters.splice(0, this.waiters.length);
    for (const w of pending) w();
  }
}

/** Ring buffer of last N (roomId, event_id) pairs for dedup. */
export class EventDeduper {
  private readonly capacity: number;
  private readonly order: string[] = [];
  private readonly set = new Set<string>();

  constructor(capacity = 512) {
    this.capacity = capacity;
  }

  /** Returns true if this is a duplicate (already seen). */
  seen(roomId: string, eventId: string): boolean {
    const key = `${roomId}\0${eventId}`;
    if (this.set.has(key)) return true;
    this.set.add(key);
    this.order.push(key);
    while (this.order.length > this.capacity) {
      const old = this.order.shift();
      if (old) this.set.delete(old);
    }
    return false;
  }
}
