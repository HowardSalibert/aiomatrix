# MiniApps for Matrix

MiniApps bring the Telegram WebApp model to Matrix: the bot posts a launch card, the client opens a
web page, and that page can prove *who* opened it without trusting the browser. The API mirrors
Telegram's closely enough that most existing mini apps run unchanged — `window.Telegram.WebApp` is an
alias of `window.MatrixMiniApp`.

There are four moving parts:

| Part | Where it runs | What it does |
|---|---|---|
| Launch signing | Bot process | Builds a signed, per-user URL (`initData`) |
| Bridge script | Mini app page | Exposes `window.MatrixMiniApp`, talks to the host over `postMessage` |
| Backend (`MiniAppServer`) | Your HTTP server | Validates `initData`, mints session tokens, routes `sendData` |
| Widget (optional) | Matrix room state | Lets clients embed the app inline instead of opening a link |

## 1. Configure the bot

```ts
const bot = await Bot.create({
  homeserverUrl: "example.org",
  userId: "@mybot:example.org",
  password: process.env.MATRIX_PASSWORD,
  miniApp: {
    // Omit to auto-generate into storagePath/miniapp.json. Needs >= 32 bytes of entropy.
    secret: process.env.MINIAPP_SECRET,
    defaultUrl: "https://app.example.org/",
    allowedOrigins: ["https://app.example.org"],
    initDataTtlSeconds: 3600,
  },
});
```

The secret is shared between the bot and the mini app's backend and must never reach the browser
bundle. If you don't provide one, the bot generates it once and persists it; read it with
`bot.miniAppSigningSecret` to copy into the backend's environment.

`allowedOrigins` is enforced on launch: a URL from anywhere else throws `MiniAppAuthError` rather than
signing launch data for an origin you don't control. When only `defaultUrl` is set, its origin becomes
the allowlist automatically.

## 2. Launch a mini app

```ts
// Launch card with a signed, single-user URL:
await bot.sendMiniApp(ctx.roomId, {
  userId: ctx.senderId,
  title: "Order form",
  description: "Pick your items and submit",
  buttonText: "Open",
  url: "https://app.example.org/order",
  startParam: "promo-42",
  // Aware hosts: lean card without plain link / duplicate keyboard dump:
  // includePlainLink: false, includeLaunchKeyboard: false,
});

// The signed launch URL stays in `dev.aiomatrix.mini_app` only — the timeline
// body is title + description + a short https link (hash stripped). Top-level
// `content.url` is omitted so clients do not treat the card as `mxc://` media.

// Or build the signed URL yourself and put it wherever you like:
const launch = bot.createMiniAppLaunch({
  userId: ctx.senderId,
  roomId: ctx.roomId,
  url: "https://app.example.org/order",
  startParam: "promo-42",
});
// launch.url, launch.signed, launch.queryId

await ctx.reply("Ready when you are", {
  keyboard: new InlineKeyboard().miniApp("Open form", launch.url),
});
```

The signed payload rides in the URL fragment (`#matrixWebAppData=...`), so it never appears in server
logs or `Referer` headers. It contains the user id and display name, the room (id, direct/group,
title), a `query_id` for the reply round trip, `start_param`, the bot's user id, an `auth_date`, a
nonce, and an HMAC-SHA256 signature.

When you know which client will open the app (your own web client, for instance), pin its origin so
the bridge refuses `postMessage` traffic from anywhere else. This is the origin of the *host* window
that embeds the mini app, not the mini app's own origin:

```ts
buildMiniAppLaunchUrl(launchUrl, signed, { matrixWebAppHost: "https://chat.example.org" });
```

Without the pin, the bridge talks only to the window that opened it and adopts that window's origin on
first contact — safe against unrelated frames, but the explicit pin is stricter.

## 3. Load the bridge in the page

```html
<script src="https://app.example.org/matrix-miniapp.js"></script>
```

Serve it from your own origin (there is no CDN to trust):

