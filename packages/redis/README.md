# Optional Redis adapters

Prefer:

```ts
import { createRedisSharedTokenStores, RedisStorage } from "aiomatrix/redis";
```

Implementation stays in the core package with **no hard redis dependency** (peer optional).
This folder is the documentation home for the adapter surface; publish path is the
`aiomatrix/redis` export.
