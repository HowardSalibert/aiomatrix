/**
 * Browser-side MiniApp bridge.
 *
 * The script is shipped as a string so a host can serve it from any HTTP stack
 * without extra build steps:
 *
 * ```ts
 * import { serveMiniAppBridge } from 'aiomatrix';
 * app.get('/matrix-miniapp.js', (_req, res) => {
 *   const asset = serveMiniAppBridge();
 *   res.type(asset.contentType).set('ETag', asset.etag).send(asset.body);
 * });
 * ```
 */

import { createHash } from "node:crypto";

/** postMessage envelope tag used by aiomatrix hosts. */
export const BRIDGE_SOURCE = "aiomatrix-miniapp";
/** Legacy envelope tag used by the StudNovSU web client. */
export const BRIDGE_SOURCE_STUDNOVSU = "studnovsu-twa";
/** URL fragment key carrying signed launch data. */
export const BRIDGE_FRAGMENT_KEY = "matrixWebAppData";
/**
 * URL fragment key that pins the host origin, e.g.
 * `#matrixWebAppData=...&matrixWebAppHost=https://app.example.org`.
 *
 * Set it whenever the host origin is known: the bridge then refuses messages
 * from anywhere else instead of trusting the first sender.
 */
export const BRIDGE_HOST_ORIGIN_KEY = "matrixWebAppHost";

export type BridgeChildMessageType =
  | "bridgeReady"
  | "ready"
  | "expand"
  | "close"
  | "sendData"
  | "setHeaderColor"
  | "setBackgroundColor"
  | "enableClosingConfirmation"
  | "disableClosingConfirmation"
  | "mainButton"
  | "backButton"
  | "haptic"
  | "openLink"
  | "requestInit";

export type BridgeHostMessageType =
  | "init"
  | "themeChanged"
  | "viewportChanged"
  | "mainButtonClicked"
  | "backButtonClicked"
  | "dataSent"
  | "error";

