# MatrixBots audit log

Five hardening cycles (crypto / sync / HTTP / DX / ship). Residual risks that need live HS smoke are listed under each cycle and summarized at the end.

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

## Final residual risks (human-only)

| Risk | Why code cannot close it |
|---|---|
| History flood on real HS | Needs populated rooms + cold `sync.json` wipe |
| Megolm decrypt with peers | Needs second device / user |
| Autojoin ACL / knock rooms | Server policy dependent |
| Token expiry mid-run | Needs revoked token |
| Key backup | Not in product scope; requests marked sent to avoid stall |
