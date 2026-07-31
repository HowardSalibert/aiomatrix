import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Bot,
  Command,
  ConfigurationError,
  Dispatcher,
  InlineKeyboard,
  MiniAppAuthError,
  Router,
  validateInitData,
} from "../dist/index.js";

const ROOM = "!room:example.org";
const USER = "@alice:example.org";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbbot-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Homeserver stub covering everything Bot.create + a quiet sync loop need. */
function homeserver(overrides = {}) {
  const requests = [];
  let syncs = 0;
  const impl = async (url, init) => {
    const parsed = new URL(String(url));
    const route = decodeURIComponent(parsed.pathname);
    const body = init?.body ? JSON.parse(init.body) : null;
    requests.push({ method: init?.method ?? "GET", route, body, search: parsed.searchParams });

    let payload;
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (route.includes(pattern)) {
        payload = typeof handler === "function" ? await handler(body, parsed) : handler;
        break;
      }
    }
    if (payload === undefined) {
      if (route.endsWith("/account/whoami")) {
        payload = { user_id: "@bot:example.org", device_id: "DEVICE" };
      } else if (route.includes("/filter")) {
        payload = { filter_id: "1" };
      } else if (route.endsWith("/sync")) {
        syncs += 1;
        // First response primes next_batch; later ones long-poll like a real
        // homeserver so the loop idles instead of spinning.
        if (syncs > 1) await longPoll(init?.signal);
        payload = { next_batch: `s${syncs}` };
      } else if (route.includes("/send/") || route.includes("/state/")) {
        payload = { event_id: `$evt${requests.length}` };
      } else {
        payload = {};
      }
    }
    return new Response(JSON.stringify(payload), {
      status: payload?.__status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  impl.requests = requests;
  return impl;
}

function longPoll(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function makeBot(options = {}) {
  const fetchImpl = options.fetchImpl ?? homeserver();
  const bot = await Bot.create({
    homeserverUrl: "https://hs.example.org",
    accessToken: "tok",
    crypto: false,
    storagePath: dir,
    logger: "silent",
    fetchImpl,
    ...options,
  });
  return { bot, fetchImpl };
}

describe("Bot.create", () => {
  it("builds a bot from an access token with crypto off", async () => {
    const { bot } = await makeBot();
    assert.equal(bot.selfId, "@bot:example.org");
    assert.equal(bot.getDeviceId(), "DEVICE");
    assert.equal(bot.cryptoEnabled, false);
    assert.equal(bot.cryptoReady, false);
    assert.equal(bot.isRunning, false);
  });

  it("requires an access token or a password", async () => {
    await assert.rejects(
      Bot.create({
        homeserverUrl: "https://hs.example.org",
        crypto: false,
        storagePath: dir,
        logger: "silent",
        fetchImpl: homeserver(),
      }),
      ConfigurationError,
    );
  });

  it("refuses a deviceId that contradicts the token", async () => {
    await assert.rejects(
      makeBot({ deviceId: "WRONG" }),
      (err) => /WRONG/.test(String(err.message)) && /DEVICE/.test(String(err.message)),
    );
  });

  it("insists on a deviceId when crypto is enabled", async () => {
    await assert.rejects(
      Bot.create({
        homeserverUrl: "https://hs.example.org",
        accessToken: "tok",
        storagePath: dir,
        logger: "silent",
        fetchImpl: homeserver({ "/account/whoami": { user_id: "@bot:example.org" } }),
      }),
      /deviceId is REQUIRED/,
    );
  });

  it("logs in with a password and reuses the session next time", async () => {
    let logins = 0;
    const fetchImpl = homeserver({
      "/login": () => {
        logins += 1;
        return {
          user_id: "@bot:example.org",
          device_id: "DEVICE",
          access_token: "from-login",
        };
      },
    });
    const options = {
      homeserverUrl: "https://hs.example.org",
      userId: "@bot:example.org",
      password: "pw",
      crypto: false,
      storagePath: dir,
      logger: "silent",
      fetchImpl,
    };
    await Bot.create(options);
    assert.equal(logins, 1);
    await Bot.create(options);
    assert.equal(logins, 1, "the persisted session was reused");
    assert.ok(fs.existsSync(path.join(dir, "session.json")));
  });
});

describe("lifecycle", () => {
  it("starts, reports health and stops", async () => {
    const { bot } = await makeBot();
    const dp = new Dispatcher();
    await bot.start(dp);
    assert.equal(bot.isRunning, true);

    const health = bot.getHealth();
    assert.equal(health.running, true);
    assert.equal(health.userId, "@bot:example.org");
    assert.equal(health.deviceId, "DEVICE");
    assert.equal(health.cryptoEnabled, false);
    assert.equal(typeof health.syncAgeMs, "number");
    assert.equal(health.pendingCallbacks, 0);
    assert.equal(health.pendingMiniAppQueries, 0);

    await bot.stop();
    assert.equal(bot.isRunning, false);
  });

  it("refuses to start twice", async () => {
    const { bot } = await makeBot();
    const dp = new Dispatcher();
    await bot.start(dp);
    await assert.rejects(bot.start(dp), ConfigurationError);
    await bot.stop();
  });

  it("is safe to stop twice", async () => {
    const { bot } = await makeBot();
    await bot.start(new Dispatcher());
    await bot.stop();
    await bot.stop();
  });

  it("collects command specs from the dispatcher on start", async () => {
    const { bot } = await makeBot();
    const dp = new Dispatcher();
    const router = new Router();
    router.message(Command("ping", { description: "Check liveness" }), () => {});
    router.message(Command("secret", { hidden: true }), () => {});
    dp.include(router);

    await bot.start(dp);
    const names = bot.commands.list().map((s) => s.name);
    assert.ok(names.includes("ping"));
    assert.match(bot.helpText(), /ping/);
    assert.doesNotMatch(bot.helpText(), /secret/, "hidden commands stay out of help");
    await bot.stop();
  });

  it("adds extra command specs and advertises them as room state", async () => {
    const { bot, fetchImpl } = await makeBot();
    bot.addCommands([{ name: "digest", description: "Daily digest" }]);
    assert.throws(() => bot.addCommands([{ description: "no name" }]), ConfigurationError);
    assert.match(bot.helpText(), /digest/);
    assert.match(bot.helpHtml(), /digest/);

    await bot.advertiseCommands(ROOM);
    const call = fetchImpl.requests.find((r) => r.route.includes("/state/"));
    assert.match(call.route, /dev\.aiomatrix\.commands/);
    assert.ok(Array.isArray(call.body.commands));
  });
});

describe("dispatching", () => {
  async function started(overrides) {
    const { bot, fetchImpl } = await makeBot(overrides);
    const dp = new Dispatcher();
    const seen = [];
    dp.use(async (ctx, next) => {
      seen.push(ctx);
      await next();
    });
    await bot.start(dp);
    return { bot, dp, seen, fetchImpl };
  }

  it("feeds room messages into the dispatcher", async () => {
    const { bot, seen } = await started();
    await bot.feedRoomEvent(ROOM, {
      type: "m.room.message",
      event_id: "$a",
      sender: USER,
      content: { msgtype: "m.text", body: "hello" },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].updateType, "message");
    assert.equal(seen[0].text, "hello");
    await bot.stop();
  });

  it("never dispatches the bot's own echoes", async () => {
    const { bot, seen } = await started();
    await bot.feedRoomEvent(ROOM, {
      type: "m.room.message",
      event_id: "$a",
      sender: "@bot:example.org",
      content: { msgtype: "m.text", body: "echo" },
    });
    assert.equal(seen.length, 0);
    await bot.stop();
  });

  it("swallows handler errors instead of killing the sync loop", async () => {
    const { bot, dp } = await makeBot().then(async ({ bot }) => {
      const dp = new Dispatcher();
      dp.message(() => {
        throw new Error("handler exploded");
      });
      await bot.start(dp);
      return { bot, dp };
    });
    await bot.feedRoomEvent(ROOM, {
      type: "m.room.message",
      event_id: "$a",
      sender: USER,
      content: { msgtype: "m.text", body: "boom" },
    });
    assert.equal(bot.isRunning, true);
    await bot.stop();
    await dp.close();
  });

  it("turns an invite for itself into an invite update", async () => {
    const { bot, seen } = await started();
    await bot.feedInvite(ROOM, [
      {
        type: "m.room.member",
        state_key: "@bot:example.org",
        sender: USER,
        content: { membership: "invite" },
      },
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].updateType, "invite");
    await bot.stop();
  });

  it("ignores invites addressed to somebody else", async () => {
    const { bot, seen } = await started();
    await bot.feedInvite(ROOM, [
      {
        type: "m.room.member",
        state_key: "@someone:example.org",
        sender: USER,
        content: { membership: "invite" },
      },
    ]);
    assert.equal(seen.length, 0);
    await bot.stop();
  });

  it("filters crypto plumbing out of to-device updates", async () => {
    const { bot, seen } = await started();
    for (const type of ["m.room_key", "m.room_key_request", "m.dummy", "m.room.encrypted"]) {
      await bot.feedToDevice({ type, sender: USER, content: {} });
    }
    assert.equal(seen.length, 0);
    await bot.feedToDevice({ type: "com.example.ping", sender: USER, content: {} });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].updateType, "to_device");
    await bot.stop();
  });

  it("stops dispatching once stopped", async () => {
    const { bot, seen } = await started();
    await bot.stop();
    await bot.feedRoomEvent(ROOM, {
      type: "m.room.message",
      event_id: "$a",
      sender: USER,
      content: { msgtype: "m.text", body: "late" },
    });
    assert.equal(seen.length, 0);
  });
});

describe("inline keyboard callbacks", () => {
  it("resolves a token minted for the room it is used in", async () => {
    const { bot } = await makeBot();
    const token = bot.callbacks.issue({
      roomId: ROOM,
      data: "vote:yes",
      messageEventId: "$card",
      userId: USER,
    });
    const read = bot.readCallbackEvent(ROOM, {
      type: "dev.aiomatrix.callback",
      sender: USER,
      content: { token },
    });
    assert.equal(read.callbackData, "vote:yes");
    assert.equal(read.messageEventId, "$card");
    assert.equal(read.queryId, token);
  });

  it("refuses a token replayed in another room", async () => {
    const { bot } = await makeBot();
    const token = bot.callbacks.issue({ roomId: ROOM, data: "x", messageEventId: "$c" });
    assert.equal(
      bot.readCallbackEvent("!other:example.org", {
        type: "dev.aiomatrix.callback",
        sender: USER,
        content: { token },
      }),
      null,
    );
  });

  it("refuses a token bound to a different user", async () => {
    const { bot } = await makeBot();
    const token = bot.callbacks.issue({
      roomId: ROOM,
      data: "x",
      messageEventId: "$c",
      userId: "@owner:example.org",
    });
    assert.equal(
      bot.readCallbackEvent(ROOM, {
        type: "dev.aiomatrix.callback",
        sender: "@intruder:example.org",
        content: { token },
      }),
      null,
    );
  });

  it("accepts the plain-text !cb fallback", async () => {
    const { bot } = await makeBot();
    const token = bot.callbacks.issue({ roomId: ROOM, data: "page:2", messageEventId: "$c" });
    const read = bot.readCallbackEvent(ROOM, {
      type: "m.room.message",
      sender: USER,
      content: { msgtype: "m.text", body: `!cb ${token}` },
    });
    assert.equal(read.callbackData, "page:2");
  });

  it("ignores unrelated messages and unknown tokens", async () => {
    const { bot } = await makeBot();
    assert.equal(
      bot.readCallbackEvent(ROOM, {
        type: "m.room.message",
        sender: USER,
        content: { msgtype: "m.text", body: "just chatting" },
      }),
      null,
    );
    assert.equal(
      bot.readCallbackEvent(ROOM, {
        type: "dev.aiomatrix.callback",
        sender: USER,
        content: { token: "made-up" },
      }),
      null,
    );
  });

  it("passes through a client-supplied payload when no token was minted", async () => {
    const { bot } = await makeBot();
    const read = bot.readCallbackEvent(ROOM, {
      type: "dev.aiomatrix.callback",
      sender: USER,
      content: { data: "raw:1", message_id: "$c" },
    });
    assert.equal(read.callbackData, "raw:1");
    assert.equal(read.queryId, "");
  });

  it("sends a keyboard whose buttons carry tokens for this room", async () => {
    const { bot, fetchImpl } = await makeBot();
    const keyboard = new InlineKeyboard().text("Yes", "vote:yes").text("No", "vote:no");
    await bot.sendMessage(ROOM, "Pick one", { keyboard });
    const sent = fetchImpl.requests.find((r) => r.route.includes("/send/"));
    const buttons = sent.body["dev.aiomatrix.keyboard"].inline.flat();
    assert.equal(buttons.length, 2);
    for (const button of buttons) {
      const record = bot.callbacks.peek(button.token);
      assert.equal(record.roomId, ROOM);
    }
  });
});

describe("MiniApp signing secret", () => {
  it("generates and persists a secret on first use", async () => {
    const { bot } = await makeBot();
    const secret = bot.miniAppSigningSecret;
    assert.ok(secret.length >= 32);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "miniapp.json"), "utf8")).secret, secret);

    const again = await makeBot();
    assert.equal(again.bot.miniAppSigningSecret, secret, "the secret survives a restart");
  });

  it("uses an explicitly configured secret", async () => {
    const { bot } = await makeBot({ miniApp: { secret: "x".repeat(24) } });
    assert.equal(bot.miniAppSigningSecret, "x".repeat(24));
  });

  it("rejects a weak configured secret", async () => {
    await assert.rejects(makeBot({ miniApp: { secret: "short" } }), ConfigurationError);
  });

  it("rejects a malformed defaultUrl", async () => {
    await assert.rejects(makeBot({ miniApp: { defaultUrl: "not a url" } }), ConfigurationError);
  });
});

