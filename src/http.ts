/** Matrix Client-Server HTTP client (no matrix-bot-sdk). */

const DEFAULT_TIMEOUT_MS = 60_000;

export class MatrixApiError extends Error {
  readonly status: number;
  readonly errcode: string | null;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const errcode =
      body && typeof body === "object" && "errcode" in body
        ? String((body as { errcode?: unknown }).errcode ?? "")
        : null;
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error?: unknown }).error ?? `HTTP ${status}`)
        : `Matrix API error HTTP ${status}`;
    super(errcode ? `${errcode}: ${message}` : message);
    this.name = "MatrixApiError";
    this.status = status;
    this.errcode = errcode || null;
    this.body = body;
  }
}

/** Normalize homeserver URL: strip trailing slashes; reject empty; warn if not https. */
export function normalizeHomeserverUrl(homeserverUrl: string): string {
  const trimmed = homeserverUrl.trim();
  if (!trimmed) {
    throw new Error("homeserverUrl must not be empty");
  }
  const base = trimmed.replace(/\/+$/, "");
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid homeserverUrl: ${homeserverUrl}`);
  }
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "matrix.studnovsu.local" ||
    host.endsWith(".local");
  if (!base.toLowerCase().startsWith("https://") && !isLocal) {
    console.warn(
      `[matrixbots] homeserverUrl is not https (${base}). Prefer HTTPS in production.`,
    );
  }
  return base;
}

export interface MatrixHttpRequestOptions {
  signal?: AbortSignal;
  /** Override default 60s timeout. */
  timeoutMs?: number;
}

export class MatrixHttp {
  readonly baseUrl: string;
  readonly accessToken: string;
  private txnCounter = 0;

  constructor(homeserverUrl: string, accessToken: string) {
    this.baseUrl = normalizeHomeserverUrl(homeserverUrl);
    this.accessToken = accessToken;
  }

  /** Transaction id helper: `m${Date.now()}.N` */
  txnId(): string {
    this.txnCounter += 1;
    return `m${Date.now()}.${this.txnCounter}`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null> | null,
    body?: unknown,
    options?: MatrixHttpRequestOptions,
  ): Promise<T> {
    const url = new URL(
      path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`,
    );
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
    };
    let payload: string | undefined;
    if (body !== undefined && body !== null) {
      headers["Content-Type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }

    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;

    const onExternalAbort = (): void => {
      controller.abort();
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }

      if (res.status < 200 || res.status >= 300) {
        throw new MatrixApiError(res.status, parsed);
      }
      return parsed as T;
    } catch (err) {
      if (timedOut) {
        throw new Error(`Matrix HTTP timeout after ${timeoutMs}ms: ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
