/**
 * Optional lightweight metrics hook. Nothing is collected unless
 * {@link BotCreateOptions.onMetric} is set — zero overhead by default.
 *
 * `crypto.keys_query` fires after each engine `/keys/query` POST.
 * `crypto.soft_budget` fires when soft-budget delays share/query work.
 * `update.timeout` fires from the Dispatcher (even if error handlers swallow).
 */

export type BotMetricName =
  | "update.received"
  | "update.handled"
  | "update.unhandled"
  | "update.error"
  | "update.timeout"
  | "http.request"
  | "http.rate_limited"
  | "sync.stale"
  | "crypto.share_room_key"
  | "crypto.keys_query"
  | "crypto.encrypt_send"
  | "crypto.soft_budget"
  | "wait_for.resolved"
  | "wait_for.timeout"
  | "admin.denied"
  | "device.prune";

export interface BotMetric {
  name: BotMetricName;
  /** Optional numeric value (latency ms, count delta, etc.). */
  value?: number;
  labels?: Record<string, string | number | boolean>;
}

export type MetricHandler = (metric: BotMetric) => void;

/** No-op-safe emit used throughout the library. */
export function emitMetric(
  handler: MetricHandler | undefined,
  metric: BotMetric,
): void {
  if (!handler) return;
  try {
    handler(metric);
  } catch {
    // Metrics must never break the bot.
  }
}
