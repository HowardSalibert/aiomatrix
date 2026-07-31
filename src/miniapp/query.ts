import { randomId } from "../util.js";

export interface MiniAppQueryRecord {
  queryId: string;
  roomId: string;
  userId: string;
  /** Event id of the card the mini app was launched from. */
  messageId: string | null;
  appId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  answeredAtMs: number | null;
}

/**
 * Tracks in-flight MiniApp launches so a mini app can post results back to the
 * bot exactly once (aiomatrix' analogue of Telegram's `answerWebAppQuery`).
 */
export class MiniAppQueryRegistry {
  private readonly queries = new Map<string, MiniAppQueryRecord>();

  constructor(
    private readonly capacity = 4_096,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  /** Register a launch and return the correlation id embedded into `initData`. */
  issue(params: {
    roomId: string;
    userId: string;
    messageId?: string | null;
    appId?: string | null;
    ttlMs?: number;
  }): MiniAppQueryRecord {
    this.prune();
    const now = Date.now();
    const record: MiniAppQueryRecord = {
      queryId: randomId(16),
      roomId: params.roomId,
      userId: params.userId,
      messageId: params.messageId ?? null,
      appId: params.appId ?? null,
      createdAtMs: now,
      expiresAtMs: now + (params.ttlMs ?? this.ttlMs),
      answeredAtMs: null,
    };
    this.queries.set(record.queryId, record);
    return record;
  }

  /** Look up a query without consuming it. */
  peek(queryId: string): MiniAppQueryRecord | null {
    const record = this.queries.get(queryId);
    if (!record) return null;
    if (record.expiresAtMs <= Date.now()) {
      this.queries.delete(queryId);
      return null;
    }
    return record;
  }

  /**
   * Claim a query for answering. Returns `null` when the id is unknown, expired,
   * already answered, or belongs to a different user — which is what makes the
   * round trip replay-safe.
   */
  claim(queryId: string, userId?: string): MiniAppQueryRecord | null {
    const record = this.peek(queryId);
    if (!record) return null;
    if (record.answeredAtMs !== null) return null;
    if (userId && record.userId !== userId) return null;
    record.answeredAtMs = Date.now();
    return record;
  }

  release(queryId: string): void {
    const record = this.queries.get(queryId);
    if (record) record.answeredAtMs = null;
  }

  revoke(queryId: string): void {
    this.queries.delete(queryId);
  }

  get size(): number {
    return this.queries.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.queries) {
      if (record.expiresAtMs <= now) this.queries.delete(id);
    }
    while (this.queries.size >= this.capacity) {
      const oldest = this.queries.keys().next();
      if (oldest.done) break;
      this.queries.delete(oldest.value);
    }
  }
}