describe("createMiniAppLaunch", () => {
  const miniApp = { defaultUrl: "https://app.example.org/" };

  it("signs launch data the mini app backend can verify", async () => {
    const { bot } = await makeBot({ miniApp });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM, startParam: "week=3" });

    const fragment = new URLSearchParams(new URL(launch.url).hash.replace(/^#/, ""));
    const initData = fragment.get("matrixWebAppData");
    const validated = validateInitData(initData, bot.miniAppSigningSecret);
    assert.equal(validated.user.id, USER);
    assert.equal(validated.room.id, ROOM);
    assert.equal(validated.startParam, "week=3");
    assert.equal(validated.botId, "@bot:example.org");
    assert.equal(validated.queryId, launch.queryId);
  });

  it("registers a query so sendData can be answered once", async () => {
    const { bot } = await makeBot({ miniApp });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM });
    assert.equal(bot.miniAppQueries.peek(launch.queryId).userId, USER);
  });

  it("skips the query when no round trip is expected", async () => {
    const { bot } = await makeBot({ miniApp });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM, withoutQuery: true });
    assert.equal(launch.queryId, null);
    assert.equal(bot.miniAppQueries.size, 0);
  });

  it("marks direct rooms in the signed payload", async () => {
    const { bot } = await makeBot({ miniApp });
    bot.client.rooms.applyDirectAccountData({ [USER]: [ROOM] });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM });
    const initData = new URLSearchParams(new URL(launch.url).hash.replace(/^#/, "")).get(
      "matrixWebAppData",
    );
    assert.equal(validateInitData(initData, bot.miniAppSigningSecret).room.type, "direct");
  });

  it("needs a url from somewhere", async () => {
    const { bot } = await makeBot();
    assert.throws(() => bot.createMiniAppLaunch({ userId: USER, roomId: ROOM }), ConfigurationError);
  });

  it("enforces the origin allowlist", async () => {
    const { bot } = await makeBot({
      miniApp: { ...miniApp, allowedOrigins: ["https://app.example.org"] },
    });
    assert.doesNotThrow(() =>
      bot.createMiniAppLaunch({ url: "https://app.example.org/x", userId: USER, roomId: ROOM }),
    );
    assert.throws(
      () => bot.createMiniAppLaunch({ url: "https://evil.example.org/", userId: USER, roomId: ROOM }),
      MiniAppAuthError,
    );
  });

  it("derives the allowlist from defaultUrl when none is given", async () => {
    const { bot } = await makeBot({ miniApp });
    assert.throws(
      () => bot.createMiniAppLaunch({ url: "https://evil.example.org/", userId: USER, roomId: ROOM }),
      MiniAppAuthError,
    );
  });
});

