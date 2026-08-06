import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigurationError } from "./errors.js";
import { readJsonSafe, writeJsonAtomic } from "./util.js";

const LOCK_FILE = "aiomatrix.lock";

export interface StorageLockInfo {
  pid: number;
  startedAtMs: number;
  hostname?: string;
}

/**
 * Exclusive lock for a storagePath (one writer per directory).
 * Uses `aiomatrix.lock` with pid; stale locks from dead pids are stolen.
 */
export class StorageLock {
  private held = false;

  constructor(private readonly storagePath: string) {}

  get lockPath(): string {
    return path.join(this.storagePath, LOCK_FILE);
  }

  acquire(): StorageLockInfo {
    if (this.held) {
      return (
        readJsonSafe<StorageLockInfo>(this.lockPath) ?? {
          pid: process.pid,
          startedAtMs: Date.now(),
        }
      );
    }
    fs.mkdirSync(this.storagePath, { recursive: true });
    const existing = readJsonSafe<StorageLockInfo>(this.lockPath);
    if (existing?.pid) {
      if (existing.pid === process.pid) {
        throw new ConfigurationError(
          `storagePath ${this.storagePath} is already locked in this process ` +
            `(${LOCK_FILE}). Use one Bot per storagePath, or storageLock: false.`,
        );
      }
      if (isPidAlive(existing.pid)) {
        throw new ConfigurationError(
          `storagePath ${this.storagePath} is locked by pid ${existing.pid} ` +
            `(started ${existing.startedAtMs}). Stop the other process or delete ${LOCK_FILE} if stale.`,
        );
      }
    }
    const info: StorageLockInfo = {
      pid: process.pid,
      startedAtMs: Date.now(),
      hostname: process.env.COMPUTERNAME ?? process.env.HOSTNAME,
    };
    writeJsonAtomic(this.lockPath, info);
    this.held = true;
    return info;
  }

  release(): void {
    if (!this.held) return;
    try {
      const existing = readJsonSafe<StorageLockInfo>(this.lockPath);
      if (existing?.pid === process.pid) fs.rmSync(this.lockPath, { force: true });
    } catch {
      /* best effort */
    }
    this.held = false;
  }

  static peek(storagePath: string): StorageLockInfo | null {
    return readJsonSafe<StorageLockInfo>(path.join(storagePath, LOCK_FILE));
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}
