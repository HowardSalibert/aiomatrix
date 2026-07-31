import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dispatcher, Router } from "../../dist/index.js";
import { createLiveBot, liveEnv, sleep } from "./helpers.mjs";

const env = liveEnv();

describe("live cold start", { skip: !env }, () => {
  it("bootstrap after wiping sync.json does not re-dispatch old timeline messages", async () => {
    const first = await createLiveBot(env, "bot");
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

    const peer = await createLiveBot(env, "peer");
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

    // Cold start: drop sync token, keep crypto/session.
    fs.rmSync(path.join(dir, "sync.json"), { force: true });

    const second = await createLiveBot(env, "bot", { storagePath: dir });
    const seenAfter = [];
    const router2 = new Router();
    const dispatcher2 = new Dispatcher();
    dispatcher2.include(router2);
    router2.message(async (ctx) => {
      if (ctx.senderId === second.bot.selfId) return;
      seenAfter.push(ctx.text);
    });

    await second.bot.start(dispatcher2);
    // Bootstrap + one runtime sync cycle.
    await sleep(8_000);

    assert.equal(
      seenAfter.includes(oldBody),
      false,
      `cold start re-dispatched old message: ${JSON.stringify(seenAfter)}`,
    );

    await second.bot.stop();
    await dispatcher2.close();
  });
});
