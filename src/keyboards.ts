import * as crypto from "node:crypto";
import {
  MemoryTtlStringMap,
  MemoryUsedTokenStore,
  type AsyncUsedTokenStore,
  type TtlStringMap,
  type UsedTokenStore,
} from "./token-store.js";
import { escapeHtml, isPlainObject, randomId, readString, timingSafeEqualStrings } from "./util.js";
import { checkSchemaVersion, readSchemaVersion } from "./schema-contract.js";

/** Content field carrying a aiomatrix inline keyboard. */
export const KEYBOARD_CONTENT_KEY = "dev.aiomatrix.keyboard";
/** Room event type sent by a client when an inline button is pressed. */
export const CALLBACK_EVENT_TYPE = "dev.aiomatrix.callback";
/** Toast / progress events for aware hosts (not timeline notices). */
export const TOAST_EVENT_TYPE = "dev.aiomatrix.toast";
export const PROGRESS_EVENT_TYPE = "dev.aiomatrix.progress";
export const CALLBACK_ANSWER_EVENT_TYPE = "dev.aiomatrix.callback_answer";
/** Text-command fallback so keyboards work in clients with no button support. */
export const CALLBACK_FALLBACK_COMMAND = "cb";
export const KEYBOARD_SCHEMA_VERSION = 1;

export type InlineButton =
  | {
      kind: "callback";
      text: string;
      data: string;
      /** Token in structured keyboard JSON (may be signed / long). */
      token?: string;
      /**
       * Short id for plaintext `!cb` fallback. Prefer this over `token` in
       * {@link renderKeyboardFallback}; signed tokens stay in JSON only.
       */
      fallback?: string;
      style?: ButtonStyle;
    }
  | { kind: "url"; text: string; url: string; style?: ButtonStyle }
  | {
      kind: "mini_app";
      text: string;
      url: string;
      startParam?: string;
      style?: ButtonStyle;
    }
  | { kind: "command"; text: string; command: string; style?: ButtonStyle };

export type ButtonStyle = "default" | "primary" | "danger" | "link";

export interface KeyboardContent {
  version: number;
  inline: InlineButton[][];
  /** Fallback command prefix a client can suggest for callback buttons. */
  fallback_command?: string;
}

/** Longest button label, in UTF-16 code units. */
export const MAX_BUTTON_TEXT_LENGTH = 128;
/** Longest callback payload, in bytes of UTF-8. */
export const MAX_CALLBACK_DATA_BYTES = 512;

function assertButtonText(label: string): string {
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new TypeError("Button text must be a non-empty string.");
  }
  if (label.length > MAX_BUTTON_TEXT_LENGTH) {
    throw new TypeError(`Button text must be at most ${MAX_BUTTON_TEXT_LENGTH} characters.`);
  }
  return label;
}

function assertCallbackData(data: string): string {
  if (typeof data !== "string") throw new TypeError("Callback data must be a string.");
  const size = Buffer.byteLength(data, "utf8");
  if (size > MAX_CALLBACK_DATA_BYTES) {
    throw new TypeError(
      `Callback data must be at most ${MAX_CALLBACK_DATA_BYTES} bytes (got ${size}).`,
    );
  }
  return data;
}

/**
 * `true` when the URL is safe to put in front of a user.
 *
 * Buttons end up as links in the HTML fallback, so anything but http(s) — and
 * `javascript:`/`data:` above all — has to be refused at build time rather than
 * relying on the receiving client to be careful.
 */
