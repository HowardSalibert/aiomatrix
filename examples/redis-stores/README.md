# Shared stores for multi-instance MiniApp HTTP

Run **one** sync + crypto process per bot device. Scale MiniApp HTTP separately:
same MiniApp secret, Redis for launch nonces and claimed callback/query tokens.

```bash
npm install redis
```

```ts
import { createClient } from "redis";
import {
  Bot,
  Dispatcher,
  RedisStorage,
  createRedisSharedTokenStores,
} from "aiomatrix";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const stores = createRedisSharedTokenStores(redis);

const bot = await Bot.create({
  homeserverUrl: process.env.MATRIX_HS_URL!,
  accessToken: process.env.MATRIX_ACCESS_TOKEN!,
  clientProfile: "aware",
  miniApp: {
    secret: process.env.MINIAPP_SECRET!,
    asyncQueryUsedStore: stores.miniAppAsyncQueryUsedStore,
    asyncNonceStore: stores.asyncNonceStore,
  },
  callbackAsyncUsedStore: stores.callbackAsyncUsedStore,
  callbackAliasStore: stores.callbackAliasStore,
  callbackBindStore: stores.callbackBindStore,
});

const dp = new Dispatcher({ storage: new RedisStorage(redis) });

// Only the syncing process calls bot.run().
const server = bot.createMiniAppServer({ asyncNonceStore: stores.asyncNonceStore });
```

Single-host bots can use `createFileSharedTokenStores(storagePath)` from `aiomatrix`
(already the default under `Bot.create`). aiomatrix has **no** redis dependency — the
library works without it.
