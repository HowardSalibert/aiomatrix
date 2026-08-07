#!/usr/bin/env node
/** Back-compat entry: `node dist/cli/doctor.js` → `aiomatrix doctor`. */
if (process.argv[2] !== "doctor") {
  process.argv.splice(2, 0, "doctor");
}
await import("./main.js");
