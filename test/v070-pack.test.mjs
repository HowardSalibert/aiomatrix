import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  F,
  InlineKeyboard,
  Router,
  buildPollStartContent,
  createOtelMetricHandler,
  editMessageWithOptions,
  mapBotError,
  parseHostCapabilities,
  roomThrottle,
  txnIdFromIdempotencyKey,
  InsufficientPowerError,
  Command,
} from "../dist/index.js";
import { makeFactory } from "./helpers.mjs";

describe("0.7.0 patch pack (1-17)", () => {
  it("idempotencyKey hashes to stable txn id", () => {
    const a = txnIdFromIdempotencyKey("room:cmd:evt");
    const b = txnIdFromIdempotencyKey("room:cmd:evt");
    assert.equal(a, b);
    assert.match(a, /^aio[0-9a-f]+$/);
  });

  it("editMessageWithOptions rebinds keyboard", async () => {
    const { client, callbacks } = makeFactory();
    const kb = new InlineKeyboard().text("A", "a");
    const eventId = await editMessageWithOptions(
      { client, roomId: "!r:ex", callbacks },
      "$old",
      { text: "edited" },
      { keyboard: kb, keyboardFallback: false },
    );
    assert.ok(eventId);
    assert.ok(client.sent.some((e) => e.content?.["m.relates_to"]?.rel_type === "m.replace"));
    assert.ok(client.sent.some((e) => e.content?.["m.new_content"]?.["dev.aiomatrix.keyboard"]));
  });

  it("mapBotError hides internals for InsufficientPowerError", () => {
    const mapped = mapBotError(
      new InsufficientPowerError("kick", 50, 0, "!r:ex"),
    );
    assert.equal(mapped.code, "insufficient_power");
    assert.ok(!mapped.text.includes("!r:ex"));
  });

  it("roomThrottle drops excess room updates", async () => {
    let ran = 0;
    const mw = roomThrottle({ limit: 1, windowMs: 60_000 });
    const ctx = { roomId: "!r:ex", senderId: "@a:ex" };
    await mw(ctx, async () => {
      ran += 1;
    });
    await mw(ctx, async () => {
      ran += 1;
    });
    assert.equal(ran, 1);
  });

  it("F.callbackData.equals and F.magic compose", async () => {
    const eq = F.callbackData.equals("go");
    assert.equal(await eq({ callbackData: "go" }), true);
    assert.equal(await eq({ callbackData: "no" }), false);
    const magic = F.magic(F.room.dm, F.from.user("@u:ex"));
    assert.equal(
      await magic.and(F.hasPower(0))({
        isDirect: true,
        senderId: "@u:ex",
        powerLevelOf: () => 10,
      }),
      true,
    );
  });

  it("Router.include filter scopes children", async () => {
    const parent = new Router("p");
    const child = new Router("c");
    let hit = false;
    child.message(async () => {
      hit = true;
    });
    parent.include(child, { filter: F.room.dm });
    const groupCtx = {
      updateType: "message",
      isDirect: false,
      roomId: "!g:ex",
      senderId: "@u:ex",
      text: "hi",
      data: {},
    };
    const dmCtx = { ...groupCtx, isDirect: true };
    assert.equal(await parent.feed(groupCtx), false);
    assert.equal(hit, false);
    assert.equal(await parent.feed(dmCtx), true);
    assert.equal(hit, true);
  });

  it("Command argsSchema fills ctx.data.args", async () => {
    const { factory } = makeFactory();
    const filter = Command("ban", {
      argsSchema: { user: "userId", days: { kind: "int", optional: true, default: 1 } },
    });
    const ctx = await factory.fromRoomEvent("!r:ex", {
      event_id: "$1",
      sender: "@mod:ex",
      type: "m.room.message",
      content: { msgtype: "m.text", body: "!ban @victim:ex.org 3" },
    });
    assert.equal(await filter(ctx), true);
    assert.equal(ctx.data.args.user, "@victim:ex.org");
    assert.equal(ctx.data.args.days, 3);
  });

  it("lean poll body omits answer list", () => {
    const lean = buildPollStartContent({
      question: "Q?",
      answers: ["a", "b"],
      leanBody: true,
    });
    assert.equal(lean.body, "Q?");
    assert.equal(lean["dev.aiomatrix.poll"].lean, true);
  });

  it("parseHostCapabilities defaults conservatively", () => {
    const stock = parseHostCapabilities({});
    assert.equal(stock.profile, "stock");
    assert.equal(stock.toast, false);
    const aware = parseHostCapabilities({ client_profile: "aware" });
    assert.equal(aware.toast, true);
  });

  it("createOtelMetricHandler fans out counters", () => {
    const seen = [];
    const handler = createOtelMetricHandler({
      getCounter: (name) => ({
        add: (v, attrs) => seen.push({ name, v, attrs }),
      }),
    });
    handler({ name: "update.handled", labels: { type: "message" } });
    assert.equal(seen.length, 1);
    assert.match(seen[0].name, /update\.handled$/);
  });
});
