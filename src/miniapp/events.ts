import { MiniAppAuthError } from "../errors.js";
import {
  InlineKeyboard,
  KEYBOARD_CONTENT_KEY,
  isSafeButtonUrl,
  renderKeyboardFallback,
} from "../keyboards.js";
import { escapeHtml, isPlainObject, readString } from "../util.js";
import {
  formatMiniAppDataPreview,
  type MiniAppDataHumanizer,
} from "./payloads.js";

/** Canonical content field describing a MiniApp launch card. */
export const MINI_APP_CONTENT_KEY = "dev.aiomatrix.mini_app";
/** msgtype used by the StudNovSU client. Kept for interoperability. */
export const MINI_APP_MSGTYPE_STUDNOVSU = "ru.studnovsu.mini_app";
/** msgtype for data sent back by a mini app. */
export const MINI_APP_DATA_MSGTYPE = "dev.aiomatrix.mini_app_data";
/** Content field / to-device event type for mini app → bot data. */
export const MINI_APP_DATA_KEY = "dev.aiomatrix.mini_app_data";
export const MINI_APP_SCHEMA_VERSION = 1;
/** Body placeholder when {@link buildMiniAppDataContent} hides from stock clients. */
export const MINI_APP_DATA_HIDDEN_BODY = "\u200b";

export interface MiniAppCardOptions {
  /** URL of the mini app. Must be https (or http on localhost). */
  url: string;
  /**
   * URL shown in the plain-text body when {@link includePlainLink} is on.
   * Defaults to `url` with the hash stripped (signed `#matrixWebAppData=…`
   * stays only in {@link MINI_APP_CONTENT_KEY}).
   */
  displayUrl?: string;
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
  /**
   * Put a short plain link in body/HTML. Default true. The link uses
   * {@link displayUrl} (hash-stripped) so signed launch blobs never dump into
   * the timeline.
   */
  includePlainLink?: boolean;
  /**
   * Attach a `mini_app` keyboard row (plus any extra `keyboard` rows).
   * Default true.
   */
  includeLaunchKeyboard?: boolean;
  /**
   * Append `!cb` / `<ol>` keyboard fallback. Default false — aware clients
   * read `dev.aiomatrix.keyboard`; stock clients use the plain link.
   */
  includeKeyboardFallback?: boolean;
  /**
   * Mirror the launch URL onto top-level `content.url`. Default false — that
   * field means `mxc://` media in Matrix. Forced true when `studnovsuCompat`.
   */
  topLevelUrl?: boolean;
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

/** Strip `#fragment` so stock clients get a readable https link. */
export function displayUrlForMiniApp(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const hash = url.indexOf("#");
    return hash >= 0 ? url.slice(0, hash) : url;
  }
}

