import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_EVENT_TYPE,
  CallbackRegistry,
  InlineKeyboard,
  KEYBOARD_CONTENT_KEY,
  buildMessageContent,
  isSafeButtonUrl,
  parseKeyboardContent,
  renderKeyboardFallback,
} from "../dist/index.js";

describe("InlineKeyboard", () => {
  it("builds rows of typed buttons", () => {
    const content = new InlineKeyboard()
      .text("Yes", "vote:yes")
      .text("No", "vote:no")
      .row()
      .url("Docs", "https://example.org/docs")
      .row()
      .miniApp("Open", "https://app.example.org")
      .row()
      .command("Help", "/help")
      .toContent();

    assert.equal(content.inline.length, 4);
    assert.deepEqual(
      content.inline[0].map((b) => b.text),
      ["Yes", "No"],
    );
    assert.deepEqual(
      content.inline.map((row) => row[0].kind),
      ["callback", "url", "mini_app", "command"],
    );
    assert.equal(content.fallback_command, "cb");
  });

  it("treats callback() as an alias of text()", () => {
    const content = new InlineKeyboard().callback("Yes", "y").toContent();
    assert.equal(content.inline[0][0].kind, "callback");
  });

  it("ignores empty rows", () => {
    const content = new InlineKeyboard().text("a", "a").row().row().toContent();
    assert.equal(content.inline.length, 1);
  });

  it("lays out a grid with adjust()", () => {
    const kb = InlineKeyboard.fromCallbacks(
      [
        ["1", "d1"],
        ["2", "d2"],
        ["3", "d3"],
        ["4", "d4"],
        ["5", "d5"],
      ],
      2,
    );
    assert.deepEqual(
      kb.buttons.map((row) => row.length),
      [2, 2, 1],
    );
  });

  it("reports emptiness", () => {
    assert.equal(new InlineKeyboard().isEmpty, true);
    assert.equal(new InlineKeyboard().text("a", "a").isEmpty, false);
  });

  it("rejects empty labels and oversized payloads", () => {
    assert.throws(() => new InlineKeyboard().text("", "d"), /non-empty/);
    assert.throws(() => new InlineKeyboard().text("x".repeat(200), "d"), /at most 128/);
    assert.throws(() => new InlineKeyboard().text("x", "d".repeat(600)), /at most 512 bytes/);
  });

  it("refuses unsafe button URLs at build time", () => {
    assert.throws(() => new InlineKeyboard().url("x", "javascript:alert(1)"), /http/);
    assert.throws(() => new InlineKeyboard().url("x", "data:text/html,<b>"), /http/);
    assert.throws(() => new InlineKeyboard().url("x", "not a url"), /http/);
    // MiniApps additionally require TLS outside localhost.
    assert.throws(() => new InlineKeyboard().miniApp("x", "http://app.example.org"), /https/);
    assert.doesNotThrow(() => new InlineKeyboard().miniApp("x", "http://localhost:3000/a"));
  });
});

describe("isSafeButtonUrl", () => {
  it("accepts http(s) and rejects everything else", () => {
    assert.equal(isSafeButtonUrl("https://example.org"), true);
    assert.equal(isSafeButtonUrl("http://example.org"), true);
    assert.equal(isSafeButtonUrl("javascript:alert(1)"), false);
    assert.equal(isSafeButtonUrl("data:text/html,x"), false);
    assert.equal(isSafeButtonUrl("mxc://example.org/a"), false);
  });

  it("requires https unless the host is loopback", () => {
    assert.equal(isSafeButtonUrl("http://example.org", true), false);
    assert.equal(isSafeButtonUrl("http://localhost:8080", true), true);
    assert.equal(isSafeButtonUrl("http://127.0.0.1", true), true);
  });
});

