import { randomUUID } from "node:crypto";
import {
  AuthenticationError,
  ConfigurationError,
  aiomatrixError,
  RateLimitedError,
  RequestTimeoutError,
} from "./errors.js";
import { createDefaultLogger, type Logger } from "./logger.js";
import { clamp, isPlainObject, jitter, readNumber, readString, sleep } from "./util.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
/** Cap on `retry_after_ms` we are willing to honour before giving up. */
const MAX_HONOURED_RETRY_AFTER_MS = 90_000;

/** Matrix Client-Server error response (`errcode` + `error`). */
export class MatrixApiError extends aiomatrixError {
  readonly status: number;
  readonly errcode: string | null;
  readonly body: unknown;
  /** Present for `M_LIMIT_EXCEEDED` (429). */
  readonly retryAfterMs: number | null;
  /** Set for `M_UNKNOWN_TOKEN` when the HS says the session can be refreshed. */
  readonly softLogout: boolean;

  constructor(status: number, body: unknown, retryAfterMs: number | null = null) {
    const errcode = readString(body, "errcode") ?? null;
    const detail = readString(body, "error");
    const message = detail ?? `Matrix API error HTTP ${status}`;
    super(errcode ? `${errcode}: ${message}` : message);
    this.status = status;
    this.errcode = errcode;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
    this.softLogout =
      isPlainObject(body) && typeof body.soft_logout === "boolean"
        ? body.soft_logout
        : false;
  }

  /** True when the homeserver said the request was throttled and not processed. */
  get isRateLimit(): boolean {
    return this.status === 429 || this.errcode === "M_LIMIT_EXCEEDED";
  }

  /** True when the access token is rejected. */
  get isAuthFailure(): boolean {
    return (
      this.status === 401 ||
      this.errcode === "M_UNKNOWN_TOKEN" ||
      this.errcode === "M_MISSING_TOKEN"
    );
  }

  /** True when the endpoint or resource simply does not exist. */
  get isNotFound(): boolean {
    return this.status === 404 || this.errcode === "M_NOT_FOUND";
  }
}

/**
 * Normalize a homeserver base URL: strip trailing slashes, reject empties,
 * and warn when plaintext HTTP is used against a non-local host.
 */
