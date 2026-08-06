# Aware host contract (aiomatrix)

Checklist for Matrix clients / hosts that understand `dev.aiomatrix.*` fields.
Follow it so bots can keep timelines clean without losing stock-client escapes.

## Send-side (bots)

| Setting | Aware default | Why |
|---|---|---|
| `clientProfile: "aware"` | one switch | Applies `AWARE_MESSAGE_DEFAULTS` + lean MiniApp flags |
| `messageDefaults.keyboardFallback: false` | via aware profile | Skip `!cb` / `<ol>` dumps |
| `messageDefaults.parseMode: "markdown"` | **library default** | Markup gets `formatted_body`; plain `"ok"` stays plain |
| MiniApp lean flags | via aware profile | See table in code / `AWARE_MINI_APP_DEFAULTS` |

```ts
const bot = await Bot.create({
  clientProfile: "aware",
  advertiseCapabilities: true, // also writes dev.aiomatrix.bot when advertiseCommands runs
  // ...
});

dp.use(autoMarkRead());
dp.use(rateLimitBackoff());
```

`bot.getHealth().ok` is suitable for k8s readiness (running, fresh sync, crypto ready).
`Bot.stop()` flushes durable alias/bind/used maps under `storagePath`.

## Receive-side (clients)

1. **One-shot** — `normalizeAiomatrixContent(content)` → `{ kind, preview, body, … }`.
2. Or step-by-step: `classifyAiomatrixContent` → `formatMessagePreview` → strip helpers.
3. **Timeline** — render structured fields; ignore plaintext / `<ol>` fallbacks.
4. **MiniApp data** — read `dev.aiomatrix.mini_app_data.data`.
5. **Button presses** — `buildCallbackContent(token)` on `dev.aiomatrix.callback`.
6. **Bot capabilities** — optional room state `dev.aiomatrix.bot` via `advertiseCapabilities`.
7. **Host capabilities** — hosts publish `dev.aiomatrix.host`; bots adapt toasts/polls via `getHostCapabilities`.
8. **Toasts / progress** — `dev.aiomatrix.callback_answer`, `dev.aiomatrix.toast`, `dev.aiomatrix.progress`
   (ephemeral UI; stock falls back to notices).
9. **Legacy migration** — old JSON/`!cb` bodies: use the helpers; do not rewrite history.

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

## Callback answers (toasts)

| Profile | `answerCallback({ text })` |
|---|---|
| `stock` (default) | Timeline notice reply (Matrix has no native toast) |
| `aware` | Room event `dev.aiomatrix.callback_answer` — hosts should show it ephemerally to `user_id` only |

Force a notice on aware hosts with `{ text, timeline: true }`.

```ts
// Host: listen for CALLBACK_ANSWER_EVENT_TYPE
import { CALLBACK_ANSWER_EVENT_TYPE } from "aiomatrix";
```

## Callback aliases, binds, multi-instance

- Short `!cb` ids / binds / used-tokens default to **files under `storagePath`** (`createFileSharedTokenStores`).
- Multi-instance: `createRedisSharedTokenStores(redis)` from **`aiomatrix`** (no redis package dependency —
  pass any `RedisLike` client). Alias resolve uses `getAsync` for strict cross-host short `!cb`.
- Ops hooks: `onSyncStale`, `onRateLimited`, `onStoreWarn`, optional `onMetric`.
- Device GC: `relocateSession({ pruneOtherDevices: true })` or cautious `pruneOtherDevicesOnStart`
  (password required, idle ≥ 7 days by default).

## Schema contract (0.8+)

- Library constant: `AIOMATRIX_SCHEMA_VERSION` / per-field `AIOMATRIX_SCHEMA`.
- Normative checklist: `AWARE_CONTRACT` (must / best_effort).
- Capability levels: `stock | aware | hybrid` via `resolveCapabilityLevel`.
- Unified receive path: `pipelineAiomatrixContent(content)` → envelope.
- Cold start: `COLD_START_DISPATCH` — timeline updates never dispatch during bootstrap.

See also `COMPAT.md`, `SCENES.md`, `PUBLIC_API.md`.
