import * as fs from "node:fs";
import * as path from "node:path";
import type { TtlStringMap } from "./token-store.js";
import { isPlainObject, readJsonSafe, readString, writeJsonAtomic } from "./util.js";

interface FileMapEntry {
  v: string;
  e: number;
}

/**
 * Durable {@link TtlStringMap} for short `!cb` aliases (and optional binds).
 * Survives process restart on a single host; multi-instance bots should still
 * inject a shared Redis map.
 */
export class FileTtlStringMap implements TtlStringMap {
  private readonly filePath: string;
  private readonly capacity: number;
  private readonly cache = new Map<string, FileMapEntry>();
  private loaded = false;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, capacity = 16_384) {
    this.filePath = filePath;
    this.capacity = capacity;
  }

  get(key: string): string | undefined {
    this.ensureLoaded();
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.e <= Date.now()) {
      this.cache.delete(key);
      this.scheduleWrite();
      return undefined;
    }
    return entry.v;
  }

  set(key: string, value: string, ttlMs: number): void {
    this.ensureLoaded();
    this.prune(Date.now());
    while (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { v: value, e: Date.now() + Math.max(1, ttlMs) });
    this.scheduleWrite();
  }

  delete(key: string): void {
    this.ensureLoaded();
    if (this.cache.delete(key)) this.scheduleWrite();
  }

  /** Flush pending writes (tests / shutdown). */
  flush(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    this.persist();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJsonSafe(this.filePath);
    if (!isPlainObject(raw) || !isPlainObject(raw.entries)) return;
    const now = Date.now();
    for (const [key, value] of Object.entries(raw.entries)) {
      if (!isPlainObject(value)) continue;
      const v = readString(value, "v");
      const e = typeof value.e === "number" ? value.e : 0;
      if (!v || e <= now) continue;
      this.cache.set(key, { v, e });
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.cache) {
      if (entry.e <= now) this.cache.delete(key);
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.persist();
    }, 50);
    this.writeTimer.unref?.();
  }

  private persist(): void {
    this.prune(Date.now());
    const entries: Record<string, FileMapEntry> = {};
    for (const [key, entry] of this.cache) entries[key] = entry;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeJsonAtomic(this.filePath, { version: 1, entries });
  }
}
