/**
 * Echo bot — the smallest useful aiomatrix setup.
 *
 * Shows commands, filters, FSM, inline keyboards, middleware, and a scheduled
 * job. Copy `.env.example` → `.env`, then `npm start`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  Bot,
  Command,
  Dispatcher,
  F,
  InlineKeyboard,
  JsonFileStorage,
  Router,
  createStates,
  errorReply,
  logging,
  throttle,
} from "aiomatrix";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(here, "../.env") });

const homeserverUrl = process.env.MATRIX_HS_URL;
const password = process.env.MATRIX_PASSWORD;
const accessToken = process.env.MATRIX_ACCESS_TOKEN;

if (!homeserverUrl || !(password || accessToken)) {
  console.error(
    "Set MATRIX_HS_URL plus either MATRIX_PASSWORD or MATRIX_ACCESS_TOKEN. Copy .env.example → .env",
  );
  process.exit(1);
}

const storagePath = path.join(here, "../data");

const bot = await Bot.create({
  // A user id, a bare server name, or a full URL all work.
  homeserverUrl,
  ...(password
    ? { password, ...(process.env.MATRIX_USER_ID ? { userId: process.env.MATRIX_USER_ID } : {}) }
    : { accessToken: accessToken!, ...(process.env.MATRIX_DEVICE_ID ? { deviceId: process.env.MATRIX_DEVICE_ID } : {}) }),
  storagePath,
  // Password login persists the device id, which is what E2EE needs across restarts.
  crypto: process.env.MATRIX_CRYPTO !== "false",
  cryptoStorePassphrase: process.env.MATRIX_CRYPTO_PASSPHRASE,
  autojoin: true,
  logger: (process.env.LOG_LEVEL as "debug" | undefined) ?? "info",
  onFatal: (err) => {
    console.error("sync died unrecoverably:", err);
    process.exit(1);
  },
});

const dp = new Dispatcher({
  storage: new JsonFileStorage(path.join(storagePath, "fsm.json")),
  fsmStrategy: "user_in_room",
});

dp.use(logging());
dp.use(throttle({ limit: 5, windowMs: 10_000 }));
dp.use(errorReply());

const router = new Router("main");
const Form = createStates("form", ["name", "colour"] as const);

router.message(Command("start", { description: "Show what this bot can do" }), async (ctx) => {
  await ctx.reply(
    [
      `Hi ${ctx.senderId}. I echo things.`,
      "",
      bot.helpText(),
    ].join("\n"),
  );
});

router.message(Command("echo", { description: "Repeat your text back" }), async (ctx) => {
  const text = ctx.commandArgs.trim();
  await ctx.reply(text || "Give me something to echo: /echo hello");
});

router.message(F.text.equals("ping"), async (ctx) => {
  await ctx.reply("pong");
});

// --------------------------------------------------------------- keyboards

router.message(Command("colour", { description: "Pick a colour" }), async (ctx) => {
  const kb = new InlineKeyboard()
    .text("Red", "colour:red")
    .text("Green", "colour:green")
    .text("Blue", "colour:blue")
    .adjust(3);
  await ctx.reply("Which one?", { keyboard: kb });
});

router.callbackQuery(F.callback.startsWith("colour:"), async (ctx) => {
  const choice = ctx.callbackData.split(":")[1] ?? "?";
  await ctx.answerCallback({ text: `Noted: ${choice}`, editText: `You picked ${choice}.` });
});

// --------------------------------------------------------------------- FSM

router.message(Command("register", { description: "A two-step form" }), async (ctx) => {
  await ctx.state.setState(Form.name);
  await ctx.reply("What should I call you? (/cancel to stop)");
});

router.message(Command("cancel"), async (ctx) => {
  await ctx.state.clear();
  await ctx.reply("Cancelled.");
});

router.message(Form.name, F.text, async (ctx) => {
  await ctx.state.updateData({ name: ctx.text.trim() });
  await ctx.state.setState(Form.colour);
  await ctx.reply("And your favourite colour?");
});

router.message(Form.colour, F.text, async (ctx) => {
  const { name } = await ctx.state.getData<{ name: string }>();
  await ctx.state.clear();
  await ctx.reply(`Got it — ${name} likes ${ctx.text.trim()}.`);
});

// ------------------------------------------------------------------- misc

router.message(F.hasAttachment, async (ctx) => {
  const size = ctx.attachment?.sizeBytes ?? 0;
  await ctx.reply(`Nice ${ctx.msgtype.replace("m.", "")}, ${size} bytes.`);
});

router.reaction(async (ctx) => {
  ctx.logger.info(`${ctx.senderId} reacted ${ctx.key}`);
});

router.membership(F.membership.joined, async (ctx) => {
  if (ctx.isSelf) return;
  await ctx.answer(`Welcome, ${ctx.displayName ?? ctx.subjectId}.`);
});

dp.include(router);
dp.fallback(async (ctx) => {
  if (ctx.updateType === "message") await ctx.reply("Try /start.");
});

await bot.run(dp, {
  onReady: async () => {
    console.log(`running as ${bot.selfId}, cryptoReady=${bot.cryptoReady}`);
    // Log liveness once a minute; syncAgeMs is the signal worth alerting on.
    bot.scheduler.every(
      60_000,
      () => {
        const health = bot.getHealth();
        console.log(`sync age ${Math.round(health.syncAgeMs / 1000)}s, rooms ${health.roomsCached}`);
      },
      { name: "health" },
    );
  },
});
