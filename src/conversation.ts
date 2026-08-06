import type { AnyContext, Filter } from "./types.js";
import type { Storage } from "./fsm.js";
import { WaitForTimeoutError } from "./errors.js";

export interface ConversationStep<C extends AnyContext = AnyContext> {
  /** Optional prompt sent before waiting. */
  prompt?: (ctx: C) => void | Promise<void>;
  /** Filter for the awaited update (default: any message in the same room/sender). */
  filter?: Filter<AnyContext>;
  /** Handle the matched update. Return `"cancel"` to abort. */
  handle: (ctx: AnyContext, data: Record<string, unknown>) => void | Promise<void | "cancel">;
}

export interface ConversationOptions {
  /** Default wait timeout per step. Default 120_000. */
  timeoutMs?: number;
  /** Optional FSM storage key namespace for persisting mid-flight data. */
  storage?: Storage;
  storageKey?: string;
}

/**
 * Lightweight multi-step dialog on top of {@link import("./bot.js").Bot.waitFor}.
 * Prefer this over hand-rolled waitFor loops for short wizards.
 */
export class Conversation {
  constructor(private readonly options: ConversationOptions = {}) {}

  async run<C extends AnyContext>(
    start: C,
    steps: ConversationStep<C>[],
  ): Promise<{ completed: boolean; data: Record<string, unknown>; cancelled: boolean }> {
    const data: Record<string, unknown> = {};
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    if (this.options.storage && this.options.storageKey) {
      const existing = await this.options.storage.get(this.options.storageKey);
      if (existing?.data) Object.assign(data, existing.data);
    }

    for (const step of steps) {
      if (step.prompt) await step.prompt(start);
      const filter =
        step.filter ??
        ((ctx: AnyContext) =>
          ctx.updateType === "message" || ctx.updateType === "edited_message");
      let next: AnyContext;
      try {
        next = await start.waitFor(filter, { timeoutMs });
      } catch (err) {
        if (err instanceof WaitForTimeoutError) {
          return { completed: false, data, cancelled: false };
        }
        throw err;
      }
      const result = await step.handle(next, data);
      if (this.options.storage && this.options.storageKey) {
        await this.options.storage.set(this.options.storageKey, {
          state: "conversation",
          data: { ...data },
        });
      }
      if (result === "cancel") {
        return { completed: false, data, cancelled: true };
      }
    }
    if (this.options.storage && this.options.storageKey) {
      await this.options.storage.delete(this.options.storageKey);
    }
    return { completed: true, data, cancelled: false };
  }
}

/** Convenience factory. */
export function createConversation(options?: ConversationOptions): Conversation {
  return new Conversation(options);
}
