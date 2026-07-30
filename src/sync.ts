import * as fs from "node:fs";
import * as path from "node:path";
import { MatrixApiError, type MatrixHttp } from "./http.js";

export interface SyncState {
  next_batch: string | null;
  filter_id?: string;
  /** True after cold-start bootstrap sync (timeline not dispatched). */
  bootstrap_done?: boolean;
}

export interface SyncResponse {
  next_batch: string;
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  device_lists?: {
    changed?: string[];
    left?: string[];
  };
  to_device?: {
    events?: Array<Record<string, unknown>>;
  };
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: Array<Record<string, unknown>>;
          limited?: boolean;
          prev_batch?: string;
        };
        state?: {
          events?: Array<Record<string, unknown>>;
        };
      }
    >;
    invite?: Record<
      string,
      {
        invite_state?: {
          events?: Array<Record<string, unknown>>;
        };
      }
    >;
  };
}

export type SyncHandler = (
  response: SyncResponse,
  meta: { isBootstrap: boolean },
) => Promise<void>;

export type SyncFatalHandler = (err: unknown) => void;

const MAX_BACKOFF_MS = 30_000;

function syncStatePath(storagePath: string): string {
  return path.join(storagePath, "sync.json");
}

export function loadSyncState(storagePath: string): SyncState {
  const file = syncStatePath(storagePath);
  try {
    if (!fs.existsSync(file)) return { next_batch: null };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
    return {
      next_batch: raw.next_batch ?? null,
      filter_id: raw.filter_id,
      bootstrap_done: raw.bootstrap_done === true,
    };
  } catch {
    return { next_batch: null };
  }
}

export function saveSyncState(storagePath: string, state: SyncState): void {
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(syncStatePath(storagePath), JSON.stringify(state, null, 2), "utf8");
}

const BOOTSTRAP_FILTER = {
  room: {
    timeline: { limit: 0 },
    state: { lazy_load_members: true },
  },
};

const RUNTIME_FILTER = {
  room: {
    timeline: { limit: 50 },
    state: { lazy_load_members: true },
  },
};

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
  );
  return resp.filter_id;
}

/**
 * Long-poll /sync loop with next_batch persistence in storagePath/sync.json.
 */
export class SyncLoop {
  private readonly http: MatrixHttp;
  private readonly storagePath: string;
  private readonly userId: string;
  private readonly onSync: SyncHandler;
  private readonly onFatal?: SyncFatalHandler;
  private readonly timeoutMs: number;
  private stopped = true;
  private running: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private fatalError: unknown = null;

  constructor(options: {
    http: MatrixHttp;
    storagePath: string;
    userId: string;
    onSync: SyncHandler;
    onFatal?: SyncFatalHandler;
    timeoutMs?: number;
  }) {
    this.http = options.http;
    this.storagePath = options.storagePath;
    this.userId = options.userId;
    this.onSync = options.onSync;
    this.onFatal = options.onFatal;
    this.timeoutMs = options.timeoutMs ?? 30_000;
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
  }

  getFatalError(): unknown {
    return this.fatalError;
  }

  private isAuthFatal(err: unknown): boolean {
    if (!(err instanceof MatrixApiError)) return false;
    if (err.status === 401) return true;
    return err.errcode === "M_UNKNOWN_TOKEN";
  }

  private async loop(): Promise<void> {
    let state = loadSyncState(this.storagePath);
    let backoffMs = 2000;
    while (!this.stopped) {
      try {
        const isCold = state.next_batch == null;
        const needBootstrap = isCold || !state.bootstrap_done;

        if (needBootstrap && !state.filter_id) {
          state.filter_id = await uploadFilter(this.http, this.userId, BOOTSTRAP_FILTER);
          saveSyncState(this.storagePath, state);
        }

        const query: Record<string, string | number> = {
          timeout: this.timeoutMs,
        };
        if (state.next_batch) query.since = state.next_batch;
        if (state.filter_id) query.filter = state.filter_id;

        const response = await this.http.request<SyncResponse>(
          "GET",
          "/_matrix/client/v3/sync",
          query,
          null,
          {
            signal: this.abort?.signal,
            timeoutMs: this.timeoutMs + 10_000,
          },
        );

        const isBootstrap = needBootstrap;
        await this.onSync(response, { isBootstrap });

        state = {
          next_batch: response.next_batch,
          filter_id: state.filter_id,
          bootstrap_done: true,
        };

        // Switch to runtime filter after first bootstrap so later gaps get timeline events.
        if (isBootstrap) {
          try {
            state.filter_id = await uploadFilter(this.http, this.userId, RUNTIME_FILTER);
          } catch (err) {
            console.warn("[matrixbots] runtime filter upload failed:", err);
          }
        }

        saveSyncState(this.storagePath, state);
        backoffMs = 2000;
      } catch (err) {
        if (this.stopped) break;
        if (this.isAuthFatal(err)) {
          this.fatalError = err;
          this.stopped = true;
          console.error("[matrixbots] sync fatal auth error — stopping loop:", err);
          this.onFatal?.(err);
          break;
        }
        // AbortError from stop() — exit quietly
        if (err instanceof Error && err.name === "AbortError") {
          break;
        }
        console.error("[matrixbots] sync error:", err);
        await new Promise((r) => setTimeout(r, backoffMs + Math.random() * 1000));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }
}
