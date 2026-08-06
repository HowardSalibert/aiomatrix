/**
 * Normative aiomatrix event/schema contract (semver for `dev.aiomatrix.*`).
 * Hosts and bots should treat {@link AIOMATRIX_SCHEMA_VERSION} bumps as:
 * - major: breaking field renames / removed kinds
 * - minor: new optional fields / kinds
 * - patch: docs / clarifications only
 */

export const AIOMATRIX_SCHEMA_VERSION = 1 as const;

/** Stable event / content keys. */
export const AIOMATRIX_EVENT_TYPES = {
  callback: "dev.aiomatrix.callback",
  callbackAnswer: "dev.aiomatrix.callback_answer",
  toast: "dev.aiomatrix.toast",
  progress: "dev.aiomatrix.progress",
  botCapabilities: "dev.aiomatrix.bot",
  hostCapabilities: "dev.aiomatrix.host",
} as const;

export const AIOMATRIX_CONTENT_KEYS = {
  keyboard: "dev.aiomatrix.keyboard",
  miniApp: "dev.aiomatrix.mini_app",
  miniAppData: "dev.aiomatrix.mini_app_data",
  poll: "dev.aiomatrix.poll",
} as const;

/**
 * Capability level for bots and hosts.
 * - `stock` — Element-like clients; plaintext fallbacks on
 * - `aware` — renders structured fields; lean timeline
 * - `hybrid` — prefer aware when host advertises features, else stock fallbacks
 */
export type CapabilityLevel = "stock" | "aware" | "hybrid";

export interface ContractRequirement {
  id: string;
  /** must = required for aware compliance; best_effort = nice to have */
  level: "must" | "best_effort";
  summary: string;
}

/** Normative checklist mirrored in AWARE_HOST.md / COMPAT.md. */
export const AWARE_CONTRACT: readonly ContractRequirement[] = [
  {
    id: "keyboard.render",
    level: "must",
    summary: "Render dev.aiomatrix.keyboard; ignore !cb dumps when structured keyboard present",
  },
  {
    id: "callback.send",
    level: "must",
    summary: "Send presses as dev.aiomatrix.callback with HMAC token",
  },
  {
    id: "callback_answer.toast",
    level: "must",
    summary: "Show callback_answer / toast ephemerally to user_id only",
  },
  {
    id: "mini_app.launch",
    level: "must",
    summary: "Launch from mini_app.url / structured card, not top-level content.url",
  },
  {
    id: "preview.normalize",
    level: "must",
    summary: "Use normalizeAiomatrixContent / formatMessagePreview for room list",
  },
  {
    id: "progress.ui",
    level: "best_effort",
    summary: "Render progress events as non-timeline UI",
  },
  {
    id: "poll.lean",
    level: "best_effort",
    summary: "Prefer structured poll UI when lean poll marker present",
  },
  {
    id: "host.advertise",
    level: "best_effort",
    summary: "Publish dev.aiomatrix.host so bots can adapt fallbacks",
  },
] as const;

export function resolveCapabilityLevel(
  profile: CapabilityLevel | "stock" | "aware" | undefined,
  hostAwareFeatures?: boolean,
): "stock" | "aware" {
  if (profile === "aware") return "aware";
  if (profile === "hybrid") return hostAwareFeatures ? "aware" : "stock";
  return "stock";
}
