#!/usr/bin/env node
/**
 * Bring up Synapse via docker compose, register bot+peer, run test/live, tear down.
 */
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "test/live/docker-compose.yml");
const liveDir = path.join(root, "test/live");
const hsUrl = process.env.MATRIX_HS_URL ?? "http://127.0.0.1:8008";
const botUser = "livebot";
const peerUser = "livepeer";
const botPass = "live-bot-pass-32chars!!!!!!!!";
const peerPass = "live-peer-pass-32chars!!!!!!!";
const serverName = "localhost";

function run(cmd, args, options = {}) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...options });
}

function runCapture(cmd, args) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] });
}

function registerUser(localpart, password) {
  const args = [
    "compose",
    "-f",
    composeFile,
    "exec",
    "-T",
    "synapse",
    "register_new_matrix_user",
    "http://localhost:8008",
    "-c",
    "/data/homeserver.yaml",
    "-u",
    localpart,
    "-p",
    password,
    "--no-admin",
  ];
  try {
    runCapture("docker", args);
  } catch (err) {
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
    if (/already|taken/i.test(out)) {
      console.log(`user ${localpart} already exists`);
      return;
    }
    console.error(out);
    throw err;
  }
}

function dumpSynapseLogs() {
  try {
    console.log("--- docker compose ps ---");
    run("docker", ["compose", "-f", composeFile, "ps", "-a"]);
    console.log("--- docker compose logs (tail) ---");
    run("docker", ["compose", "-f", composeFile, "logs", "--tail", "200"]);
  } catch (err) {
    console.warn("could not dump synapse logs", err);
  }
}

async function waitForHomeserver(url, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/_matrix/client/versions`);
      if (res.ok) {
        console.log(`homeserver ready after ${i + 1} attempt(s)`);
        return;
      }
      console.log(`wait ${i + 1}/${attempts}: HTTP ${res.status}`);
    } catch (err) {
      console.log(`wait ${i + 1}/${attempts}: ${err.cause?.code ?? err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  dumpSynapseLogs();
  throw new Error(`homeserver not ready at ${url}`);
}

/** Relax Synapse login throttling so sequential suites do not 429 on /login. */
function relaxLoginRateLimits() {
  const patch = `
## aiomatrix live tests — relax login throttling
rc_login:
  address:
    per_second: 1000
    burst_count: 1000
  account:
    per_second: 1000
    burst_count: 1000
  failed_attempts:
    per_second: 1000
    burst_count: 1000
`;
  console.log("+ patch homeserver.yaml rc_login");
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      "run",
      "--rm",
      "-T",
      "--entrypoint",
      "sh",
      "synapse",
      "-c",
      'grep -q "aiomatrix live tests" /data/homeserver.yaml 2>/dev/null || cat >> /data/homeserver.yaml',
    ],
    { cwd: root, input: patch, stdio: ["pipe", "inherit", "inherit"] },
  );
}

async function main() {
  if (!fs.existsSync(composeFile)) {
    throw new Error(`missing ${composeFile}`);
  }

  const liveTests = fs
    .readdirSync(liveDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => path.join("test/live", name));

  const botStorage = fs.mkdtempSync(path.join(os.tmpdir(), "aio-live-bot-"));
  const peerStorage = fs.mkdtempSync(path.join(os.tmpdir(), "aio-live-peer-"));

  let exitCode = 1;
  try {
    // Empty volume: generate homeserver.yaml + signing key, then start.
    run("docker", [
      "compose",
      "-f",
      composeFile,
      "run",
      "--rm",
      "-e",
      "SYNAPSE_SERVER_NAME=localhost",
      "-e",
      "SYNAPSE_REPORT_STATS=no",
      "synapse",
      "generate",
    ]);
    relaxLoginRateLimits();
    run("docker", ["compose", "-f", composeFile, "up", "-d"]);
    await waitForHomeserver(hsUrl);

    registerUser(botUser, botPass);
    registerUser(peerUser, peerPass);

    const env = {
      ...process.env,
      MATRIX_HS_URL: hsUrl,
      MATRIX_BOT_USER: `@${botUser}:${serverName}`,
      MATRIX_BOT_PASSWORD: botPass,
      MATRIX_PEER_USER: `@${peerUser}:${serverName}`,
      MATRIX_PEER_PASSWORD: peerPass,
      // Reuse one session per role across suites (avoids login 429s).
      MATRIX_BOT_STORAGE: botStorage,
      MATRIX_PEER_STORAGE: peerStorage,
    };

    // One Matrix account is shared across suites; run files sequentially so
    // rooms/devices from Megolm do not leak into cold-start assertions.
    exitCode = 0;
    for (const file of liveTests) {
      const code = await new Promise((resolve) => {
        console.log(`+ node --test ${file}`);
        const child = spawn(process.execPath, ["--test", file], {
          cwd: root,
          env,
          stdio: "inherit",
        });
        child.on("exit", (c) => resolve(c ?? 1));
      });
      if (code !== 0) exitCode = code;
    }
  } finally {
    try {
      run("docker", ["compose", "-f", composeFile, "down", "-v"]);
    } catch (err) {
      console.warn("teardown failed", err);
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  dumpSynapseLogs();
  try {
    run("docker", ["compose", "-f", composeFile, "down", "-v"]);
  } catch {
    // ignore
  }
  process.exit(1);
});
