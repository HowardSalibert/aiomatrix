import * as crypto from "node:crypto";
import { MiniAppAuthError } from "../errors.js";
import { isPlainObject, timingSafeEqualStrings } from "../util.js";
import { serveMiniAppBridge } from "./bridge.js";
import {
  MemoryNonceStore,
  validateInitData,
  type AsyncNonceStore,
  type MiniAppRoom,
  type MiniAppUser,
  type NonceStore,
  type ValidatedInitData,
} from "./initdata.js";

/** Compact HMAC-signed session token: `base64url(payload).base64url(mac)`. */
export interface MiniAppSession {
  userId: string;
  roomId: string | null;
  queryId: string | null;
  appId: string | null;
  /** Epoch seconds. */
  exp: number;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Issue a short-lived bearer token so a mini app need not resend `initData`. */
export function createSessionToken(
  session: Omit<MiniAppSession, "exp"> & { exp?: number },
  secret: string,
  ttlSeconds = 3600,
): string {
  const payload: MiniAppSession = {
    userId: session.userId,
    roomId: session.roomId ?? null,
    queryId: session.queryId ?? null,
    appId: session.appId ?? null,
    exp: session.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verify a token from {@link createSessionToken}. Throws {@link MiniAppAuthError}. */
export function verifySessionToken(token: string, secret: string): MiniAppSession {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new MiniAppAuthError("malformed session token", "malformed");
  const encoded = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!timingSafeEqualStrings(mac, sign(encoded, secret))) {
    throw new MiniAppAuthError("session token signature does not match", "bad_signature");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new MiniAppAuthError("session token payload is not JSON", "malformed");
  }
  if (!isPlainObject(parsed) || typeof parsed.userId !== "string" || typeof parsed.exp !== "number") {
    throw new MiniAppAuthError("session token payload is incomplete", "malformed");
  }
  if (parsed.exp * 1000 <= Date.now()) {
    throw new MiniAppAuthError("session token expired", "expired");
  }
  return {
    userId: parsed.userId,
    roomId: typeof parsed.roomId === "string" ? parsed.roomId : null,
    queryId: typeof parsed.queryId === "string" ? parsed.queryId : null,
    appId: typeof parsed.appId === "string" ? parsed.appId : null,
    exp: parsed.exp,
  };
}

export interface MiniAppRequest {
  method: string;
  /** Path or full URL. Only the pathname is routed on. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, a raw string, or `undefined`. */
  body?: unknown;
}

export interface MiniAppResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MiniAppAuthResult {
  validated: ValidatedInitData;
  token: string;
  expiresAtSeconds: number;
}

export interface MiniAppServerOptions {
  /** Same secret the bot signs `initData` with. */
  secret: string;
  /** Origins allowed to call this endpoint (used for CORS). */
  allowedOrigins?: string[];
  /** `initData` max age in seconds. Default 3600. */
  initDataTtlSeconds?: number;
  /** Session token lifetime in seconds. Default 3600. */
  sessionTtlSeconds?: number;
  /** Reject reused launches. Default true. */
  singleUseLaunch?: boolean;
  /**
   * Launch nonce store. Default is process-local {@link MemoryNonceStore}.
   * For multi-instance HTTP prefer {@link asyncNonceStore} (Redis SET NX).
   */
  nonceStore?: NonceStore;
  /** Atomic async nonce claim; wins over {@link nonceStore} when both are set. */
  asyncNonceStore?: AsyncNonceStore;
  /** Base path the routes are mounted under. Default `/`. */
  basePath?: string;
  /**
   * Receive `sendData` payloads. Return value is serialised into the response
   * body under `result`.
   */
  onData?: (
    session: MiniAppSession,
    data: string,
  ) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Framework-agnostic MiniApp backend.
 *
 * Handles the three things every mini app needs — validating a signed launch,
 * exchanging it for a session token, and shipping `sendData` payloads back to
 * the bot — without depending on Express, Fastify, or Node's `http` module.
 */
export class MiniAppServer {
  private readonly nonceStore: NonceStore | null;
  private readonly basePath: string;

  constructor(private readonly options: MiniAppServerOptions) {
    if (!options.secret || options.secret.length < 16) {
      throw new MiniAppAuthError(
        "MiniAppServer requires a secret of at least 16 characters",
        "malformed",
      );
    }
    if (options.singleUseLaunch === false) {
      this.nonceStore = null;
    } else if (options.asyncNonceStore) {
      this.nonceStore = options.nonceStore ?? null;
    } else {
      this.nonceStore = options.nonceStore ?? new MemoryNonceStore();
    }
    const base = (options.basePath ?? "/").replace(/\/+$/, "");
    this.basePath = base;
  }

  /** Validate a launch and mint a session token. */
  authenticate(initData: string): MiniAppAuthResult {
    if (this.options.asyncNonceStore && this.options.singleUseLaunch !== false) {
      throw new MiniAppAuthError(
        "asyncNonceStore requires authenticateAsync()",
        "malformed",
      );
    }
    const validated = validateInitData(initData, this.options.secret, {
      ...(this.options.initDataTtlSeconds !== undefined
        ? { ttlSeconds: this.options.initDataTtlSeconds }
        : {}),
      ...(this.nonceStore ? { nonceStore: this.nonceStore } : {}),
    });
    return this.mintSession(validated);
  }

  /**
   * Like {@link authenticate}, but records the launch nonce through
   * {@link MiniAppServerOptions.asyncNonceStore} when configured.
   */
  async authenticateAsync(initData: string): Promise<MiniAppAuthResult> {
    const asyncStore =
      this.options.singleUseLaunch === false ? null : (this.options.asyncNonceStore ?? null);
    if (!asyncStore) return this.authenticate(initData);

    const validated = validateInitData(initData, this.options.secret, {
      ...(this.options.initDataTtlSeconds !== undefined
        ? { ttlSeconds: this.options.initDataTtlSeconds }
        : {}),
      // Nonce checked atomically below.
    });
    if (!validated.nonce) {
      throw new MiniAppAuthError(
        "initData has no nonce but replay protection is enabled",
        "malformed",
      );
    }
    const claimed = await asyncStore.tryAdd(validated.nonce);
    if (!claimed) {
      throw new MiniAppAuthError("initData nonce was already used", "replayed");
    }
    return this.mintSession(validated);
  }

  private mintSession(validated: ValidatedInitData): MiniAppAuthResult {
    const ttl = this.options.sessionTtlSeconds ?? 3600;
    const token = createSessionToken(
      {
        userId: validated.user.id,
        roomId: validated.room?.id ?? null,
        queryId: validated.queryId,
        appId: null,
      },
      this.options.secret,
      ttl,
    );
    return { validated, token, expiresAtSeconds: Math.floor(Date.now() / 1000) + ttl };
  }

  /** Verify an `Authorization: Bearer …` header value or raw token. */
  verify(authorization: string | undefined): MiniAppSession {
    const raw = (authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!raw) throw new MiniAppAuthError("missing session token", "malformed");
    return verifySessionToken(raw, this.options.secret);
  }

  /** Route a request. Returns a plain response object the host can write out. */
  async handle(request: MiniAppRequest): Promise<MiniAppResponse> {
    const origin = headerValue(request.headers, "origin");
    const cors = this.corsHeaders(origin);
    const method = request.method.toUpperCase();
    const route = this.routeOf(request.url);

    if (method === "OPTIONS") {
      return { status: 204, headers: { ...cors }, body: "" };
    }
    if (route === "/bridge.js" && method === "GET") {
      const asset = serveMiniAppBridge();
      return {
        status: 200,
        headers: {
          "content-type": asset.contentType,
          etag: asset.etag,
          "cache-control": asset.cacheControl,
          ...cors,
        },
        body: asset.body,
      };
    }
    if (origin && !this.isOriginAllowed(origin)) {
      return this.json(403, { error: "origin_not_allowed" }, cors);
    }

    if (route === "/auth" && method === "POST") {
      const body = parseBody(request.body);
      const initData = typeof body.initData === "string" ? body.initData : "";
      try {
        const result = this.options.asyncNonceStore
          ? await this.authenticateAsync(initData)
          : this.authenticate(initData);
        return this.json(
          200,
          {
            ok: true,
            token: result.token,
            expires_at: result.expiresAtSeconds,
            user: result.validated.user,
            room: result.validated.room,
            query_id: result.validated.queryId,
            start_param: result.validated.startParam,
          },
          cors,
        );
      } catch (err) {
        return this.authError(err, cors);
      }
    }

    if (route === "/data" && method === "POST") {
      let session: MiniAppSession;
      try {
        session = this.verify(headerValue(request.headers, "authorization"));
      } catch (err) {
        return this.authError(err, cors);
      }
      const body = parseBody(request.body);
      const data =
        typeof body.data === "string" ? body.data : JSON.stringify(body.data ?? null);
      if (!this.options.onData) {
        return this.json(501, { error: "sendData is not wired on this server" }, cors);
      }
      const result = (await this.options.onData(session, data)) ?? {};
      return this.json(200, { ok: true, result }, cors);
    }

    if (route === "/me" && method === "GET") {
      try {
        const session = this.verify(headerValue(request.headers, "authorization"));
        return this.json(200, { ok: true, session }, cors);
      } catch (err) {
        return this.authError(err, cors);
      }
    }

    return this.json(404, { error: "not_found" }, cors);
  }

  /** Adapter for `node:http` / Express-style `(req, res)` handlers. */
  nodeHandler(): (
    req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body?: unknown },
    res: {
      statusCode: number;
      setHeader(name: string, value: string): void;
      end(chunk?: string): void;
    },
  ) => Promise<void> {
    return async (req, res) => {
      const response = await this.handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: req.body,
      });
      res.statusCode = response.status;
      for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
      res.end(response.body);
    };
  }