export function isSafeButtonUrl(url: string, requireHttps = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  if (requireHttps) return isLoopbackHost(parsed.hostname);
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function assertButtonUrl(url: string, requireHttps: boolean): string {
  if (!isSafeButtonUrl(url, requireHttps)) {
    throw new TypeError(
      requireHttps
        ? `MiniApp URL must be https (or http on localhost): ${url}`
        : `Button URL must be http(s): ${url}`,
    );
  }
  return url;
}

/**
 * Inline keyboard builder — the Matrix analogue of Telegram's
 * `InlineKeyboardMarkup`.
 *
 * Serialised into the `dev.aiomatrix.keyboard` content field for clients that
 * render buttons natively, plus a numbered plain-text/HTML fallback so the same
 * message stays usable in Element or any other stock client.
 */
export class InlineKeyboard {
  private rows: InlineButton[][] = [[]];

  /** Callback button: pressing it delivers a `callback_query` update to the bot. */
  text(label: string, data: string, style?: ButtonStyle): this {
    const button: InlineButton = {
      kind: "callback",
      text: assertButtonText(label),
      data: assertCallbackData(data),
    };
    if (style !== undefined) button.style = style;
    return this.push(button);
  }

  /** Alias of {@link InlineKeyboard.text}, for readers who prefer the intent. */
  callback(label: string, data: string, style?: ButtonStyle): this {
    return this.text(label, data, style);
  }

  /** Open an external URL. */
  url(label: string, url: string, style?: ButtonStyle): this {
    const button: InlineButton = {
      kind: "url",
      text: assertButtonText(label),
      url: assertButtonUrl(url, false),
    };
    if (style !== undefined) button.style = style;
    return this.push(button);
  }

  /** Launch a MiniApp. */
  miniApp(label: string, url: string, startParam?: string, style?: ButtonStyle): this {
    const button: InlineButton = {
      kind: "mini_app",
      text: assertButtonText(label),
      url: assertButtonUrl(url, true),
    };
    if (startParam !== undefined) button.startParam = startParam;
    if (style !== undefined) button.style = style;
    return this.push(button);
  }

  /** Prefill/send a bot command. */
  command(label: string, command: string, style?: ButtonStyle): this {
    const button: InlineButton = {
      kind: "command",
      text: assertButtonText(label),
      command,
    };
    if (style !== undefined) button.style = style;
    return this.push(button);
  }

  /** Start a new row. */
  row(): this {
    if (this.rows[this.rows.length - 1]?.length) this.rows.push([]);
    return this;
  }

  /** Lay out the current buttons `columns` per row. */
  adjust(columns: number): this {
    const flat = this.rows.flat();
    const width = Math.max(1, Math.floor(columns));
    this.rows = [];
    for (let i = 0; i < flat.length; i += width) {
      this.rows.push(flat.slice(i, i + width));
    }
    if (this.rows.length === 0) this.rows = [[]];
    return this;
  }

  get buttons(): InlineButton[][] {
    return this.rows.filter((row) => row.length > 0).map((row) => [...row]);
  }

  get isEmpty(): boolean {
    return this.buttons.length === 0;
  }

  /** Serialise for the `dev.aiomatrix.keyboard` content field. */
  toContent(): KeyboardContent {
    return {
      version: KEYBOARD_SCHEMA_VERSION,
      inline: this.buttons,
      fallback_command: CALLBACK_FALLBACK_COMMAND,
    };
  }

  private push(button: InlineButton): this {
    const last = this.rows[this.rows.length - 1];
    if (last) last.push(button);
    else this.rows.push([button]);
    return this;
  }

  /** Build a keyboard from a plain array-of-rows structure. */
  static from(rows: InlineButton[][]): InlineKeyboard {
    const kb = new InlineKeyboard();
    kb.rows = rows.map((row) => [...row]);
    if (kb.rows.length === 0) kb.rows = [[]];
    return kb;
  }

  /** Grid of callback buttons from `[label, data]` pairs, `columns` per row. */
  static fromCallbacks(
    entries: Array<readonly [string, string]>,
    columns = 1,
  ): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const [label, data] of entries) kb.text(label, data);
    return kb.adjust(columns);
  }

  /**
   * Paginated callback grid with prev/next controls.
   * `dataForItem(item, absoluteIndex)` must return stable callback data.
   * Nav buttons use `${navPrefix}:prev:${page}` / `${navPrefix}:next:${page}`.
   */
  static paginate<T>(
    items: readonly T[],
    options: {
      page: number;
      pageSize?: number;
      columns?: number;
      dataForItem: (item: T, index: number) => string;
      labelForItem?: (item: T, index: number) => string;
      navPrefix?: string;
      prevLabel?: string;
      nextLabel?: string;
      /** Include a page indicator button (non-nav). Default true. */
      showPageLabel?: boolean;
    },
  ): InlineKeyboard {
    const pageSize = Math.max(1, options.pageSize ?? 8);
    const columns = Math.max(1, options.columns ?? 1);
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const page = Math.min(Math.max(0, options.page), totalPages - 1);
    const start = page * pageSize;
    const slice = items.slice(start, start + pageSize);
    const kb = new InlineKeyboard();
    const labelOf = options.labelForItem ?? ((item: T) => String(item));
    for (let i = 0; i < slice.length; i += 1) {
      const item = slice[i]!;
      const abs = start + i;
      kb.text(labelOf(item, abs), options.dataForItem(item, abs));
    }
    kb.adjust(columns);
    const navPrefix = options.navPrefix ?? "page";
    const prevLabel = options.prevLabel ?? "‹";
    const nextLabel = options.nextLabel ?? "›";
    if (totalPages > 1) {
      kb.row();
      if (page > 0) kb.text(prevLabel, `${navPrefix}:prev:${page}`);
      if (options.showPageLabel !== false) {
        kb.text(`${page + 1}/${totalPages}`, `${navPrefix}:noop:${page}`);
      }
      if (page < totalPages - 1) kb.text(nextLabel, `${navPrefix}:next:${page}`);
    }
    return kb;
  }
}

