import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_FRAGMENT_KEY,
  BRIDGE_HOST_ORIGIN_KEY,
  BRIDGE_SOURCE,
  BRIDGE_SOURCE_STUDNOVSU,
  MINIAPP_BRIDGE_SCRIPT,
  buildBridgeInitMessage,
  createInitData,
  buildMiniAppLaunchUrl,
  serveMiniAppBridge,
} from "../dist/index.js";

/**
 * Runs the real bridge script against a minimal DOM stub, so the shipped
 * browser code is exercised instead of a reimplementation of it.
 */
function loadBridge({ hash = "", hostOrigin = "https://host.example.org", detached = false } = {}) {
  const outbound = [];
  const listeners = {};
  const hostWindow = {
    postMessage(message, targetOrigin) {
      outbound.push({ message, targetOrigin });
    },
  };
  const window = {
    location: { hash },
    innerHeight: 800,
    console: { error: () => {} },
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
    },
  };
  window.parent = detached ? window : hostWindow;

  const run = new Function("window", "URLSearchParams", "console", MINIAPP_BRIDGE_SCRIPT);
  run(window, URLSearchParams, window.console);

  const deliver = (message, { origin = hostOrigin, source = hostWindow } = {}) => {
    for (const handler of listeners.message ?? []) handler({ data: message, origin, source });
  };
  return { api: window.MatrixMiniApp, window, outbound, deliver, hostWindow };
}

const initMessage = (payload) => buildBridgeInitMessage(payload);

describe("bridge bootstrap", () => {
  it("exposes the API and announces itself to the host", () => {
    const { api, outbound } = loadBridge();
    assert.equal(api.__aiomatrix, true);
    assert.equal(api.platform, "matrix");
    assert.deepEqual(
      outbound.map((o) => o.message.type),
      ["bridgeReady", "requestInit"],
    );
    assert.equal(outbound[0].message.source, BRIDGE_SOURCE);
  });

  it("aliases itself as Telegram.WebApp for drop-in mini apps", () => {
    const { window, api } = loadBridge();
    assert.equal(window.Telegram.WebApp, api);
  });

  it("does not install twice", () => {
    const { window } = loadBridge();
    const first = window.MatrixMiniApp;
    const run = new Function("window", "URLSearchParams", "console", MINIAPP_BRIDGE_SCRIPT);
    run(window, URLSearchParams, window.console);
    assert.equal(window.MatrixMiniApp, first);
  });

  it("stays silent when there is no host window", () => {
    const { outbound } = loadBridge({ detached: true });
    assert.equal(outbound.length, 0);
  });
});

describe("launch data from the URL fragment", () => {
  it("reads initData from the matrix fragment key", () => {
    const signed = createInitData(
      { user: { id: "@alice:example.org" }, room: { id: "!r:example.org" }, query_id: "q1" },
      "a-sufficiently-long-signing-secret",
    );
    const url = buildMiniAppLaunchUrl("https://app.example.org/", signed);
    const { api } = loadBridge({ hash: new URL(url).hash });

    assert.equal(api.initData, signed.initData);
    assert.equal(api.initDataUnsafe.query_id, "q1");
    assert.equal(api.initDataUnsafe.user.id, "@alice:example.org", "user JSON is parsed");
    assert.equal(typeof api.initDataUnsafe.auth_date, "number");
  });

  it("accepts the Telegram fragment key too", () => {
    const { api } = loadBridge({ hash: "#tgWebAppData=query_id%3Dq2" });
    assert.equal(api.initDataUnsafe.query_id, "q2");
  });

  it("prefers the matrix key when both are present", () => {
    const { api } = loadBridge({
      hash: `#${BRIDGE_FRAGMENT_KEY}=query_id%3Dmatrix&tgWebAppData=query_id%3Dtg`,
    });
    assert.equal(api.initDataUnsafe.query_id, "matrix");
  });

  it("starts empty with no fragment", () => {
    const { api } = loadBridge();
    assert.equal(api.initData, "");
    assert.deepEqual(api.initDataUnsafe, {});
  });

  it("keeps a malformed user field as a raw string", () => {
    const { api } = loadBridge({ hash: "#matrixWebAppData=user%3Dnot-json" });
    assert.equal(api.initDataUnsafe.user, "not-json");
  });
});