export const MINIAPP_BRIDGE_SCRIPT = `/*! aiomatrix MiniApp bridge — MIT */
(function () {
  "use strict";
  if (window.MatrixMiniApp && window.MatrixMiniApp.__aiomatrix) return;

  var SOURCES = ["${BRIDGE_SOURCE}", "${BRIDGE_SOURCE_STUDNOVSU}"];
  var FRAGMENT_KEYS = ["${BRIDGE_FRAGMENT_KEY}", "tgWebAppData"];
  var listeners = Object.create(null);

  function fragmentParams() {
    return new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
  }

  // The window that launched this mini app. Every other window is untrusted:
  // accepting its messages would let it capture later sendData payloads.
  var hostWindow = window.parent && window.parent !== window ? window.parent : window.opener || null;
  var pinnedOrigin = fragmentParams().get("${BRIDGE_HOST_ORIGIN_KEY}") || "";
  var hostOrigin = pinnedOrigin || "*";

  function post(type, payload) {
    var message = { source: SOURCES[0], type: type, payload: payload };
    try {
      if (hostWindow) {
        hostWindow.postMessage(message, hostOrigin);
      }
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }
      if (window.StudNovSuTwa && window.StudNovSuTwa.postMessage) {
        window.StudNovSuTwa.postMessage(JSON.stringify(message));
      }
      if (window.MatrixMiniAppHost && window.MatrixMiniAppHost.postMessage) {
        window.MatrixMiniAppHost.postMessage(JSON.stringify(message));
      }
    } catch (err) {
      /* the host may be gone; nothing useful to do here */
    }
  }

  function emit(name, arg) {
    var handlers = listeners[name];
    if (!handlers) return;
    for (var i = 0; i < handlers.length; i++) {
      try {
        handlers[i](arg);
      } catch (err) {
        if (window.console && console.error) console.error("[aiomatrix] listener failed", err);
      }
    }
  }

  function readFragmentInitData() {
    if (!window.location.hash) return "";
    var params = fragmentParams();
    for (var i = 0; i < FRAGMENT_KEYS.length; i++) {
      var value = params.get(FRAGMENT_KEYS[i]);
      if (value) return value;
    }
    return "";
  }

  function parseInitDataUnsafe(initData) {
    var out = {};
    if (!initData) return out;
    var params = new URLSearchParams(initData);
    params.forEach(function (value, key) {
      if (key === "user" || key === "room") {
        try {
          out[key] = JSON.parse(value);
          return;
        } catch (err) {
          /* keep the raw value */
        }
      }
      out[key] = key === "auth_date" ? Number(value) : value;
    });
    return out;
  }

  var initialInitData = readFragmentInitData();

  var api = {
    __aiomatrix: true,
    version: "1.0",
    platform: "matrix",
    initData: initialInitData,
    initDataUnsafe: parseInitDataUnsafe(initialInitData),
    colorScheme: "light",
    themeParams: {},
    isExpanded: false,
    viewportHeight: window.innerHeight,
    viewportStableHeight: window.innerHeight,
    /** Matrix context filled in by the host on init. */
    matrix: { userId: null, roomId: null, deviceId: null, botId: null, queryId: null },

    ready: function () {
      post("ready");
    },
    expand: function () {
      post("expand");
      api.isExpanded = true;
    },
    close: function () {
      post("close");
    },
    sendData: function (data) {
      post("sendData", { data: typeof data === "string" ? data : JSON.stringify(data) });
    },
    openLink: function (url, options) {
      post("openLink", { url: String(url), options: options || {} });
    },
    setHeaderColor: function (color) {
      post("setHeaderColor", { color: color });
    },
    setBackgroundColor: function (color) {
      post("setBackgroundColor", { color: color });
    },
    enableClosingConfirmation: function () {
      post("enableClosingConfirmation");
    },
    disableClosingConfirmation: function () {
      post("disableClosingConfirmation");
    },
    onEvent: function (name, handler) {
      if (typeof handler !== "function") return;
      (listeners[name] = listeners[name] || []).push(handler);
    },
    offEvent: function (name, handler) {
      var handlers = listeners[name];
      if (!handlers) return;
      var index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
    MainButton: {
      text: "",
      isVisible: false,
      isActive: true,
      setText: function (text) {
        this.text = String(text);
        post("mainButton", { action: "setParams", text: this.text });
        return this;
      },
      setParams: function (params) {
        post("mainButton", { action: "setParams", params: params || {} });
        return this;
      },
      show: function () {
        this.isVisible = true;
        post("mainButton", { action: "show" });
        return this;
      },
      hide: function () {
        this.isVisible = false;
        post("mainButton", { action: "hide" });
        return this;
      },
      onClick: function (handler) {
        api.onEvent("mainButtonClicked", handler);
        return this;
      },
      offClick: function (handler) {
        api.offEvent("mainButtonClicked", handler);
        return this;
      },
    },
    BackButton: {
      isVisible: false,
      show: function () {
        this.isVisible = true;
        post("backButton", { action: "show" });
        return this;
      },
      hide: function () {
        this.isVisible = false;
        post("backButton", { action: "hide" });
        return this;
      },
      onClick: function (handler) {
        api.onEvent("backButtonClicked", handler);
        return this;
      },
      offClick: function (handler) {
        api.offEvent("backButtonClicked", handler);
        return this;
      },
    },
    HapticFeedback: {
      impactOccurred: function (style) {
        post("haptic", { kind: "impact", style: style || "medium" });
        return this;
      },
      notificationOccurred: function (type) {
        post("haptic", { kind: "notification", type: type || "success" });
        return this;
      },
      selectionChanged: function () {
        post("haptic", { kind: "selection" });
        return this;
      },
    },
  };

  function applyInit(payload) {
    if (!payload || typeof payload !== "object") return;
    if (typeof payload.initData === "string" && payload.initData) {
      api.initData = payload.initData;
      api.initDataUnsafe = parseInitDataUnsafe(payload.initData);
    } else if (payload.initDataUnsafe && typeof payload.initDataUnsafe === "object") {
      api.initDataUnsafe = payload.initDataUnsafe;
    }
    if (payload.colorScheme) api.colorScheme = payload.colorScheme;
    if (payload.themeParams) api.themeParams = payload.themeParams;
    if (typeof payload.isExpanded === "boolean") api.isExpanded = payload.isExpanded;
    if (typeof payload.viewportHeight === "number") api.viewportHeight = payload.viewportHeight;
    if (typeof payload.viewportStableHeight === "number") {
      api.viewportStableHeight = payload.viewportStableHeight;
    }
    if (payload.matrix && typeof payload.matrix === "object") {
      api.matrix = {
        userId: payload.matrix.userId || null,
        roomId: payload.matrix.roomId || null,
        deviceId: payload.matrix.deviceId || null,
        botId: payload.matrix.botId || null,
        queryId: payload.matrix.queryId || null,
      };
    } else if (api.initDataUnsafe) {
      var unsafe = api.initDataUnsafe;
      api.matrix = {
        userId: unsafe.user && unsafe.user.id ? unsafe.user.id : null,
        roomId: unsafe.room && unsafe.room.id ? unsafe.room.id : null,
        deviceId: null,
        botId: unsafe.bot_id || null,
        queryId: unsafe.query_id || null,
      };
    }
    emit("init", payload);
    emit("themeChanged", { colorScheme: api.colorScheme, themeParams: api.themeParams });
  }

  window.addEventListener("message", function (event) {
    // Only the launching window may drive this mini app.
    if (hostWindow && event.source && event.source !== hostWindow) return;
    if (pinnedOrigin && event.origin && event.origin !== pinnedOrigin) return;
    var data = event.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (err) {
        return;
      }
    }
    if (!data || SOURCES.indexOf(data.source) === -1) return;
    // Reply to the exact origin we heard from instead of broadcasting to "*".
    if (hostOrigin === "*" && event.origin && event.origin !== "null") {
      hostOrigin = event.origin;
    }
    switch (data.type) {
      case "init":
        applyInit(data.payload);
        break;
      case "themeChanged":
        if (data.payload) {
          if (data.payload.colorScheme) api.colorScheme = data.payload.colorScheme;
          if (data.payload.themeParams) api.themeParams = data.payload.themeParams;
        }
        emit("themeChanged", data.payload);
        break;
      case "viewportChanged":
        if (data.payload && typeof data.payload.viewportHeight === "number") {
          api.viewportHeight = data.payload.viewportHeight;
          api.viewportStableHeight =
            typeof data.payload.viewportStableHeight === "number"
              ? data.payload.viewportStableHeight
              : data.payload.viewportHeight;
        }
        emit("viewportChanged", data.payload);
        break;
      case "mainButtonClicked":
        emit("mainButtonClicked", data.payload);
        break;
      case "backButtonClicked":
        emit("backButtonClicked", data.payload);
        break;
      case "dataSent":
        emit("dataSent", data.payload);
        break;
      case "error":
        emit("error", data.payload);
        break;
      default:
        emit(String(data.type), data.payload);
    }
  });

  window.MatrixMiniApp = api;
  // Drop-in alias so mini apps written against the Telegram WebApp API work.
  window.Telegram = window.Telegram || {};
  if (!window.Telegram.WebApp || !window.Telegram.WebApp.__aiomatrix) {
    window.Telegram.WebApp = api;
  }

  post("bridgeReady");
  post("requestInit");
})();
`;

