/**
 * Minimal aiomatrix bot template (echo + command + aware-friendly defaults).
 *
 *   cp -r examples/template my-bot && cd my-bot
 *   npm install aiomatrix
 *   cp .env.example .env  # fill MATRIX_*
 *   npx tsx --env-file=.env src/main.ts
 *
 * In-repo development against a local build can use:
 *   import { … } from "../../dist/index.js";
 */
import {
  Bot,
  Command,
  CommandStart,
  Dispatcher,
  F,
  autoMarkRead,
  rateLimitBackoff,
  roomThrottle,
  userFacingErrors,
} from "aiomatrix";

const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL ?? process.env.MATRIX_HOMESERVER_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN,
  password: process.env.MATRIX_PASSWORD,
  userId: process.env.MATRIX_USER_ID,
  clientProfile: "aware",
  storagePath: process.env.MATRIX_STORAGE ?? "./data",
  outbox: true,
});

const dp = new Dispatcher();
dp.use(autoMarkRead());
dp.use(rateLimitBackoff());
dp.use(roomThrottle({ limit: 30, windowMs: 10_000 }));
dp.use(userFacingErrors({ swallow: true }));

dp.message(CommandStart(), async (ctx) => {
  await ctx.answer("hi — send any text and I'll echo it");
});

dp.message(Command("ping"), async (ctx) => {
  await ctx.answer("pong", { idempotencyKey: `ping:${ctx.eventId}` });
});

dp.message(F.text, async (ctx) => {
  await ctx.reply(ctx.text);
});

await bot.run(dp);
