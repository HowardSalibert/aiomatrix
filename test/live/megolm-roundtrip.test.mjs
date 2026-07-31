import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLiveBot, liveEnv, sleep, startAwaitingMessage } from "./helpers.mjs";

const env = liveEnv();

describe("live Megolm round-trip", { skip: !env }, () => {
  it("encrypts bot → peer and peer → bot in an encrypted DM", async () => {
    const botSide = await createLiveBot(env, "bot");
    const peerSide = await createLiveBot(env, "peer");

    const marker = `megolm-${Date.now()}`;
    const replyMarker = `reply-${Date.now()}`;

    const peerWait = await startAwaitingMessage(
      peerSide.bot,
      (ctx) => ctx.text.includes(marker),
    );
    const botWait = await startAwaitingMessage(
      botSide.bot,
      (ctx) => ctx.text.includes(replyMarker),
    );

    try {
      assert.equal(botSide.bot.cryptoReady, true);
      assert.equal(peerSide.bot.cryptoReady, true);
      await sleep(2_000);

      const roomId = await botSide.bot.client.createRoom({
        invite: [env.peerUser],
        isDirect: true,
        encrypted: true,
        name: `live-megolm-${Date.now()}`,
      });

      let joined = false;
      for (let i = 0; i < 60; i++) {
        const members = peerSide.bot.client.rooms.joinedMembers(roomId);
        if (members.includes(peerSide.bot.selfId)) {
          joined = true;
          break;
        }
        await sleep(500);
      }
      assert.ok(joined, "peer did not join the encrypted room in time");
      await sleep(2_000);

      await botSide.bot.client.sendText(roomId, `ping ${marker}`);
      const peerCtx = await peerWait.wait();
      assert.match(peerCtx.text, new RegExp(marker));
      assert.equal(peerCtx.roomId, roomId);

      await peerSide.bot.client.sendText(roomId, `pong ${replyMarker}`);
      const botCtx = await botWait.wait();
      assert.match(botCtx.text, new RegExp(replyMarker));
    } finally {
      await peerWait.stop().catch(() => {});
      await botWait.stop().catch(() => {});
    }
  });
});
