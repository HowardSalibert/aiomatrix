# Aware host contract (aiomatrix)

Checklist for Matrix clients / hosts that understand `dev.aiomatrix.*` fields.
Follow it so bots can keep timelines clean without losing stock-client escapes.

## Send-side (bots)

| Setting | Aware default | Why |
|---|---|---|
| `messageDefaults.keyboardFallback: false` | recommended | Skip `!cb` / `<ol>` dumps; buttons live in `dev.aiomatrix.keyboard` |
| `messageDefaults.parseMode: "markdown"` | **library default since 0.6.2** | `reply("**hi**")` gets `formatted_body` when markup is present; set `"plain"` to opt out |
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
    // parseMode defaults to "markdown" (plain strings stay without formatted_body)
  },
  miniApp: {
    defaultUrl: "https://app.example.org/",
    includePlainLink: false,
    includeLaunchKeyboard: true,
  },
});
```

`bot.sendMessage` / `sendHtml` / `answerMiniAppQuery` / `ctx.answer*` / edits honour the same defaults.

## Receive-side (clients)

1. **Classify** — `classifyAiomatrixContent(content)` → `"keyboard" | "mini_app" | "mini_app_data" | null`.
2. **Room list / notifications** — call `formatMessagePreview(content)` first. If it returns a string, use it. Do **not** show raw `content.body` for aiomatrix events (legacy JSON / `!cb` dumps).
3. **Timeline** — render `dev.aiomatrix.keyboard` and `dev.aiomatrix.mini_app` natively; ignore plaintext / `<ol>` fallbacks when present (`stripKeyboardFallbackText` / `stripKeyboardFallbackHtml`).
4. **MiniApp data** — read `dev.aiomatrix.mini_app_data.data`; use `formatMiniAppDataPreview(data)`.
5. **Button presses** — send `dev.aiomatrix.callback` with `buildCallbackContent(token)` (full signed `token` from the keyboard JSON, not the short `!cb` alias).
6. **Legacy migration** — old events may have:
   - `body === data` (raw JSON dump)
   - trailing `1. Label → !cb <token>` / `<ol>` blocks
   - top-level `content.url` https on MiniApp cards  
   Normalize with the helpers above. Do not rewrite history.

```ts
import { buildCallbackContent, CALLBACK_EVENT_TYPE } from "aiomatrix";

await client.sendEvent(roomId, CALLBACK_EVENT_TYPE, buildCallbackContent(button.token));
```

## `sendData` vs `answerMiniAppQuery` (what appears in the room)

| Path | Posted to Matrix room? | Visible as |
|---|---|---|
| Browser `sendData` → `POST /data` → `feedMiniAppData` | **No** (in-process synthetic update; human/hidden body shape) | Only your handler sees it |
| Client posts `buildMiniAppDataContent({ data, … })` | **Yes** | Human `body` + structured data field (or hidden body) |
| `ctx.answerMiniAppQuery` / `ctx.answerWebAppQuery` / `bot.answerMiniAppQuery` | **Yes** | Normal bot text/notice; **claims** the query once |

`answerWebAppQuery` is an alias of `answerMiniAppQuery` and claims the launch query when `ctx.queryId` is set (double-answer safe).

## Callback aliases, binds, multi-instance

- Short `!cb` ids map to signed tokens via `callbackAliasStore` (default: `storagePath/callback-aliases.json`).
- `answerCallback({ editText })` needs the source event id from `callbackBindStore` (default: `storagePath/callback-binds.json`).
- **Answered flags** and in-memory `side` state remain process-local unless you share `callbackUsedStore` / Redis.
- Multi-instance: inject shared `callbackAliasStore`, `callbackBindStore`, and `callbackAsyncUsedStore` (see `examples/redis-stores`).

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
