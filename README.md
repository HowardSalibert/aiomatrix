# aiomatrix

[![CI](https://github.com/HowardSalibert/aiomatrix/actions/workflows/ci.yml/badge.svg)](https://github.com/HowardSalibert/aiomatrix/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/aiomatrix.svg)](https://www.npmjs.com/package/aiomatrix)
[![Socket Badge](https://badge.socket.dev/npm/package/aiomatrix/0.3.1)](https://badge.socket.dev/npm/package/aiomatrix/0.3.1)

An aiogram-style framework for Matrix bots: routers, filters, FSM, middleware, inline keyboards,
end-to-end encryption, and a MiniApp platform modelled on Telegram WebApps.

```bash
npm install aiomatrix
# optional: end-to-end encryption (native bindings, skip on unsupported platforms)
npm install @matrix-org/matrix-sdk-crypto-nodejs
```

Node >= 20.10, ESM only.

## Hello bot

```ts
import { Bot, Dispatcher, Router, Command, F } from "aiomatrix";

const bot = await Bot.create({
  homeserverUrl: "@mybot:example.org", // user id, server name, or full URL
  password: process.env.MATRIX_PASSWORD,
  crypto: true,
});

const router = new Router();

router.message(Command("start"), async (ctx) => {
  await ctx.reply("Hi! Send me anything and I'll echo it.");
});

router.message(F.text.startsWith("echo "), async (ctx) => {
  await ctx.reply(ctx.text.slice(5));
});

const dp = new Dispatcher();
dp.include(router);

await bot.run(dp); // syncs until SIGINT/SIGTERM, then shuts down cleanly
```

`homeserverUrl` accepts a URL, a bare server name, or the bot's user id; server names and user ids
are resolved through `/.well-known/matrix/client`. With `password` the SDK logs in, persists the
session under `storagePath` (default `./data`), and reuses the same device id on restart — which is
what E2EE requires.

## Concepts

| Piece | Role |
|---|---|
| `Bot` | Owns the client, E2EE contract, callback/MiniApp registries, and scheduler |
| `Dispatcher` | Global middleware, routing, stats, error handling, handler timeouts |
| `Router` | Groups handlers per update type; nestable via `include()` |
| `Context` | Typed per-update object with `reply`, `answer`, FSM state, room metadata |
| `Filter` | Predicate over a context; compose with `and` / `or` / `not` |
| `FSMContext` | Per-user/room conversation state with pluggable storage and TTL |

### Update types

Handlers register per update type, so a reaction handler never sees a message:

```ts
router.message(F.text, onMessage);          // new messages
router.editedMessage(onEdit);               // m.replace edits
router.anyMessage(onEither);
router.callbackQuery(F.callback.startsWith("vote:"), onVote);
router.reaction(F.reaction.key("👍"), onThumbsUp);
router.miniAppData(onMiniAppData);
router.membership(F.membership.joined, onJoin);
router.invite(onInvite);
router.redaction(onRedaction);
router.pollResponse(onPollResponse);
router.toDevice(onToDevice);
router.rawEvent(onAnythingElse);            // custom event types
router.on(["message", "reaction"], onBoth); // explicit types
```

### Filters

`F` composes fluently; every leaf is a plain function, so custom filters need no base class.

```ts
import { F, and, not, Command } from "aiomatrix";

F.text;                          // any non-empty body
F.text.contains("deploy");       // also .equals .startsWith .endsWith .in .len
F.text.regexp(/^(\d+)$/);        // match lands in ctx.data.match
F.image;                         // also .video .audio .file .location .emote .notice
F.hasAttachment;
F.reply;                         // is a rich reply
F.thread;
F.mentionsMe;                    // bot mentioned via m.mentions or plain text
F.room.dm;                       // also .group .is(id) .in(ids) .encrypted
F.from.user("@alice:example.org"); // also .users([...]) .server("example.org") .self
F.hasPower(50);                  // also F.isModerator, F.isAdmin
F.callback.startsWith("vote:");  // also .data(...) .regexp()
F.miniApp.action("submit");      // also .app(id) .field(name, value?)
F.membership.joined;             // also .left .banned .invited .isSelf .is(...)

and(F.room.dm, not(F.room.encrypted));

// Aliases are extra names; the first is canonical.
Command(["help", "помощь"], { prefixes: ["/", "!"], description: "Show help" });
```

Commands are Unicode-normalized (NFC), so `/помощь` works regardless of how the client composed the
characters. Recognized forms are `/name`, `!name`, `name@bot`, `bot: name`, and — in direct chats — a
bare `name`. `Command` also accepts `description`, `args`, `minPowerLevel`, `scope`, `hidden`, and
`category`, which feed the generated help (`bot.helpText()`) and the command list advertised to clients
(`bot.advertiseCommands(roomId)`).

### FSM

```ts
import { createStates } from "aiomatrix";

const Form = createStates("form", ["name", "age"] as const);

router.message(Command("register"), async (ctx) => {
  await ctx.state.setState(Form.name);
  await ctx.reply("What's your name?");
});

router.message(Form.name, F.text, async (ctx) => {
  await ctx.state.updateData({ name: ctx.text });
  await ctx.state.setState(Form.age);
  await ctx.reply("How old are you?");
});

router.message(Form.age, F.text, async (ctx) => {
  const { name } = await ctx.state.getData<{ name: string }>();
  await ctx.state.clear();
  await ctx.reply(`Thanks, ${name}!`);
});
```

Storage defaults to memory. For state that survives restarts:

```ts
import { Dispatcher, JsonFileStorage } from "aiomatrix";

const dp = new Dispatcher({
  storage: new JsonFileStorage("./data/fsm.json"),
  fsmStrategy: "user_in_room", // or "room" | "user" | "global"
});
```

### Middleware

```ts
import { throttle, accessControl, typingIndicator, errorReply, logging, i18n } from "aiomatrix";

dp.use(logging());
dp.use(throttle({ limit: 5, windowMs: 10_000 }));
dp.use(accessControl({ allowServers: ["example.org"] }));
dp.use(typingIndicator());
dp.use(errorReply({ text: "Something broke, try again." }));
router.use(i18n({ catalogs, defaultLocale: "en" }));
```

Middleware runs outside-in and can short-circuit by not calling `next()`.

### Inline keyboards

Matrix has no native inline keyboards, so this ships a convention (`dev.aiomatrix.keyboard`) plus a
plain-text fallback so clients that don't understand it still show usable buttons.

```ts
import { InlineKeyboard } from "aiomatrix";

const kb = new InlineKeyboard()
  .text("Yes", "vote:yes")
  .text("No", "vote:no")
  .row()
  .url("Docs", "https://example.org/docs");

await ctx.reply("Ship it?", { keyboard: kb });

router.callbackQuery(F.callback.startsWith("vote:"), async (ctx) => {
  await ctx.answerCallback({ text: "Recorded" });
  await ctx.editMessageText(`You voted ${ctx.callbackData.split(":")[1]}`);
});
```

Callback tokens are random, single-use by default, bound to the room and to the user the keyboard was
sent to, so a token leaked from one room cannot be replayed in another.

### Media

```ts
await bot.client.sendFile(ctx.roomId, pngBytes, {
  filename: "plot.png",
  caption: "Latest numbers",
});
await bot.client.sendFileFromPath(ctx.roomId, "./report.pdf");

if (ctx.attachment) {
  const bytes = await ctx.downloadAttachment(); // decrypts when needed
}
```

Uploads and downloads handle encrypted attachments (`m.file` blocks with AES-CTR keys) transparently:
in an encrypted room `sendFile` encrypts before upload, and `downloadAttachment` verifies the hash
and decrypts.

### Scheduler

```ts
bot.scheduler.every(60_000, async () => { /* ... */ }, { name: "poll-feed" });
bot.scheduler.dailyAt("09:00", async () => {
  await bot.sendMessage(roomId, "Standup time");
}, "standup");
bot.scheduler.after(5_000, () => bot.sendMessage(roomId, "Five seconds later"));
```

Jobs never overlap themselves, errors are logged rather than fatal, and everything stops with the bot.

## End-to-end encryption

E2EE uses the Rust crypto machine directly (`@matrix-org/matrix-sdk-crypto-nodejs`), which is an
**optional** dependency: `import "aiomatrix"` works on platforms with no prebuilt binary as long as
you run with `crypto: false`. Requesting crypto without the package throws a `ConfigurationError`
that says exactly what to install.

The contract the SDK enforces before dispatching anything, so a bot can never quietly leak plaintext:

1. Device id must be stable. Password login persists it; `crypto: true` with a mismatched
   `deviceId` fails fast with `DeviceMismatchError`.
2. Own device keys must be uploaded and queryable (`assertOwnDeviceKeysReady`, 5 attempts).
3. Room encryption state is resolved through the room cache. If the homeserver's answer is
   *unknown* (429, network error) the send throws `EncryptionStateUnknownError` instead of falling
   back to plaintext.
4. Megolm sessions are shared with tracked peer devices, excluding the bot's own device.
   Default `rotateEveryMessage: true` forces a fresh outbound session (and real to-device
   share) on every encrypt so peers who wiped crypto still decrypt the **first** bot reply.
   Large rooms may set `rotateEveryMessage: false` and rely on the share cache +
   `reshareOnDeviceChange` (see options below).

```ts
const bot = await Bot.create({
  homeserverUrl: "example.org",
  userId: "@mybot:example.org",
  password: process.env.MATRIX_PASSWORD,
  crypto: true,
  cryptoStorePassphrase: process.env.CRYPTO_PASSPHRASE, // encrypts the store at rest
  keyBackup: true,
  encryption: {
    onlyAllowTrustedDevices: false, // bots normally can't verify anyone
    rotateEveryMessage: true, // default — set false only for large rooms
    rotationPeriodMessages: 100,
    reshareOnDeviceChange: true,
  },
  onCryptoLog: (event) => console.log("[crypto]", event.type, event),
});
```

**Resetting crypto.** Delete `storagePath/crypto` *and* log in fresh (or pass a new `deviceId`).
A crypto store from a different device id is unusable, and keeping it produces undecryptable
messages for peers.

## MiniApps

The MiniApp platform gives Matrix the Telegram WebApp developer experience: a signed launch payload,
a `window.MatrixMiniApp` bridge (aliased as `window.Telegram.WebApp` so existing mini apps mostly
just work), a framework-agnostic backend, and Matrix widgets for clients that embed apps inline.

```ts
// bot side: post a launch card with a signed, per-user URL
await bot.sendMiniApp(ctx.roomId, {
  userId: ctx.senderId,
  title: "Order form",
  url: "https://app.example.org/order",
});

// receive what the mini app sent back
router.miniAppData(F.miniApp.action("submit"), async (ctx) => {
  const { items } = ctx.payload as { items: string[] };
  await ctx.answerWebAppQuery(`Got ${items.length} items`);
});
```

```ts
// backend: validate the launch, mint a session, route sendData into the dispatcher
const server = bot.createMiniAppServer({ allowedOrigins: ["https://app.example.org"] });
http.createServer(server.nodeHandler()).listen(8080);
```

Launch data is HMAC-SHA256 signed with the bot's secret (auto-generated into
`storagePath/miniapp.json` if you don't supply one), carries a TTL, and is single-use by default so a
copied URL cannot be replayed. The browser bridge pins the host origin rather than posting to `*`.

Full walkthrough, protocol details, and a client example: [MINIAPP.md](./MINIAPP.md).

## Security notes

Report vulnerabilities privately: [SECURITY.md](./SECURITY.md). Hardening log: [AUDIT.md](./AUDIT.md).

- **HTML is a trust boundary.** `ctx.reply(text)` is plain text and always safe. `ctx.replyHtml`
  sends HTML; run untrusted input through `sanitizeMatrixHtml()`, or build it with the `html`
  tagged template, which escapes interpolations for you.
- **Plain HTTP is refused.** The access token travels on every request, so a non-localhost `http://`
  homeserver throws `ConfigurationError` unless you set `allowInsecureHomeserver: true`.
- **No secrets are logged.** Access tokens, `Authorization` headers, and full sync bodies never
  reach the logger, at any level.
- **Storage holds credentials.** `storagePath` contains the session, device id, crypto store, and
  MiniApp secret. Keep it out of version control and off shared volumes.
- **One sync + crypto writer per device.** Callback and MiniApp query tokens are HMAC-signed by
  default (shared secret). Scale MiniApp HTTP with a shared secret and a shared nonce/used-token
  store — see `examples/redis-stores`. Do not run two syncers against the same crypto store.

## Operations

```ts
bot.getHealth();
// { running, cryptoEnabled, cryptoReady, userId, deviceId,
//   lastSyncAtMs, syncAgeMs, roomsCached, pendingCallbacks,
//   pendingMiniAppQueries, scheduledJobs }

dp.getStats(); // { received, handled, unhandled, errors, timeouts }
```

Handler failures go to the dispatcher's error handler; return `true` to mark one handled:

```ts
dp.errors((err, ctx) => {
  metrics.increment("handler_error", { update: ctx?.updateType });
  return true;
});
dp.fallback(async (ctx) => ctx.answer("I didn't understand that."));
```

`syncAgeMs` is the liveness signal worth alerting on: a running bot that has not synced in several
minutes is wedged even though the process is up.

Wire `onFatal` for unrecoverable states (revoked token, deleted device); the sync loop stops instead
of spinning:

```ts
await Bot.create({ /* ... */, onFatal: (err) => { console.error(err); process.exit(1); } });
```

## Subpath exports

```ts
import { Bot } from "aiomatrix";              // everything except the native crypto class
import { CryptoEngine } from "aiomatrix/crypto"; // needs the optional native package
import { validateInitData } from "aiomatrix/miniapp";
```

## Docs

- [MINIAPP.md](./MINIAPP.md) — MiniApp protocol, bridge API, backend, widgets
- [docs/LIVE_TESTS.md](./docs/LIVE_TESTS.md) — Synapse Docker live E2EE tests
- [SECURITY.md](./SECURITY.md) — vulnerability reporting
- [CHANGELOG.md](./CHANGELOG.md)
- [AUDIT.md](./AUDIT.md) — hardening cycles and residual risks

## License

MIT
