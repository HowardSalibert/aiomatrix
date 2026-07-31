import { escapeHtml, isPlainObject, randomId, readString } from "./util.js";

/** Content field carrying a aiomatrix inline keyboard. */
export const KEYBOARD_CONTENT_KEY = "dev.aiomatrix.keyboard";
/** Room event type sent by a client when an inline button is pressed. */
export const CALLBACK_EVENT_TYPE = "dev.aiomatrix.callback";
/** Text-command fallback so keyboards work in clients with no button support. */
export const CALLBACK_FALLBACK_COMMAND = "cb";
export const KEYBOARD_SCHEMA_VERSION = 1;

export type InlineButton =
  | { kind: "callback"; text: string; data: string; token?: string; style?: ButtonStyle }
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
}

/** Parse a keyboard out of event content, or `null`. */
export function parseKeyboardContent(content: unknown): KeyboardContent | null {
  if (!isPlainObject(content)) return null;
  const raw = content[KEYBOARD_CONTENT_KEY];
  if (!isPlainObject(raw) || !Array.isArray(raw.inline)) return null;
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
          const invoke = button.token
            ? `!${CALLBACK_FALLBACK_COMMAND} ${button.token}`
            : button.text;
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
 * cannot forge arbitrary callback data by typing `!cb …`.
 */
export class CallbackRegistry {
  private readonly tokens = new Map<string, CallbackTokenRecord>();
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(options: CallbackRegistryOptions = {}) {
    this.capacity = Math.max(1, options.maxEntries ?? 4_096);
    this.ttlMs = Math.max(1, options.ttlMs ?? 24 * 60 * 60 * 1000);
  }

  /** Issue a token for a callback button. */
  issue(params: {
    data: string;
    roomId: string;
    messageEventId?: string | null;
    userId?: string | null;
    ttlMs?: number;
    singleUse?: boolean;
  }): string {
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
