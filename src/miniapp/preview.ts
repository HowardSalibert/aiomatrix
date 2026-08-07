import { KEYBOARD_CONTENT_KEY, parseKeyboardContent } from "../keyboards.js";
import { isPlainObject, readString } from "../util.js";
import {
  MINI_APP_CONTENT_KEY,
  MINI_APP_DATA_HIDDEN_BODY,
  MINI_APP_DATA_KEY,
  MINI_APP_DATA_MSGTYPE,
  MINI_APP_MSGTYPE_STUDNOVSU,
  parseMiniAppDataContent,
  parseMiniAppJson,
} from "./events.js";
import { formatMiniAppDataPreview } from "./payloads.js";

export { MINI_APP_DATA_HIDDEN_BODY };

export type AiomatrixContentKind = "keyboard" | "mini_app" | "mini_app_data";

export interface NormalizedAiomatrixContent {
  kind: AiomatrixContentKind;
  /** Room-list / notification line. */
  preview: string;
  /** Author-facing body with legacy `!cb` / dumps stripped when possible. */
  body: string;
  formattedBody?: string;
  keyboard?: unknown;
  miniApp?: unknown;
  miniAppData?: unknown;
}

/** Classify aiomatrix-shaped message content, or `null` for ordinary Matrix events. */
export function classifyAiomatrixContent(content: unknown): AiomatrixContentKind | null {
  if (!isPlainObject(content)) return null;
  if (isPlainObject(content[MINI_APP_DATA_KEY]) || content.msgtype === MINI_APP_DATA_MSGTYPE) {
    return "mini_app_data";
  }
  if (isPlainObject(content[MINI_APP_CONTENT_KEY]) || content.msgtype === MINI_APP_MSGTYPE_STUDNOVSU) {
    return "mini_app";
  }
  if (content[KEYBOARD_CONTENT_KEY] != null) return "keyboard";
  return null;
}

/**
 * Unified preview for timeline / room list / notifications.
 *
 * Returns `null` when the content is not an aiomatrix-shaped event — callers
 * should fall back to their normal `content.body` handling. For aiomatrix
 * events, prefer this over raw `body` (which may be legacy JSON or `!cb` dumps).
 */
export function formatMessagePreview(content: unknown): string | null {
  if (!isPlainObject(content)) return null;

  if (isPlainObject(content[MINI_APP_DATA_KEY]) || content.msgtype === MINI_APP_DATA_MSGTYPE) {
    const parsed = parseMiniAppDataContent(content);
    const data = parsed?.data ?? "";
    const body = readString(content, "body") ?? "";
    if (body === MINI_APP_DATA_HIDDEN_BODY || body === "") {
      return formatMiniAppDataPreview(data);
    }
    if (data && (body === data || looksLikeJson(body))) {
      return formatMiniAppDataPreview(data);
    }
    const cleaned = stripKeyboardFallbackText(body).trim();
    return cleaned || formatMiniAppDataPreview(data);
  }

  const card = content[MINI_APP_CONTENT_KEY];
  if (isPlainObject(card) || content.msgtype === MINI_APP_MSGTYPE_STUDNOVSU) {
    const title =
      (isPlainObject(card) ? readString(card, "title") : null) ??
      readString(content, "title") ??
      "Mini app";
    const description =
      (isPlainObject(card) ? readString(card, "description") : null) ??
      readString(content, "description");
    return description ? `${title}: ${description}` : title;
  }

  if (content[KEYBOARD_CONTENT_KEY] != null) {
    const body = readString(content, "body");
    const html = readString(content, "formatted_body");
    if (body != null) {
      const cleaned = stripKeyboardFallbackText(body).trim();
      if (cleaned) return cleaned;
    }
    if (html) {
      const cleanedHtml = stripKeyboardFallbackHtml(html).trim();
      if (cleanedHtml) return htmlToRoughPlain(cleanedHtml);
    }
    return null;
  }

  return null;
}

/**
 * One-shot receive helper for aware hosts: kind + preview + cleaned bodies +
 * structured fields. Returns `null` for ordinary Matrix messages.
 */
export function normalizeAiomatrixContent(
  content: unknown,
  options?: { onWarn?: (warnings: string[]) => void },
): NormalizedAiomatrixContent | null {
  const kind = classifyAiomatrixContent(content);
  if (!kind || !isPlainObject(content)) return null;
  const preview = formatMessagePreview(content) ?? "";
  const rawBody = readString(content, "body") ?? "";
  const rawHtml = readString(content, "formatted_body");
  let body = rawBody;
  let formattedBody = rawHtml;
  if (kind === "keyboard" || kind === "mini_app") {
    body = stripKeyboardFallbackText(rawBody);
    if (rawHtml) formattedBody = stripKeyboardFallbackHtml(rawHtml);
  }
  if (kind === "mini_app_data" && (rawBody === MINI_APP_DATA_HIDDEN_BODY || looksLikeJson(rawBody))) {
    body = preview;
  }
  const out: NormalizedAiomatrixContent = { kind, preview, body };
  if (formattedBody) out.formattedBody = formattedBody;
  if (content[KEYBOARD_CONTENT_KEY] != null) {
    out.keyboard =
      parseKeyboardContent(content, { onWarn: options?.onWarn }) ?? content[KEYBOARD_CONTENT_KEY];
  }
  if (content[MINI_APP_CONTENT_KEY] != null) out.miniApp = content[MINI_APP_CONTENT_KEY];
  if (content[MINI_APP_DATA_KEY] != null) out.miniAppData = content[MINI_APP_DATA_KEY];
  return out;
}

/**
 * Strip numbered `!cb …` / legacy keyboard fallback lines from a message body
 * so aware hosts can show the author text without token dumps.
 */
export function stripKeyboardFallbackText(body: string): string {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  const numbered = /^\s*\d+\.\s+.+\s*(→|->)\s*!cb\s+\S+\s*$/i;
  const bareCb = /^\s*[!/]cb\s+\S+\s*$/i;
  let inFallback = false;
  for (const line of lines) {
    if (numbered.test(line) || bareCb.test(line)) {
      inFallback = true;
      continue;
    }
    if (inFallback && line.trim() === "") continue;
    if (inFallback && /^\s*\d+\.\s+/.test(line)) continue;
    inFallback = false;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  return kept.join("\n");
}

/** Remove trailing `<ol>…</ol>` keyboard dumps from `formatted_body`. */
export function stripKeyboardFallbackHtml(html: string): string {
  return html.replace(/<ol\b[^>]*>[\s\S]*?<\/ol>/gi, "").trim();
}

function htmlToRoughPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  return parseMiniAppJson(trimmed) != null;
}
