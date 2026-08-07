import * as path from "node:path";
import { AuthenticationError } from "./errors.js";
import { MatrixApiError, type MatrixHttp } from "./http.js";
import { createDefaultLogger, type Logger } from "./logger.js";
import { clamp, jitter, readJsonSafe, sleep, writeJsonAtomic } from "./util.js";

export type SyncFilterKind = "bootstrap" | "runtime";

export interface SyncState {
  next_batch: string | null;
  filter_id?: string;
  /** Which filter `filter_id` refers to. Distinguishes the cold-start filter. */
  filter_kind?: SyncFilterKind;
  /** True after the cold-start bootstrap sync (timeline not dispatched). */
  bootstrap_done?: boolean;
  /** User the state belongs to; a mismatch resets the state. */
  user_id?: string;
}

export interface SyncTimeline {
  events?: Array<Record<string, unknown>>;
  limited?: boolean;
  prev_batch?: string;
}

export interface JoinedRoomSync {
  timeline?: SyncTimeline;
  state?: { events?: Array<Record<string, unknown>> };
  ephemeral?: { events?: Array<Record<string, unknown>> };
  account_data?: { events?: Array<Record<string, unknown>> };
  unread_notifications?: { highlight_count?: number; notification_count?: number };
  summary?: Record<string, unknown>;
}

export interface SyncResponse {
  next_batch: string;
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  device_lists?: { changed?: string[]; left?: string[] };
  to_device?: { events?: Array<Record<string, unknown>> };
  account_data?: { events?: Array<Record<string, unknown>> };
  presence?: { events?: Array<Record<string, unknown>> };
  rooms?: {
    join?: Record<string, JoinedRoomSync>;
    invite?: Record<string, { invite_state?: { events?: Array<Record<string, unknown>> } }>;
    leave?: Record<string, { timeline?: SyncTimeline; state?: { events?: Array<Record<string, unknown>> } }>;
    knock?: Record<string, { knock_state?: { events?: Array<Record<string, unknown>> } }>;
  };
}

export type SyncHandler = (
  response: SyncResponse,
  meta: { isBootstrap: boolean },
) => Promise<void>;

export type SyncFatalHandler = (err: unknown) => void;

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/**
 * How many times the same batch may fail inside `onSync` before we advance past
 * it. Without this a single un-processable batch stalls the bot forever.
 */
const MAX_POISON_RETRIES = 3;

function syncStatePath(storagePath: string): string {
  return path.join(storagePath, "sync.json");
}

export function loadSyncState(storagePath: string, userId?: string): SyncState {
  const raw = readJsonSafe<SyncState>(syncStatePath(storagePath));
  if (!raw) return { next_batch: null };
  if (userId && raw.user_id && raw.user_id !== userId) {
    // Storage belongs to a different account — never replay its sync token.
    return { next_batch: null, user_id: userId };
  }
  const state: SyncState = {
    next_batch: raw.next_batch ?? null,
    bootstrap_done: raw.bootstrap_done === true,
  };
  if (raw.filter_id) state.filter_id = raw.filter_id;
  if (raw.filter_kind) state.filter_kind = raw.filter_kind;
  if (userId ?? raw.user_id) state.user_id = userId ?? raw.user_id;
  return state;
}

export function saveSyncState(storagePath: string, state: SyncState): void {
  writeJsonAtomic(syncStatePath(storagePath), state);
}

export interface SyncFilterOptions {
  /** Timeline events per room per sync (runtime filter). Default 50. */
  timelineLimit?: number;
  /** Receive typing/receipt/ephemeral events. Default false (saves bandwidth). */
  includeEphemeral?: boolean;
  /** Receive presence updates. Default false. */
  includePresence?: boolean;
  /** Receive rooms the bot has left. Default false. */
  includeLeave?: boolean;
  /** Restrict the timeline to these event types (e.g. only `m.room.message`). */
  timelineTypes?: string[];
  /** Additional state event types to always include. */
  stateTypes?: string[];
}

/** Cold start: no timeline at all, but full state so crypto/room caches warm up.
 *
 * Prefer {@link buildRuntimeFilter} for {@link SyncLoop}: cold-start safety is
 * enforced by `isBootstrap` skip + `coldStartNotBeforeMs`, not by uploading this
 * filter (a stuck timeline.limit:0 filter historically left bots deaf).
 * Exported for custom sync loops that intentionally upload a bootstrap filter
 * and switch to runtime after the first sync.
 */
