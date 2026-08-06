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
  displayUrlForMiniApp,
  parseMiniAppContent,
  parseMiniAppDataContent,
  parseMiniAppJson,
  parseWidgetStateEvent,
  templateWidgetUrl,
} from "../dist/index.js";

const URL_OK = "https://app.example.org/start";
const URL_SIGNED =
  "https://app.example.org/start#matrixWebAppData=eyJhbGciOiJIUzI1NiJ9.payload.sig&matrixWebAppHost=https%3A%2F%2Fapp.example.org";

describe("buildMiniAppContent", () => {
  it("keeps the full launch URL only in the canonical field", () => {
    const content = buildMiniAppContent({
      url: URL_SIGNED,
      title: "Schedule",
      description: "Your week",
      buttonText: "Open schedule",
      appId: "schedule",
      startParam: "week=2",
    });
    assert.equal(content.msgtype, "m.text");
    assert.equal(content.url, undefined, "top-level url must not look like media");
    assert.match(content.body, /^Schedule\nYour week\nOpen schedule: /);
    assert.ok(!content.body.includes("matrixWebAppData"));
    assert.match(content.body, /https:\/\/app\.example\.org\/start$/);
    assert.equal(content[MINI_APP_CONTENT_KEY].url, URL_SIGNED);
    assert.equal(content[MINI_APP_CONTENT_KEY].app_id, "schedule");
    const button = content[KEYBOARD_CONTENT_KEY].inline[0][0];
    assert.equal(button.kind, "mini_app");
    assert.equal(button.url, URL_SIGNED);
    assert.ok(!content.body.includes("!cb"));
  });

  it("can omit the plain link and launch keyboard for aware hosts", () => {
    const content = buildMiniAppContent({
      url: URL_OK,
      title: "App",
      includePlainLink: false,
      includeLaunchKeyboard: false,
    });
    assert.equal(content.body, "App");
    assert.equal(content[KEYBOARD_CONTENT_KEY], undefined);
    assert.equal(content[MINI_APP_CONTENT_KEY].url, URL_OK);
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

  it("strips fragments for displayUrlForMiniApp", () => {
    assert.equal(displayUrlForMiniApp(URL_SIGNED), "https://app.example.org/start");
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
  it("round-trips a sendData payload with a human body", () => {
    const content = buildMiniAppDataContent({
      data: '{"action":"submit","items":[1,2]}',
      queryId: "q1",
      appId: "shop",
      messageId: "$card",
    });
    assert.equal(content.msgtype, MINI_APP_DATA_MSGTYPE);
    assert.equal(content.body, "Submitted: 2 items");
    assert.equal(content[MINI_APP_DATA_KEY].data, '{"action":"submit","items":[1,2]}');
    assert.equal(content[MINI_APP_DATA_KEY].query_id, "q1");
    const parsed = parseMiniAppDataContent(content);
    assert.equal(parsed.data, '{"action":"submit","items":[1,2]}');
    assert.equal(parsed.queryId, "q1");
    assert.equal(parsed.appId, "shop");
    assert.equal(parsed.messageId, "$card");
  });

  it("can hide mini_app_data from stock clients", () => {
    const content = buildMiniAppDataContent({
      data: '{"action":"close"}',
      queryId: null,
      appId: null,
      messageId: null,
      hideFromStockClients: true,
    });
    assert.equal(content.body, "\u200b");
    assert.equal(content[MINI_APP_DATA_KEY].hidden, true);
    assert.equal(content[MINI_APP_DATA_KEY].data, '{"action":"close"}');
  });

  it("honours body / formatBody overrides", () => {
    assert.equal(
      buildMiniAppDataContent({
        data: "{}",
        queryId: null,
        appId: null,
        messageId: null,
        body: "Saved",
      }).body,
      "Saved",
    );
    assert.equal(
      buildMiniAppDataContent({
        data: '{"action":"submit"}',
        queryId: null,
        appId: null,
        messageId: null,
        formatBody: () => "Custom summary",
      }).body,
      "Custom summary",
    );
  });

  it("parseMiniAppJson tolerates non-JSON", () => {
    assert.deepEqual(parseMiniAppJson('{"a":1}'), { a: 1 });
    assert.equal(parseMiniAppJson("hello"), null);
  });
});

describe("widget helpers stay importable", () => {
  it("builds widget state", () => {
    const state = buildWidgetStateContent({
      id: "w1",
      url: "https://app.example.org/w",
      name: "W",
    });
    assert.equal(state.type, "m.custom");
    void WIDGET_STATE_EVENT_TYPE;
    void WIDGET_LAYOUT_STATE_EVENT_TYPE;
    void buildWidgetLayoutContent;
    void buildWidgetRemovalContent;
    void parseWidgetStateEvent;
    void templateWidgetUrl;
    void MiniAppQueryRegistry;
    void MINI_APP_DATA_KEY;
  });
});
