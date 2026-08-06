import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KEYBOARD_CONTENT_KEY,
  MINI_APP_CONTENT_KEY,
  MINI_APP_DATA_KEY,
  MINI_APP_DATA_MSGTYPE,
  buildCallbackContent,
  buildMiniAppContent,
  buildMiniAppDataContent,
  classifyAiomatrixContent,
  formatMessagePreview,
  formatMiniAppDataPreview,
  normalizeAiomatrixContent,
  parseMiniAppPayload,
  stripKeyboardFallbackHtml,
  stripKeyboardFallbackText,
} from "../dist/index.js";

describe("formatMiniAppDataPreview", () => {
  it("humanizes known actions", () => {
    assert.equal(
      formatMiniAppDataPreview('{"action":"submit","items":["a","b"]}'),
      "Submitted: 2 items",
    );
    assert.equal(formatMiniAppDataPreview('{"action":"rsvp","status":"yes"}'), "RSVP: yes");
    assert.equal(
      formatMiniAppDataPreview('{"action":"publish","title":"Hello"}'),
      "Published: Hello",
    );
  });

  it("falls back for plain strings and unknown JSON", () => {
    assert.equal(formatMiniAppDataPreview("thanks"), "thanks");
    assert.match(formatMiniAppDataPreview('{"foo":1,"bar":2}'), /foo=1/);
  });
});

describe("parseMiniAppPayload", () => {
  it("requires an action field", () => {
    assert.equal(parseMiniAppPayload('{"items":[]}'), null);
    assert.equal(parseMiniAppPayload('{"action":"submit","items":[]}').action, "submit");
  });
});

describe("formatMessagePreview", () => {
  it("prefers structured mini_app_data over legacy JSON body", () => {
    const legacy = {
      msgtype: MINI_APP_DATA_MSGTYPE,
      body: '{"action":"submit","items":[1]}',
      [MINI_APP_DATA_KEY]: {
        version: 1,
        data: '{"action":"submit","items":[1]}',
      },
    };
    assert.equal(formatMessagePreview(legacy), "Submitted: 1 items");
  });

  it("summarizes mini_app cards", () => {
    const content = buildMiniAppContent({
      url: "https://app.example.org/",
      title: "Order",
      description: "Checkout",
      includePlainLink: false,
      includeLaunchKeyboard: false,
    });
    assert.equal(formatMessagePreview(content), "Order: Checkout");
    assert.ok(content[MINI_APP_CONTENT_KEY]);
  });

  it("strips !cb fallbacks from keyboard messages", () => {
    const body = "Pick one\n\n1. Yes → !cb abc123\n2. No → !cb def456";
    assert.equal(stripKeyboardFallbackText(body), "Pick one");
    assert.equal(
      formatMessagePreview({
        body,
        [KEYBOARD_CONTENT_KEY]: { version: 1, inline: [] },
      }),
      "Pick one",
    );
  });

  it("returns null for ordinary messages", () => {
    assert.equal(formatMessagePreview({ msgtype: "m.text", body: "hi" }), null);
  });

  it("humanizes hidden mini_app_data bodies", () => {
    const content = buildMiniAppDataContent({
      data: '{"action":"close"}',
      queryId: null,
      appId: null,
      messageId: null,
      hideFromStockClients: true,
    });
    assert.equal(formatMessagePreview(content), "Closed");
  });

  it("classifies content kinds", () => {
    assert.equal(
      classifyAiomatrixContent(
        buildMiniAppDataContent({
          data: "{}",
          queryId: null,
          appId: null,
          messageId: null,
        }),
      ),
      "mini_app_data",
    );
    assert.equal(
      classifyAiomatrixContent(
        buildMiniAppContent({ url: "https://app.example.org/", includeLaunchKeyboard: false }),
      ),
      "mini_app",
    );
    assert.equal(
      classifyAiomatrixContent({
        body: "x",
        [KEYBOARD_CONTENT_KEY]: { version: 1, inline: [] },
      }),
      "keyboard",
    );
    assert.equal(classifyAiomatrixContent({ msgtype: "m.text", body: "hi" }), null);
  });

  it("strips HTML ol keyboard dumps", () => {
    const html = "<p>Pick</p><ol><li>Yes: <code>!cb x</code></li></ol>";
    assert.equal(stripKeyboardFallbackHtml(html), "<p>Pick</p>");
    assert.equal(
      formatMessagePreview({
        body: "Pick\n\n1. Yes → !cb x",
        formatted_body: html,
        [KEYBOARD_CONTENT_KEY]: { version: 1, inline: [] },
      }),
      "Pick",
    );
  });

  it("builds callback content for aware hosts", () => {
    assert.deepEqual(buildCallbackContent("tok.mac"), { token: "tok.mac" });
    assert.deepEqual(buildCallbackContent("tok.mac", { data: "legacy" }), {
      token: "tok.mac",
      data: "legacy",
    });
  });

  it("normalizes content in one shot", () => {
    const content = buildMiniAppDataContent({
      data: '{"action":"submit","items":[1]}',
      queryId: null,
      appId: null,
      messageId: null,
    });
    const norm = normalizeAiomatrixContent(content);
    assert.equal(norm.kind, "mini_app_data");
    assert.equal(norm.preview, "Submitted: 1 items");
    assert.ok(norm.miniAppData);
  });
});