/**
 * Build the `m.room.message` content for a MiniApp launch card.
 *
 * Layers:
 * 1. `dev.aiomatrix.mini_app` — full launch URL (may include signed hash);
 * 2. optional structured keyboard for aware clients;
 * 3. lean body (title + description [+ short plain link]) for stock clients.
 *
 * Top-level `content.url` is omitted by default so hosts do not treat the
 * card as encrypted media (`mxc://` convention).
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
  const includePlainLink = options.includePlainLink !== false;
  const includeLaunchKeyboard = options.includeLaunchKeyboard !== false;
  const includeKeyboardFallback = options.includeKeyboardFallback === true;
  const topLevelUrl = options.topLevelUrl === true || options.studnovsuCompat === true;
  const displayUrl = options.displayUrl ?? displayUrlForMiniApp(options.url);

  const card: MiniAppCard = { version: MINI_APP_SCHEMA_VERSION, url: options.url };
  if (options.title) card.title = options.title;
  if (options.description) card.description = options.description;
  if (options.buttonText) card.button_text = options.buttonText;
  if (options.appId) card.app_id = options.appId;
  if (options.botId) card.bot_id = options.botId;
  if (options.startParam) card.start_param = options.startParam;
  if (options.display) card.display = options.display;

  const bodyLines = [title];
  if (options.description) bodyLines.push(options.description);
  if (includePlainLink) bodyLines.push(`${buttonText}: ${displayUrl}`);

  const htmlParts = [
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    options.description ? `<p>${escapeHtml(options.description)}</p>` : "",
  ];
  if (includePlainLink) {
    htmlParts.push(
      `<p><a href="${escapeHtml(displayUrl)}">${escapeHtml(buttonText)}</a></p>`,
    );
  }

  const content: Record<string, unknown> = {
    msgtype: options.studnovsuCompat
      ? MINI_APP_MSGTYPE_STUDNOVSU
      : options.notice
        ? "m.notice"
        : "m.text",
    body: options.body ?? bodyLines.join("\n"),
    format: "org.matrix.custom.html",
    formatted_body: htmlParts.filter(Boolean).join(""),
    title,
    [MINI_APP_CONTENT_KEY]: card,
  };

  if (topLevelUrl) content.url = options.url;
  if (options.botId) content.bot_id = options.botId;

  if (includeLaunchKeyboard || options.keyboard) {
    const extra = options.keyboard?.buttons ?? [];
    const rows = includeLaunchKeyboard
      ? [
          [
            options.startParam
              ? {
                  kind: "mini_app" as const,
                  text: buttonText,
                  url: options.url,
                  startParam: options.startParam,
                }
              : { kind: "mini_app" as const, text: buttonText, url: options.url },
          ],
          ...extra,
        ]
      : [...extra];
    if (rows.length > 0) {
      const withLaunch = InlineKeyboard.from(rows);
      const keyboardContent = withLaunch.toContent();
      content[KEYBOARD_CONTENT_KEY] = keyboardContent;
      if (includeKeyboardFallback) {
        const fallback = renderKeyboardFallback(keyboardContent);
        if (fallback.text) {
          content.body = `${content.body}\n\n${fallback.text}`;
        }
        if (fallback.html) {
          content.formatted_body = `${content.formatted_body}${fallback.html}`;
        }
      }
    }
  }

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

export interface MiniAppDataContentOptions extends MiniAppDataPayload {
  /**
   * Explicit human body. Takes precedence over {@link summary} / {@link formatBody}.
   * Raw JSON must stay in {@link MINI_APP_DATA_KEY}.data — never put it here by default.
   */
  body?: string;
  /** Alias for {@link body}. */
  summary?: string;
  /** Build a human body from raw + parsed JSON. */
  formatBody?: MiniAppDataHumanizer;
  /**
   * Use a zero-width body so Element / Schildi do not surface the event as
   * ordinary chat text. Aware clients still read {@link MINI_APP_DATA_KEY}.
   * Default false.
   */
  hideFromStockClients?: boolean;
  /**
   * Override msgtype (default {@link MINI_APP_DATA_MSGTYPE}). Useful when a
   * host wants a private / ignored type for stock clients.
   */
  msgtype?: string;
}

/**
 * Build the content a client sends when a mini app calls `sendData`.
 *
 * `dev.aiomatrix.mini_app_data.data` always holds the raw string; `body` is a
 * short human summary unless {@link MiniAppDataContentOptions.hideFromStockClients}
 * is set.
 */
export function buildMiniAppDataContent(
  payload: MiniAppDataPayload | MiniAppDataContentOptions,
): Record<string, unknown> {
  const opts = payload as MiniAppDataContentOptions;
  const hide = opts.hideFromStockClients === true;
  let body: string;
  if (hide) {
    body = MINI_APP_DATA_HIDDEN_BODY;
  } else if (opts.body != null) {
    body = opts.body;
  } else if (opts.summary != null) {
    body = opts.summary;
  } else if (opts.formatBody) {
    const parsed = parseMiniAppJson(opts.data);
    body = opts.formatBody(opts.data, parsed) ?? formatMiniAppDataPreview(opts.data);
  } else {
    body = formatMiniAppDataPreview(opts.data);
  }

  return {
    msgtype: opts.msgtype ?? MINI_APP_DATA_MSGTYPE,
    body,
    [MINI_APP_DATA_KEY]: {
      version: MINI_APP_SCHEMA_VERSION,
      data: opts.data,
      ...(opts.queryId ? { query_id: opts.queryId } : {}),
      ...(opts.appId ? { app_id: opts.appId } : {}),
      ...(opts.messageId ? { message_id: opts.messageId } : {}),
      ...(hide ? { hidden: true } : {}),
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
