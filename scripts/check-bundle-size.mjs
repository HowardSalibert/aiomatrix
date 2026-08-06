#!/usr/bin/env node
/**
 * Soft bundle budget for dist/index.js (uncompressed). Keeps accidental bloat
 * out of minors. Adjust only with a deliberate release note.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, "dist/index.js");
const MAX_BYTES = 120_000; // entry re-exports only; real code is split across dist/
const size = fs.statSync(file).size;
if (size > MAX_BYTES) {
  console.error(`check:size fail: dist/index.js is ${size} bytes (budget ${MAX_BYTES})`);
  process.exit(1);
}
console.log(`check:size ok: dist/index.js ${size} bytes (budget ${MAX_BYTES})`);