describe("sendMiniApp", () => {
  const miniApp = { defaultUrl: "https://app.example.org/" };

  it("posts a launch card with a signed per-user URL", async () => {
    const { bot, fetchImpl } = await makeBot({ miniApp });
    await bot.sendMiniApp(ROOM, { title: "Schedule", userId: USER });
    const sent = fetchImpl.requests.find((r) => r.route.includes("/send/"));
    const card = sent.body["dev.aiomatrix.mini_app"];
    assert.equal(card.title, "Schedule");
    assert.match(card.url, /#matrixWebAppData=/);
    assert.equal(card.bot_id, "@bot:example.org");
  });

  it("posts a plain card when no user is given", async () => {
    const { bot, fetchImpl } = await makeBot({ miniApp });
    await bot.sendMiniApp(ROOM, { title: "Schedule" });
    const card = fetchImpl.requests.find((r) => r.route.includes("/send/")).body[
      "dev.aiomatrix.mini_app"
    ];
    assert.equal(card.url, "https://app.example.org/");
  });

  it("needs a url", async () => {
    const { bot } = await makeBot();
    await assert.rejects(bot.sendMiniApp(ROOM, { title: "x" }), ConfigurationError);
  });
});

describe("answerMiniAppQuery", () => {
  const miniApp = { defaultUrl: "https://app.example.org/" };

  it("answers into the room the mini app was launched from", async () => {
    const { bot, fetchImpl } = await makeBot({ miniApp });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM, messageId: "$card" });
    const eventId = await bot.answerMiniAppQuery(launch.queryId, "Saved");
    assert.ok(eventId);
    const sent = fetchImpl.requests.find((r) => r.route.includes("/send/"));
    assert.ok(sent.route.includes(ROOM), "answered into the launching room");
    assert.equal(sent.body.body, "Saved");
  });

  it("answers at most once", async () => {
    const { bot } = await makeBot({ miniApp });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM });
    assert.ok(await bot.answerMiniAppQuery(launch.queryId, "first"));
    assert.equal(await bot.answerMiniAppQuery(launch.queryId, "second"), null);
  });

  it("returns null for an unknown query", async () => {
    const { bot } = await makeBot({ miniApp });
    assert.equal(await bot.answerMiniAppQuery("nope", "hi"), null);
  });

  it("releases the query when sending fails so the mini app can retry", async () => {
    let fail = true;
    const fetchImpl = homeserver({
      "/send/": () => {
        if (!fail) return { event_id: "$ok" };
        fail = false;
        return { __status: 500, error: "boom" };
      },
    });
    const { bot } = await makeBot({ miniApp, fetchImpl, retry: { maxRetries: 0 } });
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM });
    await assert.rejects(bot.answerMiniAppQuery(launch.queryId, "first"));
    assert.ok(await bot.answerMiniAppQuery(launch.queryId, "retry"));
  });
});

