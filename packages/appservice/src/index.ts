/**
 * Universal Matrix Application Service (appservice) for any homeserver that
 * speaks the Application Service API (Synapse, Dendrite, Conduit, …).
 *
 * Not a Synapse Python module — pure Node/TypeScript HTTP + HS push.
 * Extractable to FakeHoward/aiomatrix-appservice; kept here for CI TDD.
 */

import * as http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppserviceRegistration {
  id: string;
  url: string;
  as_token: string;
  hs_token: string;
  sender_localpart: string;
  namespaces: {
    users?: Array<{ exclusive: boolean; regex: string }>;
    rooms?: Array<{ exclusive: boolean; regex: string }>;
    aliases?: Array<{ exclusive: boolean; regex: string }>;
  };
  rate_limited?: boolean;
  protocols?: string[];
}

export interface MatrixTransactionEvent {
  type: string;
  room_id?: string;
  event_id?: string;
  sender?: string;
  content?: Record<string, unknown>;
  origin_server_ts?: number;
  state_key?: string;
  unsigned?: Record<string, unknown>;
}

export interface AppserviceHandlers {
  onTransaction?: (
    txnId: string,
    events: MatrixTransactionEvent[],
  ) => void | Promise<void>;
  onQueryUser?: (userId: string) => boolean | Promise<boolean>;
  onQueryRoom?: (alias: string) => boolean | Promise<boolean>;
}

export interface AppserviceOptions {
  hsToken: string;
  asToken: string;
  homeserverUrl: string;
  handlers?: AppserviceHandlers;
  /** Bind address. Default 127.0.0.1 */
  host?: string;
  /** Listen port. Default 8090 */
  port?: number;
  logger?: { info: (m: string) => void; warn: (m: string, e?: unknown) => void };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * HTTP Application Service. Homeservers push `/transactions/{txnId}`;
 * the AS may query `/users` / `/rooms` namespaces.
 */
export class Appservice {
  private readonly opts: AppserviceOptions;
  private server: http.Server | null = null;
  private readonly seenTxn = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(opts: AppserviceOptions) {
    this.opts = opts;
  }

  /** Verify `Authorization: Bearer <hs_token>` (or `access_token` query). */
  authorize(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      return safeEqual(header.slice(7).trim(), this.opts.hsToken);
    }
    const q = url.searchParams.get("access_token");
    return q != null && safeEqual(q, this.opts.hsToken);
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!this.authorize(req, url)) {
      json(res, 401, { errcode: "M_FORBIDDEN", error: "Invalid hs_token" });
      return;
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    // PUT /_matrix/app/v1/transactions/{txnId}
    const txnMatch = path.match(/^\/_matrix\/app\/v1\/transactions\/([^/]+)$/);
    if (req.method === "PUT" && txnMatch) {
      const txnId = decodeURIComponent(txnMatch[1]!);
      if (this.seenTxn.has(txnId)) {
        json(res, 200, {});
        return;
      }
      const raw = await readBody(req);
      let events: MatrixTransactionEvent[] = [];
      try {
        const parsed = JSON.parse(raw) as { events?: MatrixTransactionEvent[] };
        events = Array.isArray(parsed.events) ? parsed.events : [];
      } catch {
        json(res, 400, { errcode: "M_BAD_JSON", error: "Invalid JSON" });
        return;
      }
      this.rememberTxn(txnId);
      try {
        await this.opts.handlers?.onTransaction?.(txnId, events);
      } catch (err) {
        this.opts.logger?.warn(`onTransaction failed txn=${txnId}`, err);
        json(res, 500, { errcode: "M_UNKNOWN", error: "Handler failed" });
        return;
      }
      json(res, 200, {});
      return;
    }

    // GET /_matrix/app/v1/users/{userId}
    const userMatch = path.match(/^\/_matrix\/app\/v1\/users\/([^/]+)$/);
    if (req.method === "GET" && userMatch) {
      const userId = decodeURIComponent(userMatch[1]!);
      const ok = (await this.opts.handlers?.onQueryUser?.(userId)) ?? false;
      if (!ok) {
        json(res, 404, { errcode: "M_NOT_FOUND", error: "User not found" });
        return;
      }
      json(res, 200, {});
      return;
    }

    // GET /_matrix\/app\/v1\/rooms/{alias}
    const roomMatch = path.match(/^\/_matrix\/app\/v1\/rooms\/([^/]+)$/);
    if (req.method === "GET" && roomMatch) {
      const alias = decodeURIComponent(roomMatch[1]!);
      const ok = (await this.opts.handlers?.onQueryRoom?.(alias)) ?? false;
      if (!ok) {
        json(res, 404, { errcode: "M_NOT_FOUND", error: "Room not found" });
        return;
      }
      json(res, 200, {});
      return;
    }

    if (req.method === "GET" && (path === "/health" || path === "/_matrix/app/v1/health")) {
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { errcode: "M_UNRECOGNIZED", error: "Not found" });
  }

