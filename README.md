# matrixbots

**EN:** Aiogram-like DX for Matrix bots. Crypto is not an optional footgun — E2EE uses `@matrix-org/matrix-sdk-crypto-nodejs` (Rust), never a hand-rolled Olm.

**RU:** DX как у aiogram для Matrix-ботов. Крипто не «по желанию»: E2EE через `@matrix-org/matrix-sdk-crypto-nodejs` (Rust), без самописного Olm.

Status: **v0.1** — single package at repo root, echo example, strict E2EE contract.

**Deps (v0.1):** `matrix-bot-sdk@0.8.0` + `@matrix-org/matrix-sdk-crypto-nodejs@0.4.x` (peer range of bot-sdk). Newer crypto-nodejs `0.6.x` needs Node ≥24 and is not pinned yet.

## Philosophy

- Telegram-like handlers: `Router`, `Dispatcher`, `Command`, `F`, FSM (`MemoryStorage` + `createStates`).
- Thin client: `matrix-bot-sdk` + `RustSdkCryptoStorageProvider`.
- **Strict E2EE contract:** the bot must not silently send ciphertext nobody can decrypt, and must not fall back to plaintext in encrypted rooms.

## Why crypto-nodejs (not reinvented Olm)

Megolm/Olm done wrong = undeliverable secrets and false confidence. We reuse the Matrix.org Rust crypto engine (`matrix-sdk-crypto-nodejs`) via `matrix-bot-sdk`’s storage provider. Device keys are verified against the homeserver (`/_matrix/client/v3/keys/query`) before start and before send.

## E2EE contract

1. With `crypto: true` (default): init crypto under `storagePath/crypto`, `prepareCrypto`, verify **own** device keys via `keys/query`. Missing → `CryptoNotReadyError` (no half-broken start).
2. Config `deviceId` must match the client device → else `DeviceMismatchError` (refuse start).
3. Before send into an encrypted room: `keys/query` joined human peers; zero device keys → `PeerKeysMissingError`, **do not send**.
4. Never plaintext-fallback in encrypted rooms.
5. `bot.cryptoReady: boolean` after successful verification.

## Quickstart

```bash
cd Z:\MatrixBots
npm install
npm run build

cd examples\echo
copy .env.example .env
# fill MATRIX_HS_URL, MATRIX_ACCESS_TOKEN, MATRIX_DEVICE_ID
npm install
npx tsx src/main.ts
```

Or from repo root (after building and filling `examples/echo/.env`):

```bash
npm run dev
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
  deviceId: process.env.MATRIX_DEVICE_ID!, // REQUIRED when crypto enabled
  storagePath: './data',
  crypto: true, // default true
});

const dp = new Dispatcher({ storage: new MemoryStorage() });
const router = new Router('main');

const Form = createStates('Form', ['name', 'done'] as const);

router.message(Command('start'), async (ctx) => {
  await ctx.reply('Hi! Send /echo <text>');
});

router.message(Command('echo'), async (ctx) => {
  const text = ctx.commandArgs.trim() || '…';
  await ctx.reply(text);
});

router.message(F.text.equals('ping'), async (ctx) => {
  await ctx.reply('pong');
});

router.message(Command('name'), async (ctx) => {
  await ctx.state.setState(Form.name);
  await ctx.reply('Как тебя зовут?');
});
router.message(Form.name, F.text, async (ctx) => {
  await ctx.state.updateData({ name: ctx.text });
  await ctx.state.setState(Form.done);
  await ctx.reply(`Приятно, ${ctx.text}`);
});

dp.include(router);
await bot.start(dp);
```

## Commands

`Command('echo')` matches `/echo`, `!echo`, and in DMs also bare `echo` as the first token. Args land in `ctx.commandArgs`.

## License

MIT — Copyright Howard Salibert / StudNovSU contributors.