describe("renderKeyboardFallback", () => {
  it("renders numbered choices for clients that ignore the keyboard", () => {
    const kb = new InlineKeyboard()
      .text("Approve", "ok")
      .row()
      .url("Site", "https://example.org/")
      .toContent();
    const fallback = renderKeyboardFallback(kb);
    assert.match(fallback.text, /1\. Approve/);
    assert.match(fallback.text, /2\. Site → https:\/\/example\.org\//);
    assert.match(fallback.html, /<a href="https:\/\/example\.org\/">/);
  });

  it("escapes hostile labels coming off the wire", () => {
    const parsed = parseKeyboardContent({
      [KEYBOARD_CONTENT_KEY]: {
        version: 1,
        inline: [[{ kind: "callback", text: '<img src=x onerror="a()">', data: "d" }]],
      },
    });
    const fallback = renderKeyboardFallback(parsed);
    assert.ok(!fallback.html.includes("<img"));
    assert.match(fallback.html, /&lt;img/);
  });

  it("does not linkify a javascript: URL smuggled through remote content", () => {
    const parsed = parseKeyboardContent({
      [KEYBOARD_CONTENT_KEY]: {
        version: 1,
        inline: [[{ kind: "url", text: "Click", url: "javascript:alert(1)" }]],
      },
    });
    const fallback = renderKeyboardFallback(parsed);
    assert.ok(!fallback.html.includes("<a href"));
    assert.match(fallback.html, /javascript:alert\(1\)/);
  });

  it("shows the fallback command for tokenised callbacks", () => {
    const fallback = renderKeyboardFallback({
      version: 1,
      inline: [[{ kind: "callback", text: "Go", data: "d", token: "abc123" }]],
    });
    assert.match(fallback.text, /!cb abc123/);
  });
});

describe("parseKeyboardContent", () => {
  it("returns null for content without a keyboard", () => {
    assert.equal(parseKeyboardContent({ body: "hi" }), null);
    assert.equal(parseKeyboardContent(null), null);
    assert.equal(parseKeyboardContent({ [KEYBOARD_CONTENT_KEY]: { inline: [] } }), null);
  });

  it("skips malformed buttons instead of throwing", () => {
    const parsed = parseKeyboardContent({
      [KEYBOARD_CONTENT_KEY]: {
        inline: [
          [{ kind: "callback", text: "ok", data: "d" }, { kind: "callback" }, "junk"],
          "not-a-row",
        ],
      },
    });
    assert.equal(parsed.inline.length, 1);
    assert.equal(parsed.inline[0].length, 1);
  });
});

describe("keyboard tokenisation on send", () => {
  const target = (callbacks) => ({
    client: { async sendEvent() { return "$sent"; } },
    roomId: "!r:example.org",
    callbacks,
  });

  it("swaps callback payloads for opaque tokens", () => {
    const callbacks = new CallbackRegistry();
    const keyboard = new InlineKeyboard().text("Yes", "vote:yes");
    const { content, tokens } = buildMessageContent({ text: "Pick" }, { keyboard }, target(callbacks));
    assert.equal(tokens.length, 1);
    const button = content[KEYBOARD_CONTENT_KEY].inline[0][0];
    assert.equal(button.token, tokens[0]);
    const record = callbacks.peek(tokens[0]);
    assert.equal(record.data, "vote:yes");
    assert.equal(record.roomId, "!r:example.org");
  });

  it("mints exactly one token per callback button", () => {
    const callbacks = new CallbackRegistry();
    const keyboard = new InlineKeyboard().text("a", "a").text("b", "b").url("c", "https://e.org");
    const { tokens } = buildMessageContent({ text: "x" }, { keyboard }, target(callbacks));
    assert.equal(tokens.length, 2);
    assert.equal(callbacks.size, 2);
  });

  it("appends the fallback to body and formatted_body", () => {
    const keyboard = new InlineKeyboard().text("Yes", "y");
    const { content } = buildMessageContent(
      { text: "Question?" },
      { keyboard },
      target(new CallbackRegistry()),
    );
    assert.match(content.body, /^Question\?/);
    assert.match(content.body, /1\. Yes/);
    assert.equal(content.format, "org.matrix.custom.html");
    assert.match(content.formatted_body, /<ol>/);
  });
});

describe("CallbackRegistry", () => {
  const base = { roomId: "!r:example.org", data: "d" };

  it("keeps resolving a reusable token", () => {
    const reg = new CallbackRegistry();
    const token = reg.issue(base);
    assert.equal(reg.resolve(token).data, "d");
    assert.equal(reg.resolve(token).data, "d");
  });

  it("consumes a single-use token", () => {
    const reg = new CallbackRegistry();
    const token = reg.issue({ ...base, singleUse: true });
    assert.ok(reg.resolve(token));
    assert.equal(reg.resolve(token), null);
  });

  it("enforces the owner when one was recorded", () => {
    const reg = new CallbackRegistry();
    const token = reg.issue({ ...base, userId: "@alice:example.org" });
    assert.equal(reg.resolve(token, "@mallory:example.org"), null);
    assert.ok(reg.resolve(token, "@alice:example.org"));
  });

  it("expires tokens after their ttl", () => {
    const reg = new CallbackRegistry({ ttlMs: 1 });
    const token = reg.issue(base);
    assert.equal(reg.resolve(token, undefined, Date.now() + 50), null);
  });

  it("evicts the oldest token past capacity", () => {
    const reg = new CallbackRegistry({ maxEntries: 2 });
    const first = reg.issue(base);
    reg.issue(base);
    reg.issue(base);
    assert.ok(reg.size <= 2);
    assert.equal(reg.peek(first), null);
  });

  it("binds tokens to a message id after the event lands", () => {
    const reg = new CallbackRegistry();
    const token = reg.issue(base);
    reg.bind([token], "$sent");
    assert.equal(reg.peek(token).messageEventId, "$sent");
  });

  it("revokes every token of a message when its keyboard is removed", () => {
    const reg = new CallbackRegistry();
    const a = reg.issue({ ...base, messageEventId: "$m1" });
    const b = reg.issue({ ...base, messageEventId: "$m2" });
    reg.revokeForMessage("$m1");
    assert.equal(reg.peek(a), null);
    assert.ok(reg.peek(b));
  });

  it("uses url-safe, unguessable tokens", () => {
    const reg = new CallbackRegistry();
    const token = reg.issue(base);
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    assert.notEqual(token, reg.issue(base));
  });
});

describe("wire constants", () => {
  it("stay namespaced under the library", () => {
    assert.equal(CALLBACK_EVENT_TYPE, "m.matrixbots.callback");
    assert.equal(KEYBOARD_CONTENT_KEY, "m.matrixbots.keyboard");
  });
});
