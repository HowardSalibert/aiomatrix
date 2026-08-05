# Changelog

All notable changes to this project. Format loosely follows [Keep a Changelog]; the project uses
semantic versioning.

## Unreleased

## 0.6.0

### Breaking

- **Node.js >= 24** (aligns with `@matrix-org/matrix-sdk-crypto-nodejs` ^0.6.1).
- **Native crypto 0.6:** Megolm share uses `CollectStrategy` (`onlyAllowTrustedDevices` /
  `errorOnVerifiedUserProblem` map onto it). `bootstrapCrossSigning` uploads the returned
  signing-key requests (with optional password UIA).
- **Unsigned `dev.aiomatrix.callback` payloads rejected by default.** Opt in with
  `allowUnsignedCallbacks: true` if a custom client must send raw `content.data`.
- **Crypto store passphrase required** unless `allowUnencryptedCryptoStore: true`. When omitted, a
  random passphrase is generated and persisted as `storagePath/crypto-passphrase.json`.
- **MiniApp cards no longer set top-level `content.url`** (that field means `mxc://` media). The
  signed launch URL lives only in `dev.aiomatrix.mini_app.url`. Opt back in with `topLevelUrl` /
  `studnovsuCompat`. Body is title + description + a short hash-stripped link (not the JWT fragment);
  `!cb` keyboard dump is off by default for MiniApps (`includeKeyboardFallback`).

### Added

- **Mid-run password re-login** via `onTokenExpired` when `refresh_token` is missing/fails and
  `autoReloginOnAuthFailure` + `password` are set. `MatrixHttp.setBaseUrl` follows delegated HS URLs.
- **`rotateEveryMessageMaxPeers`** (default 32): per-message Megolm rotation stays on for DMs/small
  rooms; larger rooms use period rotation to avoid a KeysQuery/share storm.
- **`ctx.signal` / AbortController**: handler timeouts abort the signal; send helpers refuse after
  timeout or bot stop. `DispatchQueue.close()` rejects pending work on `client.stop()`.
- **`resolveCryptoStorePassphrase`**, **`shouldRotateEveryMessage`**, live helpers
  `refreshMiniAppSessionRoomAuth` / `assertMiniAppJoinedLive` / `assertMiniAppPowerLive`.
- **`bootstrapCrossSigning`** is invoked from `Bot.start` when the option is set.
- Live tests: refresh_token exchange and mid-run password recovery.
- **`SendOptions.keyboardFallback`** / **`messageDefaults`**: aware hosts can omit `!cb` / `<ol>`
  dumps while keeping `dev.aiomatrix.keyboard`.
- **`parseMode: "markdown"`** plus `replyMarkdown` / `answerMarkdown` / `markdownToHtml`
  (`**bold**`, `_italic_`, code, links).
- **Short `!cb` aliases** for signed callbacks (JWT stays in keyboard JSON only).
- MiniApp send flags: `includePlainLink`, `includeLaunchKeyboard`, `includeKeyboardFallback`,
  `topLevelUrl` (bot `miniApp.*` defaults + per-call overrides).
- **Device GC:** `listDevices`, `deleteDevice(s)`, `pruneOtherDevices`, and
  `relocateSession({ pruneOtherDevices: true })` to drop ghost bot devices after crypto wipes.

### Fixed

- Failed key-backup uploads are no longer `markRequestAsSent` — the queue can retry.
- MiniApp `/data` and `/me` refresh membership/power through `resolveRoomAuth` before gates.
- Multi-instance footgun: warn when signed callback/query/nonce stores stay process-local.
- Removed race-prone `RedisUsedTokenStore` from `examples/redis-stores` (async store only).
- Docs: Socket badge / engines; clarify 0.3.0 Megolm note superseded by 0.3.1 / 0.6.0 peer cap.

## 0.5.0

### Added

- **Session recovery helpers:** `diagnoseSession`, `wipeCryptoStore`, `relocateSession`,
  `createSessionRefreshHandler`, plus `loadPersistedDeviceId` / `savePersistedDeviceId`.
- **`autoReloginOnAuthFailure`** on `BotCreateOptions` (default `true` when `password` is set):
  rejected persisted sessions password-login again with the same device id.
- **MiniApp room auth:** `MiniAppRoom.membership` / `power_level` snapshots in signed initData;
  `MiniAppSession.membership` / `powerLevel`; helpers `assertMiniAppJoined`, `assertMiniAppPower`,
  `miniAppHasPower`, `miniAppMembershipIs`; `MiniAppServer` options `resolveRoomAuth`,
  `requireMembership`, `minPowerLevel`, `includeRoomAuthInSession`; `GET /room-auth`.
- **`F.miniApp.hasPower` / `F.miniApp.joined`** filters.
- **`RoomCache.membershipOf`**.
- **`AsyncUsedTokenStore`** / `MemoryAsyncUsedTokenStore`, `callbackAsyncUsedStore`,
  `miniApp.asyncQueryUsedStore`, `resolveAsync` / `claimAsync` on signed registries.
