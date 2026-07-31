import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_EVENT_TYPE,
  InlineKeyboard,
  buildMiniAppDataContent,
} from "../dist/index.js";
import { makeFactory, messageContext } from "./helpers.mjs";

const ROOM = "!room:example.org";

function event(type, content, extra = {}) {
  return {
    type,
    event_id: "$e1",
    sender: "@alice:example.org",
    room_id: ROOM,
    content,
    ...extra,
  };
}

describe("ContextFactory classification", () => {
  it("builds a message context", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(ROOM, event("m.room.message", { msgtype: "m.text", body: "hi" }));
    assert.equal(ctx.updateType, "message");
    assert.equal(ctx.text, "hi");
    assert.equal(ctx.body, "hi", "0.1/0.2 alias still works");
    assert.equal(ctx.senderId, "@alice:example.org");
    assert.equal(ctx.eventId, "$e1");
  });

  it("skips a message with no msgtype", async () => {
    const { factory } = makeFactory();
    assert.equal(await factory.fromRoomEvent(ROOM, event("m.room.message", { body: "hi" })), null);
  });

  it("recognises reactions, redactions and polls", async () => {
    const { factory } = makeFactory();
    const reaction = await factory.fromRoomEvent(
      ROOM,
      event("m.reaction", {
        "m.relates_to": { rel_type: "m.annotation", event_id: "$target", key: "👍" },
      }),
    );
    assert.equal(reaction.updateType, "reaction");
    assert.equal(reaction.key, "👍");
    assert.equal(reaction.targetEventId, "$target");

    const redaction = await factory.fromRoomEvent(
      ROOM,
      event("m.room.redaction", { reason: "spam" }, { redacts: "$gone" }),
    );
    assert.equal(redaction.updateType, "redaction");
    assert.equal(redaction.reason, "spam");

    const poll = await factory.fromRoomEvent(
      ROOM,
      event("m.poll.response", {
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
        "org.matrix.msc3381.poll.response": { answers: ["a1"] },
      }),
    );
    assert.equal(poll.updateType, "poll_response");
  });

  it("distinguishes invites from other membership changes", async () => {
    const { factory } = makeFactory();
    const invite = await factory.fromRoomEvent(
      ROOM,
      event("m.room.member", { membership: "invite" }, { state_key: "@bot:example.org" }),
    );
    assert.equal(invite.updateType, "invite");
    assert.equal(invite.subjectId, "@bot:example.org");

    const join = await factory.fromRoomEvent(
      ROOM,
      event("m.room.member", { membership: "join" }, { state_key: "@alice:example.org" }),
    );
    assert.equal(join.updateType, "membership");
    assert.equal(join.membership, "join");
  });

  it("falls back to a raw event context", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(ROOM, event("com.example.custom", { a: 1 }));
    assert.equal(ctx.updateType, "raw_event");
    assert.equal(ctx.eventType, "com.example.custom");
  });

  it("classifies mini app data before message handling", async () => {
    const { factory } = makeFactory();
    const content = buildMiniAppDataContent({
      data: '{"ok":true}',
      queryId: "q1",
      appId: "app",
      messageId: null,
    });
    const ctx = await factory.fromRoomEvent(ROOM, event("m.room.message", content));
    assert.equal(ctx.updateType, "mini_app_data");
    assert.equal(ctx.raw, '{"ok":true}');
    assert.deepEqual(ctx.payload, { ok: true });
    assert.equal(ctx.queryId, "q1");
  });

  it("classifies a button press as a callback query", async () => {
    const harness = makeFactory();
    const token = harness.callbacks.issue({ data: "vote:yes", roomId: ROOM, messageEventId: "$card" });
    const ctx = await harness.factory.fromRoomEvent(
      ROOM,
      event(CALLBACK_EVENT_TYPE, { token }),
    );
    assert.equal(ctx.updateType, "callback_query");
    assert.equal(ctx.callbackData, "vote:yes");
    assert.equal(ctx.messageEventId, "$card");
  });

  it("ignores a callback token replayed in another room", async () => {
    const harness = makeFactory();
    const token = harness.callbacks.issue({ data: "d", roomId: ROOM, messageEventId: "$card" });
    const ctx = await harness.factory.fromRoomEvent(
      "!other:example.org",
      event(CALLBACK_EVENT_TYPE, { token }),
    );
    assert.notEqual(ctx.updateType, "callback_query");
  });

  it("builds a to-device context", async () => {
    const { factory } = makeFactory();
    const ctx = factory.fromToDevice({
      type: "m.room_key_request",
      sender: "@alice:example.org",
      content: { action: "request" },
    });
    assert.equal(ctx.updateType, "to_device");
    assert.equal(ctx.eventType, "m.room_key_request");
    assert.deepEqual(ctx.toDeviceContent, { action: "request" });
  });

  it("marks direct rooms", async () => {
    const direct = await messageContext("hi", { isDirect: true });
    assert.equal(direct.ctx.isDirect, true);
    const group = await messageContext("hi");
    assert.equal(group.ctx.isDirect, false);
  });
});

