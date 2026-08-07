import type { Bot } from "./bot.js";
import type { Dispatcher } from "./dispatcher.js";
import type { Logger } from "./logger.js";

/**
 * Installable bot plugin. Prefer this over ad-hoc wiring for stores/metrics/middleware.
 */
export interface BotPlugin {
  readonly name: string;
  install(bot: Bot, ctx: PluginContext): void | Promise<void>;
  onStart?(bot: Bot, dispatcher: Dispatcher): void | Promise<void>;
  onStop?(bot: Bot): void | Promise<void>;
}

export interface PluginContext {
  logger: Logger;
  storagePath: string;
}

/** Define a plugin with a stable name. */
export function definePlugin(plugin: BotPlugin): BotPlugin {
  if (!plugin.name?.trim()) throw new TypeError("plugin.name is required");
  return plugin;
}