```ts
import { serveMiniAppBridge } from "aiomatrix";

app.get("/matrix-miniapp.js", (_req, res) => {
  const asset = serveMiniAppBridge();
  res.type(asset.contentType).set("ETag", asset.etag).set("Cache-Control", asset.cacheControl);
  res.send(asset.body);
});
```

`MiniAppServer` also serves it at `GET <basePath>/bridge.js`.

### Bridge API

```js
const app = window.MatrixMiniApp; // === window.Telegram.WebApp

app.initData;            // signed payload string — send this to your backend
app.initDataUnsafe;      // parsed, NOT verified; for optimistic rendering only
app.matrix;              // { userId, roomId, botId, queryId, startParam }
app.version;             // "1.0"
app.platform;            // "matrix"
app.colorScheme;         // "light" | "dark"
app.themeParams;
app.isExpanded;
app.viewportHeight;
app.viewportStableHeight;

app.ready();             // tell the host the page is painted
app.expand();
app.close();
app.sendData(payload);   // string or object; object is JSON-stringified
app.openLink(url, { tryInstantView });
app.setHeaderColor(color);
app.setBackgroundColor(color);
app.enableClosingConfirmation();
app.disableClosingConfirmation();

app.MainButton.setText("Submit").show();
app.MainButton.setParams({ color: "#2563eb", is_active: true });
app.MainButton.onClick(submit);
app.BackButton.show();
app.BackButton.onClick(goBack);
app.HapticFeedback.impactOccurred("medium");
app.HapticFeedback.notificationOccurred("success");
app.HapticFeedback.selectionChanged();

app.onEvent("themeChanged", handler);   // also viewportChanged, mainButtonClicked,
app.offEvent("themeChanged", handler);  // backButtonClicked, dataSent, error
```

`initDataUnsafe` is exactly what its name says: anyone can edit the fragment. Every authorization
decision must be based on the backend's verification of `initData`.

## 4. Validate on the backend

```ts
import http from "node:http";

const server = bot.createMiniAppServer({
  allowedOrigins: ["https://app.example.org"],
  sessionTtlSeconds: 3600,
  singleUseLaunch: true,
  // Live PL/membership from the bot RoomCache (default when created via Bot).
  // requireMembership: ["join"],
  // minPowerLevel: 50,
});

http.createServer(server.nodeHandler()).listen(8080);
```

Launch cards signed by `Bot.createMiniAppLaunch` include a **snapshot** of the user's membership
and power level in `room`. Those fields are copied into the session token. Snapshots can go stale —
for moderator-gated writes prefer `resolveRoomAuth` / `GET /room-auth`, or the helpers:

```ts
import { assertMiniAppJoined, assertMiniAppPower } from "aiomatrix";

const session = server.verify(req.headers.authorization);
assertMiniAppJoined(session);
assertMiniAppPower(session, 50); // fail-closed when powerLevel is null
```

Routes, relative to `basePath` (default `/`):

| Route | Purpose |
|---|---|
| `POST /auth` | Body `{ initData }`. Returns `{ token, expires_at, user, room, query_id, start_param }` |
| `POST /data` | `Authorization: Bearer <token>`, body `{ data }`. Routes into the dispatcher |
| `GET /me` | Returns the session behind a token (includes `membership` / `powerLevel` when present) |
| `GET /room-auth` | Live or session room auth (`membership`, `power_level`) |
| `GET /bridge.js` | The bridge script |
| `OPTIONS *` | CORS preflight |

Inside your own framework, use the pieces directly:

```ts
const { validated, token } = server.authenticate(req.body.initData);
const session = server.verify(req.headers.authorization); // throws MiniAppAuthError
```

Front-end flow:

```js
const res = await fetch("/api/miniapp/auth", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData: app.initData }),
});
const { token, user, query_id } = await res.json();

await fetch("/api/miniapp/data", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ data: JSON.stringify({ action: "submit", items }) }),
});
```

## 5. Handle the data in the bot

```ts
router.miniAppData(F.miniApp.action("submit"), async (ctx) => {
  const items = (ctx.payload as { items: string[] }).items;
  await ctx.answerWebAppQuery(`Order accepted: ${items.length} items`);
});
```

