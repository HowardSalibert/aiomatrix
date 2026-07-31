import * as crypto from "node:crypto";
import { MiniAppAuthError } from "../errors.js";
import { isPlainObject, randomId } from "../util.js";

/**
 * HMAC salt for deriving the signing key from the bot's MiniApp secret.
 * Mirrors Telegram's `WebAppData` construction with a Matrix-specific label so
 * a secret can never be replayed across ecosystems.
 */
export const INIT_DATA_HMAC_SALT = "MatrixWebAppData";
export const DEFAULT_INIT_DATA_TTL_SECONDS = 3600;

export interface MiniAppUser {
  /** Matrix user id, e.g. `@alice:example.org`. */
  id: string;
  /** Localpart, provided for parity with Telegram's `username`. */
  username?: string;
  first_name?: string;
  last_name?: string;
  photo_url?: string;
  language_code?: string;
  is_bot?: boolean;
}

export interface MiniAppRoom {
  /** Matrix room id. */
  id: string;
  type: "direct" | "group";
  title?: string;
  photo_url?: string;
}

export interface MiniAppInitDataPayload {
  user: MiniAppUser;
  room?: MiniAppRoom;
  /** Correlation id used by `answerMiniAppQuery`. */
  query_id?: string;
  /** Deep-link parameter (`?startapp=`/`start_param`). */
  start_param?: string;
  /** Event id of the message the mini app was launched from. */
  message_id?: string;
  /** Bot user id that owns the mini app. */
  bot_id?: string;
  /** Seconds since the epoch when the payload was signed. */
  auth_date: number;
  /** Anti-replay nonce. */
  nonce: string;
}

export interface SignedInitData {
  /** URL-encoded string to hand to the mini app (`Telegram.WebApp.initData` shape). */
  initData: string;
  /** Parsed, unsigned view (`initDataUnsafe`). */
  initDataUnsafe: Record<string, unknown>;
  /** Epoch ms when the signature stops being accepted. */
  expiresAtMs: number;
}

function deriveSigningKey(secret: string): Buffer {
  return crypto.createHmac("sha256", INIT_DATA_HMAC_SALT).update(secret).digest();
}

/**
 * Build the data-check string: every field except `hash`, sorted by key and
 * joined with newlines. Identical in spirit to Telegram's algorithm, so mini
 * apps written for Telegram validate with the same code shape.
 */