describe("host origin handling", () => {
  it("broadcasts to * until it learns the host origin", () => {
    const { outbound, deliver, api } = loadBridge();
    assert.equal(outbound[0].targetOrigin, "*");
    deliver(initMessage({ initData: "" }));
    api.ready();
    assert.equal(outbound.at(-1).targetOrigin, "https://host.example.org");
  });

  it("pins the origin from the fragment and refuses anyone else", () => {
    const { api, deliver, outbound } = loadBridge({
      hash: `#${BRIDGE_HOST_ORIGIN_KEY}=https://host.example.org`,
    });
    assert.equal(outbound[0].targetOrigin, "https://host.example.org");

    deliver(initMessage({ initData: "", colorScheme: "dark" }), {
      origin: "https://evil.example.org",
    });
    assert.equal(api.colorScheme, "light", "the foreign origin was ignored");

    deliver(initMessage({ initData: "", colorScheme: "dark" }));
    assert.equal(api.colorScheme, "dark");
  });

  it("ignores messages from a window other than the host", () => {
    const { api, deliver } = loadBridge();
    deliver(initMessage({ initData: "", colorScheme: "dark" }), { source: { name: "attacker" } });
    assert.equal(api.colorScheme, "light");
  });

  it("never adopts a null origin as the reply target", () => {
    const { api, deliver, outbound } = loadBridge();
    deliver(initMessage({ initData: "" }), { origin: "null" });
    api.ready();
    assert.equal(outbound.at(-1).targetOrigin, "*");
  });
});

