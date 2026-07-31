#!/usr/bin/env node
/**
 * Bring up Synapse via docker compose, register bot+peer, run test/live, tear down.
 */
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
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

function run(cmd, args) {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd: root });
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
  console.log(`+ docker ${args.join(" ")}`);
  try {
    execFileSync("docker", args, { encoding: "utf8", cwd: root, stdio: ["ignore", "pipe", "pipe"] });
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

async function waitForHomeserver(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/_matrix/client/versions`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`homeserver not ready at ${url}`);
}

async function main() {
  if (!fs.existsSync(composeFile)) {
    throw new Error(`missing ${composeFile}`);
  }

  const liveTests = fs
    .readdirSync(liveDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => path.join("test/live", name));

  let exitCode = 1;
  try {
    run("docker", ["compose", "-f", composeFile, "up", "-d"]);
    await waitForHomeserver(hsUrl);
    await new Promise((r) => setTimeout(r, 3_000));

    registerUser(botUser, botPass);
    registerUser(peerUser, peerPass);

    const env = {
      ...process.env,
      MATRIX_HS_URL: hsUrl,
      MATRIX_BOT_USER: `@${botUser}:${serverName}`,
      MATRIX_BOT_PASSWORD: botPass,
      MATRIX_PEER_USER: `@${peerUser}:${serverName}`,
      MATRIX_PEER_PASSWORD: peerPass,
    };

    exitCode = await new Promise((resolve) => {
      console.log(`+ node --test ${liveTests.join(" ")}`);
      const child = spawn(process.execPath, ["--test", ...liveTests], {
        cwd: root,
        env,
        stdio: "inherit",
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
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
  try {
    run("docker", ["compose", "-f", composeFile, "down", "-v"]);
  } catch {
    // ignore
  }
  process.exit(1);
});
