import { MiniAppAuthError } from "../errors.js";
import { InlineKeyboard, KEYBOARD_CONTENT_KEY, isSafeButtonUrl } from "../keyboards.js";
import { escapeHtml, isPlainObject, readString } from "../util.js";

/** Canonical content field describing a MiniApp launch card. */
export const MINI_APP_CONTENT_KEY = "m.matrixbots.mini_app";
/** msgtype used by the StudNovSU client. Kept for interoperability. */
export const MINI_APP_MSGTYPE_STUDNOVSU = "ru.studnovsu.mini_app";
/** msgtype for data sent back by a mini app. */
export const MINI_APP_DATA_MSGTYPE = "m.matrixbots.mini_app_data";
/** Content field / to-device event type for mini app → bot data. */
export const MINI_APP_DATA_KEY = "m.matrixbots.mini_app_data";
export const MINI_APP_SCHEMA_VERSION = 1;

export interface MiniAppCardOptions {
  /** URL of the mini app. Must be https (or http on localhost). */
  url: string;
  title?: string;
  /** Plain-text body shown by clients without mini app support. */
  body?: string;
  description?: string;
  /** Label of the launch button. Default `Open`. */
  buttonText?: string;
  /** Bot application id, when the host resolves allowlists by app. */
  botId?: string;
  /** Stable identifier of the mini app (routing key for `mini_app_data`). */
  appId?: string;
  /** Deep-link parameter handed to the mini app on launch. */
  startParam?: string;
  /** Suggested presentation. */
  display?: "sheet" | "fullscreen" | "inline";
  /** Extra inline keyboard rendered under the card. */
  keyboard?: InlineKeyboard;
  /**
   * Use the StudNovSU msgtype (`ru.studnovsu.mini_app`) so existing clients
   * recognise the card. Default false → `m.text` with the canonical field, which
   * degrades gracefully everywhere.
   */
  studnovsuCompat?: boolean;
  /** Send as a notice instead of a text message. */
  notice?: boolean;
}

export interface MiniAppCard {
  version: number;
  url: string;
  title?: string;
  description?: string;
  button_text?: string;
  app_id?: string;
  bot_id?: string;
  start_param?: string;
  display?: "sheet" | "fullscreen" | "inline";
}

/**
 * Build the `m.room.message` content for a MiniApp launch card.
 *
 * The result carries three layers so it works everywhere:
 * 1. `m.matrixbots.mini_app` — canonical descriptor for matrixbots-aware hosts;
 * 2. top-level `url`/`title` plus the StudNovSU msgtype when requested;
 * 3. a plain-text/HTML body with the link, so stock clients stay usable.
 */
export function buildMiniAppContent(options: MiniAppCardOptions): Record<string, unknown> {
  // The URL is rendered as a link in the HTML fallback, so refuse anything but
  // TLS (or loopback for local development) before it reaches a client.
  if (!isSafeButtonUrl(options.url, true)) {
    throw new MiniAppAuthError(
      `MiniApp URL must be https (or http on localhost): ${options.url}`,
      "malformed",
    );
  }
  const title = options.title ?? "Mini app";
  const buttonText = options.buttonText ?? "Open";
  const card: MiniAppCard = { version: MINI_APP_SCHEMA_VERSION, url: options.url };
  if (options.title) card.title = options.title;
  if (options.description) card.description = options.description;
  if (options.buttonText) card.button_text = options.buttonText;
  if (options.appId) card.app_id = options.appId;
  if (options.botId) card.bot_id = options.botId;
  if (options.startParam) card.start_param = options.startParam;
  if (options.display) card.display = options.display;

  const keyboard = options.keyboard ?? new InlineKeyboard();
  const withLaunch = InlineKeyboard.from([
    [
      options.startParam
        ? { kind: "mini_app", text: buttonText, url: options.url, startParam: options.startParam }
        : { kind: "mini_app", text: buttonText, url: options.url },
    ],
    ...keyboard.buttons,
  ]);

  const bodyLines = [title];
  if (options.description) bodyLines.push(options.description);
  bodyLines.push(`${buttonText}: ${options.url}`);

  const content: Record<string, unknown> = {
    msgtype: options.studnovsuCompat
      ? MINI_APP_MSGTYPE_STUDNOVSU
      : options.notice
        ? "m.notice"
        : "m.text",
    body: options.body ?? bodyLines.join("\n"),
    format: "org.matrix.custom.html",
    formatted_body: [
      `<p><strong>${escapeHtml(title)}</strong></p>`,
      options.description ? `<p>${escapeHtml(options.description)}</p>` : "",
      `<p><a href="${escapeHtml(options.url)}">${escapeHtml(buttonText)}</a></p>`,
    ]
      .filter(Boolean)
      .join(""),
    // Top-level fields mirror the StudNovSU schema.
    url: options.url,
    title,
    [MINI_APP_CONTENT_KEY]: card,
    [KEYBOARD_CONTENT_KEY]: withLaunch.toContent(),
  };
  if (options.botId) content.bot_id = options.botId;
  return content;
}

