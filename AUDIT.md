# aiomatrix audit log

Seven hardening cycles (crypto / sync / HTTP / DX / ship / RU-bots / publish). Residual risks that need live HS smoke are listed under each cycle and summarized at the end.

---

## Cycle 1

Problems found (confirmed gaps):

1. Cold start without `since` floods full room timelines into `onMessage` → bots re-answer old messages.
2. `ToDeviceRequest.body` not normalized to `{ messages }` HTTP shape.
3. `updateTrackedUsers` fire-and-forget races vs `receiveSync` lock.
4. `EncryptionSettings.historyVisibility` hard-coded Shared; room state ignored.
5. `timeline.limited` does not refresh encryption / history_visibility state.
6. `assertOwnDeviceKeysReady` only one 500ms retry.
7. `RequestType.KeysBackup` / unknown types logged but not marked → can stall outgoing loop.
8. No `rooms.invite` / autojoin handling.
9. Missing whoami `device_id` fails before prepare even when config has deviceId.
10. No HTTP AbortSignal / timeout; sync stop cannot abort in-flight fetch.

### Fixes

- Bootstrap filter `timeline.limit: 0` + skip dispatch; persist `bootstrap_done`; then runtime filter limit 50.
- `normalizeToDeviceBody` in send path.
- Collect track users / await `updateTrackedUsers` after `receiveSync`.
- Cache `m.room.history_visibility`; feed into `EncryptionSettings`.
- On `timeline.limited`, clear caches and refresh state via `/state`.
- Own-keys: 5 attempts, backoff 300/600/1200/2400.
- KeysBackup / unknown: warn + `markRequestAsSent("{}")`.
- Autojoin invites (`autojoin` default true).
- Whoami device optional before prepare; after prepare require configured == crypto device.
- HTTP default 60s timeout; sync uses timeoutMs+10s + AbortController on stop.

### Cycle 1 residual

- Live HS smoke for bootstrap filter + autojoin + Megolm share (human-only).
- KeysBackup intentionally skipped (no backup setup).

---

## Cycle 2

Problems found:

1. `MatrixApiError` export (already present — verified).
2. No public `joinRoom`.
3. deviceId not persisted across restarts.
4. No crypto store passphrase option; silent unencrypted store.
5. Sync spins forever on `M_UNKNOWN_TOKEN` / 401.
6. Homeserver URL not validated / https-warned.
7. `sendHtmlText` plain body only stripped tags (no entity decode); XSS trust undocumented.

### Fixes

- `joinRoom(roomIdOrAlias)` public.
- Persist `storagePath/device.json`; load when options.deviceId missing.
- `cryptoStorePassphrase` → `OlmMachine.initialize`; warn once if empty.
- Auth fatal stops SyncLoop + `onFatal`.
- `normalizeHomeserverUrl` reject empty; warn non-https except localhost / `.local`.
- Entity-decode in plain body; README XSS trust boundary.

### Cycle 2 residual

- Live token-expiry behaviour against real HS (human-only).

---

## Cycle 3

Problems found:

1. Peer-bot heuristic missed `bot_` prefix (StudNovSU).
2. No event dedup → possible double dispatch.
3. `isDirect` only 2-member heuristic.
4. No mention filter helper.
5. Reactions should use encrypt path (verified: `sendReaction` → `sendEvent`).
6. Self / echo skips already in dispatcher.
7. No typing helper.

### Fixes

- `isLikelyBotUserId`: `bot_` / `_bot` / `-bot` / ends with `bot`.
- Ring buffer dedup 512 `(roomId, event_id)`.
- `m.direct` account-data cache + 2-member fallback.
- `F.mention` / `mentioned`.
- `setTyping(roomId, typing, timeoutMs?)`.

### Cycle 3 residual

- `m.direct` cache not invalidated on account-data sync events (refresh via `getDirectRoomIds(true)` if needed).

---

## Cycle 4

Problems found:

