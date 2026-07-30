import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  Bot,
  Command,
  createStates,
  Dispatcher,
  F,
  MemoryStorage,
  Router,
} from "matrixbots";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "../.env") });

const homeserverUrl = process.env.MATRIX_HS_URL;
const accessToken = process.env.MATRIX_ACCESS_TOKEN;
const deviceId = process.env.MATRIX_DEVICE_ID;

if (!homeserverUrl || !accessToken || !deviceId) {
  console.error(
    "Missing MATRIX_HS_URL, MATRIX_ACCESS_TOKEN, or MATRIX_DEVICE_ID. Copy .env.example → .env",
  );
  process.exit(1);
}

const bot = await Bot.create({
  homeserverUrl,
  accessToken,
  deviceId,
  storagePath: path.join(__dirname, "../data"),
  crypto: true,
  autojoin: true,
});

const dp = new Dispatcher({ storage: new MemoryStorage() });
const router = new Router("main");

const Form = createStates("Form", ["name", "done"] as const);

router.message(Command("start"), async (ctx) => {
  await ctx.reply("Hi! Send /echo <text>");
});

router.message(Command("echo"), async (ctx) => {
  const text = ctx.commandArgs.trim() || "…";
  await ctx.reply(text);
});

router.message(F.text.equals("ping"), async (ctx) => {
  await ctx.reply("pong");
});

router.message(Command("name"), async (ctx) => {
  await ctx.state.setState(Form.name);
  await ctx.reply("Как тебя зовут?");
});

router.message(Form.name, F.text, async (ctx) => {
  await ctx.state.updateData({ name: ctx.text });
  await ctx.state.setState(Form.done);
  await ctx.reply(`Приятно, ${ctx.text}`);
});

dp.include(router);

try {
  await bot.start(dp);
  console.log("echo bot running; cryptoReady =", bot.cryptoReady);
} catch (err) {
  console.error("Failed to start bot:", err);
  process.exit(1);
}