describe("MessageContext parsing", () => {
  it("reads html only for the custom html format", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.text",
        body: "bold",
        format: "org.matrix.custom.html",
        formatted_body: "<b>bold</b>",
      }),
    );
    assert.equal(ctx.html, "<b>bold</b>");

    const other = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", { msgtype: "m.text", body: "x", format: "other", formatted_body: "<b>x</b>" }),
    );
    assert.equal(other.html, null);
  });

  it("prefers m.new_content for an edit", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.text",
        body: "* corrected",
        "m.new_content": { msgtype: "m.text", body: "corrected" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
      }),
    );
    assert.equal(ctx.updateType, "edited_message");
    assert.equal(ctx.isEdit, true);
    assert.equal(ctx.editsEventId, "$orig");
    assert.equal(ctx.text, "corrected", "handlers see the replacement, not the fallback");
  });

  it("reads a rich reply", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.text",
        body: "> quoted\n\nanswer",
        "m.relates_to": { "m.in_reply_to": { event_id: "$parent" } },
      }),
    );
    assert.equal(ctx.replyToEventId, "$parent");
    assert.equal(ctx.threadRootId, null);
  });

  it("reads a thread relation and ignores its reply fallback", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.text",
        body: "in thread",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          is_falling_back: true,
          "m.in_reply_to": { event_id: "$last" },
        },
      }),
    );
    assert.equal(ctx.threadRootId, "$root");
    assert.equal(ctx.replyToEventId, null, "a falling-back reply is not a real reply");
  });

  it("keeps an explicit reply inside a thread", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.text",
        body: "answer",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$root",
          is_falling_back: false,
          "m.in_reply_to": { event_id: "$specific" },
        },
      }),
    );
    assert.equal(ctx.replyToEventId, "$specific");
  });

  it("reads intentional mentions defensively", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.text",
        body: "hi",
        "m.mentions": { user_ids: ["@bot:example.org", 42], room: true },
      }),
    );
    assert.deepEqual(ctx.mentions.userIds, ["@bot:example.org"]);
    assert.equal(ctx.mentions.room, true);
  });

  it("exposes attachments", async () => {
    const { factory } = makeFactory();
    const ctx = await factory.fromRoomEvent(
      ROOM,
      event("m.room.message", {
        msgtype: "m.image",
        body: "cat.png",
        url: "mxc://hs/abc",
        info: { mimetype: "image/png", size: 3 },
      }),
    );
    assert.equal(ctx.attachment.msgtype, "m.image");
    const bytes = await ctx.downloadAttachment();
    assert.equal(bytes.length, 3);
  });

  it("throws a clear error when downloading from a message with no attachment", async () => {
    const { ctx } = await messageContext("no files here");
    await assert.rejects(ctx.downloadAttachment(), /no attachment/);
  });
});

