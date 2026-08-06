import type { MessageDefaults } from "./types.js";

/** Defaults applied when `clientProfile: "aware"`. */
export const AWARE_MESSAGE_DEFAULTS: MessageDefaults = {
  keyboardFallback: false,
  parseMode: "markdown",
};

export const AWARE_MINI_APP_DEFAULTS = {
  includePlainLink: false,
  includeLaunchKeyboard: true,
  includeKeyboardFallback: false,
  topLevelUrl: false,
} as const;

/** Room/account state type advertising bot capabilities to aware hosts. */
export const BOT_CAPABILITIES_STATE_EVENT_TYPE = "dev.aiomatrix.bot";

export const BOT_CAPABILITIES_SCHEMA_VERSION = 1;

export interface BotCapabilitiesContent {
  version: number;
  /** Hosts that render `dev.aiomatrix.keyboard` natively. */
  client_profile: "stock" | "aware";
  keyboard_fallback: boolean;
  parse_mode: "plain" | "markdown" | "html";
  mini_app: {
    top_level_url: boolean;
    include_plain_link: boolean;
    include_launch_keyboard: boolean;
    include_keyboard_fallback: boolean;
  };
  features: string[];
}

export interface BuildBotCapabilitiesOptions {
  clientProfile?: "stock" | "aware";
  keyboardFallback?: boolean;
  parseMode?: "plain" | "markdown" | "html";
  topLevelUrl?: boolean;
  includePlainLink?: boolean;
  includeLaunchKeyboard?: boolean;
  includeKeyboardFallback?: boolean;
  features?: string[];
}

/** Build `dev.aiomatrix.bot` state content for hosts to detect aware bots. */
export function buildBotCapabilitiesContent(
  options: BuildBotCapabilitiesOptions = {},
): BotCapabilitiesContent {
  const profile = options.clientProfile ?? "stock";
  const aware = profile === "aware";
  return {
    version: BOT_CAPABILITIES_SCHEMA_VERSION,
    client_profile: profile,
    keyboard_fallback: options.keyboardFallback ?? !aware,
    parse_mode: options.parseMode ?? "markdown",
    mini_app: {
      top_level_url: options.topLevelUrl ?? false,
      include_plain_link: options.includePlainLink ?? !aware,
      include_launch_keyboard: options.includeLaunchKeyboard ?? true,
      include_keyboard_fallback: options.includeKeyboardFallback ?? false,
    },
    features: options.features ?? [
      "keyboard",
      "mini_app",
      "mini_app_data",
      "callback",
      "callback_answer",
      "format_message_preview",
      "poll",
      "wait_for",
    ],
  };
}
