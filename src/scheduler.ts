import type { Logger } from "./logger.js";
import { createDefaultLogger } from "./logger.js";
import { randomId } from "./util.js";

export interface ScheduledJob {
  readonly id: string;
  readonly name: string;
  /** Next run, epoch ms. `null` once the job is finished. */
  readonly nextRunAtMs: number | null;
  readonly runCount: number;
  readonly lastError: unknown;
  cancel(): void;
}

interface JobRecord {
  id: string;
  name: string;
  everyMs: number | null;
  nextRunAtMs: number | null;
  runCount: number;
  lastError: unknown;
  running: boolean;
  fn: () => unknown;
  /** Stop after this many runs. */
  maxRuns: number | null;
}

export interface SchedulerOptions {
  /** Tick resolution in ms. Default 1000. */
  tickMs?: number;
  logger?: Logger;
  /** Called when a job throws. Default: log at warn level. */
  onError?: (error: unknown, job: ScheduledJob) => void;
}

/**
 * Small cron-less scheduler for bot chores: reminders, digests, cache warmups.
 *
 * A single timer drives every job, jobs never overlap with themselves, and a
 * throwing job never stops the loop — the alternative (a `setInterval` per job)
 * leaks timers and silently dies on the first unhandled rejection.
 */
export class Scheduler {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly logger: Logger;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly options: SchedulerOptions = {}) {
    this.logger = (options.logger ?? createDefaultLogger()).child("scheduler");
    this.tickMs = Math.max(50, options.tickMs ?? 1_000);
  }

  /** Run `fn` every `everyMs`, starting after the first interval. */
  every(
    everyMs: number,
    fn: () => unknown,
    options?: { name?: string; immediate?: boolean; maxRuns?: number },
  ): ScheduledJob {
    const interval = Math.max(1, Math.floor(everyMs));
    return this.add({
      everyMs: interval,
      nextRunAtMs: Date.now() + (options?.immediate ? 0 : interval),
      name: options?.name ?? "every",
      maxRuns: options?.maxRuns ?? null,
      fn,
    });
  }

  /** Run `fn` once after `delayMs`. */
  after(delayMs: number, fn: () => unknown, name = "after"): ScheduledJob {
    return this.add({
      everyMs: null,
      nextRunAtMs: Date.now() + Math.max(0, delayMs),
      name,
      maxRuns: 1,
      fn,
    });
  }

  /** Run `fn` at a specific wall-clock time. */
  at(date: Date | number, fn: () => unknown, name = "at"): ScheduledJob {
    const when = typeof date === "number" ? date : date.getTime();
    return this.add({ everyMs: null, nextRunAtMs: when, name, maxRuns: 1, fn });
  }

  /**
   * Run `fn` daily at `HH:MM` local time.
   * Intentionally simple: for real cron expressions plug in your own scheduler.
   */
  dailyAt(time: string, fn: () => unknown, name = "daily"): ScheduledJob {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (!match) throw new Error(`dailyAt expects "HH:MM", got "${time}"`);
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) throw new Error(`dailyAt time out of range: "${time}"`);
    const dayMs = 24 * 60 * 60 * 1000;
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= Date.now()) next.setTime(next.getTime() + dayMs);
    return this.add({
      everyMs: dayMs,
      nextRunAtMs: next.getTime(),
      name,
      maxRuns: null,
      fn,
    });
  }

  private add(params: Omit<JobRecord, "id" | "runCount" | "lastError" | "running">): ScheduledJob {
    const id = randomId(8);
    const record: JobRecord = {
      id,
      runCount: 0,
      lastError: null,
      running: false,
      ...params,
    };
    this.jobs.set(id, record);
    this.ensureTimer();
    return this.view(record);
  }

  private view(record: JobRecord): ScheduledJob {
    const scheduler = this;
    return {
      get id() {
        return record.id;
      },
      get name() {
        return record.name;
      },
      get nextRunAtMs() {
        return record.nextRunAtMs;
      },
      get runCount() {
        return record.runCount;
      },
      get lastError() {
        return record.lastError;
      },
      cancel() {
        scheduler.jobs.delete(record.id);
      },
    };
  }

  get size(): number {
    return this.jobs.size;
  }

  /** Stop the timer and forget every job. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.jobs.clear();
  }

  private ensureTimer(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Never keep the process alive just because a job is pending.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private tick(): void {
    const now = Date.now();
    for (const record of [...this.jobs.values()]) {
      if (record.running || record.nextRunAtMs === null || record.nextRunAtMs > now) continue;
      record.running = true;
      void (async () => {
        try {
          await record.fn();
          record.lastError = null;
        } catch (err) {
          record.lastError = err;
          if (this.options.onError) this.options.onError(err, this.view(record));
          else this.logger.warn(`job "${record.name}" failed`, err);
        } finally {
          record.running = false;
          record.runCount += 1;
          if (record.maxRuns !== null && record.runCount >= record.maxRuns) {
            record.nextRunAtMs = null;
            this.jobs.delete(record.id);
          } else if (record.everyMs !== null) {
            // Anchor on "now" so a slow job cannot build up a backlog of runs.
            record.nextRunAtMs = Date.now() + record.everyMs;
          } else {
            record.nextRunAtMs = null;
            this.jobs.delete(record.id);
          }
        }
      })();
    }
  }
}
