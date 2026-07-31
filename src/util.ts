import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write JSON atomically: temp file in the same directory + `rename`.
 * A crash mid-write leaves either the old file or the new one, never a truncated one.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomId(6)}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw err;
  }
}

/** Read and parse JSON, returning `null` for missing/corrupt files. */
export function readJsonSafe<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** URL-safe random identifier. */
export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Timing-safe string comparison that does not leak length through early exit. */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Hash both sides so unequal lengths still take a constant-ish path.
  const hashA = crypto.createHash("sha256").update(bufA).digest();
  const hashB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
}

/**
 * Sleep that resolves early when `signal` aborts.
 *
 * Pass `{ unref: true }` for idle waits that must not hold the process open.
 */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  options?: { unref?: boolean },
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    // Refs the loop by default: an awaited sleep is in-flight work (retry
    // backoff, sync backoff), and letting the process exit underneath it would
    // silently abandon the operation. Idle waiters opt out explicitly.
    if (options?.unref && typeof timer.unref === "function") timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Full jitter for exponential backoff: random value in `[base, base*2)`. */
export function jitter(baseMs: number): number {
  return baseMs + Math.random() * baseMs;
}

/** Clamp a number into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve a storage path, refusing parent-directory escapes in *relative*
 * inputs while still allowing legitimate absolute paths and names like `a..b`.
 */
export function resolveStoragePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("storagePath must not be empty");
  }
  const segments = trimmed.split(/[\\/]+/);
  if (!path.isAbsolute(trimmed) && segments.includes("..")) {
    throw new Error(
      `storagePath must not traverse parent directories ("..") — got ${raw}`,
    );
  }
  return path.resolve(trimmed);
}

/** `true` when the value is a plain JSON object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a string property from an unknown object, or `undefined`. */
export function readString(source: unknown, key: string): string | undefined {
  if (!isPlainObject(source)) return undefined;
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

/** Read a finite number property from an unknown object, or `undefined`. */
export function readNumber(source: unknown, key: string): number | undefined {
  if (!isPlainObject(source)) return undefined;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A bounded insertion-ordered cache. Evicts the oldest entry past `capacity`. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("LruCache capacity must be >= 1");
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): IterableIterator<K> {
    return this.map.keys();
  }
}

/** A promise chain that serialises async work while surviving rejections. */
export class AsyncLock {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Escape text for safe inclusion in an HTML `formatted_body`. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Deterministic fingerprint of a string set — used for cache invalidation.
 *
 * Entries are length-prefixed rather than joined by a separator, so no choice of
 * member names can make two different sets hash alike.
 */
export function fingerprintSet(values: Iterable<string>): string {
  const sorted = [...new Set(values)].sort();
  const hash = crypto.createHash("sha256");
  for (const value of sorted) {
    hash.update(`${Buffer.byteLength(value, "utf8")}:${value}`);
  }
  return hash.digest("base64url");
}