describe("host to mini app messages", () => {
  it("applies the init payload", () => {
    const { api, deliver } = loadBridge();
    deliver(
      initMessage({
        initData: "query_id=q9",
        colorScheme: "dark",
        themeParams: { bg_color: "#000" },
        isExpanded: true,
        viewportHeight: 640,
        viewportStableHeight: 600,
        matrix: { userId: "@alice:example.org", roomId: "!r:example.org", queryId: "q9" },
      }),
    );
    assert.equal(api.initData, "query_id=q9");
    assert.equal(api.colorScheme, "dark");
    assert.equal(api.themeParams.bg_color, "#000");
    assert.equal(api.isExpanded, true);
    assert.equal(api.viewportHeight, 640);
    assert.equal(api.viewportStableHeight, 600);
    assert.equal(api.matrix.userId, "@alice:example.org");
    assert.equal(api.matrix.queryId, "q9");
    assert.equal(api.matrix.deviceId, null);
  });

  it("derives the matrix context from initData when the host omits it", () => {
    const { api, deliver } = loadBridge();
    deliver(
      initMessage({
        initData: `user=${encodeURIComponent('{"id":"@bob:example.org"}')}&room=${encodeURIComponent('{"id":"!r:example.org"}')}&query_id=q3&bot_id=@bot:example.org`,
      }),
    );
    assert.equal(api.matrix.userId, "@bob:example.org");
    assert.equal(api.matrix.roomId, "!r:example.org");
    assert.equal(api.matrix.botId, "@bot:example.org");
    assert.equal(api.matrix.queryId, "q3");
  });

  it("notifies init and theme listeners", () => {
    const { api, deliver } = loadBridge();
    const seen = [];
    api.onEvent("init", (p) => seen.push(["init", p.colorScheme]));
    api.onEvent("themeChanged", (p) => seen.push(["theme", p.colorScheme]));
    deliver(initMessage({ initData: "", colorScheme: "dark" }));
    assert.deepEqual(seen, [
      ["init", "dark"],
      ["theme", "dark"],
    ]);
  });

  it("tracks viewport changes", () => {
    const { api, deliver } = loadBridge();
    let seen = null;
    api.onEvent("viewportChanged", (p) => (seen = p));
    deliver({ source: BRIDGE_SOURCE, type: "viewportChanged", payload: { viewportHeight: 500 } });
    assert.equal(api.viewportHeight, 500);
    assert.equal(api.viewportStableHeight, 500, "falls back to viewportHeight");
    assert.equal(seen.viewportHeight, 500);
  });

  it("routes button clicks, dataSent and errors", () => {
    const { api, deliver } = loadBridge();
    const seen = [];
    api.MainButton.onClick(() => seen.push("main"));
    api.BackButton.onClick(() => seen.push("back"));
    api.onEvent("dataSent", () => seen.push("dataSent"));
    api.onEvent("error", (p) => seen.push(`error:${p.message}`));

    deliver({ source: BRIDGE_SOURCE, type: "mainButtonClicked" });
    deliver({ source: BRIDGE_SOURCE, type: "backButtonClicked" });
    deliver({ source: BRIDGE_SOURCE, type: "dataSent" });
    deliver({ source: BRIDGE_SOURCE, type: "error", payload: { message: "nope" } });
    assert.deepEqual(seen, ["main", "back", "dataSent", "error:nope"]);
  });

  it("accepts the legacy StudNovSU envelope and JSON strings", () => {
    const { api, deliver } = loadBridge();
    deliver(JSON.stringify({ source: BRIDGE_SOURCE_STUDNOVSU, type: "init", payload: { initData: "query_id=legacy" } }));
    assert.equal(api.initDataUnsafe.query_id, "legacy");
  });

  it("ignores foreign and malformed messages", () => {
    const { api, deliver } = loadBridge();
    deliver({ source: "some-other-widget", type: "init", payload: { colorScheme: "dark" } });
    deliver("not json at all");
    deliver(null);
    assert.equal(api.colorScheme, "light");
  });

  it("keeps working when a listener throws", () => {
    const { api, deliver } = loadBridge();
    const seen = [];
    api.onEvent("dataSent", () => {
      throw new Error("boom");
    });
    api.onEvent("dataSent", () => seen.push("second"));
    deliver({ source: BRIDGE_SOURCE, type: "dataSent" });
    assert.deepEqual(seen, ["second"]);
  });

  it("forwards unknown message types to matching listeners", () => {
    const { api, deliver } = loadBridge();
    let seen = null;
    api.onEvent("customThing", (p) => (seen = p));
    deliver({ source: BRIDGE_SOURCE, type: "customThing", payload: { a: 1 } });
    assert.deepEqual(seen, { a: 1 });
  });

  it("removes listeners on offEvent", () => {
    const { api, deliver } = loadBridge();
    let calls = 0;
    const handler = () => (calls += 1);
    api.onEvent("dataSent", handler);
    deliver({ source: BRIDGE_SOURCE, type: "dataSent" });
    api.offEvent("dataSent", handler);
    deliver({ source: BRIDGE_SOURCE, type: "dataSent" });
    assert.equal(calls, 1);
    api.offEvent("neverRegistered", handler);
    api.onEvent("dataSent", "not a function");
  });
});

