/**
 * Cold-start / bootstrap contract — what must never become application updates.
 *
 * SyncLoop marks the first sync as bootstrap (`isBootstrap: true`). The client:
 * - applies state/crypto warmup
 * - does **not** dispatch timeline history as messages/callbacks/polls
 * - may still observe capability state (`dev.aiomatrix.host`) for caching
 * - drops timeline events with `origin_server_ts` before the bootstrap instant
 *
 * {@link COLD_START_DISPATCH} is the normative matrix for authors and hosts.
 */

export type ColdStartUpdateKind =
  | "message"
  | "edited_message"
  | "reaction"
  | "redaction"
  | "membership"
  | "invite"
  | "callback_query"
  | "mini_app_data"
  | "poll_response"
  | "ephemeral"
  | "to_device"
  | "raw_event"
  | "host_capabilities_state";

export const COLD_START_DISPATCH: Record<
  ColdStartUpdateKind,
  "never" | "bootstrap_ok" | "after_bootstrap"
> = {
  message: "after_bootstrap",
  edited_message: "after_bootstrap",
  reaction: "after_bootstrap",
  redaction: "after_bootstrap",
  membership: "after_bootstrap",
  invite: "after_bootstrap",
  callback_query: "after_bootstrap",
  mini_app_data: "after_bootstrap",
  poll_response: "after_bootstrap",
  ephemeral: "after_bootstrap",
  to_device: "after_bootstrap",
  raw_event: "after_bootstrap",
  /** Host capability state may warm the bot cache during bootstrap (handlers must not see it). */
  host_capabilities_state: "bootstrap_ok",
};

export function shouldDispatchOnColdStart(
  kind: ColdStartUpdateKind,
  isBootstrap: boolean,
): boolean {
  const rule = COLD_START_DISPATCH[kind];
  if (!isBootstrap) return true;
  return rule === "bootstrap_ok";
}