  private routeOf(url: string): string {
    let pathname = url;
    try {
      pathname = new URL(url, "http://localhost").pathname;
    } catch {
      pathname = url.split("?")[0] ?? url;
    }
    if (this.basePath && pathname.startsWith(this.basePath)) {
      pathname = pathname.slice(this.basePath.length) || "/";
    }
    return pathname.endsWith("/") && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
  }

  private isOriginAllowed(origin: string): boolean {
    const allowed = this.options.allowedOrigins ?? [];
    if (allowed.length === 0) return false;
    const normalized = origin.trim().toLowerCase().replace(/\/+$/, "");
    return allowed.some((entry) => {
      const candidate = entry.trim().toLowerCase().replace(/\/+$/, "");
      if (candidate === "*") return true;
      try {
        return new URL(candidate).origin.toLowerCase() === normalized;
      } catch {
        return candidate === normalized;
      }
    });
  }

  private corsHeaders(origin: string | undefined): Record<string, string> {
    if (!origin || !this.isOriginAllowed(origin)) return { vary: "Origin" };
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-max-age": "600",
      vary: "Origin",
    };
  }

  private authError(err: unknown, cors: Record<string, string>): MiniAppResponse {
    if (err instanceof MiniAppAuthError) {
      // 401 for anything the caller can fix by re-launching the mini app.
      return this.json(401, { error: err.reason, message: err.message }, cors);
    }
    throw err;
  }

  private json(
    status: number,
    payload: Record<string, unknown>,
    cors: Record<string, string>,
  ): MiniAppResponse {
    return {
      status,
      headers: { ...JSON_HEADERS, ...cors },
      body: JSON.stringify(payload),
    };
  }
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = direct ?? findHeaderCaseInsensitive(headers, name);
  if (Array.isArray(value)) return value[0];
  return value;
}

function findHeaderCaseInsensitive(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) return value;
  }
  return undefined;
}

function parseBody(body: unknown): Record<string, unknown> {
  if (isPlainObject(body)) return body;
  if (typeof body === "string" && body.trim()) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Fall through: treat an unparseable body as empty.
    }
  }
  if (body instanceof Uint8Array) {
    return parseBody(Buffer.from(body).toString("utf8"));
  }
  return {};
}

export type { MiniAppRoom, MiniAppUser };
