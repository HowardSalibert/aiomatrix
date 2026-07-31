import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { F, and, mentioned, not, or } from "../dist/index.js";
import { makeFactory, messageContext } from "./helpers.mjs";

const ROOM = "!room:example.org";

async function msg(text, options) {
  return (await messageContext(text, options)).ctx;
}

describe("F.text matchers", () => {
  it("passes for any non-empty text", async () => {
    assert.equal(await F.text(await msg("hi")), true);
    assert.equal(await F.text(await msg("   ")), false);
  });

  it("matches equals/contains/startsWith/endsWith case-insensitively by default", async () => {
    const ctx = await msg("Hello World");
    assert.equal(await F.text.equals("hello world")(ctx), true);
    assert.equal(await F.text.equals("hello world", { ignoreCase: false })(ctx), false);
    assert.equal(await F.text.contains("LO WO")(ctx), true);
    assert.equal(await F.text.startsWith("hello")(ctx), true);
    assert.equal(await F.text.endsWith("world")(ctx), true);
  });

  it("matches a set of values", async () => {
    const filter = F.text.in(["yes", "no"]);
    assert.equal(await filter(await msg("YES")), true);
    assert.equal(await filter(await msg("maybe")), false);
  });

  it("stores regexp captures on ctx.data.match", async () => {
    const ctx = await msg("order 42 please");
    assert.equal(await F.text.regexp(/order (\d+)/)(ctx), true);
    assert.equal(ctx.data.match[1], "42");
  });

  it("reuses a global regexp across calls", async () => {
    const filter = F.text.regexp(/\d+/g);
    assert.equal(await filter(await msg("1")), true);
    assert.equal(await filter(await msg("2")), true);
  });

  it("measures length in code points, not UTF-16 units", async () => {
    const filter = F.text.len((n) => n === 2);
    assert.equal(await filter(await msg("👍👍")), true);
  });

  it("folds Unicode before comparing", async () => {
    assert.equal(await F.text.equals("ПРИВЕТ")(await msg("привет")), true);
  });
});

describe("F content-type filters", () => {
  it("matches msgtypes", async () => {
    const image = await msg("cat.png", { msgtype: "m.image", content: { url: "mxc://hs/a" } });
    assert.equal(await F.image(image), true);
    assert.equal(await F.text(image), true, "an image still carries a body");
    assert.equal(await F.file(image), false);
    assert.equal(await F.msgtype("m.image", "m.video")(image), true);
    assert.equal(await F.hasAttachment(image), true);
  });

  it("detects notices and emotes", async () => {
    assert.equal(await F.notice(await msg("x", { msgtype: "m.notice" })), true);
    assert.equal(await F.emote(await msg("x", { msgtype: "m.emote" })), true);
  });

  it("detects html bodies", async () => {
    const plain = await msg("x");
    assert.equal(await F.html(plain), false);
    const rich = await msg("x", {
      content: { format: "org.matrix.custom.html", formatted_body: "<b>x</b>" },
    });
    assert.equal(await F.html(rich), true);
  });

  it("detects replies, threads and edits", async () => {
    const reply = await msg("x", {
      content: { "m.relates_to": { "m.in_reply_to": { event_id: "$p" } } },
    });
    assert.equal(await F.reply(reply), true);
    assert.equal(await F.thread(reply), false);

    const threaded = await msg("x", {
      content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root" } },
    });
    assert.equal(await F.thread(threaded), true);

    const edit = await msg("* x", {
      content: {
        "m.relates_to": { rel_type: "m.replace", event_id: "$o" },
        "m.new_content": { msgtype: "m.text", body: "x" },
      },
    });
    assert.equal(await F.edited(edit), true);
  });
});

describe("F room and sender filters", () => {
  it("separates DMs from group rooms", async () => {
    assert.equal(await F.room.dm(await msg("x", { isDirect: true })), true);
    assert.equal(await F.room.group(await msg("x")), true);
  });

  it("matches specific rooms", async () => {
    const ctx = await msg("x");
    assert.equal(await F.room.is(ROOM)(ctx), true);
    assert.equal(await F.room.in(["!other:hs", ROOM])(ctx), true);
    assert.equal(await F.room.is("!other:hs")(ctx), false);
  });

  it("reads encryption from the cache without blocking", async () => {
    const harness = makeFactory();
    harness.client.rooms.setEncrypted(ROOM, "m.megolm.v1.aes-sha2");
    const ctx = (await messageContext("x", { harness })).ctx;
    assert.equal(await F.room.encrypted(ctx), true);

    const plainHarness = makeFactory();
    const plain = (await messageContext("x", { harness: plainHarness })).ctx;
    assert.equal(await F.room.encrypted(plain), false, "unknown is treated as not encrypted");
  });

  it("matches senders, servers and self", async () => {
    const ctx = await msg("x", { sender: "@alice:example.org" });
    assert.equal(await F.from.user("@alice:example.org")(ctx), true);
    assert.equal(await F.from.users(["@bob:hs", "@alice:example.org"])(ctx), true);
    assert.equal(await F.from.server("example.org")(ctx), true);
    assert.equal(await F.from.server("other.org")(ctx), false);
    assert.equal(await F.from.self(ctx), false);

    const own = await msg("x", { sender: "@bot:example.org" });
    assert.equal(await F.from.self(own), true);
  });

  it("checks power levels", async () => {
    const admin = await msg("x", { powerLevels: { users: { "@alice:example.org": 100 } } });
    assert.equal(await F.isAdmin(admin), true);
    assert.equal(await F.isModerator(admin), true);
    assert.equal(await F.hasPower(50)(admin), true);

    const plain = await msg("x");
    assert.equal(await F.isModerator(plain), false);
    assert.equal(await F.hasPower(0)(plain), true);
  });
});

