import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Bot, Dispatcher, Router } from "../../dist/index.js";

export function liveEnv() {
  const hs = process.env.MATRIX_HS_URL;
  const botUser = process.env.MATRIX_BOT_USER;
  const botPass = process.env.MATRIX_BOT_PASSWORD;
  const peerUser = process.env.MATRIX_PEER_USER;
  const peerPass = process.env.MATRIX_PEER_PASSWORD;
  if (!hs || !botUser || !botPass || !peerUser || !peerPass) {
    return null;
  }
  return { hs, botUser, botPass, peerUser, peerPass };
}

export function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function createLiveBot(env, role, overrides = {}) {
  const userId = role === "bot" ? env.botUser : env.peerUser;
  const password = role === "bot" ? env.botPass : env.peerPass;
  const storagePath = overrides.storagePath ?? tmpDir(`aio-live-${role}-`);
  const bot = await Bot.create({
    homeserverUrl: env.hs,
    userId,
    password,
    storagePath,
    crypto: overrides.crypto !== false,
    logger: overrides.logger ?? "warn",
    autojoin: overrides.autojoin !== false,
    syncTimeoutMs: overrides.syncTimeoutMs ?? 5_000,
    ...overrides.botOptions,
  });
  return { bot, storagePath };
}

/** Start bot with a router; return a promise that resolves on the first matching message. */
export async function startAwaitingMessage(bot, predicate, timeoutMs = 60_000) {
  const router = new Router();
  const dispatcher = new Dispatcher();
  dispatcher.include(router);

  let resolve;
  let reject;
  const done = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

  router.message(async (ctx) => {
    if (ctx.senderId === bot.selfId) return;
    if (predicate && !(await predicate(ctx))) return;
    clearTimeout(timer);
    resolve(ctx);
  });

  await bot.start(dispatcher);
  return {
    dispatcher,
    wait: () => done,
    async stop() {
      clearTimeout(timer);
      await bot.stop();
      await dispatcher.close();
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