/** Parse a MiniApp card from message content, or `null`. */
export function parseMiniAppContent(content: unknown): MiniAppCard | null {
  if (!isPlainObject(content)) return null;
  const canonical = content[MINI_APP_CONTENT_KEY];
  if (isPlainObject(canonical)) {
    const url = readString(canonical, "url");
    if (url) {
      const card: MiniAppCard = {
        version: typeof canonical.version === "number" ? canonical.version : MINI_APP_SCHEMA_VERSION,
        url,
      };
      const title = readString(canonical, "title");
      if (title) card.title = title;
      const description = readString(canonical, "description");
      if (description) card.description = description;
      const buttonText = readString(canonical, "button_text");
      if (buttonText) card.button_text = buttonText;
      const appId = readString(canonical, "app_id");
      if (appId) card.app_id = appId;
      const botId = readString(canonical, "bot_id");
      if (botId) card.bot_id = botId;
      const startParam = readString(canonical, "start_param");
      if (startParam) card.start_param = startParam;
      return card;
    }
  }
  // StudNovSU-shaped card.
  if (content.msgtype === MINI_APP_MSGTYPE_STUDNOVSU) {
    const url = readString(content, "url");
    if (!url) return null;
    const card: MiniAppCard = { version: MINI_APP_SCHEMA_VERSION, url };
    const title = readString(content, "title");
    if (title) card.title = title;
    const botId = readString(content, "bot_id");
    if (botId) card.bot_id = botId;
    return card;
  }
  return null;
}

export interface MiniAppDataPayload {
  /** Raw string as sent by `WebApp.sendData`. */
  data: string;
  queryId: string | null;
  appId: string | null;
  /** Event id of the card the mini app was launched from. */
  messageId: string | null;
}

/** Build the content a client sends when a mini app calls `sendData`. */
export function buildMiniAppDataContent(payload: MiniAppDataPayload): Record<string, unknown> {
  return {
    msgtype: MINI_APP_DATA_MSGTYPE,
    body: payload.data,
    [MINI_APP_DATA_KEY]: {
      version: MINI_APP_SCHEMA_VERSION,
      data: payload.data,
      ...(payload.queryId ? { query_id: payload.queryId } : {}),
      ...(payload.appId ? { app_id: payload.appId } : {}),
      ...(payload.messageId ? { message_id: payload.messageId } : {}),
    },
  };
}

/** Parse mini app → bot data out of message or to-device content. */
export function parseMiniAppDataContent(content: unknown): MiniAppDataPayload | null {
  if (!isPlainObject(content)) return null;
  const block = content[MINI_APP_DATA_KEY];
  if (isPlainObject(block)) {
    const data = readString(block, "data") ?? readString(content, "body") ?? "";
    return {
      data,
      queryId: readString(block, "query_id") ?? null,
      appId: readString(block, "app_id") ?? null,
      messageId: readString(block, "message_id") ?? null,
    };
  }
  if (content.msgtype === MINI_APP_DATA_MSGTYPE) {
    return {
      data: readString(content, "body") ?? "",
      queryId: readString(content, "query_id") ?? null,
      appId: readString(content, "app_id") ?? null,
      messageId: null,
    };
  }
  return null;
}

/** Try to JSON-parse mini app data, returning `null` when it is not JSON. */
export function parseMiniAppJson(data: string): unknown {
  const trimmed = data.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}