  private rememberTxn(txnId: string): void {
    this.seenTxn.add(txnId);
    this.seenOrder.push(txnId);
    while (this.seenOrder.length > 4096) {
      const stale = this.seenOrder.shift();
      if (stale) this.seenTxn.delete(stale);
    }
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("already listening");
    const host = this.opts.host ?? "127.0.0.1";
    const wantPort = this.opts.port ?? 8090;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        this.opts.logger?.warn("request error", err);
        if (!res.headersSent) json(res, 500, { errcode: "M_UNKNOWN", error: "Internal" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(wantPort, host, () => resolve());
    });
    const addr = this.server.address();
    const port =
      typeof addr === "object" && addr && typeof addr.port === "number" ? addr.port : wantPort;
    this.opts.logger?.info(`appservice listening on http://${host}:${port}`);
    return { host, port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** Send as the appservice (uses `as_token`). */
  async hsRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const base = this.opts.homeserverUrl.replace(/\/+$/, "");
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.asToken}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, json: parsed };
  }
}

/** Build a registration object suitable for HS config / YAML export. */
export function buildRegistration(input: {
  id: string;
  url: string;
  asToken: string;
  hsToken: string;
  senderLocalpart: string;
  userRegex?: string;
  exclusiveUsers?: boolean;
}): AppserviceRegistration {
  return {
    id: input.id,
    url: input.url,
    as_token: input.asToken,
    hs_token: input.hsToken,
    sender_localpart: input.senderLocalpart,
    namespaces: {
      users: [
        {
          exclusive: input.exclusiveUsers ?? true,
          regex: input.userRegex ?? `@${input.senderLocalpart}.*`,
        },
      ],
    },
    rate_limited: false,
  };
}

/** Generate opaque tokens for registration (not cryptographically bound to HS). */
export function generateAppserviceToken(seed?: string): string {
  const material = seed ?? `${Date.now()}:${Math.random()}`;
  return createHmac("sha256", "aiomatrix-appservice").update(material).digest("hex");
}

export function registrationToYaml(reg: AppserviceRegistration): string {
  const lines = [
    `id: ${JSON.stringify(reg.id)}`,
    `url: ${JSON.stringify(reg.url)}`,
    `as_token: ${JSON.stringify(reg.as_token)}`,
    `hs_token: ${JSON.stringify(reg.hs_token)}`,
    `sender_localpart: ${JSON.stringify(reg.sender_localpart)}`,
    `rate_limited: ${reg.rate_limited === false ? "false" : "true"}`,
    "namespaces:",
  ];
  if (reg.namespaces.users?.length) {
    lines.push("  users:");
    for (const u of reg.namespaces.users) {
      lines.push(`    - exclusive: ${u.exclusive}`);
      lines.push(`      regex: ${JSON.stringify(u.regex)}`);
    }
  }
  return lines.join("\n") + "\n";
}