export function buildDataCheckString(params: URLSearchParams | Record<string, string>): string {
  const entries: Array<[string, string]> =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  return entries
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function computeHash(secret: string, dataCheckString: string): string {
  return crypto
    .createHmac("sha256", deriveSigningKey(secret))
    .update(dataCheckString)
    .digest("hex");
}

/**
 * Sign a MiniApp launch payload.
 *
 * The returned `initData` travels to the browser; the mini app's backend calls
 * {@link validateInitData} with the same secret to authenticate the user
 * without trusting the front end.
 */
export function createInitData(
  payload: Omit<MiniAppInitDataPayload, "auth_date" | "nonce"> & {
    auth_date?: number;
    nonce?: string;
  },
  secret: string,
  options?: { ttlSeconds?: number },
): SignedInitData {
  if (!secret || secret.length < 16) {
    throw new MiniAppAuthError(
      "MiniApp secret must be at least 16 characters of high-entropy data",
      "malformed",
    );
  }
  const authDate = payload.auth_date ?? Math.floor(Date.now() / 1000);
  const nonce = payload.nonce ?? randomId(12);
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("nonce", nonce);
  params.set("user", JSON.stringify(payload.user));
  if (payload.room) params.set("room", JSON.stringify(payload.room));
  if (payload.query_id) params.set("query_id", payload.query_id);
  if (payload.start_param) params.set("start_param", payload.start_param);
  if (payload.message_id) params.set("message_id", payload.message_id);
  if (payload.bot_id) params.set("bot_id", payload.bot_id);

  const hash = computeHash(secret, buildDataCheckString(params));
  params.set("hash", hash);

  const ttl = options?.ttlSeconds ?? DEFAULT_INIT_DATA_TTL_SECONDS;
  return {
    initData: params.toString(),
    initDataUnsafe: parseInitDataLoose(params),
    expiresAtMs: (authDate + ttl) * 1000,
  };
}

function parseInitDataLoose(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    if (key === "user" || key === "room") {
      try {
        out[key] = JSON.parse(value) as unknown;
        continue;
      } catch {
        // fall through to the raw string
      }
    }
    if (key === "auth_date") {
      const num = Number(value);
      out[key] = Number.isFinite(num) ? num : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

export interface ValidateInitDataOptions {
  /** Max age of `auth_date` in seconds. Default 3600. */
  ttlSeconds?: number;
  /**
   * Reject a `nonce` that was already used. Supply a shared store to make
   * launches strictly single-use across processes.
   */
  nonceStore?: NonceStore;
  /** Override the clock (tests). */
  nowMs?: number;
}

export interface ValidatedInitData {
  user: MiniAppUser;
  room: MiniAppRoom | null;
  queryId: string | null;
  startParam: string | null;
  messageId: string | null;
  botId: string | null;
  authDate: number;
  nonce: string;
  /** Every raw field, for forward compatibility. */
  raw: Record<string, string>;
}

/**
 * Verify a MiniApp `initData` string.
 *
 * Throws {@link MiniAppAuthError} on a bad signature, an expired `auth_date`,
 * a replayed nonce, or malformed payloads. Never trust `initDataUnsafe` in a
 * backend — always run it through this function.
 */
export function validateInitData(
  initData: string,
  secret: string,
  options: ValidateInitDataOptions = {},
): ValidatedInitData {
  if (!initData || typeof initData !== "string") {
    throw new MiniAppAuthError("initData is empty", "malformed");
  }
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw new MiniAppAuthError("initData has no hash", "missing_hash");
  }
  const expected = computeHash(secret, buildDataCheckString(params));
  const provided = Buffer.from(hash, "hex");
  const computed = Buffer.from(expected, "hex");
  if (
    provided.length !== computed.length ||
    provided.length === 0 ||
    !crypto.timingSafeEqual(provided, computed)
  ) {
    throw new MiniAppAuthError("initData signature does not match", "bad_signature");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new MiniAppAuthError("initData has no valid auth_date", "malformed");
  }
  const ttl = options.ttlSeconds ?? DEFAULT_INIT_DATA_TTL_SECONDS;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (nowSeconds - authDate > ttl) {
    throw new MiniAppAuthError(
      `initData expired (${nowSeconds - authDate}s old, ttl ${ttl}s)`,
      "expired",
    );
  }
  // Small tolerance for clock skew between the signer and the validator.
  if (authDate - nowSeconds > 60) {
    throw new MiniAppAuthError("initData auth_date is in the future", "malformed");
  }

  const nonce = params.get("nonce") ?? "";
  if (options.nonceStore) {
    if (!nonce) {
      throw new MiniAppAuthError("initData has no nonce but replay protection is enabled", "malformed");
    }
    if (options.nonceStore.has(nonce)) {
      throw new MiniAppAuthError("initData nonce was already used", "replayed");
    }
    options.nonceStore.add(nonce);
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new MiniAppAuthError("initData has no user", "malformed");
  }
  let user: MiniAppUser;
  try {
    const parsed = JSON.parse(userRaw) as unknown;
    if (!isPlainObject(parsed) || typeof parsed.id !== "string" || !parsed.id) {
      throw new Error("bad user");
    }
    user = parsed as unknown as MiniAppUser;
  } catch {
    throw new MiniAppAuthError("initData user is not a valid object", "malformed");
  }

  let room: MiniAppRoom | null = null;
  const roomRaw = params.get("room");
  if (roomRaw) {
    try {
      const parsed = JSON.parse(roomRaw) as unknown;
      if (isPlainObject(parsed) && typeof parsed.id === "string") {
        room = parsed as unknown as MiniAppRoom;
      }
    } catch {
      throw new MiniAppAuthError("initData room is not a valid object", "malformed");
    }
  }

  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) raw[key] = value;

  return {
    user,
    room,
    queryId: params.get("query_id"),
    startParam: params.get("start_param"),
    messageId: params.get("message_id"),
    botId: params.get("bot_id"),
    authDate,
    nonce,
    raw,
  };
}

/** Single-use launch nonces. Inject a shared adapter when scaling MiniApp HTTP. */
export interface NonceStore {
  has(nonce: string): boolean;
  add(nonce: string): void;
}

/**
 * Atomic nonce claim for async backends (Redis SET NX).
 * Prefer this over {@link NonceStore} when MiniApp HTTP is multi-instance.
 */
export interface AsyncNonceStore {
  /** `true` if this call recorded the nonce; `false` if it was already used. */
  tryAdd(nonce: string): Promise<boolean>;
}

/** Bounded in-memory nonce store for single-use launch protection. */
export class MemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly capacity = 8_192,
    private readonly ttlMs = DEFAULT_INIT_DATA_TTL_SECONDS * 1000,
  ) {}

  has(nonce: string): boolean {
    const at = this.seen.get(nonce);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.seen.delete(nonce);
      return false;
    }
    return true;
  }

  add(nonce: string): void {
    const now = Date.now();
    for (const [key, at] of this.seen) {
      if (now - at > this.ttlMs) this.seen.delete(key);
      else break;
    }
    while (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next();
      if (oldest.done) break;
      this.seen.delete(oldest.value);
    }
    this.seen.set(nonce, now);
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Append signed launch data to a mini app URL.
 *
 * `initData` goes in the fragment (`#tgWebAppData=…`-style) so it never reaches
 * server access logs or `Referer` headers.
 *
 * Pass `{ matrixWebAppHost: '<host origin>' }` as `extra` when the embedding
 * origin is known — the browser bridge then rejects `postMessage` traffic from
 * every other origin.
 */
export function buildMiniAppLaunchUrl(
  baseUrl: string,
  signed: SignedInitData,
  extra?: Record<string, string>,
): string {
  const url = new URL(baseUrl);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  fragment.set("matrixWebAppData", signed.initData);
  for (const [key, value] of Object.entries(extra ?? {})) fragment.set(key, value);
  url.hash = fragment.toString();
  return url.toString();
}

/** True when `url` is https (or http on localhost) and its origin is allowlisted. */
export function isMiniAppUrlAllowed(url: string, allowedOrigins: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    return false;
  }
  if (allowedOrigins.length === 0) return false;
  const origin = parsed.origin.toLowerCase();
  return allowedOrigins.some((allowed) => {
    const trimmed = allowed.trim().toLowerCase().replace(/\/+$/, "");
    if (!trimmed) return false;
    if (trimmed === "*") return true;
    try {
      return new URL(trimmed).origin.toLowerCase() === origin;
    } catch {
      return trimmed === origin;
    }
  });
}
