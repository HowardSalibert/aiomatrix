import { isPlainObject, readString } from "../util.js";

/**
 * Common MiniApp `sendData` actions. Bots may use other strings; these are the
 * ones {@link formatMiniAppDataPreview} and {@link parseMiniAppPayload} know.
 */
export const MINI_APP_KNOWN_ACTIONS = [
  "publish",
  "submit",
  "rsvp",
  "cancel",
  "select",
  "share",
  "close",
] as const;

export type MiniAppKnownAction = (typeof MINI_APP_KNOWN_ACTIONS)[number];

/** Shared envelope for typed MiniApp JSON payloads. */
export interface MiniAppPayloadBase {
  action: string;
  version?: number;
}

export interface MiniAppPublishPayload extends MiniAppPayloadBase {
  action: "publish";
  title?: string;
  text?: string;
  id?: string;
}

export interface MiniAppSubmitPayload extends MiniAppPayloadBase {
  action: "submit";
  formId?: string;
  items?: unknown[];
  values?: Record<string, unknown>;
}

export interface MiniAppRsvpPayload extends MiniAppPayloadBase {
  action: "rsvp";
  status?: "yes" | "no" | "maybe" | string;
  eventId?: string;
}

export interface MiniAppCancelPayload extends MiniAppPayloadBase {
  action: "cancel";
  reason?: string;
  id?: string;
}

export interface MiniAppSelectPayload extends MiniAppPayloadBase {
  action: "select";
  id?: string;
  value?: string | number | boolean;
  label?: string;
}

export interface MiniAppSharePayload extends MiniAppPayloadBase {
  action: "share";
  url?: string;
  title?: string;
}

export interface MiniAppClosePayload extends MiniAppPayloadBase {
  action: "close";
}

export type MiniAppTypedPayload =
  | MiniAppPublishPayload
  | MiniAppSubmitPayload
  | MiniAppRsvpPayload
  | MiniAppCancelPayload
  | MiniAppSelectPayload
  | MiniAppSharePayload
  | MiniAppClosePayload
  | (MiniAppPayloadBase & Record<string, unknown>);

const ACTION_LABELS: Record<string, string> = {
  publish: "Published",
  submit: "Submitted",
  rsvp: "RSVP",
  cancel: "Cancelled",
  select: "Selected",
  share: "Shared",
  close: "Closed",
};

function tryParseJson(data: unknown): unknown {
  if (typeof data !== "string") return data;
  const trimmed = data.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/** Parse `sendData` into a typed envelope when it is JSON with an `action`. */
export function parseMiniAppPayload(data: string | unknown): MiniAppTypedPayload | null {
  const parsed = tryParseJson(data);
  if (!isPlainObject(parsed)) return null;
  const action = readString(parsed, "action");
  if (!action) return null;
  return parsed as MiniAppTypedPayload;
}

/**
 * Turn MiniApp `sendData` into a short timeline / room-list line.
 * Prefer this over dumping raw JSON into `content.body`.
 */
export function formatMiniAppDataPreview(
  data: string | unknown,
  options?: { maxLength?: number },
): string {
  const maxLength = Math.max(16, options?.maxLength ?? 120);
  const parsed = tryParseJson(data);
  if (parsed == null) {
    const raw = typeof data === "string" ? data.trim() : String(data ?? "");
    return truncate(raw || "Mini app data", maxLength);
  }
  if (Array.isArray(parsed)) {
    return truncate(`Mini app data (${parsed.length} items)`, maxLength);
  }
  if (!isPlainObject(parsed)) {
    return truncate(String(parsed), maxLength);
  }

  const action = readString(parsed, "action");
  if (action) {
    const label = ACTION_LABELS[action] ?? titleCase(action);
    const detail = previewDetail(parsed, action);
    return truncate(detail ? `${label}: ${detail}` : label, maxLength);
  }

  const keys = Object.keys(parsed);
  if (keys.length === 0) return "Mini app data";
  if (keys.length <= 3) {
    return truncate(
      keys.map((k) => `${k}=${stringifyShort(parsed[k])}`).join(", "),
      maxLength,
    );
  }
  return truncate(`Mini app data (${keys.length} fields)`, maxLength);
}

/**
 * Optional humanizer hook for bots that want custom copy while staying on the
 * same preview path as aware clients.
 */
export type MiniAppDataHumanizer = (
  data: string,
  parsed: unknown,
) => string | null | undefined;

function previewDetail(parsed: Record<string, unknown>, action: string): string {
  switch (action) {
    case "publish":
      return readString(parsed, "title") ?? readString(parsed, "text") ?? "";
    case "submit": {
      if (Array.isArray(parsed.items)) return `${parsed.items.length} items`;
      const formId = readString(parsed, "formId") ?? readString(parsed, "form_id");
      return formId ? `form ${formId}` : "";
    }
    case "rsvp":
      return readString(parsed, "status") ?? "";
    case "cancel":
      return readString(parsed, "reason") ?? readString(parsed, "id") ?? "";
    case "select":
      return (
        readString(parsed, "label") ??
        (parsed.value !== undefined ? stringifyShort(parsed.value) : readString(parsed, "id") ?? "")
      );
    case "share":
      return readString(parsed, "title") ?? readString(parsed, "url") ?? "";
    default:
      return readString(parsed, "title") ?? readString(parsed, "label") ?? "";
  }
}

function stringifyShort(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function titleCase(value: string): string {
  if (!value) return "Mini app";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