`ctx.raw` is the exact string the mini app sent, `ctx.payload` is the parsed JSON (or `null` if it
wasn't JSON), `ctx.queryId` correlates with the launch, and `ctx.appId` identifies the app.

Answering out of band works too, and reports whether the query was still live:

```ts
const eventId = await bot.answerMiniAppQuery(queryId, "Done");
if (eventId === null) {
  // unknown, expired, or already answered
}
```

If sending fails, the query is released so the mini app can retry rather than losing the round trip.

## 6. Widgets (optional)

Element and other widget-capable clients can embed a mini app inline:

```ts
await bot.pinMiniAppWidget(roomId, {
  widgetId: "order-form",
  url: "https://app.example.org/order?matrixUserId=$matrix_user_id",
  name: "Order form",
  title: "Place an order",
  layout: true, // also write io.element.widgets.layout so it pins to the top
});

await bot.removeWidget(roomId, "order-form");
```

Widget URLs support the standard `$matrix_user_id`, `$matrix_room_id`, `$matrix_display_name`, and
`$matrix_avatar_url` templates, which the client substitutes. Note that widget URL parameters are
*not* signed — treat them as hints, and still run the `initData` flow for anything privileged.

Pinning a widget requires enough power level to send state events in the room.

## Security model

What the signature buys you, and what it doesn't:

- **Authenticated.** `initData` is HMAC-SHA256 over the sorted `key=value` pairs, with the signing key
  derived as `HMAC(secret, "MatrixWebAppData")` — the same construction Telegram uses. Comparison is
  timing-safe. A tampered user id fails verification.
- **Time-boxed.** `auth_date` plus `initDataTtlSeconds` (default 1 hour) bound how long a captured
  launch stays usable.
- **Single-use.** Each launch carries a nonce; `MiniAppServer` rejects a second `/auth` with the same
  one. Set `singleUseLaunch: false` only if you truly need reloads to re-authenticate. With several
  HTTP workers, pass `asyncNonceStore` (Redis SET NX — `examples/redis-stores`) so the check is
  global; the default store is process-local.

- **Origin-pinned.** The bridge posts only to the window that launched it, and only to
  `matrixWebAppHost` when that is set. Messages from other windows or origins are ignored, so a rogue
  frame cannot harvest `sendData` payloads.
- **Not confidential.** The fragment is visible to the user and to any script on the page. Never put
  secrets in `start_param`, and don't skip TLS.
- **Session tokens are bearer tokens.** They are HMAC-signed and carry `{ userId, roomId, queryId,
  appId, exp }`. Treat them like cookies: HTTPS only, no logging.

The bot secret must be identical on both sides. Rotating it invalidates every outstanding launch and
session, which is the intended way to revoke them.

## Compatibility with Telegram mini apps

Mostly drop-in. Differences worth knowing:

- IDs are Matrix ids (`@alice:example.org`), not numeric.
- `chat` is `room`, with `type: "direct" | "group"`.
- The fragment key is `matrixWebAppData`; the bridge also reads `tgWebAppData`, so a Telegram-built
  URL still parses.
- The signing salt is `MatrixWebAppData`, so Telegram-signed payloads will not validate here (by
  design — they were signed by a different party).
- There is no Telegram-style native launcher. Clients open the URL, or embed it as a widget.

## Reference

- `createInitData` / `validateInitData` — signing and verification
- `buildMiniAppLaunchUrl` / `isMiniAppUrlAllowed` — URL construction and allowlisting
- `MiniAppServer`, `createSessionToken`, `verifySessionToken` — backend
- `MiniAppQueryRegistry` — in-flight launches and replay protection
- `MINIAPP_BRIDGE_SCRIPT`, `serveMiniAppBridge`, `buildBridgeInitMessage` — browser bridge
- `buildMiniAppContent`, `buildMiniAppDataContent` — event content builders
- `buildWidgetStateContent`, `buildWidgetLayoutContent`, `templateWidgetUrl`, `parseWidgetStateEvent`
