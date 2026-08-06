import { sleep } from "./util.js";

/**
 * Soft rate budget for Megolm / keys-query fanout.
 *
 * Opt-in only. When exceeded, outbound crypto work is **delayed** (never hard-failed
 * and never auto-pruned) so a buggy handler loop cannot storm the homeserver or
 * peer devices. Caps keep the bot responsive under abuse.
 */
export interface CryptoSoftBudgetOptions {
  /** Max `share_room_key` emissions per rolling minute. Default 30 when enabled. */
  maxShareRoomKeyPerMinute?: number;
  /** Max `keys/query` posts per rolling minute. Default 60 when enabled. */
  maxKeysQueryPerMinute?: number;
  /** Max soft delay applied when over budget (ms). Default 5_000. Hard-capped at 15_000. */
  maxDelayMs?: number;
  /** Called when a delay is applied (also mirrored to onMetric / onCryptoLog). */
  onSoftBudget?: (info: {
    kind: "share_room_key" | "keys_query";
    delayMs: number;
    count: number;
    limit: number;
  }) => void;
}

export interface CryptoSoftBudget {
  /** Await before sharing room keys when over budget. */
  beforeShareRoomKey(): Promise<void>;
  /** Await before posting keys/query when over budget. */
  beforeKeysQuery(): Promise<void>;
}

class SlidingWindow {
  private readonly stamps: number[] = [];

  constructor(private readonly windowMs: number) {}

  count(now = Date.now()): number {
    this.prune(now);
    return this.stamps.length;
  }

  push(now = Date.now()): number {
    this.prune(now);
    this.stamps.push(now);
    return this.stamps.length;
  }

  oldest(now = Date.now()): number | undefined {
    this.prune(now);
    return this.stamps[0];
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= cutoff) {
      this.stamps.shift();
    }
  }
}

/** Build a soft budget, or `null` when options are absent/disabled. */
export function createCryptoSoftBudget(
  options: CryptoSoftBudgetOptions | undefined,
): CryptoSoftBudget | null {
  if (!options) return null;
  const shareLimit = Math.max(1, options.maxShareRoomKeyPerMinute ?? 30);
  const queryLimit = Math.max(1, options.maxKeysQueryPerMinute ?? 60);
  const maxDelayMs = Math.min(15_000, Math.max(0, options.maxDelayMs ?? 5_000));
  const shareWindow = new SlidingWindow(60_000);
  const queryWindow = new SlidingWindow(60_000);

  const throttle = async (
    kind: "share_room_key" | "keys_query",
    window: SlidingWindow,
    limit: number,
  ): Promise<void> => {
    const now = Date.now();
    const count = window.count(now);
    if (count < limit) {
      window.push(now);
      return;
    }
    const oldest = window.oldest(now) ?? now;
    const wait = Math.min(maxDelayMs, Math.max(0, oldest + 60_000 - now));
    options.onSoftBudget?.({ kind, delayMs: wait, count, limit });
    if (wait > 0) await sleep(wait);
    window.push(Date.now());
  };

  return {
    beforeShareRoomKey: () => throttle("share_room_key", shareWindow, shareLimit),
    beforeKeysQuery: () => throttle("keys_query", queryWindow, queryLimit),
  };
}
