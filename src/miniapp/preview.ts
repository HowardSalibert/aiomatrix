import { KEYBOARD_CONTENT_KEY } from "../keyboards.js";
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
    if (body == null) return null;
    const cleaned = stripKeyboardFallbackText(body).trim();
    return cleaned || null;
  }

  return null;
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

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  return parseMiniAppJson(trimmed) != null;
}