export function normalizeHomeserverUrl(
  homeserverUrl: string,
  options?: { allowInsecure?: boolean; logger?: Logger },
): string {
  const trimmed = homeserverUrl.trim();
  if (!trimmed) {
    throw new aiomatrixError("homeserverUrl must not be empty");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const base = withScheme.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new aiomatrixError(`Invalid homeserverUrl: ${homeserverUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new aiomatrixError(
      `homeserverUrl must use http(s), got ${url.protocol} in ${homeserverUrl}`,
    );
  }
  // The access token travels on every request, so plain http to a remote host
  // is a credential leak. Refuse it unless the caller opts in explicitly.
  if (url.protocol === "http:" && !options?.allowInsecure && !isLocalHost(url.hostname)) {
    throw new ConfigurationError(
      `homeserverUrl uses plain http (${base}), which would send the access token unencrypted. ` +
        `Use https, or set allowInsecureHomeserver: true if this really is a trusted network.`,
    );
  }
  return base;
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  );
}

export interface MatrixHttpRequestOptions {
  signal?: AbortSignal;
  /** Override the default 60s timeout for this request. */
  timeoutMs?: number;
  /**
   * Safe to replay when the outcome is unknown (network drop, 5xx).
   * GET and PUT default to `true`; POST/DELETE default to `false`.
   */
  idempotent?: boolean;
  /** Override the retry budget for this request (`0` disables retries). */
  maxRetries?: number;
  /** Send a raw body (Buffer/Uint8Array) with an explicit content type. */
  rawBody?: Uint8Array;
  contentType?: string;
  /** Return the response as bytes instead of parsed JSON. */
  responseType?: "json" | "bytes";
  /** Extra headers merged over the defaults (never overrides Authorization). */
  headers?: Record<string, string>;
  /** Skip the Authorization header (used for `.well-known` discovery). */
  anonymous?: boolean;
}

export interface MatrixHttpOptions {
  accessToken?: string;
  logger?: Logger;
  allowInsecure?: boolean;
  /** Default request timeout in ms (default 60_000). */
  timeoutMs?: number;
  /** Max retry attempts after the first try (default 4). */
  maxRetries?: number;
  /** Base delay for exponential backoff (default 500ms). */
  retryBaseMs?: number;
  /** Ceiling for a single backoff delay (default 30_000ms). */
  maxRetryDelayMs?: number;
  /**
   * Called when the HS rejects the token. Return a fresh access token to retry
   * transparently, or `null`/throw to surface an {@link AuthenticationError}.
   */
  onTokenExpired?: (error: MatrixApiError) => Promise<string | null>;
  /** Observability hook fired for every completed attempt. */
  onRequest?: (info: RequestTelemetry) => void;
  /** Injected fetch (tests / custom agents). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface RequestTelemetry {
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  attempt: number;
  retried: boolean;
  error?: unknown;
}

/** Matrix Client-Server HTTP client with retry/throttle handling. */
export class MatrixHttp {
  private _baseUrl: string;
  private allowInsecure: boolean;
  /** Defined non-enumerably in the constructor so logging cannot leak it. */
  private declare accessToken: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly onTokenExpired?: (error: MatrixApiError) => Promise<string | null>;
  private readonly onRequest?: (info: RequestTelemetry) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly txnPrefix = randomUUID().replace(/-/g, "").slice(0, 12);
  private txnCounter = 0;
  private refreshInFlight: Promise<string | null> | null = null;

  constructor(homeserverUrl: string, accessTokenOrOptions?: string | MatrixHttpOptions) {
    const options: MatrixHttpOptions =
      typeof accessTokenOrOptions === "string"
        ? { accessToken: accessTokenOrOptions }
        : (accessTokenOrOptions ?? {});
    this.logger = options.logger ?? createDefaultLogger();
    this.allowInsecure = options.allowInsecure === true;
    this._baseUrl = normalizeHomeserverUrl(homeserverUrl, {
      allowInsecure: this.allowInsecure,
      logger: this.logger,
    });
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.onTokenExpired = options.onTokenExpired;
    this.onRequest = options.onRequest;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new aiomatrixError(
        "global fetch is unavailable — use Node >= 24 or pass fetchImpl",
      );
    }
    // Keep the token out of enumerable state so accidental JSON.stringify(http)
    // or structured logging of the client cannot leak credentials.
    Object.defineProperty(this, "accessToken", {
      value: options.accessToken ?? "",
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }

  /** Normalized homeserver base URL (no trailing slash). */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /** Replace the bearer token (after a login refresh). */
  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  /**
   * Update the homeserver base URL (e.g. after password re-login returns a
   * different `well_known` / delegated homeserver).
   */
  setBaseUrl(homeserverUrl: string): void {
    this._baseUrl = normalizeHomeserverUrl(homeserverUrl, {
      allowInsecure: this.allowInsecure,
      logger: this.logger,
    });
  }

  hasAccessToken(): boolean {
    return this.accessToken.length > 0;
  }

  /**
   * Transaction id: `m{processPrefix}.{counter}.{timestamp}`. The random
   * per-process prefix prevents collisions with a previous run of the same bot
   * (which would make the homeserver silently swallow the send as a duplicate).
   */
  txnId(): string {
    this.txnCounter += 1;
    return `m${this.txnPrefix}.${this.txnCounter}.${Date.now()}`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null> | null,
    body?: unknown,
    options?: MatrixHttpRequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const idempotent =
      options?.idempotent ?? (method === "GET" || method === "PUT" || method === "HEAD");
    const budget = options?.maxRetries ?? this.maxRetries;
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;

    let attempt = 0;
    let lastError: unknown;
    let refreshed = false;

    for (;;) {
      attempt += 1;
      const startedAt = Date.now();
      let status: number | null = null;
      try {
        const result = await this.attempt<T>(method, url, body, options, timeoutMs);
        status = result.status;
        this.onRequest?.({
          method,
          path,
          status,
          durationMs: Date.now() - startedAt,
          attempt,
          retried: attempt > 1,
        });
        return result.value;
      } catch (err) {
        lastError = err;
        if (err instanceof MatrixApiError) status = err.status;
        this.onRequest?.({
          method,
          path,
          status,
          durationMs: Date.now() - startedAt,
          attempt,
          retried: attempt > 1,
          error: err,
        });

        if (options?.signal?.aborted) throw err;

        if (err instanceof MatrixApiError && err.isAuthFailure) {
          if (!refreshed) {
            const token = await this.tryRefreshToken(err);
            if (token) {
              refreshed = true;
              continue;
            }
          }
          // Always the same error type, whether or not a refresh was attempted:
          // callers key off AuthenticationError to decide the session is dead.
          throw new AuthenticationError(
            `Access token rejected by homeserver (${err.errcode ?? err.status}).`,
            err.softLogout,
            { cause: err },
          );
        }

        const delay = this.retryDelayFor(err, attempt, idempotent);
        if (delay === null || attempt > budget) {
          if (err instanceof MatrixApiError && err.isRateLimit) {
            throw new RateLimitedError(err.retryAfterMs ?? 0, method, path);
          }
          throw err;
        }
        this.logger.debug(
          `retrying ${method} ${path} in ${delay}ms (attempt ${attempt}/${budget})`,
        );
        await sleep(delay, options?.signal);
        if (options?.signal?.aborted) throw lastError;
      }
    }
  }

  /** Convenience wrapper for binary downloads. */
  async requestBytes(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null> | null,
    options?: MatrixHttpRequestOptions,
  ): Promise<Uint8Array> {
    return this.request<Uint8Array>(method, path, query, undefined, {
      ...options,
      responseType: "bytes",
    });
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null> | null,
  ): URL {
    const url = new URL(
      /^https?:\/\//i.test(path)
        ? path
        : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`,
    );
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async attempt<T>(
    method: string,
    url: URL,
    body: unknown,
    options: MatrixHttpRequestOptions | undefined,
    timeoutMs: number,
  ): Promise<{ value: T; status: number }> {
    const headers: Record<string, string> = { ...(options?.headers ?? {}) };
    if (!options?.anonymous && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    let payload: string | Buffer | undefined;
    if (options?.rawBody) {
      payload = Buffer.from(
        options.rawBody.buffer,
        options.rawBody.byteOffset,
        options.rawBody.byteLength,
      );
      headers["Content-Type"] = options.contentType ?? "application/octet-stream";
    } else if (body !== undefined && body !== null) {
      headers["Content-Type"] = options?.contentType ?? "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }

    // Bail out before touching the transport: not every custom `fetchImpl`
    // honours an already-aborted signal, and a request nobody is waiting for
    // must not keep a timeout timer (and the process) alive.
    if (options?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = (): void => controller.abort();
    options?.signal?.addEventListener("abort", onExternalAbort, { once: true });
    // Deliberately refs the event loop: the timer exists to bound an in-flight
    // request, so the process must not be able to exit before it fires.
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });

      if (res.status < 200 || res.status >= 300) {
        const text = await res.text().catch(() => "");
        const parsed = parseMaybeJson(text);
        throw new MatrixApiError(res.status, parsed, retryAfterFrom(res, parsed));
      }

      if (options?.responseType === "bytes") {
        const buf = new Uint8Array(await res.arrayBuffer());
        return { value: buf as unknown as T, status: res.status };
      }
      const text = await res.text();
      return { value: parseMaybeJson(text) as T, status: res.status };
    } catch (err) {
      if (timedOut) {
        throw new RequestTimeoutError(timeoutMs, method, url.pathname);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * Returns the delay to wait before the next attempt, or `null` when the error
   * must not be retried.
   */
  private retryDelayFor(err: unknown, attempt: number, idempotent: boolean): number | null {
    if (err instanceof MatrixApiError) {
      if (err.isRateLimit) {
        // 429 means the request was rejected, never applied — always safe to replay.
        const hinted = err.retryAfterMs ?? this.retryBaseMs * 2 ** (attempt - 1);
        if (hinted > MAX_HONOURED_RETRY_AFTER_MS) return null;
        return clamp(hinted, 100, MAX_HONOURED_RETRY_AFTER_MS);
      }
      if (err.status >= 500 && err.status < 600) {
        return idempotent ? this.backoff(attempt) : null;
      }
      return null;
    }
    if (err instanceof RequestTimeoutError) {
      return idempotent ? this.backoff(attempt) : null;
    }
    if (err instanceof Error && err.name === "AbortError") {
      return null;
    }
    // Network-level failure (DNS, ECONNRESET, TLS). Unknown whether applied.
    if (err instanceof TypeError || (err instanceof Error && "code" in err)) {
      return idempotent ? this.backoff(attempt) : null;
    }
    return null;
  }

  private backoff(attempt: number): number {
    return clamp(
      jitter(this.retryBaseMs * 2 ** (attempt - 1)),
      this.retryBaseMs,
      this.maxRetryDelayMs,
    );
  }

  private async tryRefreshToken(err: MatrixApiError): Promise<string | null> {
    if (!this.onTokenExpired) return null;
    this.refreshInFlight ??= (async () => {
      try {
        return await this.onTokenExpired!(err);
      } catch (refreshErr) {
        this.logger.error("token refresh failed", refreshErr);
        return null;
      } finally {
        // Allow a later 401 to trigger another refresh attempt.
        setTimeout(() => {
          this.refreshInFlight = null;
        }, 0).unref?.();
      }
    })();
    const token = await this.refreshInFlight;
    if (token) {
      this.setAccessToken(token);
      this.logger.info("access token refreshed");
    }
    return token;
  }
}

function parseMaybeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function retryAfterFrom(res: Response, body: unknown): number | null {
  const fromBody = readNumber(body, "retry_after_ms");
  if (fromBody !== undefined) return Math.max(0, fromBody);
  const header = res.headers?.get?.("Retry-After");
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}
