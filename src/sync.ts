import * as fs from "node:fs";
import * as path from "node:path";
import type { MatrixHttp } from "./http.js";

export interface SyncState {
  next_batch: string | null;
  filter_id?: string;
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
  };
}

export type SyncHandler = (response: SyncResponse) => Promise<void>;

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
    };
  } catch {
    return { next_batch: null };
  }
}

export function saveSyncState(storagePath: string, state: SyncState): void {
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(syncStatePath(storagePath), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Long-poll /sync loop with next_batch persistence in storagePath/sync.json.
 */
export class SyncLoop {
  private readonly http: MatrixHttp;
  private readonly storagePath: string;
  private readonly onSync: SyncHandler;
  private readonly timeoutMs: number;
  private stopped = true;
  private running: Promise<void> | null = null;

  constructor(options: {
    http: MatrixHttp;
    storagePath: string;
    onSync: SyncHandler;
    timeoutMs?: number;
  }) {
    this.http = options.http;
    this.storagePath = options.storagePath;
    this.onSync = options.onSync;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.running = this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  async waitUntilStopped(): Promise<void> {
    if (this.running) await this.running.catch(() => undefined);
  }

  private async loop(): Promise<void> {
    let state = loadSyncState(this.storagePath);
    while (!this.stopped) {
      try {
        const query: Record<string, string | number> = {
          timeout: this.timeoutMs,
        };
        if (state.next_batch) query.since = state.next_batch;
        if (state.filter_id) query.filter = state.filter_id;

        const response = await this.http.request<SyncResponse>(
          "GET",
          "/_matrix/client/v3/sync",
          query,
        );

        await this.onSync(response);

        state = {
          next_batch: response.next_batch,
          filter_id: state.filter_id,
        };
        saveSyncState(this.storagePath, state);
      } catch (err) {
        if (this.stopped) break;
        console.error("[matrixbots] sync error:", err);
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
      }
    }
  }
}