describe("mentions", () => {
  it("matches intentional mentions", async () => {
    const ctx = await msg("hey", {
      content: { "m.mentions": { user_ids: ["@bot:example.org"] } },
    });
    assert.equal(await F.mentionsMe(ctx), true);
  });

  it("matches an @room mention", async () => {
    const ctx = await msg("everyone", { content: { "m.mentions": { room: true } } });
    assert.equal(await F.mentionsMe(ctx), true);
  });

  it("falls back to the plain-text body", async () => {
    const ctx = await msg("hey @bot can you help");
    assert.equal(await F.mentionsMe(ctx), true);
    assert.equal(await F.mention("bot")(ctx), true);
    assert.equal(await F.mention("someone-else")(ctx), false);
  });

  it("looks inside the HTML pill", async () => {
    const ctx = await msg("hey", {
      content: {
        format: "org.matrix.custom.html",
        formatted_body: '<a href="https://matrix.to/#/@bot:example.org">Bot</a> hi',
      },
    });
    assert.equal(await F.mentionsMe(ctx), true);
  });

  it("exposes the legacy mentioned() helper", async () => {
    const ctx = await msg("ping @bot");
    assert.equal(mentioned(ctx, "bot"), true);
    assert.equal(mentioned(ctx, ""), false);
  });
});

describe("update-specific filters", () => {
  it("filters reactions by key and target", () => {
    const ctx = { key: "👍", targetEventId: "$t", data: {} };
    assert.equal(F.reaction.key("👍", "👎")(ctx), true);
    assert.equal(F.reaction.key("❤️")(ctx), false);
    assert.equal(F.reaction.on("$t")(ctx), true);
  });

  it("filters callback data", () => {
    const ctx = { callbackData: "vote:yes", data: {} };
    assert.equal(F.callback.data("vote:yes")(ctx), true);
    assert.equal(F.callback.startsWith("vote:")(ctx), true);
    assert.equal(F.callback.regexp(/^vote:(\w+)$/)(ctx), true);
    assert.equal(ctx.data.match[1], "yes");
  });

  it("filters mini app payloads", () => {
    const ctx = { appId: "schedule", payload: { action: "submit", id: 7 }, data: {} };
    assert.equal(F.miniApp.app("schedule")(ctx), true);
    assert.equal(F.miniApp.app("other")(ctx), false);
    assert.equal(F.miniApp.action("submit", "cancel")(ctx), true);
    assert.equal(F.miniApp.field("id", 7)(ctx), true);
    assert.equal(F.miniApp.field("id")(ctx), true);
    assert.equal(F.miniApp.field("missing")(ctx), false);
    assert.equal(F.miniApp.action("submit")({ payload: "not json", data: {} }), false);
  });

  it("filters membership transitions", () => {
    const joined = { membership: "join", previousMembership: "invite", isSelf: false };
    assert.equal(F.membership.joined(joined), true);
    assert.equal(F.membership.is("join", "leave")(joined), true);

    const profileChange = { membership: "join", previousMembership: "join", isSelf: false };
    assert.equal(F.membership.joined(profileChange), false, "a profile edit is not a join");

    assert.equal(F.membership.left({ membership: "leave" }), true);
    assert.equal(F.membership.banned({ membership: "ban" }), true);
    assert.equal(F.membership.invited({ membership: "invite" }), true);
    assert.equal(F.membership.isSelf({ membership: "join", isSelf: true }), true);
  });
});

describe("combinators", () => {
  it("and/or/not compose", async () => {
    const ctx = await msg("hello world");
    assert.equal(await and(F.text, F.text.contains("hello"))(ctx), true);
    assert.equal(await and(F.text, F.text.contains("nope"))(ctx), false);
    assert.equal(await or(F.text.contains("nope"), F.text.contains("world"))(ctx), true);
    assert.equal(await not(F.text.contains("nope"))(ctx), true);
    assert.equal(await F.and(F.text, F.room.group)(ctx), true);
  });

  it("short-circuits and() on the first failure", async () => {
    let called = false;
    const spy = () => {
      called = true;
      return true;
    };
    await and(() => false, spy)(await msg("x"));
    assert.equal(called, false);
  });

  it("wraps an arbitrary predicate", async () => {
    const filter = F.custom((ctx) => ctx.text.length === 1);
    assert.equal(await filter(await msg("x")), true);
  });
});
