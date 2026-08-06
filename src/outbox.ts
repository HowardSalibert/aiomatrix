import * as fs from "node:fs";
import * as path from "node:path";
import { randomId, readJsonSafe, writeJsonAtomic } from "./util.js";

export interface OutboxEntry {
  id: string;
  roomId: string;
  eventType: string;
  content: Record<string, unknown>;
  txnId?: string;
  createdAtMs: number;
  attempts: number;
  lastError?: string;
}

export interface OutboxStore {
  enqueue(entry: Omit<OutboxEntry, "id" | "createdAtMs" | "attempts">): Promise<OutboxEntry>;
  list(): Promise<OutboxEntry[]>;
  remove(id: string): Promise<void>;
  bumpAttempt(id: string, error?: string): Promise<void>;
}

/** File-backed outbox under `storagePath/outbox.json`. */
export class FileOutboxStore implements OutboxStore {
  private readonly file: string;

  constructor(storagePath: string) {
    this.file = path.join(storagePath, "outbox.json");
  }

  private read(): OutboxEntry[] {
    const raw = readJsonSafe<{ entries?: OutboxEntry[] }>(this.file);
    return Array.isArray(raw?.entries) ? raw.entries : [];
  }

  private write(entries: OutboxEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeJsonAtomic(this.file, { entries });
  }

  async enqueue(
    entry: Omit<OutboxEntry, "id" | "createdAtMs" | "attempts">,
  ): Promise<OutboxEntry> {
    const full: OutboxEntry = {
      ...entry,
      id: randomId(12),
      createdAtMs: Date.now(),
      attempts: 0,
    };
    const entries = this.read();
    entries.push(full);
    this.write(entries);
    return full;
  }

  async list(): Promise<OutboxEntry[]> {
    return this.read();
  }

  async remove(id: string): Promise<void> {
    this.write(this.read().filter((e) => e.id !== id));
  }

  async bumpAttempt(id: string, error?: string): Promise<void> {
    const entries = this.read();
    for (const e of entries) {
      if (e.id === id) {
        e.attempts += 1;
        if (error) e.lastError = error.slice(0, 500);
      }
    }
    this.write(entries);
  }
}

export interface OutboxOptions {
  store: OutboxStore;
  send: (
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    txnId?: string,
  ) => Promise<string>;
  /** Max attempts before dropping. Default 8. */
  maxAttempts?: number;
  onDrop?: (entry: OutboxEntry) => void;
}

/** Drain pending outbox entries (call on start and after transient failures). */
export async function flushOutbox(options: OutboxOptions): Promise<{ sent: number; dropped: number }> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 8);
  let sent = 0;
  let dropped = 0;
  for (const entry of await options.store.list()) {
    if (entry.attempts >= maxAttempts) {
      await options.store.remove(entry.id);
      options.onDrop?.(entry);
      dropped += 1;
      continue;
    }
    try {
      await options.send(entry.roomId, entry.eventType, entry.content, entry.txnId);
      await options.store.remove(entry.id);
      sent += 1;
    } catch (err) {
      await options.store.bumpAttempt(
        entry.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { sent, dropped };
}
