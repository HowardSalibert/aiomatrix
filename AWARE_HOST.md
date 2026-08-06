# Aware host contract (aiomatrix)

Checklist for Matrix clients / hosts that understand `dev.aiomatrix.*` fields.
Follow it so bots can keep timelines clean without losing stock-client escapes.

## Send-side (bots)

| Setting | Aware default | Why |
|---|---|---|
| `messageDefaults.keyboardFallback: false` | recommended | Skip `!cb` / `<ol>` dumps; buttons live in `dev.aiomatrix.keyboard` |
| `messageDefaults.parseMode: "markdown"` | **library default since 0.6.2** | `reply("**hi**")` gets `formatted_body`; set `"plain"` to opt out |
| MiniApp `includePlainLink: false` | when only aware hosts open apps | No bare https line under the card |
| MiniApp `includeLaunchKeyboard: false` | optional | Card field is enough; avoid duplicate mini_app button |
| MiniApp `includeKeyboardFallback: false` | library default | Do not append `!cb` under launch cards |
| MiniApp `topLevelUrl: false` | library default | Top-level `url` means `mxc://` media — keep launch URL in `dev.aiomatrix.mini_app` only |
| MiniApp data `body` / `summary` / `formatBody` | human preview | Raw JSON only in `dev.aiomatrix.mini_app_data.data` |
| `hideFromStockClients: true` | for silent round-trips | Zero-width body so Element/Schildi do not show service events as chat |

```ts
const bot = await Bot.create({
  // ...
  messageDefaults: {
    keyboardFallback: false, // aware room / custom client
    // parseMode defaults to "markdown"
  },
  miniApp: {
    defaultUrl: "https://app.example.org/",
    includePlainLink: false,
    includeLaunchKeyboard: true,
  },
});
```

## Receive-side (clients)

1. **Room list / notifications** — call `formatMessagePreview(content)` first. If it returns a string, use it. Do **not** show raw `content.body` for aiomatrix events (legacy JSON / `!cb` dumps).
2. **Timeline** — render `dev.aiomatrix.keyboard` and `dev.aiomatrix.mini_app` natively; ignore plaintext fallbacks when present.
3. **MiniApp data** — read `dev.aiomatrix.mini_app_data.data`; use `formatMiniAppDataPreview(data)` (or the event body if it is already human and not JSON).
4. **Legacy migration** — old events may have:
   - `body === data` (raw JSON dump)
   - trailing `1. Label → !cb <token>` blocks
   - top-level `content.url` https on MiniApp cards  
   Normalize with `formatMessagePreview` / `stripKeyboardFallbackText` / card field parsers. Do not rewrite history.

## `sendData` vs `answerWebAppQuery` (what appears in the room)

| Path | Posted to Matrix room? | Visible as |
|---|---|---|
| Browser `sendData` → `POST /data` → `feedMiniAppData` | **No** (in-process synthetic update) | Only your handler sees it |
| Client posts `buildMiniAppDataContent(...)` as `m.room.message` | **Yes** | Human `body` + structured data field (or hidden body) |
| `ctx.answerWebAppQuery` / `bot.answerMiniAppQuery` | **Yes** | Normal bot text/notice (`m.text` / `m.notice`) |

Default HTTP MiniApp flow never writes the user's `sendData` JSON into the room. The bot reply is a separate message. If a **native client** mirrors `sendData` into the timeline, it must use `buildMiniAppDataContent` (human body) rather than stuffing JSON into `body`.

## Device GC (ops)

After crypto wipes / redeploys, prune ghost devices so Megolm fanout stays small:

```ts
await relocateSession({
  storagePath: "./data",
  homeserverUrl: "example.org",
  user: "@bot:example.org",
  password: process.env.MATRIX_PASSWORD!,
  wipeCrypto: true,
  pruneOtherDevices: true, // recommended default ops path
});
```

Or call `pruneOtherDevices(http, { keepDeviceId, auth })` on a live session.
