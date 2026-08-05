import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Dispatcher,
  MatrixHttp,
  Router,
  createDefaultLogger,
  createSessionRefreshHandler,
  loadSession,
  logout,
  refreshAccessToken,
} from "../../dist/index.js";
import { createLiveBot, liveEnv, sleep, tmpDir } from "./helpers.mjs";

const env = liveEnv();
const silent = createDefaultLogger("silent");

describe("live token refresh / mid-run relogin", { skip: !env }, () => {
  it("exchanges refresh_token for a new access token", async () => {
    // Own storage: shared MATRIX_BOT_STORAGE may hold a token killed by revoked-token.
    const storagePath = tmpDir("aio-live-refresh-");
    const { bot } = await createLiveBot(env, "bot", {
      crypto: false,
      storagePath,
    });
    const session = loadSession(storagePath);
    assert.ok(session?.refreshToken, "homeserver should issue a refresh_token");

    const handler = createSessionRefreshHandler({
      storagePath,
      homeserverUrl: session.homeserverUrl,
      logger: silent,
      allowInsecure: session.homeserverUrl.startsWith("http:"),
    });
    const viaHandler = await handler(new Error("401"));
    assert.ok(viaHandler);
    assert.notEqual(viaHandler, session.accessToken);

    const updated = loadSession(storagePath);
    assert.equal(updated?.accessToken, viaHandler);
    assert.ok(updated?.refreshToken);

    // Direct /refresh with the (possibly rotated) token the handler persisted.
    const anon = new MatrixHttp(updated.homeserverUrl, {
      allowInsecure: updated.homeserverUrl.startsWith("http:"),
      logger: silent,
    });
    const next = await refreshAccessToken(anon, updated.refreshToken);
    assert.ok(next.accessToken);
    assert.notEqual(next.accessToken, viaHandler);

    await bot.stop().catch(() => {});
  });

  it("password-relogins mid-run when the access token is revoked", async () => {
    let fatal = null;
    const storagePath = tmpDir("aio-live-relogin-");
    const { bot } = await createLiveBot(env, "bot", {
      crypto: false,
      storagePath,
      botOptions: {
        autoReloginOnAuthFailure: true,
        onFatal: (err) => {
          fatal = err;
        },
      },
    });

    const dispatcher = new Dispatcher();
    dispatcher.include(new Router());
    await bot.start(dispatcher);
    await sleep(1_500);

    await logout(bot.client.http);
    const whoami = await bot.client.getWhoAmI();
    assert.equal(whoami.user_id, bot.selfId);
    assert.equal(fatal, null, "password re-login should prevent onFatal");

    await bot.stop().catch(() => {});
    await dispatcher.close();
  });
});
