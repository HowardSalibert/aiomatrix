#!/usr/bin/env node
/**
 * `npx create-aiomatrix <dir>` — scaffold a minimal bot project.
 * Delegates to `aiomatrix create`.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const main = path.join(here, "main.js");
const child = spawn(process.execPath, [main, "create", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