/** Parse a keyboard out of event content, or `null`. */
export function parseKeyboardContent(
  content: unknown,
  options?: { onWarn?: (warnings: string[]) => void },
): KeyboardContent | null {
  if (!isPlainObject(content)) return null;
  const raw = content[KEYBOARD_CONTENT_KEY];
  if (!isPlainObject(raw) || !Array.isArray(raw.inline)) return null;
  const versionInfo = checkSchemaVersion("keyboard", readSchemaVersion(raw));
  if (!versionInfo.supported) {
    options?.onWarn?.([
      `keyboard version ${versionInfo.version} newer than library support`,
    ]);
  }
  const inline: InlineButton[][] = [];
  for (const row of raw.inline) {
    if (!Array.isArray(row)) continue;
    const parsed: InlineButton[] = [];
    for (const button of row) {
      if (!isPlainObject(button)) continue;
      const text = readString(button, "text");
      if (!text) continue;
      const kind = readString(button, "kind");
      if (kind === "url") {
        const url = readString(button, "url");
        if (url) parsed.push({ kind: "url", text, url });
      } else if (kind === "mini_app") {
        const url = readString(button, "url");
        if (url) {
          const item: InlineButton = { kind: "mini_app", text, url };
          const startParam = readString(button, "startParam");
          if (startParam) item.startParam = startParam;
          parsed.push(item);
        }
      } else if (kind === "command") {
        const command = readString(button, "command");
        if (command) parsed.push({ kind: "command", text, command });
      } else {
        const data = readString(button, "data") ?? "";
        const item: InlineButton = { kind: "callback", text, data };
        const token = readString(button, "token");
        if (token) item.token = token;
        const fallback = readString(button, "fallback");
        if (fallback) item.fallback = fallback;
        parsed.push(item);
      }
    }
    if (parsed.length > 0) inline.push(parsed);
  }
  if (inline.length === 0) return null;
  return {
    version: typeof raw.version === "number" ? raw.version : KEYBOARD_SCHEMA_VERSION,
    inline,
    ...(readString(raw, "fallback_command")
      ? { fallback_command: readString(raw, "fallback_command") as string }
      : {}),
  };
}

export interface KeyboardFallback {
  text: string;
  html: string;
}

/**
 * Render a plain-text + HTML fallback so users on clients without keyboard
 * support can still act on the message.
 */
export function renderKeyboardFallback(keyboard: KeyboardContent): KeyboardFallback {
  const lines: string[] = [];
  const htmlItems: string[] = [];
  let index = 0;
  for (const row of keyboard.inline) {
    for (const button of row) {
      index += 1;
      switch (button.kind) {
        case "url":
          lines.push(`${index}. ${button.text} → ${button.url}`);
          htmlItems.push(`<li>${escapeHtml(button.text)}: ${renderUrl(button.url)}</li>`);
          break;
        case "mini_app":
          lines.push(`${index}. ${button.text} (mini app) → ${button.url}`);
          htmlItems.push(
            `<li>${escapeHtml(button.text)} <em>(mini app)</em>: ${renderUrl(button.url)}</li>`,
          );
          break;
        case "command":
          lines.push(`${index}. ${button.text} → ${button.command}`);
          htmlItems.push(
            `<li>${escapeHtml(button.text)}: <code>${escapeHtml(button.command)}</code></li>`,
          );
          break;
        default: {
          const id = button.fallback ?? button.token;
          const invoke = id ? `!${CALLBACK_FALLBACK_COMMAND} ${id}` : button.text;
          lines.push(`${index}. ${button.text} → ${invoke}`);
          htmlItems.push(
            `<li>${escapeHtml(button.text)}: <code>${escapeHtml(invoke)}</code></li>`,
          );
        }
      }
    }
  }
  return {
    text: lines.join("\n"),
    html: htmlItems.length > 0 ? `<ol>${htmlItems.join("")}</ol>` : "",
  };
}

