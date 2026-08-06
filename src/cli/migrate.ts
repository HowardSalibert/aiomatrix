import * as fs from "node:fs";
import * as path from "node:path";
import { resolveStoragePath, writeJsonAtomic } from "../util.js";

export interface MigrateResult {
  storagePath: string;
  actions: string[];
  warnings: string[];
}

/**
 * Best-effort layout migration for older aiomatrix storage directories.
 * Never prints secrets. Idempotent.
 */
export function migrateStorage(storagePath: string): MigrateResult {
  const root = resolveStoragePath(storagePath);
  fs.mkdirSync(root, { recursive: true });
  const actions: string[] = [];
  const warnings: string[] = [];

  const ensureDir = (name: string): void => {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      actions.push(`created ${name}/`);
    }
  };
  ensureDir("crypto");

  // Legacy flat callback used file → keep; ensure sibling maps exist as empty.
  const ensureEmptyJson = (file: string, shape: unknown): void => {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) {
      writeJsonAtomic(p, shape);
      actions.push(`created ${file}`);
    }
  };
  ensureEmptyJson("callback-used.json", { entries: {} });
  ensureEmptyJson("callback-aliases.json", { entries: {} });
  ensureEmptyJson("callback-binds.json", { entries: {} });
  ensureEmptyJson("miniapp-query-used.json", { entries: {} });
  ensureEmptyJson("outbox.json", { entries: [] });

  const device = path.join(root, "device.json");
  const session = path.join(root, "session.json");
  if (fs.existsSync(session) && !fs.existsSync(device)) {
    warnings.push("session.json present but device.json missing — prefer password re-login");
  }
  if (!fs.existsSync(session)) {
    warnings.push("no session.json — Bot.create needs accessToken or password");
  }

  const marker = path.join(root, "storage-version.json");
  writeJsonAtomic(marker, { version: 1, migratedAtMs: Date.now() });
  actions.push("wrote storage-version.json (v1)");

  return { storagePath: root, actions, warnings };
}