export function buildBootstrapFilter(options: SyncFilterOptions = {}): Record<string, unknown> {
  return {
    presence: { limit: 0, types: [] },
    room: {
      timeline: { limit: 0 },
      state: { lazy_load_members: true },
      ephemeral: { limit: 0, types: [] },
      include_leave: false,
    },
    ...(options.includePresence ? { presence: { limit: 10 } } : {}),
  };
}

export function buildRuntimeFilter(options: SyncFilterOptions = {}): Record<string, unknown> {
  const timeline: Record<string, unknown> = {
    limit: clamp(options.timelineLimit ?? 50, 1, 1000),
  };
  if (options.timelineTypes?.length) timeline.types = options.timelineTypes;

  const state: Record<string, unknown> = { lazy_load_members: true };
  if (options.stateTypes?.length) state.types = options.stateTypes;

  const room: Record<string, unknown> = {
    timeline,
    state,
    include_leave: options.includeLeave === true,
  };
  if (!options.includeEphemeral) {
    room.ephemeral = { limit: 0, types: [] };
  }

  return {
    presence: options.includePresence ? { limit: 10 } : { limit: 0, types: [] },
    room,
  };
}

async function uploadFilter(
  http: MatrixHttp,
  userId: string,
  filter: unknown,
): Promise<string> {
  const resp = await http.request<{ filter_id: string }>(
    "POST",
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/filter`,
    null,
    filter,
    { idempotent: true },
  );
  return resp.filter_id;
}

export interface SyncLoopOptions {
  http: MatrixHttp;
  storagePath: string;
  userId: string;
  onSync: SyncHandler;
  onFatal?: SyncFatalHandler;
  /** Long-poll timeout sent to the homeserver. Default 30s. */
  timeoutMs?: number;
  logger?: Logger;
  filter?: SyncFilterOptions;
  /** `offline` keeps the bot from showing as online. Default `offline`. */
  setPresence?: "online" | "offline" | "unavailable";
  /** Called whenever a sync round-trip succeeds (health/metrics). */
  onHealthy?: (info: { latencyMs: number; nextBatch: string }) => void;
  /** First backoff delay after a failed sync. Default 1000ms. */
  backoffMinMs?: number;
  /** Ceiling for the exponential backoff. Default 30_000ms. */
  backoffMaxMs?: number;
}

/**
 * Long-poll `/sync` loop with `next_batch` persistence in `storagePath/sync.json`.
 *
 * Guarantees:
 * - a cold start (`since` absent / `bootstrap_done` false) never dispatches
 *   timeline events into handlers — state/crypto still warm up;
 * - one runtime filter only (no limit:0 → limit:N switch; that replayed history
 *   on Synapse when the filter changed);
 * - the client also drops timeline events older than the bootstrap instant, so
 *   any later Synapse history replay cannot re-trigger handlers;
 * - backoff sleeps abort immediately on {@link stop};
 * - a batch that repeatedly breaks `onSync` is skipped instead of stalling.
 */
export class SyncLoop {
  private readonly http: MatrixHttp;
  private readonly storagePath: string;
  private readonly userId: string;
  private readonly onSync: SyncHandler;
  private readonly onFatal?: SyncFatalHandler;
  private readonly onHealthy?: (info: { latencyMs: number; nextBatch: string }) => void;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly filterOptions: SyncFilterOptions;
  private readonly setPresence: "online" | "offline" | "unavailable";
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private stopped = true;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private fatalError: unknown = null;
  private lastSyncAt = 0;

  constructor(options: SyncLoopOptions) {
    this.http = options.http;
    this.storagePath = options.storagePath;
    this.userId = options.userId;
    this.onSync = options.onSync;
    this.onFatal = options.onFatal;
    this.onHealthy = options.onHealthy;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.logger = (options.logger ?? createDefaultLogger()).child("sync");
    this.filterOptions = options.filter ?? {};
    this.setPresence = options.setPresence ?? "offline";
    this.backoffMinMs = Math.max(1, options.backoffMinMs ?? MIN_BACKOFF_MS);
    this.backoffMaxMs = Math.max(this.backoffMinMs, options.backoffMaxMs ?? MAX_BACKOFF_MS);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.fatalError = null;
    this.abort = new AbortController();
    this.running = this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  async waitUntilStopped(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
    this.running = null;
  }

  getFatalError(): unknown {
    return this.fatalError;
  }

  /** Epoch ms of the last successful sync (0 before the first one). */
  getLastSyncAt(): number {
    return this.lastSyncAt;
  }

  get isRunning(): boolean {
    return !this.stopped;
  }

  private isAuthFatal(err: unknown): boolean {
    if (err instanceof AuthenticationError) return true;
    if (!(err instanceof MatrixApiError)) return false;
    return err.isAuthFailure;
  }

  private async loop(): Promise<void> {
    let state = loadSyncState(this.storagePath, this.userId);
    let backoffMs = this.backoffMinMs;
    let poisonBatch: string | null = null;
    let poisonCount = 0;

    while (!this.stopped) {
      try {
        const needBootstrap = state.next_batch == null || !state.bootstrap_done;
        // Always the runtime filter. A bootstrap→runtime filter switch made
        // Synapse replay recent timelines into the first live sync.
        const wantKind: SyncFilterKind = "runtime";

        if (!state.filter_id || state.filter_kind !== wantKind) {
          const filter = buildRuntimeFilter(this.filterOptions);
          try {
            state.filter_id = await uploadFilter(this.http, this.userId, filter);
            state.filter_kind = wantKind;
            saveSyncState(this.storagePath, state);
            this.logger.debug(`uploaded ${wantKind} filter ${state.filter_id}`);
          } catch (err) {
            if (this.isAuthFatal(err)) throw err;
            this.logger.warn(
              `${wantKind} filter upload failed; syncing without a filter this round`,
              err,
            );
            delete state.filter_id;
            delete state.filter_kind;
          }
        }

        const query: Record<string, string | number> = {
          timeout: this.timeoutMs,
          set_presence: this.setPresence,
        };
        if (state.next_batch) query.since = state.next_batch;
        if (state.filter_id) query.filter = state.filter_id;

        const startedAt = Date.now();
        const response = await this.http.request<SyncResponse>(
          "GET",
          "/_matrix/client/v3/sync",
          query,
          null,
          {
            signal: this.abort?.signal,
            timeoutMs: this.timeoutMs + 15_000,
            idempotent: true,
          },
        );
        if (this.stopped) break;
        if (!response?.next_batch) {
          throw new Error("sync response is missing next_batch");
        }

        const isBootstrap = needBootstrap;
        try {
          await this.onSync(response, { isBootstrap });
          poisonBatch = null;
          poisonCount = 0;
        } catch (err) {
          const batchKey = state.next_batch ?? "<initial>";
          if (poisonBatch === batchKey) poisonCount += 1;
          else {
            poisonBatch = batchKey;
            poisonCount = 1;
          }
          if (poisonCount <= MAX_POISON_RETRIES) {
            this.logger.error(
              `sync handler failed (attempt ${poisonCount}/${MAX_POISON_RETRIES}); retrying the same batch`,
              err,
            );
            throw err;
          }
          this.logger.error(
            `sync handler keeps failing on batch ${batchKey}; skipping it to keep the loop alive`,
            err,
          );
          poisonBatch = null;
          poisonCount = 0;
        }

        state = {
          next_batch: response.next_batch,
          bootstrap_done: true,
          user_id: this.userId,
          ...(state.filter_id ? { filter_id: state.filter_id } : {}),
          ...(state.filter_kind ? { filter_kind: state.filter_kind } : {}),
        };
        saveSyncState(this.storagePath, state);

        this.lastSyncAt = Date.now();
        this.onHealthy?.({
          latencyMs: this.lastSyncAt - startedAt,
          nextBatch: response.next_batch,
        });
        backoffMs = this.backoffMinMs;
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof Error && err.name === "AbortError") break;
        if (this.isAuthFatal(err)) {
          this.fatalError = err;
          this.stopped = true;
          this.logger.error("fatal auth error — stopping sync loop", err);
          this.safeFatal(err);
          break;
        }
        this.logger.error(`sync error; backing off ${Math.round(backoffMs)}ms`, err);
        await sleep(jitter(backoffMs), this.abort?.signal);
        backoffMs = clamp(backoffMs * 2, this.backoffMinMs, this.backoffMaxMs);
      }
    }
    this.stopped = true;
  }

  private safeFatal(err: unknown): void {
    try {
      this.onFatal?.(err);
    } catch (hookErr) {
      this.logger.error("onFatal hook threw", hookErr);
    }
  }
}
