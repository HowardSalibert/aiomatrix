/**
 * Optional OpenTelemetry-style adapter. **No `@opentelemetry/*` dependency** —
 * wire your SDK in the callbacks. Use with `BotCreateOptions.onMetric` /
 * `onRequest`.
 */

import type { BotMetric, MetricHandler } from "./metrics.js";

export interface OtelLikeCounter {
  add(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface OtelLikeHistogram {
  record(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface OtelAdapterOptions {
  /** Called for each metric name the first time it is seen. */
  getCounter?: (name: string) => OtelLikeCounter | undefined;
  getHistogram?: (name: string) => OtelLikeHistogram | undefined;
  /** Prefix for metric names. Default `aiomatrix.`. */
  prefix?: string;
  /** Extra attributes on every point. */
  resourceAttributes?: Record<string, string | number | boolean>;
}

/** Build an `onMetric` handler that fans out to OTel-like instruments. */
export function createOtelMetricHandler(options: OtelAdapterOptions = {}): MetricHandler {
  const prefix = options.prefix ?? "aiomatrix.";
  const counters = new Map<string, OtelLikeCounter | undefined>();
  const histograms = new Map<string, OtelLikeHistogram | undefined>();

  return (metric: BotMetric) => {
    const name = `${prefix}${metric.name}`;
    const attrs = {
      ...(options.resourceAttributes ?? {}),
      ...(metric.labels ?? {}),
    };
    if (metric.value !== undefined && options.getHistogram) {
      let hist = histograms.get(name);
      if (!histograms.has(name)) {
        hist = options.getHistogram(name);
        histograms.set(name, hist);
      }
      hist?.record(metric.value, attrs);
      return;
    }
    if (!options.getCounter) return;
    let counter = counters.get(name);
    if (!counters.has(name)) {
      counter = options.getCounter(name);
      counters.set(name, counter);
    }
    counter?.add(metric.value ?? 1, attrs);
  };
}

/** Build an `onRequest` handler that records HTTP duration histograms. */
export function createOtelRequestHandler(options: OtelAdapterOptions = {}): (info: {
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  attempt: number;
  retried: boolean;
  error?: unknown;
}) => void {
  const prefix = options.prefix ?? "aiomatrix.";
  const name = `${prefix}http.request.duration_ms`;
  let hist: OtelLikeHistogram | undefined;
  let resolved = false;
  return (info) => {
    if (!options.getHistogram) return;
    if (!resolved) {
      hist = options.getHistogram(name);
      resolved = true;
    }
    hist?.record(info.durationMs, {
      ...(options.resourceAttributes ?? {}),
      method: info.method,
      path: info.path,
      status: info.status ?? 0,
      attempt: info.attempt,
      retried: info.retried,
      error: info.error ? "1" : "0",
    });
  };
}