describe("context send helpers", () => {
  it("answer sends a plain message", async () => {
    const { ctx, client } = await messageContext("hi");
    await ctx.answer("hello");
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].content.body, "hello");
    assert.equal(client.sent[0].content["m.relates_to"], undefined);
  });

  it("reply attaches an in-reply-to relation", async () => {
    const { ctx, client } = await messageContext("hi");
    await ctx.reply("hello");
    assert.deepEqual(client.sent[0].content["m.relates_to"], {
      "m.in_reply_to": { event_id: "$trigger" },
    });
  });

  it("answerHtml derives a plain-text fallback", async () => {
    const { ctx, client } = await messageContext("hi");
    await ctx.answerHtml("<p>Hello <strong>world</strong></p>");
    assert.equal(client.sent[0].content.format, "org.matrix.custom.html");
    assert.match(client.sent[0].content.body, /Hello world/);
  });

  it("threads a reply when asked", async () => {
    const { ctx, client } = await messageContext("hi", {
      content: {
        "m.relates_to": { rel_type: "m.thread", event_id: "$root", is_falling_back: true },
      },
    });
    await ctx.answer("in thread", { thread: true });
    const relation = client.sent[0].content["m.relates_to"];
    assert.equal(relation.rel_type, "m.thread");
    assert.equal(relation.event_id, "$root");
  });

  it("attaches a keyboard and mints tokens bound to the sent event", async () => {
    const { ctx, client, callbacks } = await messageContext("hi");
    await ctx.answer("Pick", { keyboard: new InlineKeyboard().text("Yes", "yes") });
    const keyboard = client.sent[0].content["dev.aiomatrix.keyboard"];
    const token = keyboard.inline[0][0].token;
    assert.equal(callbacks.peek(token).messageEventId, client.sent[0].eventId);
  });

  it("restricts keyboard buttons to the triggering user", async () => {
    const { ctx, client, callbacks } = await messageContext("hi", { sender: "@alice:example.org" });
    await ctx.answer("Pick", { keyboard: new InlineKeyboard().text("Yes", "yes") });
    const token = client.sent[0].content["dev.aiomatrix.keyboard"].inline[0][0].token;
    assert.equal(callbacks.resolve(token, "@mallory:example.org"), null);
    assert.ok(callbacks.resolve(token, "@alice:example.org"));
  });

  it("passes mentions and extra content through", async () => {
    const { ctx, client } = await messageContext("hi");
    await ctx.answer("ping", {
      mentions: { userIds: ["@bob:hs", "@bob:hs"], room: true },
      extra: { "com.example.tag": 1 },
      notice: true,
    });
    const content = client.sent[0].content;
    assert.deepEqual(content["m.mentions"], { user_ids: ["@bob:hs"], room: true });
    assert.equal(content["com.example.tag"], 1);
    assert.equal(content.msgtype, "m.notice");
  });

  it("reacts, redacts, marks read and toggles typing", async () => {
    const { ctx, client } = await messageContext("hi");
    await ctx.react("👍");
    assert.equal(client.sent[0].type, "m.reaction");
    await ctx.deleteMessage("cleanup");
    assert.deepEqual(client.redactions[0], {
      roomId: ROOM,
      eventId: "$trigger",
      reason: "cleanup",
    });
    await ctx.markRead();
    assert.equal(client.receipts[0].eventId, "$trigger");
    await ctx.withTyping(async () => {});
    assert.deepEqual(
      client.typing.map((t) => t.on),
      [true, false],
    );
  });

  it("turns typing off even when the wrapped work throws", async () => {
    const { ctx, client } = await messageContext("hi");
    await assert.rejects(
      ctx.withTyping(async () => {
        throw new Error("boom");
      }),
    );
    assert.deepEqual(
      client.typing.map((t) => t.on),
      [true, false],
    );
  });

  it("exposes power levels from the room cache", async () => {
    const { ctx } = await messageContext("hi", {
      powerLevels: { users: { "@alice:example.org": 75 }, users_default: 10 },
    });
    assert.equal(ctx.powerLevelOf(), 75);
    assert.equal(ctx.powerLevelOf("@rando:hs"), 10);
    assert.equal(ctx.powerLevels().usersDefault, 10);
  });

  it("gives each context its own scratch data bag", async () => {
    const first = await messageContext("a");
    const second = await messageContext("b");
    first.ctx.data.userName = "Alice";
    assert.equal(second.ctx.data.userName, undefined);
  });
});