1. `stop()` did not await sync loop / abort fetch.
2. Sync error backoff uncapped.
3. `storagePath` accepted `..` traversal.
4. Handler/crypto stampede under burst sync.
5. Risk of logging secrets (audit: no token/sync-body logs found; keep discipline).
6. engines already `node>=20`; sole native dep crypto-nodejs.

### Fixes

- `stop()` aborts + `waitUntilStopped`.
- Backoff capped at 30s.
- Refuse `storagePath` containing `..`.
- `DispatchQueue`: concurrency 1/room, global 8.
- No access-token / Authorization / full sync body logging.
- `engines.node >=20` confirmed; only `@matrix-org/matrix-sdk-crypto-nodejs`.

### Cycle 4 residual

- Queue does not cancel pending work on stop (handlers may finish after stop) — acceptable for bots.

---

## Cycle 5

Problems found / ship gaps:

1. Version still 0.1.0.
2. No automated tests.
3. README missing architecture / audit pointer / v0.2 notes.
4. Echo example should typecheck against `autojoin` etc.
5. Need green `npm run build && npm test`.
6. Commit + push.

### Fixes

- Bump to `0.2.0`.
- `test/*.test.mjs` for Command, ToDevice normalize, bot heuristic; `"test"` script.
- README architecture, E2EE, audit, XSS, v0.2.
- Echo example documents `autojoin: true`.
- Grep: no TODO/FIXME/HACK left in sync/crypto paths.

### Cycle 5 residual (live HS smoke only)

- End-to-end: cold start against populated rooms does not re-answer history.
- Encrypted DM: share key + decrypt with peer.
- Autojoin invite round-trip.
- 401 stops loop without spinning.
- APK/mobile N/A (this package is Node SDK only).

---

## Cycle 6 (v0.2.1)

Hardening for public consumers / RU bots:

1. **Fail-fast device mismatch** — `createMatrixClient` throws `DeviceMismatchError` when both `options.deviceId` and whoami `device_id` are set and differ (no soft-allow).
2. **Cyrillic NFC command normalize** — exported `normalizeCommandName` (`NFC` + lower + strip `/!` + before `:`); `Command` / `parseCommandToken` / `matchCommand` / `suggestCommands` all fold through it; Unicode `\S+` kept; tests for `!сводка`, `/помощь`, aliases, prefix suggest, NFD≡NFC.
3. **RoomKeyWithheldError** message includes `rotateEveryMessage` alongside the other policy flags.
4. **Docs** — device/crypto wipe ops (wipe `storagePath/crypto` + set login `device_id`); prefer `Bot`/`ctx.reply`; quickstart notes packages ↔ `Z:\aiomatrix` must stay identical at v0.2.1.
5. Prior E2EE surface confirmed: self-exclude megolm recipients, `rotateEveryMessage` default, DeviceLists dirty before KeysQuery (Cycles / share-policy work).

### Cycle 6 residual

- Live HS smoke still human-only (see Cycle 5 residual).
- Publish to npm is out of band (tests green ≠ published).

---

## Cycle 7 (v0.3.0) — pre-publication audit

Full-project sweep for bottlenecks, illogical behaviour, leaks, vulnerabilities, and unfinished work.

### Vulnerabilities

| # | Issue | Impact | Fix |
|---|---|---|---|
| 1 | `isRoomEncrypted` cached `false` on *any* error (429, network) | Plaintext into an encrypted room, permanently for the process | Sync-backed `RoomCache`; only a 404 means "not encrypted", otherwise `EncryptionStateUnknownError` |
| 2 | Callback tokens not bound to a room | Token captured in room A replayed in room B | Token check includes `roomId` + issued-to user; single-use by default; CSPRNG tokens |
| 3 | MiniApp bridge used `postMessage(msg, "*")` and accepted any sender | Any frame/opener could read `sendData` payloads and inject host messages | Post only to the launching window; optional `matrixWebAppHost` pin; reject foreign windows/origins |
| 4 | Plain-HTTP homeserver only warned | Access token sent unencrypted | `ConfigurationError` unless `allowInsecureHomeserver` |
| 5 | Button / MiniApp-card URLs unvalidated | `javascript:` URL in a button | `isSafeButtonUrl` on every button and launch URL |
| 6 | `fingerprintSet` joined members with `\0` | Two device sets could collide → a needed Megolm re-share suppressed | Length-prefixed encoding |
| 7 | `txnId()` = timestamp + counter | Collision across restarts → dropped or duplicated events | Random UUID prefix |
| 8 | MiniApp launches replayable | A copied URL authenticates forever | Nonce + TTL + single-use `/auth`; timing-safe HMAC compare |

