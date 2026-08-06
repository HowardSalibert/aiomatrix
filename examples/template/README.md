# Minimal bot template

```bash
cp -r examples/template my-bot && cd my-bot
npm install aiomatrix
export MATRIX_HS_URL=https://matrix.example.org
export MATRIX_ACCESS_TOKEN=syt_...
npx tsx src/main.ts
```

Uses `clientProfile: "aware"`, `autoMarkRead`, `rateLimitBackoff`, `roomThrottle`,
and `userFacingErrors`. Swap `accessToken` for `password` + `userId` when you want
device-stable login.

Optional Redis (multi-instance):

```ts
import { createRedisSharedTokenStores, RedisStorage } from "aiomatrix";
```

`redis` is an **optional peer dependency** of aiomatrix — install it only when needed.