/**
 * Link markup for a button URL, degrading to escaped text when the scheme is
 * not http(s) — keyboards parsed off the wire are untrusted input.
 */
function renderUrl(url: string): string {
  const safe = escapeHtml(url);
  return isSafeButtonUrl(url) ? `<a href="${safe}">${safe}</a>` : safe;
}

export interface CallbackTokenRecord {
  data: string;
  roomId: string;
  messageEventId: string;
  /** Restrict the button to a single user id, when set. */
  userId?: string;
  expiresAtMs: number;
  /** Already answered — used to reject replays of single-use buttons. */
  answered: boolean;
  /** Reject the token once it has been resolved. */
  singleUse: boolean;
}

export interface CallbackIssueParams {
  data: string;
  roomId: string;
  messageEventId?: string | null;
  userId?: string | null;
  ttlMs?: number;
  singleUse?: boolean;
}

/** Mint / resolve opaque or signed callback tokens. */
export interface CallbackTokenStore {
  issue(params: CallbackIssueParams): string;
  /**
   * Short id for plaintext `!cb` fallback. Defaults to `token` when omitted
   * (process-local opaque registries already issue short tokens).
   */
  fallbackOf?(token: string): string;
  bindMessage(tokens: readonly string[], messageEventId: string): void;
  bind(tokens: readonly string[], messageEventId: string): void;
  peek(token: string, now?: number): CallbackTokenRecord | null;
  resolve(token: string, userId?: string, now?: number): CallbackTokenRecord | null;
  /** Prefer this when an async used-token store is configured. */
  resolveAsync?(
    token: string,
    userId?: string,
    now?: number,
  ): Promise<CallbackTokenRecord | null>;
  markAnswered(token: string): void;
  revoke(token: string): void;
  revokeForMessage(messageEventId: string): void;
  readonly size: number;
  clear(): void;
}

export interface CallbackRegistryOptions {
  /** Tokens kept in memory before the oldest are evicted. */
  maxEntries?: number;
  /** How long a button stays pressable. */
  ttlMs?: number;
}

/**
 * Short-lived registry mapping opaque button tokens to callback payloads.
 *
 * Tokens (not the payload) travel through the fallback text command, so a user
 * cannot forge arbitrary callback data by typing `!cb …`. Process-local only —
 * use {@link SignedCallbackRegistry} when several bot processes share a secret.
 */
export class CallbackRegistry implements CallbackTokenStore {
  private readonly tokens = new Map<string, CallbackTokenRecord>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(options: CallbackRegistryOptions = {}) {
    this.capacity = Math.max(1, options.maxEntries ?? 4_096);
    this.ttlMs = Math.max(1, options.ttlMs ?? 24 * 60 * 60 * 1000);
  }

  /** Issue a token for a callback button. */
  issue(params: CallbackIssueParams): string {
    this.prune();
    // 16 bytes: tokens travel through the plain-text fallback, so they must not
    // be guessable by anyone who can read the room.
    const token = randomId(16);
    const record: CallbackTokenRecord = {
      data: params.data,
      roomId: params.roomId,
      messageEventId: params.messageEventId ?? "",
      expiresAtMs: Date.now() + (params.ttlMs ?? this.ttlMs),
      answered: false,
      singleUse: params.singleUse ?? false,
    };
    if (params.userId) record.userId = params.userId;
    this.tokens.set(token, record);
    return token;
  }

  /** Attach a message event id to tokens issued before the send completed. */
  bindMessage(tokens: readonly string[], messageEventId: string): void {
    for (const token of tokens) {
      const record = this.tokens.get(token);
      if (record) record.messageEventId = messageEventId;
    }
  }

