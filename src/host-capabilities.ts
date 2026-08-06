/**
 * Host ↔ bot capability handshake (`dev.aiomatrix.host` room/account state).
 * Bots read this to adapt fallbacks; hosts write it to advertise features.
 */

export const HOST_CAPABILITIES_STATE_EVENT_TYPE = "dev.aiomatrix.host";
export const HOST_CAPABILITIES_SCHEMA_VERSION = 1;

export interface HostCapabilitiesContent {
  version: number;
  /** Host profile hint. */
  client_profile?: "stock" | "aware";
  features?: string[];
  /** Host renders structured keyboards — skip `!cb` dumps. */
  keyboard?: boolean;
  /** Host renders `dev.aiomatrix.callback_answer` / toast. */
  callback_answer?: boolean;
  toast?: boolean;
  progress?: boolean;
  poll_ui?: boolean;
  mini_app?: boolean;
}

export interface ResolvedHostCapabilities {
  profile: "stock" | "aware";
  features: Set<string>;
  keyboardNative: boolean;
  toast: boolean;
  progress: boolean;
  pollUi: boolean;
  miniApp: boolean;
}

/** Parse host capability state; unknown/malformed → conservative stock defaults. */
export function parseHostCapabilities(content: unknown): ResolvedHostCapabilities {
  const raw =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};
  const features = new Set<string>();
  if (Array.isArray(raw.features)) {
    for (const f of raw.features) {
      if (typeof f === "string" && f) features.add(f);
    }
  }
  const profile = raw.client_profile === "aware" ? "aware" : "stock";
  const aware = profile === "aware";
  const has = (key: string, fallback: boolean): boolean => {
    if (typeof raw[key] === "boolean") return raw[key] as boolean;
    if (features.has(key)) return true;
    return fallback;
  };
  return {
    profile,
    features,
    keyboardNative: has("keyboard", aware),
    toast: has("toast", aware) || has("callback_answer", aware),
    progress: has("progress", aware),
    pollUi: has("poll_ui", aware),
    miniApp: has("mini_app", aware),
  };
}

export function buildHostCapabilitiesContent(
  options: Partial<HostCapabilitiesContent> = {},
): HostCapabilitiesContent {
  const profile = options.client_profile ?? "aware";
  return {
    version: HOST_CAPABILITIES_SCHEMA_VERSION,
    client_profile: profile,
    features: options.features ?? [
      "keyboard",
      "callback_answer",
      "toast",
      "progress",
      "poll_ui",
      "mini_app",
    ],
    keyboard: options.keyboard ?? true,
    callback_answer: options.callback_answer ?? true,
    toast: options.toast ?? true,
    progress: options.progress ?? true,
    poll_ui: options.poll_ui ?? true,
    mini_app: options.mini_app ?? true,
  };
}