### Bottlenecks

| # | Issue | Fix |
|---|---|---|
| 1 | `rotateEveryMessage: true` default re-shared Megolm to every device per message, with a `/keys/query` per send | 0.3.0 tried default `false` + share cache; **0.3.1 restored `true`** — false caused first bot replies to stay undecryptable after peer crypto wipe until a later key exchange |
| 2 | Room state re-fetched over HTTP inside filters | `RoomCache` populated from `/sync`, LRU-bounded |
| 3 | `EventDeduper` used `Array.shift()` (O(n) per event) | Head pointer, amortized O(1) |
| 4 | `DispatchQueue.release()` woke every waiter | Wake exactly one |
| 5 | No 429 handling — retried immediately into the same limit | `retry_after_ms` honoured; exponential backoff with jitter for 5xx |

### Logic errors and unfinished work

| # | Issue | Fix |
|---|---|---|
| 1 | Runtime filter upload failure left the bot on `timeline.limit: 0` forever — silently deaf | Persisted filter kind compared with desired kind, re-uploaded on mismatch |
| 2 | `receiveSyncChanges` output discarded → decrypted to-device events lost | `onToDeviceEvents` / `onDecryptRecovered` handlers |
| 3 | Events that could not be decrypted yet were dropped | Bounded retry queue, re-attempted when keys arrive |
| 4 | Sync backoff not abortable → `stop()` could hang for 30s | `sleep(ms, signal)` |
| 5 | `sync.json` / `device.json` written non-atomically | `writeJsonAtomic` for all persisted state |
| 6 | `resolveSafeStoragePath` rejected legitimate absolute paths containing `..` | Only reject traversal in relative paths |
| 7 | No token refresh; expired tokens looped | `refreshAccessToken` + `AuthenticationError` → `onFatal` |
| 8 | Only `message` updates existed; reactions, callbacks, membership, redactions had nowhere to go | 11 update types with typed contexts and router methods |
| 9 | No graceful shutdown for in-flight handlers | `DispatchQueue.drain(timeout)`, `bot.run()` signal handling |

### Universal compatibility

- Native E2EE bindings moved to `optionalDependencies` and loaded on demand, so `import "aiomatrix"`
  works where no prebuilt binary exists. Verified by removing `node_modules/@matrix-org` and importing
  the root entry (CI job `no-native-crypto`).
- Homeserver discovery via `.well-known`, so `homeserverUrl` accepts a URL, a server name, or a user id.
- CI matrix: Node 20.10 / 22 / 24 on Linux, Windows, macOS.

### Testing

580 tests over 121 suites, covering every module. Two test-harness bugs were fixed along the way: a
mock `fetch` that resolved synchronously starved the microtask queue and hung the sync tests, and a
`/sync` mock that returned immediately produced a busy loop instead of long-polling.

### Cycle 7 residual

- Live HS smoke remains human-only (see Cycle 5 residual).
- MiniApp launch flow has no client-side integration test against a real Matrix client; the bridge is
  tested against a DOM stub.
- Key backup is implemented but not exercised against a real backup version.

---

## Final residual risks (human-only)

| Risk | Why code cannot close it |
|---|---|
| History flood on real HS | Needs populated rooms + cold `sync.json` wipe |
| Megolm decrypt with peers | Needs second device / user |
| Autojoin ACL / knock rooms | Server policy dependent |
| Token expiry mid-run | Needs revoked token |
| Key backup | Not in product scope; requests marked sent to avoid stall |
