/**
 * End-to-end MiniApp example.
 *
 * One process runs three things:
 *   1. the bot, which posts signed launch cards;
 *   2. an HTTP server hosting the mini app page and the bridge script;
 *   3. the MiniApp backend, which validates launches and routes `sendData`
 *      payloads back into the dispatcher.
 *
 * Copy `.env.example` → `.env`, then `npm start` and say `/order` to the bot.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  Bot,
  Command,
  Dispatcher,
  F,
  InlineKeyboard,
  Router,
  serveMiniAppBridge,
} from "aiomatrix";
import { PAGE_HTML } from "./page.js";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(here, "../.env") });

const homeserverUrl = process.env.MATRIX_HS_URL;
const password = process.env.MATRIX_PASSWORD;
if (!homeserverUrl || !password) {
  console.error("Set MATRIX_HS_URL and MATRIX_PASSWORD. Copy .env.example → .env");
  process.exit(1);
}

const publicUrl = (process.env.MINIAPP_PUBLIC_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const port = Number(process.env.PORT ?? 8080);

const bot = await Bot.create({
  homeserverUrl,
  password,
  ...(process.env.MATRIX_USER_ID ? { userId: process.env.MATRIX_USER_ID } : {}),
  storagePath: path.join(here, "../data"),
  crypto: process.env.MATRIX_CRYPTO !== "false",
  autojoin: true,
  logger: (process.env.LOG_LEVEL as "debug" | undefined) ?? "info",
  miniApp: {
    ...(process.env.MINIAPP_SECRET ? { secret: process.env.MINIAPP_SECRET } : {}),
    defaultUrl: `${publicUrl}/app`,
    allowedOrigins: [new URL(publicUrl).origin],
    initDataTtlSeconds: 3600,
  },
});

// ------------------------------------------------------------------ bot side

const dp = new Dispatcher();
const router = new Router("miniapp");

router.message(Command("order", { description: "Open the order form" }), async (ctx) => {
  await bot.sendMiniApp(ctx.roomId, {
    userId: ctx.senderId,
    title: "Order form",
    description: "Pick what you want and submit.",
    buttonText: "Open form",
    appId: "order",
    startParam: "from-command",
  });
});

router.message(Command("link", { description: "Get a raw signed launch link" }), async (ctx) => {
  const launch = bot.createMiniAppLaunch({ userId: ctx.senderId, roomId: ctx.roomId });
  await ctx.reply("Single-use, expires in an hour:", {
    keyboard: new InlineKeyboard().miniApp("Open", launch.url),
  });
});

// What the mini app sends back through `MatrixMiniApp.sendData(...)`.
router.miniAppData(F.miniApp.action("submit"), async (ctx) => {
  const payload = ctx.payload as { items?: string[]; note?: string };
  const items = payload.items ?? [];
  const answered = await ctx.answerWebAppQuery(
    items.length > 0
      ? `Order received: ${items.join(", ")}${payload.note ? ` (${payload.note})` : ""}`
      : "Empty order, nothing to do.",
  );
  ctx.logger.info(`order from ${ctx.senderId} acknowledged as ${answered}`);
});

router.miniAppData(async (ctx) => {
  ctx.logger.warn(`unrecognised mini app payload: ${ctx.raw.slice(0, 200)}`);
});

dp.include(router);

// ------------------------------------------------------------- backend side

// Validates initData, mints session tokens, and feeds `sendData` into `dp`.
const miniAppServer = bot.createMiniAppServer({ basePath: "/api/miniapp" });
const miniAppHandler = miniAppServer.nodeHandler();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", publicUrl);

  if (url.pathname === "/app" || url.pathname === "/") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    // The bridge is same-origin, so a strict CSP still works.
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
    );
    res.end(PAGE_HTML);
    return;
  }

  if (url.pathname === "/matrix-miniapp.js") {
    const asset = serveMiniAppBridge();
    res.statusCode = 200;
    res.setHeader("content-type", asset.contentType);
    res.setHeader("etag", asset.etag);
    res.setHeader("cache-control", asset.cacheControl);
    res.end(asset.body);
    return;
  }

  if (url.pathname.startsWith("/api/miniapp")) {
    // node:http gives us no parsed body, so collect it first.
    collectJson(req)
      .then((body) =>
        miniAppHandler(
          { method: req.method, url: req.url, headers: req.headers, body },
          res,
        ),
      )
      .catch((err: unknown) => {
        console.error("mini app request failed", err);
        res.statusCode = 500;
        res.end('{"error":"internal"}');
      });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

async function collectJson(req: http.IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" && req.method !== "PUT") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A mini app payload is small; refuse anything that looks like an upload.
    if (size > 256 * 1024) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

await new Promise<void>((resolve) => server.listen(port, resolve));
console.log(`mini app on ${publicUrl}/app  (secret in data/miniapp.json)`);

await bot.run(dp, {
  onReady: async () => console.log(`bot running as ${bot.selfId}; say /order in a room`),
  onShutdown: async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  },
});
