/**
 * Pluggable logger. The library never calls `console.*` directly — everything
 * goes through a {@link Logger} so hosts can route logs into pino/winston,
 * silence them in tests, or ship them to a collector.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  trace(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  /** Derive a child logger with an extra name segment. */
  child(name: string): Logger;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 100,
};

export function parseLogLevel(value: unknown, fallback: LogLevel = "info"): LogLevel {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized in LEVEL_WEIGHT ? (normalized as LogLevel) : fallback;
}

/** Console logger with `[matrixbots:scope]` prefixes and level filtering. */
export class ConsoleLogger implements Logger {
  readonly level: LogLevel;
  private readonly scope: string;
  private readonly threshold: number;

  constructor(level: LogLevel = "info", scope = "matrixbots") {
    this.level = level;
    this.scope = scope;
    this.threshold = LEVEL_WEIGHT[level];
  }

  child(name: string): Logger {
    return new ConsoleLogger(this.level, `${this.scope}:${name}`);
  }

  trace(message: string, detail?: unknown): void {
    this.emit("trace", message, detail);
  }

  debug(message: string, detail?: unknown): void {
    this.emit("debug", message, detail);
  }

  info(message: string, detail?: unknown): void {
    this.emit("info", message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.emit("warn", message, detail);
  }

  error(message: string, detail?: unknown): void {
    this.emit("error", message, detail);
  }

  private emit(level: LogLevel, message: string, detail?: unknown): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const line = `[${this.scope}] ${message}`;
    const sink =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "info"
            ? console.info
            : console.debug;
    if (detail === undefined) sink(line);
    else sink(line, detail);
  }
}

/** Logger that drops everything. Useful in tests and embedded hosts. */
export const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

/**
 * Default logger honouring `MATRIXBOTS_LOG_LEVEL` (trace|debug|info|warn|error|silent).
 */
export function createDefaultLogger(level?: LogLevel): Logger {
  const resolved =
    level ??
    parseLogLevel(
      typeof process !== "undefined" ? process.env?.MATRIXBOTS_LOG_LEVEL : undefined,
    );
  if (resolved === "silent") return silentLogger;
  return new ConsoleLogger(resolved);
}