describe("mini app data from the HTTP bridge", () => {
  const miniApp = { defaultUrl: "https://app.example.org/" };

  it("refuses to dispatch before the bot is started", async () => {
    const { bot } = await makeBot({ miniApp });
    await assert.rejects(
      bot.feedMiniAppData({ userId: USER, roomId: ROOM }, "{}"),
      ConfigurationError,
    );
  });

  it("feeds a payload as a mini_app_data update", async () => {
    const { bot } = await makeBot({ miniApp });
    const dp = new Dispatcher();
    const seen = [];
    dp.miniAppData((ctx) => seen.push(ctx));
    await bot.start(dp);

    const launch = bot.createMiniAppLaunch({
      userId: USER,
      roomId: ROOM,
      messageId: "$card",
      appId: "schedule",
    });
    const ctx = await bot.feedMiniAppData(
      { userId: USER, queryId: launch.queryId },
      JSON.stringify({ action: "submit" }),
    );
    assert.equal(seen.length, 1);
    assert.equal(ctx.roomId, ROOM, "the room comes from the query registry");
    assert.equal(ctx.appId, "schedule");
    assert.equal(ctx.eventId, "$card", "the launching card is the reply target");
    assert.deepEqual(ctx.payload, { action: "submit" });
    await bot.stop();
  });

  it("drops a payload with no room context", async () => {
    const { bot } = await makeBot({ miniApp });
    await bot.start(new Dispatcher());
    assert.equal(await bot.feedMiniAppData({ userId: USER }, "{}"), null);
    await bot.stop();
  });

  it("wires createMiniAppServer to the dispatcher by default", async () => {
    const { bot } = await makeBot({ miniApp });
    const dp = new Dispatcher();
    const seen = [];
    dp.miniAppData((ctx) => seen.push(ctx.raw));
    await bot.start(dp);

    const server = bot.createMiniAppServer();
    const launch = bot.createMiniAppLaunch({ userId: USER, roomId: ROOM });
    const initData = new URLSearchParams(new URL(launch.url).hash.replace(/^#/, "")).get(
      "matrixWebAppData",
    );
    const auth = server.authenticate(initData);
    const response = await server.handle({
      method: "POST",
      url: "/data",
      headers: { authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ data: "hello" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, ["hello"]);
    await bot.stop();
  });
});

describe("widgets", () => {
  it("pins a widget and sets the Element layout", async () => {
    const { bot, fetchImpl } = await makeBot();
    await bot.pinMiniAppWidget(ROOM, {
      widgetId: "schedule",
      url: "https://app.example.org/",
      name: "Schedule",
    });
    const states = fetchImpl.requests.filter((r) => r.route.includes("/state/"));
    assert.match(states[0].route, /im\.vector\.modular\.widgets\/schedule/);
    assert.equal(states[0].body.url, "https://app.example.org/");
    assert.equal(states[0].body.creatorUserId, "@bot:example.org");
    assert.match(states[1].route, /io\.element\.widgets\.layout/);
  });

  it("skips the layout when asked", async () => {
    const { bot, fetchImpl } = await makeBot();
    await bot.pinMiniAppWidget(ROOM, {
      widgetId: "schedule",
      url: "https://app.example.org/",
      name: "Schedule",
      layout: false,
    });
    assert.equal(fetchImpl.requests.filter((r) => r.route.includes("/state/")).length, 1);
  });

  it("removes a widget with empty content", async () => {
    const { bot, fetchImpl } = await makeBot();
    await bot.removeWidget(ROOM, "schedule");
    const state = fetchImpl.requests.find((r) => r.route.includes("/state/"));
    assert.deepEqual(state.body, {});
  });
});

describe("static helpers", () => {
  it("exposes a keyboard factory", () => {
    assert.ok(Bot.keyboard() instanceof InlineKeyboard);
  });
});
