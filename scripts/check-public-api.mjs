#!/usr/bin/env node
/**
 * Fail if frozen public exports disappear from dist/index.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const entry = fs.readFileSync(path.join(root, "dist/index.js"), "utf8");
const mod = await import(pathToFileURL(path.join(root, "dist/index.js")).href);

const REQUIRED = [
  "Bot",
  "Dispatcher",
  "Router",
  "Command",
  "F",
  "InlineKeyboard",
  "AIOMATRIX_SCHEMA_VERSION",
  "AIOMATRIX_SCHEMA",
  "AWARE_CONTRACT",
  "resolveCapabilityLevel",
  "pipelineAiomatrixContent",
  "buildAiomatrixEnvelope",
  "COLD_START_DISPATCH",
  "shouldDispatchOnColdStart",
  "StorageLock",
  "FileOutboxStore",
  "flushOutbox",
  "definePlugin",
  "canSendToRoom",
  "migrateStorage",
  "createRedisSharedTokenStores",
  "createOtelMetricHandler",
];

let failed = 0;
for (const name of REQUIRED) {
  if (typeof mod[name] === "undefined") {
    console.error(`missing export: ${name}`);
    failed += 1;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
for (const sub of ["./redis", "./otel"]) {
  const target = pkg.exports?.[sub]?.import;
  if (!target || !fs.existsSync(path.join(root, target))) {
    console.error(`exports[${sub}] missing on disk`);
    failed += 1;
  }
}

if (!entry.includes("AIOMATRIX_SCHEMA_VERSION")) {
  console.error("dist/index.js does not reference schema version (unexpected tree-shake?)");
  failed += 1;
}

if (failed) process.exit(1);
console.log(`check:api ok (${REQUIRED.length} symbols)`);
