#!/usr/bin/env node
/**
 * `npx aiomatrix <cmd>` — doctor | migrate | create
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { diagnoseSession, loadPersistedDeviceId } from "../session-recovery.js";
import { loadSession } from "../login.js";
import { loadSyncState } from "../sync.js";
import { resolveStoragePath } from "../util.js";
import { StorageLock } from "../storage-lock.js";
import { migrateStorage } from "./migrate.js";

function usage(): never {
  console.log(`Usage:
  aiomatrix doctor [--storage <path>]
  aiomatrix migrate [--storage <path>]
  aiomatrix create <dir> [--aware]

doctor   — session/device/crypto checklist (no secrets)
migrate  — idempotent storage layout migration
create   — scaffold a minimal bot project
`);
  process.exit(2);
}

function parseStorage(argv: string[]): string {
  let storage = "./data";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--storage") storage = argv[++i] ?? storage;
    else if (arg?.startsWith("--storage=")) storage = arg.slice("--storage=".length);
  }
  return storage;
}

function doctor(argv: string[]): void {
  const root = resolveStoragePath(parseStorage(argv));
  console.log(`aiomatrix doctor — storage=${root}\n`);
  const session = loadSession(root);
  const deviceId = loadPersistedDeviceId(root);
  const sync = loadSyncState(root);
  const diagnosis = diagnoseSession(root);
  const lock = StorageLock.peek(root);

  const lines: Array<[string, string]> = [
    ["session.json", session ? `ok user=${session.userId} device=${session.deviceId}` : "MISSING"],
    [
      "refresh_token",
      session?.refreshToken ? "present" : session ? "absent" : "n/a",
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
      "lock",
      lock
        ? `held by pid ${lock.pid}${StorageLock.peek(root) && isAlive(lock.pid) ? " (alive)" : " (stale?)"}`
        : "none",
    ],
    ["suggestedAction", diagnosis.suggestedAction],
  ];
  for (const [label, value] of lines) {
    console.log(`  ${label.padEnd(24)} ${value}`);
  }
  if (diagnosis.suggestedAction !== "ok") process.exitCode = 1;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function migrate(argv: string[]): void {
  const result = migrateStorage(parseStorage(argv));
  console.log(`aiomatrix migrate — ${result.storagePath}`);
  for (const a of result.actions) console.log(`  + ${a}`);
  for (const w of result.warnings) console.log(`  ! ${w}`);
}

function create(argv: string[]): void {
  const dir = argv[0];
  if (!dir) usage();
  const aware = argv.includes("--aware");
  const root = path.resolve(dir!);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  const pkg = {
    name: path.basename(root),
    private: true,
    type: "module",
    engines: { node: ">=24" },
    scripts: { start: "tsx src/main.ts", doctor: "aiomatrix doctor --storage ./data" },
    dependencies: { aiomatrix: "^0.8.0" },
    devDependencies: { tsx: "^4.19.2", typescript: "^5.7.2" },
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(
    path.join(root, ".env.example"),
    "MATRIX_HS_URL=https://matrix.example.org\nMATRIX_ACCESS_TOKEN=\nMATRIX_STORAGE=./data\n",
  );
  fs.writeFileSync(
    path.join(root, "src/main.ts"),
    `import {
  Bot,
  CommandStart,
  Dispatcher,
  F,
  autoMarkRead,
  rateLimitBackoff,
  roomThrottle,
  userFacingErrors,
} from "aiomatrix";

const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN,
  clientProfile: ${aware ? '"aware"' : '"stock"'},
  storagePath: process.env.MATRIX_STORAGE ?? "./data",
});

const dp = new Dispatcher();
dp.use(autoMarkRead());
dp.use(rateLimitBackoff());
dp.use(roomThrottle({ limit: 30, windowMs: 10_000 }));
dp.use(userFacingErrors({ swallow: true }));

dp.message(CommandStart(), async (ctx) => {
  await ctx.answer("hi");
});
dp.message(F.text, async (ctx) => {
  await ctx.reply(ctx.text);
});

await bot.run(dp);
`,
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    `# ${path.basename(root)}

\`\`\`bash
cp .env.example .env
npm install
npm start
\`\`\`
`,
  );
  console.log(`created ${root}`);
  console.log("next: cd there, fill .env, npm install && npm start");
}

function main(argv: string[]): void {
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (!cmd || cmd === "--help" || cmd === "-h") usage();
  if (cmd === "doctor") return doctor(rest);
  if (cmd === "migrate") return migrate(rest);
  if (cmd === "create") return create(rest);
  // backwards compatible: bare flags → doctor
  if (cmd.startsWith("--")) return doctor(argv);
  usage();
}

main(process.argv.slice(2));