  /** Alias of {@link CallbackRegistry.bindMessage}. */
  bind(tokens: readonly string[], messageEventId: string): void {
    this.bindMessage(tokens, messageEventId);
  }

  /** Read a record without consuming it. */
  peek(token: string, now = Date.now()): CallbackTokenRecord | null {
    const record = this.tokens.get(token);
    if (!record) return null;
    if (record.expiresAtMs <= now) {
      this.tokens.delete(token);
      return null;
    }
    return record;
  }

  resolve(token: string, userId?: string, now = Date.now()): CallbackTokenRecord | null {
    const record = this.peek(token, now);
    if (!record) return null;
    if (record.userId && userId && record.userId !== userId) return null;
    if (record.singleUse) this.tokens.delete(token);
    return record;
  }

  markAnswered(token: string): void {
    const record = this.tokens.get(token);
    if (record) record.answered = true;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  /** Drop every token issued for a message (e.g. after the keyboard is removed). */
  revokeForMessage(messageEventId: string): void {
    for (const [token, record] of this.tokens) {
      if (record.messageEventId === messageEventId) this.tokens.delete(token);
    }
  }

  get size(): number {
    return this.tokens.size;
  }

  /** Drop every token, e.g. on shutdown. */
  clear(): void {
    this.tokens.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, record] of this.tokens) {
      if (record.expiresAtMs <= now) this.tokens.delete(token);
    }
    while (this.tokens.size >= this.capacity) {
      const oldest = this.tokens.keys().next();
      if (oldest.done) break;
      this.tokens.delete(oldest.value);
    }
  }
}

interface SignedCallbackPayload {
  d: string;
  r: string;
  u?: string;
  e: number;
  s: boolean;
  n: string;
}

export interface SignedCallbackRegistryOptions {
  /** HMAC secret shared by every process that must resolve these tokens. */
  secret: string;
  ttlMs?: number;
  /**
   * Single-use consumption and revoke blacklist.
   * Share across instances (e.g. Redis) when `singleUse` must be global.
   */
  used?: UsedTokenStore;
  /**
   * Async single-use store for multi-instance claim. When set, prefer
   * {@link SignedCallbackRegistry.resolveAsync}.
   */
  asyncUsed?: AsyncUsedTokenStore;
  /**
   * Short `!cb` alias → signed token map. Defaults to process memory.
   * Bot.create wires a file-backed map under `storagePath` so aliases survive
   * restart; multi-instance bots should inject a shared Redis map.
   */
  aliasStore?: TtlStringMap;
  /**
   * Optional durable `token → messageEventId` map so `answerCallback({ editText })`
   * still finds the source message after a restart.
   */
  bindStore?: TtlStringMap;
}

/**
 * HMAC-signed callback tokens. Any process with the same secret can verify the
 * full token; short `!cb` aliases need a shared {@link TtlStringMap} (file or Redis).
 * Without {@link SignedCallbackRegistryOptions.bindStore}, message-id bindings
 * stay process-local.
 */
export class SignedCallbackRegistry implements CallbackTokenStore {
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly used: UsedTokenStore;
  private readonly asyncUsed: AsyncUsedTokenStore | null;
  private readonly aliasStore: TtlStringMap;
  private readonly bindStore: TtlStringMap | null;
  /** Local message-id bindings and answered flags keyed by full token. */
  private readonly side = new Map<string, { messageEventId: string; answered: boolean }>();
  private readonly byMessage = new Map<string, Set<string>>();
  /** Hot cache: short `!cb` aliases → signed token. */
  private readonly aliases = new Map<string, string>();
  private readonly aliasOf = new Map<string, string>();

  constructor(options: SignedCallbackRegistryOptions) {
    if (!options.secret || options.secret.length < 16) {
      throw new TypeError("SignedCallbackRegistry requires a secret of at least 16 characters");
    }
    this.secret = options.secret;
    this.ttlMs = Math.max(1, options.ttlMs ?? 24 * 60 * 60 * 1000);
    this.used = options.used ?? new MemoryUsedTokenStore();
    this.asyncUsed = options.asyncUsed ?? null;
    this.aliasStore = options.aliasStore ?? new MemoryTtlStringMap();
    this.bindStore = options.bindStore ?? null;
  }

