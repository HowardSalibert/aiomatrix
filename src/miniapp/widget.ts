import { isPlainObject, readString } from "../util.js";

/** Element-compatible widget state event type. */
export const WIDGET_STATE_EVENT_TYPE = "im.vector.modular.widgets";
/** Widget layout state event used by Element to size/pin widgets. */
export const WIDGET_LAYOUT_STATE_EVENT_TYPE = "io.element.widgets.layout";

export interface WidgetOptions {
  /** Unique widget id (also the state key). */
  widgetId: string;
  /** Widget URL. May contain `$matrix_user_id`, `$matrix_room_id`, `$theme`, … */
  url: string;
  name: string;
  title?: string;
  /** `m.custom` by default; use `m.etherpad`, `m.jitsi`, … for known kinds. */
  type?: string;
  /** Extra data passed to the widget. */
  data?: Record<string, unknown>;
  /** Who created the widget (defaults to the bot at send time). */
  creatorUserId?: string;
  /** Ask the client to wait for capability negotiation before loading. */
  waitForIframeLoad?: boolean;
}

/**
 * Build the content for an `im.vector.modular.widgets` state event.
 *
 * Widgets are the native Matrix embedding mechanism: pinning a mini app as a
 * widget makes it usable in Element and other stock clients without any
 * matrixbots-specific support.
 */
export function buildWidgetStateContent(options: WidgetOptions): Record<string, unknown> {
  return {
    type: options.type ?? "m.custom",
    url: options.url,
    name: options.name,
    ...(options.title ? { title: options.title } : {}),
    data: { title: options.title ?? options.name, ...(options.data ?? {}) },
    ...(options.creatorUserId ? { creatorUserId: options.creatorUserId } : {}),
    waitForIframeLoad: options.waitForIframeLoad ?? true,
    id: options.widgetId,
  };
}

/** Content that removes a widget (empty state event). */
export function buildWidgetRemovalContent(): Record<string, unknown> {
  return {};
}

export interface WidgetUrlVariables {
  userId?: string;
  roomId?: string;
  displayName?: string;
  avatarUrl?: string;
  widgetId?: string;
  theme?: string;
  deviceId?: string;
  /** Additional `$name` → value replacements. */
  extra?: Record<string, string>;
}

const WIDGET_VARIABLE_KEYS: Array<[string, keyof WidgetUrlVariables]> = [
  ["$matrix_user_id", "userId"],
  ["$matrix_room_id", "roomId"],
  ["$matrix_display_name", "displayName"],
  ["$matrix_avatar_url", "avatarUrl"],
  ["$matrix_widget_id", "widgetId"],
  ["$matrix_device_id", "deviceId"],
  ["$theme", "theme"],
];

/**
 * Substitute the standard widget URL template variables.
 * Values are URL-encoded, so a hostile display name cannot break out of the URL.
 */
export function templateWidgetUrl(url: string, variables: WidgetUrlVariables): string {
  let out = url;
  for (const [token, key] of WIDGET_VARIABLE_KEYS) {
    const value = variables[key];
    if (typeof value === "string") {
      out = out.split(token).join(encodeURIComponent(value));
    }
  }
  for (const [name, value] of Object.entries(variables.extra ?? {})) {
    const token = name.startsWith("$") ? name : `$${name}`;
    out = out.split(token).join(encodeURIComponent(value));
  }
  return out;
}

export interface ParsedWidget {
  widgetId: string;
  url: string;
  name: string;
  type: string;
  data: Record<string, unknown>;
}

/** Parse a widget state event, returning `null` for removals/malformed content. */
export function parseWidgetStateEvent(event: unknown): ParsedWidget | null {
  if (!isPlainObject(event)) return null;
  const content = isPlainObject(event.content) ? event.content : null;
  if (!content) return null;
  const url = readString(content, "url");
  if (!url) return null;
  const widgetId = readString(content, "id") ?? readString(event, "state_key") ?? "";
  if (!widgetId) return null;
  return {
    widgetId,
    url,
    name: readString(content, "name") ?? widgetId,
    type: readString(content, "type") ?? "m.custom",
    data: isPlainObject(content.data) ? content.data : {},
  };
}

/**
 * Element widget layout so a pinned mini app gets a usable amount of space.
 */
export function buildWidgetLayoutContent(
  widgetId: string,
  options?: { container?: "top" | "right"; height?: number; width?: number; index?: number },
): Record<string, unknown> {
  return {
    widgets: {
      [widgetId]: {
        container: options?.container ?? "top",
        index: options?.index ?? 0,
        height: options?.height ?? 45,
        width: options?.width ?? 100,
      },
    },
  };
}
