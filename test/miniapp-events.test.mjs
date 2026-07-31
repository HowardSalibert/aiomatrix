import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InlineKeyboard,
  KEYBOARD_CONTENT_KEY,
  MINI_APP_CONTENT_KEY,
  MINI_APP_DATA_KEY,
  MINI_APP_DATA_MSGTYPE,
  MINI_APP_MSGTYPE_STUDNOVSU,
  MiniAppAuthError,
  MiniAppQueryRegistry,
  WIDGET_LAYOUT_STATE_EVENT_TYPE,
  WIDGET_STATE_EVENT_TYPE,
  buildMiniAppContent,
  buildMiniAppDataContent,
  buildWidgetLayoutContent,
  buildWidgetRemovalContent,
  buildWidgetStateContent,
  parseMiniAppContent,
  parseMiniAppDataContent,
  parseMiniAppJson,
  parseWidgetStateEvent,
  templateWidgetUrl,
} from "../dist/index.js";

const URL_OK = "https://app.example.org/start";

describe("buildMiniAppContent", () => {
  it("layers a canonical descriptor, a keyboard and a readable body", () => {
    const content = buildMiniAppContent({
      url: URL_OK,
      title: "Schedule",
      description: "Your week",
      buttonText: "Open schedule",
      appId: "schedule",
      startParam: "week=2",
    });
    assert.equal(content.msgtype, "m.text");
    assert.match(content.body, /Schedule/);
    assert.match(content.body, /Open schedule: https:\/\/app\.example\.org\/start/);
    assert.equal(content[MINI_APP_CONTENT_KEY].url, URL_OK);
    assert.equal(content[MINI_APP_CONTENT_KEY].app_id, "schedule");
    assert.equal(content[MINI_APP_CONTENT_KEY].start_param, "week=2");
    const button = content[KEYBOARD_CONTENT_KEY].inline[0][0];
    assert.equal(button.kind, "mini_app");
    assert.equal(button.startParam, "week=2");
  });

  it("mirrors the StudNovSU shape when asked", () => {
    const content = buildMiniAppContent({
      url: URL_OK,
      title: "App",
      botId: "@bot:example.org",
      studnovsuCompat: true,
    });
    assert.equal(content.msgtype, MINI_APP_MSGTYPE_STUDNOVSU);
    assert.equal(content.url, URL_OK);
    assert.equal(content.title, "App");
    assert.equal(content.bot_id, "@bot:example.org");
  });

  it("keeps extra keyboard rows under the launch button", () => {
    const content = buildMiniAppContent({
      url: URL_OK,
      keyboard: new InlineKeyboard().text("Later", "later"),
    });
    const rows = content[KEYBOARD_CONTENT_KEY].inline;
    assert.equal(rows[0][0].kind, "mini_app");
    assert.equal(rows[1][0].kind, "callback");
  });

  it("escapes titles and descriptions in the HTML body", () => {
    const content = buildMiniAppContent({ url: URL_OK, title: "<script>x</script>" });
    assert.ok(!content.formatted_body.includes("<script>"));
    assert.match(content.formatted_body, /&lt;script&gt;/);
  });

  it("refuses a URL that is not https", () => {
    assert.throws(() => buildMiniAppContent({ url: "http://app.example.org" }), MiniAppAuthError);
    assert.throws(() => buildMiniAppContent({ url: "javascript:alert(1)" }), MiniAppAuthError);
    assert.doesNotThrow(() => buildMiniAppContent({ url: "http://localhost:5173/" }));
  });

  it("can send as a notice", () => {
    assert.equal(buildMiniAppContent({ url: URL_OK, notice: true }).msgtype, "m.notice");
  });
});

