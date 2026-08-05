import * as crypto from "node:crypto";
import {
  MemoryUsedTokenStore,
  type AsyncUsedTokenStore,
  type UsedTokenStore,
} from "../token-store.js";
import { isPlainObject, randomId, timingSafeEqualStrings } from "../util.js";

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

export interface MiniAppQueryIssueParams {
  roomId: string;
  userId: string;
  messageId?: string | null;
  appId?: string | null;
  ttlMs?: number;
}

/** In-flight MiniApp launch correlation (`answerWebAppQuery`). */
export interface MiniAppQueryStore {
  issue(params: MiniAppQueryIssueParams): MiniAppQueryRecord;
  peek(queryId: string): MiniAppQueryRecord | null;
  claim(queryId: string, userId?: string): MiniAppQueryRecord | null;
  claimAsync?(queryId: string, userId?: string): Promise<MiniAppQueryRecord | null>;
  release(queryId: string): void;
  revoke(queryId: string): void;
  readonly size: number;
}

/**
 * Tracks in-flight MiniApp launches so a mini app can post results back to the
 * bot exactly once (aiomatrix' analogue of Telegram's `answerWebAppQuery`).
 * Process-local — use {@link SignedMiniAppQueryRegistry} across instances.
 */
export class MiniAppQueryRegistry implements MiniAppQueryStore {
  private readonly queries = new Map<string, MiniAppQueryRecord>();

  constructor(
    private readonly capacity = 4_096,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  /** Register a launch and return the correlation id embedded into `initData`. */
  issue(params: MiniAppQueryIssueParams): MiniAppQueryRecord {
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

interface SignedQueryPayload {
  r: string;
  u: string;
  m: string | null;
  a: string | null;
  c: number;
  e: number;
  n: string;
}

export interface SignedMiniAppQueryRegistryOptions {
  secret: string;
  ttlMs?: number;
  /** Claimed / revoked ids. Share across instances for global single-answer. */
  used?: UsedTokenStore;
  /** Async claim store for multi-instance; prefer {@link SignedMiniAppQueryRegistry.claimAsync}. */
  asyncUsed?: AsyncUsedTokenStore;
}

/**
 * HMAC-signed `queryId` values. Any process with the secret can peek/claim;
 * inject a shared {@link UsedTokenStore} / {@link AsyncUsedTokenStore} so
 * `claim` is once across instances.
 */
export class SignedMiniAppQueryRegistry implements MiniAppQueryStore {
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly used: UsedTokenStore;
  private readonly asyncUsed: AsyncUsedTokenStore | null;
  private issued = 0;

  constructor(options: SignedMiniAppQueryRegistryOptions) {
    if (!options.secret || options.secret.length < 16) {
      throw new TypeError("SignedMiniAppQueryRegistry requires a secret of at least 16 characters");
    }
    this.secret = options.secret;
    this.ttlMs = Math.max(1, options.ttlMs ?? 60 * 60 * 1000);
    this.used = options.used ?? new MemoryUsedTokenStore();
    this.asyncUsed = options.asyncUsed ?? null;
  }

  issue(params: MiniAppQueryIssueParams): MiniAppQueryRecord {
    const now = Date.now();
    const payload: SignedQueryPayload = {
      r: params.roomId,
      u: params.userId,
      m: params.messageId ?? null,
      a: params.appId ?? null,
      c: now,
      e: now + (params.ttlMs ?? this.ttlMs),
      n: randomId(8),
    };
    const queryId = signQueryToken(payload, this.secret);
    this.issued += 1;
    return {
      queryId,
      roomId: payload.r,
      userId: payload.u,
      messageId: payload.m,
      appId: payload.a,
      createdAtMs: payload.c,
      expiresAtMs: payload.e,
      answeredAtMs: this.used.has(claimedKey(queryId)) ? payload.c : null,
    };
  }

  peek(queryId: string): MiniAppQueryRecord | null {
    if (this.used.has(revokedKey(queryId))) return null;
    const payload = verifyQueryToken(queryId, this.secret);
    if (!payload) return null;
    if (payload.e <= Date.now()) return null;
    return {
      queryId,
      roomId: payload.r,
      userId: payload.u,
      messageId: payload.m,
      appId: payload.a,
      createdAtMs: payload.c,
      expiresAtMs: payload.e,
      answeredAtMs: this.used.has(claimedKey(queryId)) ? Date.now() : null,
    };
  }

  claim(queryId: string, userId?: string): MiniAppQueryRecord | null {
    if (this.asyncUsed) {
      throw new TypeError(
        "SignedMiniAppQueryRegistry has asyncUsed configured; call claimAsync()",
      );
    }
    const record = this.peek(queryId);
    if (!record) return null;
    if (record.answeredAtMs !== null) return null;
    if (userId && record.userId !== userId) return null;
    const ttl = Math.max(1, record.expiresAtMs - Date.now());
    if (this.used.tryAdd) {
      if (!this.used.tryAdd(claimedKey(queryId), ttl)) return null;
    } else {
      if (this.used.has(claimedKey(queryId))) return null;
      this.used.add(claimedKey(queryId), ttl);
    }
    return { ...record, answeredAtMs: Date.now() };
  }

  async claimAsync(queryId: string, userId?: string): Promise<MiniAppQueryRecord | null> {
    const record = this.peek(queryId);
    if (!record) return null;
    if (record.answeredAtMs !== null) return null;
    if (userId && record.userId !== userId) return null;
    const ttl = Math.max(1, record.expiresAtMs - Date.now());
    if (this.asyncUsed) {
      if (!(await this.asyncUsed.tryAdd(claimedKey(queryId), ttl))) return null;
    } else if (this.used.tryAdd) {
      if (!this.used.tryAdd(claimedKey(queryId), ttl)) return null;
    } else {
      if (this.used.has(claimedKey(queryId))) return null;
      this.used.add(claimedKey(queryId), ttl);
    }
    return { ...record, answeredAtMs: Date.now() };
  }

  release(queryId: string): void {
    this.used.delete?.(claimedKey(queryId));
  }

  revoke(queryId: string): void {
    const record = this.peek(queryId);
    const ttl = record ? Math.max(1, record.expiresAtMs - Date.now()) : this.ttlMs;
    this.used.add(revokedKey(queryId), ttl);
    this.used.add(claimedKey(queryId), ttl);
  }

  get size(): number {
    return this.issued;
  }
}

function claimedKey(queryId: string): string {
  return `mq:claim:${queryId}`;
}

function revokedKey(queryId: string): string {
  return `mq:rev:${queryId}`;
}

function signQueryToken(payload: SignedQueryPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

function verifyQueryToken(token: string, secret: string): SignedQueryPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!timingSafeEqualStrings(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (typeof parsed.r !== "string" || typeof parsed.u !== "string") return null;
    if (typeof parsed.c !== "number" || typeof parsed.e !== "number") return null;
    if (typeof parsed.n !== "string") return null;
    return {
      r: parsed.r,
      u: parsed.u,
      m: typeof parsed.m === "string" ? parsed.m : null,
      a: typeof parsed.a === "string" ? parsed.a : null,
      c: parsed.c,
      e: parsed.e,
      n: parsed.n,
    };
  } catch {
    return null;
  }
}