  issue(params: CallbackIssueParams): string {
    const ttl = params.ttlMs ?? this.ttlMs;
    // `n` doubles as the short `!cb` alias so stock timelines stay readable.
    const alias = randomId(8);
    const payload: SignedCallbackPayload = {
      d: params.data,
      r: params.roomId,
      e: Date.now() + ttl,
      s: params.singleUse ?? false,
      n: alias,
    };
    if (params.userId) payload.u = params.userId;
    const token = signCallbackToken(payload, this.secret);
    this.rememberAlias(alias, token, ttl);
    const messageEventId = params.messageEventId ?? "";
    this.side.set(token, { messageEventId, answered: false });
    if (messageEventId) {
      this.trackMessage(token, messageEventId);
      this.bindStore?.set(bindKey(token), messageEventId, ttl);
    }
    return token;
  }

  fallbackOf(token: string): string {
    return this.aliasOf.get(token) ?? this.aliasStore.get(aliasOfKey(token)) ?? token;
  }

  /** Resolve a short fallback alias or a full signed token to the signed form. */
  private canonicalize(token: string): string {
    if (this.aliases.has(token)) return this.aliases.get(token)!;
    const fromStore = this.aliasStore.get(aliasKey(token));
    if (fromStore) {
      this.aliases.set(token, fromStore);
      this.aliasOf.set(fromStore, token);
      return fromStore;
    }
    return token;
  }

  /**
   * Like {@link canonicalize}, but awaits {@link TtlStringMap.getAsync} on miss
   * so Redis-backed aliases resolve correctly across hosts.
   */
  private async canonicalizeAsync(token: string): Promise<string> {
    const sync = this.canonicalize(token);
    if (sync !== token || this.aliases.has(token)) return sync;
    const getAsync = this.aliasStore.getAsync?.bind(this.aliasStore);
    if (!getAsync) return token;
    const fromStore = await getAsync(aliasKey(token));
    if (fromStore) {
      this.aliases.set(token, fromStore);
      this.aliasOf.set(fromStore, token);
      return fromStore;
    }
    return token;
  }

  private rememberAlias(alias: string, token: string, ttlMs: number): void {
    this.aliases.set(alias, token);
    this.aliasOf.set(token, alias);
    this.aliasStore.set(aliasKey(alias), token, ttlMs);
    this.aliasStore.set(aliasOfKey(token), alias, ttlMs);
  }

  bindMessage(tokens: readonly string[], messageEventId: string): void {
    for (const token of tokens) {
      const local = this.side.get(token) ?? { messageEventId: "", answered: false };
      local.messageEventId = messageEventId;
      this.side.set(token, local);
      this.trackMessage(token, messageEventId);
      const ttl = Math.max(1, (this.peek(token)?.expiresAtMs ?? Date.now() + this.ttlMs) - Date.now());
      this.bindStore?.set(bindKey(token), messageEventId, ttl);
    }
  }

  bind(tokens: readonly string[], messageEventId: string): void {
    this.bindMessage(tokens, messageEventId);
  }

  peek(token: string, now = Date.now()): CallbackTokenRecord | null {
    const signed = this.canonicalize(token);
    if (this.used.has(deadKey(signed))) return null;
    const payload = verifyCallbackToken(signed, this.secret);
    if (!payload) return null;
    if (payload.e <= now) return null;
    const local = this.side.get(signed);
    const bound = local?.messageEventId || this.bindStore?.get(bindKey(signed)) || "";
    const record: CallbackTokenRecord = {
      data: payload.d,
      roomId: payload.r,
      messageEventId: bound,
      expiresAtMs: payload.e,
      answered: local?.answered ?? this.used.has(answeredKey(signed)),
      singleUse: payload.s,
    };
    if (payload.u) record.userId = payload.u;
    return record;
  }

  resolve(token: string, userId?: string, now = Date.now()): CallbackTokenRecord | null {
    if (this.asyncUsed) {
      throw new TypeError(
        "SignedCallbackRegistry has asyncUsed configured; call resolveAsync()",
      );
    }
    const signed = this.canonicalize(token);
    const record = this.peek(signed, now);
    if (!record) return null;
    if (record.userId && userId && record.userId !== userId) return null;
    if (record.singleUse) {
      const ttl = Math.max(1, record.expiresAtMs - now);
      if (this.used.tryAdd) {
        if (!this.used.tryAdd(deadKey(signed), ttl)) return null;
      } else {
        this.used.add(deadKey(signed), ttl);
      }
    }
    return record;
  }

