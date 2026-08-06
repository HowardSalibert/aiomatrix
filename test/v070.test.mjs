import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALLBACK_ANSWER_EVENT_TYPE,
  ContextFactory,
  InlineKeyboard,
  InsufficientPowerError,
  MemoryStorage,
  RoomCache,
  SignedCallbackRegistry,
  WaitForTimeoutError,
  buildPollStartContent,
  createCryptoSoftBudget,
  once,
  parseCommandArgs,
  RedisTtlStringMap,
} from "../dist/index.js";
import { FakeBot, FakeClient, makeFactory } from "./helpers.mjs";

describe("0.7.0 surfaces", () => {
  it("parseCommandArgs coerces typed tokens", () => {
    const args = parseCommandArgs('@alice:ex.org 3 "hello world"', {
      user: "userId",
      count: "int",
      note: "rest",
    });
    assert.equal(args.user, "@alice:ex.org");
    assert.equal(args.count, 3);
    assert.equal(args.note, "hello world");
  });

  it("InlineKeyboard.paginate adds nav controls", () => {
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    const kb = InlineKeyboard.paginate(items, {
      page: 0,
      pageSize: 4,
      columns: 2,
      dataForItem: (item) => `pick:${item}`,
      navPrefix: "list",
    });
    const flat = kb.buttons.flat();
    assert.ok(flat.some((b) => b.kind === "callback" && b.data === "list:next:0"));
    assert.ok(flat.some((b) => b.data === "pick:item0"));
  });

  it("buildPollStartContent shapes MSC3381 payload", () => {
    const content = buildPollStartContent({
      question: "Lunch?",
      answers: ["Pizza", "Sushi"],
    });
    assert.match(content.body, /^Lunch\?/);
    assert.ok(content["org.matrix.msc3381.poll.start"]);
    assert.equal(content["m.poll.start"].answers.length, 2);
  });

  it("once middleware skips duplicate keys", async () => {
    let runs = 0;
    const mw = once({ key: (ctx) => ctx.eventId });
    const ctx = { eventId: "$same" };
    await mw(ctx, async () => {
      runs += 1;
    });
    await mw(ctx, async () => {
      runs += 1;
    });
    assert.equal(runs, 1);
  });

  it("createCryptoSoftBudget delays when over limit", async () => {
    const hits = [];
    const budget = createCryptoSoftBudget({
      maxShareRoomKeyPerMinute: 1,
      maxDelayMs: 5,
      onSoftBudget: (info) => hits.push(info),
    });
    assert.ok(budget);
    await budget.beforeShareRoomKey();
    await budget.beforeShareRoomKey();
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "share_room_key");
  });

  it("RedisTtlStringMap getAsync reads remote entries", async () => {
    const store = new Map();
    const redis = {
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value) {
        store.set(key, value);
        return "OK";
      },
      async del(...keys) {
        for (const k of keys) store.delete(k);
        return keys.length;
      },
    };
    const map = new RedisTtlStringMap(redis, { prefix: "t:" });
    map.set("a", "token", 60_000);
    assert.equal(await map.getAsync("a"), "token");
  });

  it("aware answerCallback emits toast event", async () => {
    const rooms = new RoomCache();
    const client = new FakeClient({ rooms });
    const callbacks = new SignedCallbackRegistry({ secret: "x".repeat(16) });
    const token = callbacks.issue({
      data: "press",
      roomId: "!r:ex",
      messageEventId: "$kb",
    });
    const bot = new FakeBot(client, callbacks, { clientProfile: "aware" });
    const factory = new ContextFactory({
      bot,
      client,
      logger: bot.logger,
      storage: new MemoryStorage(),
      callbacks,
    });
    const ctx = await factory.fromRoomEvent("!r:ex", {
      event_id: "$cb1",
      sender: "@u:ex",
      type: "dev.aiomatrix.callback",
      content: { token },
    });
    assert.equal(ctx.updateType, "callback_query");
    await ctx.answerCallback({ text: "Saved" });
    assert.ok(client.sent.some((e) => e.type === CALLBACK_ANSWER_EVENT_TYPE));
    assert.ok(!client.sent.some((e) => e.type === "m.room.message" && e.content?.body === "Saved"));
  });

  it("kick refuses without bot power", async () => {
    const rooms = new RoomCache();
    rooms.applyStateEvent("!r:ex", {
      type: "m.room.power_levels",
      content: {
        users: { "@bot:example.org": 0 },
        kick: 50,
        ban: 50,
        invite: 0,
        users_default: 0,
      },
    });
    const { factory, client } = makeFactory({
      rooms,
      selfId: "@bot:example.org",
      clientProfile: "stock",
    });
    client.selfId = "@bot:example.org";
    const ctx = await factory.fromRoomEvent("!r:ex", {
      event_id: "$m",
      sender: "@admin:ex",
      type: "m.room.message",
      content: { msgtype: "m.text", body: "kick" },
    });
    await assert.rejects(() => ctx.kick("@victim:ex"), InsufficientPowerError);
  });

  it("WaitForTimeoutError is exported", () => {
    const err = new WaitForTimeoutError(42);
    assert.equal(err.timeoutMs, 42);
    assert.match(err.message, /42/);
  });

  it("getRepliedMessage loads quote target", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent("!r:ex", {
      event_id: "$reply",
      sender: "@u:ex",
      type: "m.room.message",
      content: {
        msgtype: "m.text",
        body: "re",
        "m.relates_to": { "m.in_reply_to": { event_id: "$orig" } },
      },
    });
    const quoted = await ctx.getRepliedMessage();
    assert.ok(quoted);
    assert.equal(quoted.text, "quoted");
  });
});
