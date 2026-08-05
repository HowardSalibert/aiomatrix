import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Dispatcher, Router, logout } from "../../dist/index.js";
import { createLiveBot, liveEnv, sleep } from "./helpers.mjs";

const env = liveEnv();

describe("live revoked token", { skip: !env }, () => {
  it("stops sync and fires onFatal after logout", async () => {
    let fatal = null;
    const { bot } = await createLiveBot(env, "bot", {
      botOptions: {
        // Disable mid-run password recovery so revoke still surfaces as fatal.
        autoReloginOnAuthFailure: false,
        onFatal: (err) => {
          fatal = err;
        },
      },
    });

    const dispatcher = new Dispatcher();
    dispatcher.include(new Router());
    await bot.start(dispatcher);
    await sleep(2_000);
    assert.equal(bot.isRunning, true);

    // Invalidate the access token while sync is running.
    await logout(bot.client.http);
    await sleep(25_000);

    assert.ok(fatal, "onFatal should run after the token is revoked");
    assert.equal(bot.isRunning, false);

    await bot.stop().catch(() => {});
    await dispatcher.close();
  });
});