  async resolveAsync(
    token: string,
    userId?: string,
    now = Date.now(),
  ): Promise<CallbackTokenRecord | null> {
    const signed = await this.canonicalizeAsync(token);
    // peek() re-canonicalizes sync-only; pass the already-resolved signed token.
    const record = this.peek(signed, now);
    if (!record) return null;
    if (record.userId && userId && record.userId !== userId) return null;
    if (record.singleUse) {
      const ttl = Math.max(1, record.expiresAtMs - now);
      if (this.asyncUsed) {
        if (!(await this.asyncUsed.tryAdd(deadKey(signed), ttl))) return null;
      } else if (this.used.tryAdd) {
        if (!this.used.tryAdd(deadKey(signed), ttl)) return null;
      } else {
        this.used.add(deadKey(signed), ttl);
      }
    }
    return record;
  }

  markAnswered(token: string): void {
    const signed = this.canonicalize(token);
    const local = this.side.get(signed) ?? { messageEventId: "", answered: false };
    local.answered = true;
    this.side.set(signed, local);
    const record = this.peek(signed);
    const ttl = record ? Math.max(1, record.expiresAtMs - Date.now()) : this.ttlMs;
    this.used.add(answeredKey(signed), ttl);
  }

  revoke(token: string): void {
    const signed = this.canonicalize(token);
    this.used.add(deadKey(signed), this.ttlMs);
    const local = this.side.get(signed);
    if (local?.messageEventId) {
      this.byMessage.get(local.messageEventId)?.delete(signed);
    }
    this.side.delete(signed);
    this.bindStore?.delete(bindKey(signed));
    const alias = this.aliasOf.get(signed) ?? this.aliasStore.get(aliasOfKey(signed));
    if (alias) {
      this.aliases.delete(alias);
      this.aliasOf.delete(signed);
      this.aliasStore.delete(aliasKey(alias));
      this.aliasStore.delete(aliasOfKey(signed));
    }
  }

  revokeForMessage(messageEventId: string): void {
    const tokens = this.byMessage.get(messageEventId);
    if (!tokens) return;
    for (const token of [...tokens]) this.revoke(token);
    this.byMessage.delete(messageEventId);
  }

  get size(): number {
    return this.side.size;
  }

  clear(): void {
    this.side.clear();
    this.byMessage.clear();
    this.aliases.clear();
    this.aliasOf.clear();
  }

  private trackMessage(token: string, messageEventId: string): void {
    let set = this.byMessage.get(messageEventId);
    if (!set) {
      set = new Set();
      this.byMessage.set(messageEventId, set);
    }
    set.add(token);
  }
}

function deadKey(token: string): string {
  return `cb:dead:${token}`;
}

function answeredKey(token: string): string {
  return `cb:ans:${token}`;
}

function aliasKey(alias: string): string {
  return `cb:alias:${alias}`;
}

function aliasOfKey(token: string): string {
  return `cb:aliasof:${token}`;
}

function bindKey(token: string): string {
  return `cb:bind:${token}`;
}

/**
 * Content for a client → bot button press (`dev.aiomatrix.callback`).
 * Aware hosts should send this instead of inventing ad-hoc shapes.
 */
export function buildCallbackContent(
  token: string,
  options?: { data?: string },
): Record<string, unknown> {
  const content: Record<string, unknown> = { token };
  if (options?.data !== undefined) content.data = options.data;
  return content;
}

function signCallbackToken(payload: SignedCallbackPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

function verifyCallbackToken(token: string, secret: string): SignedCallbackPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!timingSafeEqualStrings(mac, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (typeof parsed.d !== "string" || typeof parsed.r !== "string") return null;
    if (typeof parsed.e !== "number" || typeof parsed.s !== "boolean") return null;
    if (typeof parsed.n !== "string") return null;
    const out: SignedCallbackPayload = {
      d: parsed.d,
      r: parsed.r,
      e: parsed.e,
      s: parsed.s,
      n: parsed.n,
    };
    if (typeof parsed.u === "string") out.u = parsed.u;
    return out;
  } catch {
    return null;
  }
}
