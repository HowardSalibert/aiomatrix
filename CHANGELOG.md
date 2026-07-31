# Changelog

All notable changes to this project. Format loosely follows [Keep a Changelog]; the project uses
semantic versioning.

## 0.3.0

A near-total rework toward the aiogram feature set, plus the MiniApp platform. The message-handling
basics are unchanged, but routing, contexts, and the client surface grew substantially. See
[MIGRATION.md](./MIGRATION.md).

### Security fixes

- **Plaintext leak into encrypted rooms.** `isRoomEncrypted` used to cache `false` on *any* error, so a
  429 or a network blip could downgrade a room to plaintext for the rest of the process lifetime. The
  encryption state now comes from a sync-backed cache; only a definitive 404 means "not encrypted", and
  an indeterminate answer raises `EncryptionStateUnknownError` instead of sending in the clear.
- **Callback token replay across rooms.** Inline keyboard tokens are now bound to the room *and* the
  user the keyboard was sent to, single-use by default, and generated from a CSPRNG.
- **MiniApp bridge origin spoofing.** The browser bridge no longer posts to `*` or accepts messages
  from arbitrary windows. It talks only to the launching window, and only to `matrixWebAppHost` when
  that fragment parameter is set.
- **Access token over plain HTTP.** A non-localhost `http://` homeserver now throws
  `ConfigurationError` rather than warning, since the token travels on every request. Opt out with
  `allowInsecureHomeserver: true`.
- **`javascript:` URLs in buttons and MiniApp cards.** Button and launch URLs are validated
  (`isSafeButtonUrl`); only https, plus http on localhost, is accepted.
- **Hash collisions in device-set fingerprints.** `fingerprintSet` length-prefixes its members, so
  two different device sets can no longer produce the same fingerprint and suppress a needed re-share.
- Transaction ids include random bytes instead of relying on a timestamp plus counter.

### Performance

- **Megolm share storm.** Share sets are cached per room and invalidated on device-list changes rather
  than recomputed per message, and `rotateEveryMessage` now defaults to `false`. This removes the
  `/keys/query` flood that made encrypted rooms unusable at any real membership size.
- **Undecryptable events are retried** from a bounded queue instead of being dropped when keys arrive
  a moment late.
- `EventDeduper` evicts in amortized O(1) instead of `Array.shift()`.
- `DispatchQueue` wakes one waiter per release instead of the whole herd.
- Room state (encryption, members, power levels, direct status, history visibility) is populated from
  `/sync` and cached with an LRU, so filters like `F.room.encrypted` never touch HTTP.

### Reliability

- **Sync filter recovery.** If the runtime filter failed to upload after bootstrap, the bot stayed on
  `timeline.limit: 0` forever and silently saw no messages. The persisted filter kind is now compared
  with the desired kind and re-uploaded when they differ.
- **429 handling.** `retry_after_ms` is honoured, with exponential backoff and jitter for 5xx.
- **Poison batch protection**, configurable backoff bounds, and abortable backoff so `stop()` cannot
  hang.
- **Atomic writes** for `sync.json`, `device.json`, `session.json`, and `miniapp.json`.
- **Token refresh** for homeservers issuing refreshable tokens; unrecoverable auth failures stop the
  loop and call `onFatal` instead of spinning.
- Graceful shutdown drains in-flight handlers with a timeout.

### Added

- **Update types.** `message`, `edited_message`, `reaction`, `redaction`, `membership`, `invite`,
  `callback_query`, `mini_app_data`, `poll_response`, `to_device`, `raw_event`, each with a typed
  context and a dedicated `Router` method.
- **MiniApp platform.** Signed `initData` (HMAC-SHA256, TTL, single-use nonces), the
  `window.MatrixMiniApp` browser bridge with a `window.Telegram.WebApp` alias, a framework-agnostic
  `MiniAppServer`, launch cards, query round trips, and Matrix widget helpers. See
  [MINIAPP.md](./MINIAPP.md).
- **Inline keyboards** with callback queries, URL/MiniApp/command buttons, and a plain-text fallback
  for clients that don't understand the convention.