- **`RedisAsyncUsedTokenStore`** in `examples/redis-stores` (awaited `SET NX`).
- **`DeviceMismatchError.recovery`** structured wipe/relogin guidance.
- **`MiniAppAuthError` reason `"forbidden"`** (HTTP 403 from MiniAppServer).

### Fixed

- **Access-token refresh was never wired.** `createMatrixClient` now attaches
  `MatrixHttp.onTokenExpired` to exchange `refresh_token` and persist `session.json`, so
  password-login bots survive token expiry without a fatal restart when the HS issues refresh
  tokens.
- Startup whoami `401` / `M_UNKNOWN_TOKEN` with a password falls back to re-login instead of
  dying immediately.
- Redis used-token example no longer claims success before Redis confirms `SET NX`.

### Notes

- Snapshot MiniApp power levels can go stale; use `resolveRoomAuth` (default when creating the
  server from a live `Bot`) for moderator-gated actions.
- Multi-instance bots must inject async used-token / nonce stores; memory defaults remain
  process-local.

## 0.4.0

### Added

- **Signed callback / MiniApp query tokens by default.** `SignedCallbackRegistry` and
  `SignedMiniAppQueryRegistry` use the MiniApp (or `callbackSecret`) HMAC secret so any process
  with that secret can resolve them. Inject `callbackUsedStore` / `miniApp.queryUsedStore` /
  `miniApp.asyncNonceStore` for single-use semantics across instances; see `examples/redis-stores`.
  Pass `new CallbackRegistry()` / `new MiniAppQueryRegistry()` for the old process-local Maps.
- **Live Synapse CI** (`test/live`, `npm run test:live:ci`): Megolm round-trip, cold start after
  wiping `sync.json`, revoked access token → `onFatal`. Notes in `docs/LIVE_TESTS.md`.
- **SECURITY.md** and CI `npm audit --omit=dev --audit-level=high`.

### Fixed

- **Cold start after wiping `sync.json` could re-dispatch recent room history.** Sync keeps a
  single runtime filter (no `timeline.limit: 0` → N switch), marks the first sync as bootstrap
  (no handler dispatch), and ignores timeline events with `origin_server_ts` before that
  bootstrap so later Synapse history replays stay quiet.
- **Live CI flake on Synapse `/login` 429.** Suites reuse bot/peer session storage; the ephemeral
  Synapse config relaxes `rc_login`.

### Notes

- Default callback / MiniApp query stores are now HMAC-signed and shareable across processes.
  Inject Redis (or similar) used-token / nonce stores for strict single-use semantics at scale.
  Legacy in-memory Maps remain available via `new CallbackRegistry()` /
  `new MiniAppQueryRegistry()`.

## 0.3.1

### Fixed

- **First bot reply undecryptable until the user's next message.** 0.3.0 defaulted
  `rotateEveryMessage` to `false` and skipped Megolm re-share when the outbound session looked
  "already shared". After a human crypto wipe (often same `device_id`), peers received ciphertext
  without keys until a later device-list / key exchange. Defaults are restored to
  `rotateEveryMessage: true`, and when rotating the bot refreshes KeysQuery for **all** share
  peers (not only sync-dirty users) before `shareRoomKey`.

### Notes

- Large rooms that need the cheaper share cache can still set `encryption: { rotateEveryMessage: false }`
  and rely on `reshareOnDeviceChange` — document the peer-wipe edge case for your operators.

## 0.3.0

A near-total rework toward the aiogram feature set, plus the MiniApp platform. The message-handling
basics are unchanged, but routing, contexts, and the client surface grew substantially.

### Renamed

- **The package is published as `aiomatrix`.** `matrixbots` on npm is taken by an unrelated package
  last touched in 2022.
- Custom event types moved from `m.matrixbots.*` to `dev.aiomatrix.*`. The `m.*` namespace is reserved
  for the Matrix specification, so using it was wrong regardless of the rename.
- `MATRIXBOTS_LOG_LEVEL` → `AIOMATRIX_LOG_LEVEL`.

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
  than recomputed per message. *(Superseded: 0.3.1 restored `rotateEveryMessage: true` for peer-wipe
  correctness; 0.6.0 keeps that for small rooms and adds `rotateEveryMessageMaxPeers` for large ones.)*
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

- **Native crypto is an `optionalDependency`.** `import "aiomatrix"` now works on platforms without a
  prebuilt binary; the engine loads on demand via `loadCryptoEngine()` (or `aiomatrix/crypto`), and
  asking for crypto without the package raises a `ConfigurationError` that names the fix.
- `rotateEveryMessage` defaults to `false`.
- Presence defaults to `offline`, so bots stay invisible unless asked otherwise.
- Stricter TypeScript (`noUncheckedIndexedAccess`, `noImplicitOverride`, `noUnusedLocals`,
  `noUnusedParameters`, `noFallthroughCasesInSwitch`).
- Subpath exports: `aiomatrix`, `aiomatrix/crypto`, `aiomatrix/miniapp`.
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
