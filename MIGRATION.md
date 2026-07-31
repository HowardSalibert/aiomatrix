# Migrating from 0.2.x to 0.3.0

Most bots need three small edits or none at all. Commands, filters, `ctx.reply`, `Router.message`, and
`Bot.create` all still work the way they did. The breaking changes are concentrated in the crypto
export, the dispatcher's internal entry point, and two behaviour defaults.

## 0. The package is now called `aiomatrix`

`matrixbots` on npm belongs to an unrelated, abandoned package, so the published name is `aiomatrix`.

```diff
-import { Bot } from "matrixbots";
+import { Bot } from "aiomatrix";
```

```bash
npm uninstall matrixbots && npm install aiomatrix
```

The custom event types moved with it, and out of the `m.*` namespace that the Matrix spec reserves for
itself:

| 0.2.x | 0.3.0 |
|---|---|
| `m.matrixbots.commands` | `dev.aiomatrix.commands` |
| `m.matrixbots.keyboard` | `dev.aiomatrix.keyboard` |
| `m.matrixbots.callback` | `dev.aiomatrix.callback` |
| `m.matrixbots.mini_app` | `dev.aiomatrix.mini_app` |

Only the command-advertisement event existed in 0.2.x; the rest are new. If you have `m.matrixbots.commands`
state events lying around in rooms, re-run `bot.advertiseCommands(roomId)` to write the new one. Also
rename the `MATRIXBOTS_LOG_LEVEL` environment variable to `AIOMATRIX_LOG_LEVEL`.

## Requirements

- Node >= 20.10 (was >= 20).

## 1. `CryptoEngine` moved out of the root entry

The native E2EE bindings are now an `optionalDependency`, so `aiomatrix` itself imports on any
platform. `CryptoEngine` is no longer a runtime export of the root module.

```diff
-import { CryptoEngine } from "aiomatrix";
+import { CryptoEngine } from "aiomatrix/crypto";
```

or, if you want the friendly error when the native package is missing:

```ts
import { loadCryptoEngine } from "aiomatrix";
const CryptoEngine = await loadCryptoEngine();
```

Nothing changes for bots that just set `crypto: true` — the `Bot` loads the engine itself. If you ship
a lockfile, add the optional dependency explicitly so it is definitely installed on your platform:

```bash
npm install @matrix-org/matrix-sdk-crypto-nodejs
```

`mapHistoryVisibility` also moved to `aiomatrix/crypto`. The policy helpers
(`resolveEncryptionSharePolicy`, `normalizeToDeviceBody`, `DEFAULT_ENCRYPTION_SHARE_POLICY`,
`filterShareRecipients`, `parseToDeviceRecipients`) stay on the root export — they are pure functions
with no native code behind them.

## 2. `Dispatcher.feed` takes a context

Only relevant if you fed events into the dispatcher yourself.

```diff
-await dispatcher.feed(bot, roomId, event);
+await bot.feedRoomEvent(roomId, event);
```

`bot.feedRoomEvent`, `bot.feedToDevice`, and `bot.feedInvite` build the right typed context and run it
through the dispatcher — the same path the sync loop uses, which makes them useful for tests, bridges,
and replays. `dispatcher.feed(ctx)` still exists for contexts you built with `ContextFactory`.

## 3. `createContext` became `ContextFactory`

```diff
-import { createContext } from "aiomatrix";
-const ctx = createContext(bot, roomId, event);
+import { ContextFactory } from "aiomatrix";
+const factory = new ContextFactory(deps);
+const ctx = await factory.fromRoomEvent(roomId, event);
```

`ctx` grew fields (`updateType`, `logger`, `data`, `roomName`, `attachment`, `mentions`,
`powerLevels()`, …) but keeps everything 0.2.x had, including the `body` alias for `text`.

## Behaviour changes to be aware of

**Presence defaults to `offline`.** Bots no longer appear online to every room member. Restore the old
behaviour with `presence: "online"`.

**Plain-HTTP homeservers are refused.** The access token is sent on every request, so a non-localhost
`http://` URL now throws `ConfigurationError` instead of warning:

```ts
await Bot.create({ homeserverUrl: "http://matrix.internal", allowInsecureHomeserver: true });
```

**`rotateEveryMessage` defaults to `false`.** In 0.2.x every encrypted message started a fresh Megolm
session and re-shared it to every device in the room, which is why encrypted rooms were slow. If you
depended on that (you almost certainly did not), set it explicitly:

```ts
await Bot.create({ /* ... */, encryption: { rotateEveryMessage: true } });
```

**Encryption state is no longer guessed.** When the homeserver cannot tell us whether a room is
encrypted (rate limit, network error), sends now throw `EncryptionStateUnknownError` instead of falling
back to plaintext. Handle it as a retryable error:

```ts
try {
  await ctx.reply("hi");
} catch (err) {
  if (err instanceof EncryptionStateUnknownError) return; // the next sync will settle it
  throw err;
}
```

**Filters that touch encryption are cache-only.** `F.room.encrypted` reads the sync-backed cache and
never blocks on HTTP, so it is `false` for a room the bot has not seen state for yet. Use
`await client.isRoomEncrypted(roomId)` when you need the authoritative answer.

## Deprecations

`guardedSendText` and `guardedSendHtml` still work but are unnecessary: the client enforces the E2EE
contract on every send, so `ctx.reply` and `client.sendText` are already guarded. The `retryHandler`
middleware is gone; use `errorReply` plus `dp.errors(handler)` (or `handlerTimeoutMs`) instead.

## Things worth adopting

None of these are required, but they are why 0.3.0 exists:

```ts
// Log in with a password so the device id survives restarts — the thing E2EE needs.
await Bot.create({ homeserverUrl: "example.org", userId: "@bot:example.org", password, crypto: true });

// Start, wait for a signal, shut down cleanly.
await bot.run(dp);

// Liveness that actually reflects the sync loop.
setInterval(() => {
  if (bot.getHealth().syncAgeMs > 300_000) process.exit(1);
}, 60_000);

// Persistent conversation state.
new Dispatcher({ storage: new JsonFileStorage("./data/fsm.json") });

// Buttons, and a plain-text fallback for clients that don't render them.
await ctx.reply("Pick one", { keyboard: new InlineKeyboard().text("A", "pick:a").text("B", "pick:b") });
```

Also see [MINIAPP.md](./MINIAPP.md) for the MiniApp platform and [CHANGELOG.md](./CHANGELOG.md) for the
full list of fixes.
