# matrixbots

**EN:** Aiogram-like DX for Matrix bots. Crypto is not an optional footgun — E2EE uses `@matrix-org/matrix-sdk-crypto-nodejs` (Rust OlmMachine) directly, never a hand-rolled Olm.

**RU:** DX как у aiogram для Matrix-ботов. Крипто не «по желанию»: E2EE через `@matrix-org/matrix-sdk-crypto-nodejs` (OlmMachine напрямую), без самописного Olm.

Status: **v0.2.0** — hardened sync/E2EE/HTTP (see [AUDIT.md](./AUDIT.md)). **No `matrix-bot-sdk`.**

**Deps:** own Client-Server HTTP client + `@matrix-org/matrix-sdk-crypto-nodejs@0.4.x` (sole runtime dependency). Node `>=20`.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Bot / Dispatcher / Router / Command / F / FSM          │  ← public DX
├─────────────────────────────────────────────────────────┤
│  MatrixClient  (join, typing, send*, encrypt path)      │
│  SyncLoop      (filter bootstrap, abort, backoff≤30s)   │
│  MatrixHttp    (timeouts, AbortSignal, MatrixApiError)  │
├─────────────────────────────────────────────────────────┤
│  CryptoEngine → OlmMachine (Rust)                       │
│  outgoing: upload/query/claim/to-device/signatures       │
│  Megolm encrypt/decrypt; history_visibility-aware share │
└─────────────────────────────────────────────────────────┘
```

## E2EE contract

1. With `crypto: true` (default): init OlmMachine under `storagePath/crypto`, `prepareCrypto` (flush outgoing), verify **own** device keys via `keys/query` (5 attempts, backoff 300–2400ms). Missing → `CryptoNotReadyError`.
2. Config `deviceId` (or `storagePath/device.json`) must match crypto device after prepare → else `DeviceMismatchError`. Whoami without `device_id` does not fail before prepare.
3. Before send into an encrypted room: `keys/query` joined human peers; zero device keys → `PeerKeysMissingError`, **do not send**. Then claim sessions, `shareRoomKey` with configurable bot `encryption` policy (room `history_visibility`), encrypt as `m.room.encrypted`. All withheld / zero-share → `RoomKeyWithheldError` (see [E2EE share policy](#e2ee-share-policy)).
4. Never plaintext-fallback in encrypted rooms. Reactions use the same `sendEvent` encrypt path.
5. Cold sync: filter `timeline.limit: 0` + skip handler dispatch on bootstrap; `bootstrap_done` in `sync.json`.
6. `bot.cryptoReady: boolean` after successful verification.

## v0.2 hardening (summary)

- Sync bootstrap / no history flood; autojoin invites; limited-timeline state refresh
- ToDevice `{ messages }` normalization; KeysBackup never stalls the queue
- HTTP 60s timeout + AbortController on sync stop; auth fatal stops the loop
- Device persistence (`device.json`); optional `cryptoStorePassphrase`; `autojoin`
- Event dedup (512), per-room/global dispatch queue, path-traversal refuse on `storagePath`
- Mentions helper `F.mention` / `mentioned`; `setTyping`; `joinRoom`; exported `MatrixApiError`

Full findings → [AUDIT.md](./AUDIT.md).

## XSS / HTML trust boundary

`sendHtmlText` / `ctx.replyHtml` send `formatted_body` to Matrix as markup. This library does **not** execute HTML; Matrix clients may render it. **Bot authors are responsible** for sanitizing any untrusted HTML before calling these APIs.

## Quickstart

```bash
cd Z:\MatrixBots
npm install
npm run build
npm test

cd examples\echo
copy .env.example .env
# fill MATRIX_HS_URL, MATRIX_ACCESS_TOKEN, MATRIX_DEVICE_ID
npm install
npx tsx src/main.ts
```

### Minimal bot

```ts
import {
  Bot,
  Dispatcher,
  Router,
  Command,
  F,
  MemoryStorage,
  createStates,
} from 'matrixbots';

const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  deviceId: process.env.MATRIX_DEVICE_ID!, // REQUIRED when crypto enabled (or device.json)
  storagePath: './data',
  crypto: true, // default true
  autojoin: true, // default true
});

const dp = new Dispatcher({ storage: new MemoryStorage() });
const router = new Router('main');

router.message(Command('echo'), async (ctx) => {
  await ctx.reply(ctx.commandArgs.trim() || '…');
});

router.message(F.mention('MyBot'), async (ctx) => {
  await ctx.reply('You mentioned me');
});

dp.include(router);
await bot.start(dp);
```

## E2EE share policy

These settings are **bot/client `EncryptionSettings`** passed into OlmMachine `shareRoomKey`. They are **not** Synapse homeserver config (`encryption` section / room state). Changing them only affects how *this* bot shares megolm session keys with peer devices.

### Defaults (bots)

| Option | Default | Meaning |
|---|---|---|
| `onlyAllowTrustedDevices` | `false` | Share megolm with unverified human devices (normal for bots). |
| `errorOnVerifiedUserProblem` | `false` | Do not fail the share when a verified user has an unverified device. |

If you leave the Rust/SDK defaults (`onlyAllowTrustedDevices: true`), peers often get `m.room_key.withheld` instead of a key — ciphertext they cannot decrypt until a later share (feels like “bot replies on my next message”).

### Tighten for verified-only communities

```ts
const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  deviceId: process.env.MATRIX_DEVICE_ID!,
  encryption: {
    onlyAllowTrustedDevices: true,
    errorOnVerifiedUserProblem: true,
  },
});
```

### Crypto logs (`onCryptoLog`)

When keys are withheld or peers cannot decrypt, matrixbots emits structured events (and mirrors important ones to `console`):

```ts
import type { CryptoLogEvent } from 'matrixbots';

const bot = await Bot.create({
  // ...
  onCryptoLog: (event: CryptoLogEvent) => {
    // share_room_key | withheld_detail | peer_keys_missing | encrypt_send | warn | error
    console.log('[crypto]', event);
  },
});
```

- `withheld_detail` — truncated to-device body (max 500 chars) so you see withheld codes / user ids.
- `share_room_key` — `keyShares` vs `withheld` counts + resolved policy.
- If `keyShares === 0` and `withheld > 0` → throws `RoomKeyWithheldError` (sending a new session would be useless). If some keys were shared, withheld ghost devices only produce a warn.

## Commands

`Command('echo')` matches `/echo`, `!echo`, and in DMs also bare `echo` as the first token. Args land in `ctx.commandArgs`.

### Command specs for host autocomplete

Interactive Tab / slash UI is the **host client's** job. matrixbots can export specs for hosts to wire into autocomplete:

```ts
import { defineCommands, matchCommand } from 'matrixbots';

const commands = defineCommands([
  { name: 'echo', aliases: ['say'], description: 'Repeat text', args: '<text>' },
  { name: 'help', description: 'List commands' },
]);

const hit = matchCommand('/echo hi', commands);
// → { spec: commands[0], args: 'hi' }
```

## License

MIT — Copyright Howard Salibert / StudNovSU contributors.