- **`F` filter namespace** covering text, media, rooms, senders, power levels, mentions, reactions,
  callbacks, MiniApp payloads, and membership.
- **FSM** gains `JsonFileStorage`, TTL expiry, and `FsmStrategy` (`user_in_room`, `room`, `user`,
  `global`), plus `inStateGroup`.
- **Middleware** library: `throttle`, `accessControl`, `i18n`, `typingIndicator`, `errorReply`,
  `logging`, `skipSelf`, `compose`.
- **Commands** gain aliases, `hidden`, `minPowerLevel`, `scope`, `category`, generated help
  (`bot.helpText()` / `helpHtml()`), and client advertisement via `bot.advertiseCommands(roomId)`.
- **Media**: `sendFile`, `sendFileFromPath`, `sendSticker`, `sendLocation`, thumbnails, and
  transparent encrypt/decrypt of attachments.
- **Client surface**: room creation, invites/kicks/bans, power levels, aliases, receipts and read
  markers, account data, `/messages` and `/relations` pagination, edits, threads, mention pills.
- **`Scheduler`** (`every`, `after`, `at`, `dailyAt`) with non-overlapping runs.
- **`sanitizeMatrixHtml`**, plus the `html` tagged template and `fmt` helpers — no dependencies.
- **Homeserver discovery** via `.well-known`, so `homeserverUrl` accepts a URL, a server name, or the
  bot's user id.
- **Password login and session persistence**, which is what makes a stable device id (and therefore
  E2EE) work across restarts.
- **Structured errors**: `ConfigurationError`, `AuthenticationError`, `DiscoveryError`,
  `RateLimitedError`, `RequestTimeoutError`, `EncryptionStateUnknownError`, `MediaTooLargeError`,
  `MiniAppAuthError`, `HandlerTimeoutError`.
- **Pluggable logger** (`Logger` interface, `ConsoleLogger`, per-module children) and observability
  hooks: `bot.getHealth()`, `dp.stats`, `onRequest`, `onCryptoLog`.
- **Key backup** (`keyBackup`) and optional cross-signing bootstrap.
- `bot.run(dp)` — start, wait for SIGINT/SIGTERM, shut down cleanly.
- 580 tests across every module.

### Changed

- **Native crypto is an `optionalDependency`.** `import "matrixbots"` now works on platforms without a
  prebuilt binary; the engine loads on demand via `loadCryptoEngine()` (or `matrixbots/crypto`), and
  asking for crypto without the package raises a `ConfigurationError` that names the fix.
- `rotateEveryMessage` defaults to `false`.
- Presence defaults to `offline`, so bots stay invisible unless asked otherwise.
- Stricter TypeScript (`noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`).
- Subpath exports: `matrixbots`, `matrixbots/crypto`, `matrixbots/miniapp`.
- `sideEffects: false` for tree-shaking.

### Deprecated

- `guardedSendText` / `guardedSendHtml` — the E2EE contract is enforced by the client, so plain
  `ctx.reply` / `client.sendText` are already guarded.
- `retryHandler` middleware, replaced by `errorReply` plus dispatcher-level error handling.

## 0.2.1

- Fail fast with `DeviceMismatchError` when the configured device id and the homeserver's disagree.
- Unicode NFC normalization for command names, so Cyrillic commands (`/помощь`, `!сводка`) match
  regardless of composition.
- `RoomKeyWithheldError` message includes the effective share policy.
- Docs for device/crypto wipe procedure.

## 0.2.0

- Bootstrap sync filter (`timeline.limit: 0`) so a cold start does not answer history.
- `joinRoom`, autojoin for invites, persisted device id, crypto store passphrase.
- Auth failures stop the sync loop instead of spinning.
- Event dedup, `m.direct` cache, mention filter, typing helper.
- Capped sync backoff, abortable `stop()`, per-room dispatch concurrency.
- First test suite and architecture docs.

## 0.1.0

Initial release: sync loop, Rust E2EE, dispatcher, command filter, FSM.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