export interface BridgeAsset {
  body: string;
  contentType: string;
  etag: string;
  /** Suggested `Cache-Control` value. */
  cacheControl: string;
}

/** Serve the bridge script from any HTTP framework. */
export function serveMiniAppBridge(): BridgeAsset {
  const etag = `"${createHash("sha256").update(MINIAPP_BRIDGE_SCRIPT).digest("base64url").slice(0, 27)}"`;
  return {
    body: MINIAPP_BRIDGE_SCRIPT,
    contentType: "application/javascript; charset=utf-8",
    etag,
    cacheControl: "public, max-age=3600, must-revalidate",
  };
}

/**
 * `init` payload a host sends to the iframe/WebView after `bridgeReady`.
 * Keeping this typed on the Node side prevents host/mini-app protocol drift.
 */
export interface BridgeInitPayload {
  initData: string;
  initDataUnsafe?: Record<string, unknown>;
  version?: string;
  platform?: string;
  colorScheme?: "light" | "dark";
  themeParams?: Record<string, string>;
  isExpanded?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  matrix?: {
    userId?: string | null;
    roomId?: string | null;
    deviceId?: string | null;
    botId?: string | null;
    queryId?: string | null;
  };
}

/** Build a well-formed host → mini app `init` message. */
export function buildBridgeInitMessage(payload: BridgeInitPayload): {
  source: string;
  type: "init";
  payload: BridgeInitPayload;
} {
  return {
    source: BRIDGE_SOURCE,
    type: "init",
    payload: {
      version: "1.0",
      platform: "matrix",
      colorScheme: "light",
      themeParams: {},
      ...payload,
    },
  };
}