describe("mini app to host messages", () => {
  const typesOf = (outbound) => outbound.slice(2).map((o) => o.message.type);

  it("posts lifecycle calls", () => {
    const { api, outbound } = loadBridge();
    api.ready();
    api.expand();
    api.close();
    assert.deepEqual(typesOf(outbound), ["ready", "expand", "close"]);
    assert.equal(api.isExpanded, true);
  });

  it("serialises sendData payloads", () => {
    const { api, outbound } = loadBridge();
    api.sendData({ action: "submit", id: 7 });
    api.sendData("raw string");
    const payloads = outbound.slice(2).map((o) => o.message.payload.data);
    assert.deepEqual(JSON.parse(payloads[0]), { action: "submit", id: 7 });
    assert.equal(payloads[1], "raw string");
  });

  it("posts chrome and haptic calls", () => {
    const { api, outbound } = loadBridge();
    api.setHeaderColor("#101010");
    api.setBackgroundColor("#fff");
    api.enableClosingConfirmation();
    api.disableClosingConfirmation();
    api.openLink("https://example.org", { tryInstantView: true });
    api.HapticFeedback.impactOccurred();
    api.HapticFeedback.notificationOccurred("error");
    api.HapticFeedback.selectionChanged();
    assert.deepEqual(typesOf(outbound), [
      "setHeaderColor",
      "setBackgroundColor",
      "enableClosingConfirmation",
      "disableClosingConfirmation",
      "openLink",
      "haptic",
      "haptic",
      "haptic",
    ]);
    const haptics = outbound.slice(-3).map((o) => o.message.payload);
    assert.deepEqual(haptics[0], { kind: "impact", style: "medium" });
    assert.deepEqual(haptics[1], { kind: "notification", type: "error" });
    assert.deepEqual(haptics[2], { kind: "selection" });
  });

  it("drives MainButton and BackButton state", () => {
    const { api, outbound } = loadBridge();
    api.MainButton.setText("Send").show();
    assert.equal(api.MainButton.text, "Send");
    assert.equal(api.MainButton.isVisible, true);
    api.MainButton.hide();
    assert.equal(api.MainButton.isVisible, false);
    api.BackButton.show();
    assert.equal(api.BackButton.isVisible, true);
    api.BackButton.hide();
    assert.deepEqual(typesOf(outbound), [
      "mainButton",
      "mainButton",
      "mainButton",
      "backButton",
      "backButton",
    ]);
  });

  it("survives a host window that has gone away", () => {
    const { api, hostWindow } = loadBridge();
    hostWindow.postMessage = () => {
      throw new Error("host closed");
    };
    assert.doesNotThrow(() => api.sendData({ a: 1 }));
  });

  it("also posts through a WebView bridge when present", () => {
    const posted = [];
    const window = {
      location: { hash: "" },
      innerHeight: 800,
      console: { error: () => {} },
      addEventListener: () => {},
      ReactNativeWebView: { postMessage: (raw) => posted.push(JSON.parse(raw)) },
    };
    window.parent = window;
    new Function("window", "URLSearchParams", "console", MINIAPP_BRIDGE_SCRIPT)(
      window,
      URLSearchParams,
      window.console,
    );
    window.MatrixMiniApp.sendData("x");
    assert.deepEqual(
      posted.map((m) => m.type),
      ["bridgeReady", "requestInit", "sendData"],
    );
  });
});

describe("serveMiniAppBridge", () => {
  it("returns a cacheable javascript asset", () => {
    const asset = serveMiniAppBridge();
    assert.equal(asset.body, MINIAPP_BRIDGE_SCRIPT);
    assert.match(asset.contentType, /javascript/);
    assert.match(asset.etag, /^"[\w-]+"$/);
    assert.match(asset.cacheControl, /max-age=\d+/);
  });

  it("produces a stable etag", () => {
    assert.equal(serveMiniAppBridge().etag, serveMiniAppBridge().etag);
  });
});

describe("buildBridgeInitMessage", () => {
  it("fills in protocol defaults", () => {
    const message = buildBridgeInitMessage({ initData: "query_id=q" });
    assert.equal(message.source, BRIDGE_SOURCE);
    assert.equal(message.type, "init");
    assert.equal(message.payload.version, "1.0");
    assert.equal(message.payload.platform, "matrix");
    assert.equal(message.payload.colorScheme, "light");
  });

  it("lets the caller override defaults", () => {
    const message = buildBridgeInitMessage({ initData: "", colorScheme: "dark" });
    assert.equal(message.payload.colorScheme, "dark");
  });
});
