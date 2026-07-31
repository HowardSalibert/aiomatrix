# Shared stores for multi-instance MiniApp HTTP

Run **one** sync + crypto process per bot device. Scale MiniApp HTTP separately:
same `MINIAPP_SECRET`, Redis for launch nonces and claimed query ids.

```bash
npm install redis
```

```ts
import { createClient } from "redis";
import { Bot } from "aiomatrix";
import { RedisAsyncNonceStore, RedisUsedTokenStore } from "./stores.js";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const asyncNonceStore = new RedisAsyncNonceStore(redis);
const queryUsed = new RedisUsedTokenStore(redis, { prefix: "aio:mq:" });
const callbackUsed = new RedisUsedTokenStore(redis, { prefix: "aio:cb:" });

const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  miniApp: {
    secret: process.env.MINIAPP_SECRET!,
    queryUsedStore: queryUsed,
  },
  callbackUsedStore: callbackUsed,
});

// Only the syncing process calls bot.run().
// HTTP workers:
const server = bot.createMiniAppServer({ asyncNonceStore });
```

`/auth` uses `authenticateAsync` when `asyncNonceStore` is set (Redis SET NX).
Without Redis, defaults stay in-memory and single-process.