describe("parseMiniAppContent", () => {
  it("round-trips a canonical card", () => {
    const content = buildMiniAppContent({ url: URL_OK, title: "T", appId: "a" });
    const card = parseMiniAppContent(content);
    assert.equal(card.url, URL_OK);
    assert.equal(card.title, "T");
    assert.equal(card.app_id, "a");
  });

  it("reads a StudNovSU card without the canonical field", () => {
    const card = parseMiniAppContent({
      msgtype: MINI_APP_MSGTYPE_STUDNOVSU,
      url: URL_OK,
      title: "Legacy",
      bot_id: "@bot:hs",
    });
    assert.equal(card.url, URL_OK);
    assert.equal(card.title, "Legacy");
    assert.equal(card.bot_id, "@bot:hs");
  });

  it("returns null for ordinary messages and malformed cards", () => {
    assert.equal(parseMiniAppContent({ msgtype: "m.text", body: "hi" }), null);
    assert.equal(parseMiniAppContent({ [MINI_APP_CONTENT_KEY]: { version: 1 } }), null);
    assert.equal(parseMiniAppContent({ msgtype: MINI_APP_MSGTYPE_STUDNOVSU }), null);
    assert.equal(parseMiniAppContent(null), null);
  });
});

describe("mini app data", () => {
  it("round-trips a sendData payload", () => {
    const content = buildMiniAppDataContent({
      data: '{"action":"ok"}',
      queryId: "q1",
      appId: "app",
      messageId: "$card",
    });
    assert.equal(content.msgtype, MINI_APP_DATA_MSGTYPE);
    assert.equal(content.body, '{"action":"ok"}');
    const parsed = parseMiniAppDataContent(content);
    assert.deepEqual(parsed, {
      data: '{"action":"ok"}',
      queryId: "q1",
      appId: "app",
      messageId: "$card",
    });
  });

  it("omits absent correlation fields", () => {
    const content = buildMiniAppDataContent({
      data: "x",
      queryId: null,
      appId: null,
      messageId: null,
    });
    assert.deepEqual(Object.keys(content[MINI_APP_DATA_KEY]).sort(), ["data", "version"]);
  });

  it("falls back to the body and to a bare msgtype form", () => {
    assert.equal(
      parseMiniAppDataContent({ [MINI_APP_DATA_KEY]: { version: 1 }, body: "from-body" }).data,
      "from-body",
    );
    const bare = parseMiniAppDataContent({
      msgtype: MINI_APP_DATA_MSGTYPE,
      body: "raw",
      query_id: "q",
    });
    assert.equal(bare.data, "raw");
    assert.equal(bare.queryId, "q");
  });

  it("ignores unrelated content", () => {
    assert.equal(parseMiniAppDataContent({ msgtype: "m.text", body: "hi" }), null);
    assert.equal(parseMiniAppDataContent("nope"), null);
  });

  it("parses JSON payloads only when they look like JSON", () => {
    assert.deepEqual(parseMiniAppJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseMiniAppJson("  [1,2] "), [1, 2]);
    assert.equal(parseMiniAppJson("plain text"), null);
    assert.equal(parseMiniAppJson("{broken"), null);
  });
});

