# Shared stores for multi-instance MiniApp HTTP

Run **one** sync + crypto process per bot device. Scale MiniApp HTTP separately:
same MiniApp secret, Redis for launch nonces and claimed callback/query tokens.

```bash
npm install redis
```

```ts
import { createClient } from "redis";
import { Bot } from "aiomatrix";
import { RedisAsyncNonceStore, RedisAsyncUsedTokenStore } from "./stores.js";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const asyncNonceStore = new RedisAsyncNonceStore(redis);
const queryUsed = new RedisAsyncUsedTokenStore(redis, { prefix: "aio:mq:" });
const callbackUsed = new RedisAsyncUsedTokenStore(redis, { prefix: "aio:cb:" });

const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  miniApp: {
    secret: process.env.MINIAPP_SECRET!,
    asyncQueryUsedStore: queryUsed,
    asyncNonceStore,
  },
  callbackAsyncUsedStore: callbackUsed,
});

// Only the syncing process calls bot.run().
// HTTP workers can share createMiniAppServer({ asyncNonceStore }).
const server = bot.createMiniAppServer({ asyncNonceStore });
```

`/auth` uses `authenticateAsync` when `asyncNonceStore` or `resolveRoomAuth` is set.
Callback / query claim uses awaited Redis `SET NX` via `resolveAsync` / `claimAsync`.

Without Redis, defaults stay in-memory and single-process.
