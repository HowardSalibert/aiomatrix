#!/usr/bin/env node
/**
 * `npx aiomatrix doctor` — session / crypto / device checklist (no secrets printed).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadSession } from "../login.js";
import { diagnoseSession, loadPersistedDeviceId } from "../session-recovery.js";
import { loadSyncState } from "../sync.js";
import { resolveStoragePath } from "../util.js";

function usage(): never {
  console.log(`Usage: aiomatrix doctor [--storage <path>]

Checks session.json, device.json, sync token, and crypto store presence.
Does not print access tokens or passphrases.
`);
  process.exit(2);
}

function main(argv: string[]): void {
  const args = argv[0] === "doctor" ? argv.slice(1) : argv;
  let storage = "./data";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--storage") {
      storage = args[++i] ?? storage;
      continue;
    }
    if (arg?.startsWith("--storage=")) {
      storage = arg.slice("--storage=".length);
    }
  }
  const root = resolveStoragePath(storage);
  console.log(`aiomatrix doctor — storage=${root}\n`);

  const session = loadSession(root);
  const deviceId = loadPersistedDeviceId(root);
  const sync = loadSyncState(root);
  const diagnosis = diagnoseSession(root);

  const lines: Array<[string, string]> = [
    ["session.json", session ? `ok user=${session.userId} device=${session.deviceId}` : "MISSING"],
    [
      "refresh_token",
      session?.refreshToken ? "present" : session ? "absent (password re-login may be needed)" : "n/a",
    ],
    ["device.json", deviceId ? `ok device=${deviceId}` : "MISSING"],
    [
      "device match",
      session && deviceId
        ? session.deviceId === deviceId
          ? "ok"
          : `MISMATCH session=${session.deviceId} device.json=${deviceId}`
        : "n/a",
    ],
    ["sync.json", sync.next_batch ? "ok next_batch set" : "missing / empty"],
    [
      "crypto/",
      fs.existsSync(path.join(root, "crypto")) ? "present" : "absent (ok if crypto:false)",
    ],
    [
      "crypto-passphrase.json",
      fs.existsSync(path.join(root, "crypto-passphrase.json"))
        ? "present (not printed)"
        : "absent",
    ],
    ["suggestedAction", diagnosis.suggestedAction],
  ];

  for (const [label, value] of lines) {
    console.log(`  ${label.padEnd(24)} ${value}`);
  }

  if (diagnosis.suggestedAction !== "ok") {
    console.log("\nSuggested recovery:");
    console.log(`  - follow SessionDiagnosis.suggestedAction=${diagnosis.suggestedAction}`);
    console.log("  - stop every process writing this storagePath");
    console.log("  - consider relocateSession / wipeCryptoStore only when advised");
    process.exitCode = 1;
  } else {
    console.log("\nLooks healthy enough to start. Prefer one writer per storagePath.");
  }
}

main(process.argv.slice(2));
