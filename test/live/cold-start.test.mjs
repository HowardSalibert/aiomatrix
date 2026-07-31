import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dispatcher, Router } from "../../dist/index.js";
import { createLiveBot, liveEnv, sleep } from "./helpers.mjs";

const env = liveEnv();

describe("live cold start", { skip: !env }, () => {
  it("bootstrap after wiping sync.json does not re-dispatch old timeline messages", async () => {
    // Crypto off: this suite only checks sync bootstrap / dispatch, not Megolm.
    const first = await createLiveBot(env, "bot", { crypto: false });
    const dir = first.storagePath;

    const router = new Router();
    const dispatcher = new Dispatcher();
    dispatcher.include(router);
    const seen = [];
    router.message(async (ctx) => {
      if (ctx.senderId === first.bot.selfId) return;
      seen.push(ctx.text);
    });

    await first.bot.start(dispatcher);
    await sleep(2_000);

    const roomId = await first.bot.client.createRoom({
      invite: [env.peerUser],
      isDirect: true,
      encrypted: false,
      name: `cold-start-${Date.now()}`,
    });

    const peer = await createLiveBot(env, "peer", { crypto: false });
    const peerDp = new Dispatcher();
    peerDp.include(new Router());
    await peer.bot.start(peerDp);
    await sleep(2_000);

    const oldBody = `old-${Date.now()}`;
    await peer.bot.client.sendText(roomId, oldBody);
    await sleep(3_000);
    assert.ok(seen.includes(oldBody), "first run should see the message");

    await first.bot.stop();
    await dispatcher.close();
    await peer.bot.stop();
    await peerDp.close();

    fs.rmSync(path.join(dir, "sync.json"), { force: true });

    const second = await createLiveBot(env, "bot", { storagePath: dir, crypto: false });
    const seenAfter = [];
    const router2 = new Router();
    const dispatcher2 = new Dispatcher();
    dispatcher2.include(router2);
    router2.message(async (ctx) => {
      if (ctx.senderId === second.bot.selfId) return;
      seenAfter.push(ctx.text);
    });

    await second.bot.start(dispatcher2);
    // Bootstrap + a couple of runtime sync cycles — no new traffic yet.
    await sleep(8_000);

    assert.equal(
      seenAfter.includes(oldBody),
      false,
      `cold start re-dispatched old message: ${JSON.stringify(seenAfter)}`,
    );

    // Sync is alive: a fresh message after bootstrap must still arrive.
    const peer2 = await createLiveBot(env, "peer", { crypto: false });
    const peer2Dp = new Dispatcher();
    peer2Dp.include(new Router());
    await peer2.bot.start(peer2Dp);
    const fresh = `fresh-${Date.now()}`;
    await peer2.bot.client.sendText(roomId, fresh);
    await sleep(5_000);
    assert.ok(seenAfter.includes(fresh), `runtime sync missed ${fresh}: ${JSON.stringify(seenAfter)}`);

    await second.bot.stop();
    await dispatcher2.close();
    await peer2.bot.stop();
    await peer2Dp.close();
  });
});
