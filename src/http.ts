/** Matrix Client-Server HTTP client (no matrix-bot-sdk). */

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

export class MatrixHttp {
  readonly baseUrl: string;
  readonly accessToken: string;
  private txnCounter = 0;

  constructor(homeserverUrl: string, accessToken: string) {
    this.baseUrl = homeserverUrl.replace(/\/+$/, "");
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

    const res = await fetch(url, { method, headers, body: payload });
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
  }
}