describe("MiniAppQueryRegistry", () => {
  const params = { roomId: "!r:hs", userId: "@alice:hs", messageId: "$card", appId: "app" };

  it("issues a unique query id per launch", () => {
    const registry = new MiniAppQueryRegistry();
    const a = registry.issue(params);
    const b = registry.issue(params);
    assert.notEqual(a.queryId, b.queryId);
    assert.match(a.queryId, /^[A-Za-z0-9_-]{20,}$/);
    assert.equal(a.roomId, "!r:hs");
    assert.equal(a.answeredAtMs, null);
  });

  it("claims a query exactly once", () => {
    const registry = new MiniAppQueryRegistry();
    const { queryId } = registry.issue(params);
    assert.ok(registry.claim(queryId, "@alice:hs"));
    assert.equal(registry.claim(queryId, "@alice:hs"), null, "replays are refused");
  });

  it("refuses a claim from another user", () => {
    const registry = new MiniAppQueryRegistry();
    const { queryId } = registry.issue(params);
    assert.equal(registry.claim(queryId, "@mallory:hs"), null);
    assert.ok(registry.claim(queryId, "@alice:hs"));
  });

  it("allows a retry after release", () => {
    const registry = new MiniAppQueryRegistry();
    const { queryId } = registry.issue(params);
    registry.claim(queryId);
    registry.release(queryId);
    assert.ok(registry.claim(queryId));
  });

  it("expires and revokes queries", async () => {
    const registry = new MiniAppQueryRegistry();
    const short = registry.issue({ ...params, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(registry.peek(short.queryId), null);

    const other = registry.issue(params);
    registry.revoke(other.queryId);
    assert.equal(registry.peek(other.queryId), null);
  });

  it("stays bounded", () => {
    const registry = new MiniAppQueryRegistry(4);
    for (let i = 0; i < 50; i++) registry.issue(params);
    assert.ok(registry.size <= 4);
  });

  it("rejects an unknown query id", () => {
    assert.equal(new MiniAppQueryRegistry().claim("nope"), null);
  });
});

describe("widgets", () => {
  it("builds an Element-compatible widget state event", () => {
    const content = buildWidgetStateContent({
      widgetId: "w1",
      url: "https://app.example.org/widget",
      name: "Schedule",
      title: "This week",
      type: "m.custom",
      data: { appId: "schedule" },
      creatorUserId: "@bot:hs",
    });
    assert.equal(WIDGET_STATE_EVENT_TYPE, "im.vector.modular.widgets");
    assert.equal(content.id, "w1");
    assert.equal(content.url, "https://app.example.org/widget");
    assert.equal(content.data.title, "This week");
    assert.equal(content.data.appId, "schedule");
    assert.equal(content.creatorUserId, "@bot:hs");
    assert.equal(content.waitForIframeLoad, true);
  });

  it("removes a widget with empty content", () => {
    assert.deepEqual(buildWidgetRemovalContent(), {});
  });

  it("substitutes and encodes template variables", () => {
    const out = templateWidgetUrl(
      "https://app.example.org/?u=$matrix_user_id&r=$matrix_room_id&t=$theme&x=$custom",
      {
        userId: "@alice:example.org",
        roomId: "!room:example.org",
        theme: "dark",
        extra: { custom: "a b&c" },
      },
    );
    const parsed = new URL(out);
    assert.equal(parsed.searchParams.get("u"), "@alice:example.org");
    assert.equal(parsed.searchParams.get("r"), "!room:example.org");
    assert.equal(parsed.searchParams.get("t"), "dark");
    assert.equal(parsed.searchParams.get("x"), "a b&c");
    assert.ok(!out.includes("$matrix_user_id"));
  });

  it("leaves unknown variables untouched", () => {
    assert.equal(
      templateWidgetUrl("https://a.example/?u=$matrix_user_id", {}),
      "https://a.example/?u=$matrix_user_id",
    );
  });

  it("parses a widget state event and ignores removals", () => {
    const parsed = parseWidgetStateEvent({
      type: WIDGET_STATE_EVENT_TYPE,
      state_key: "w1",
      content: { id: "w1", url: "https://a.example/", name: "N", type: "m.custom" },
    });
    assert.equal(parsed.widgetId, "w1");
    assert.equal(parsed.name, "N");
    assert.equal(parseWidgetStateEvent({ state_key: "w1", content: {} }), null);
    assert.equal(parseWidgetStateEvent(null), null);
  });

  it("falls back to the state key for the widget id", () => {
    const parsed = parseWidgetStateEvent({
      state_key: "w2",
      content: { url: "https://a.example/" },
    });
    assert.equal(parsed.widgetId, "w2");
    assert.equal(parsed.name, "w2");
  });

  it("builds a layout that gives the widget usable space", () => {
    const content = buildWidgetLayoutContent("w1", { container: "right", height: 80 });
    assert.equal(WIDGET_LAYOUT_STATE_EVENT_TYPE, "io.element.widgets.layout");
    assert.equal(content.widgets.w1.container, "right");
    assert.equal(content.widgets.w1.height, 80);
    assert.equal(content.widgets.w1.width, 100);
  });
});
