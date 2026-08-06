/**
 * Redis adapters — prefer importing from `aiomatrix` directly since 0.7.0.
 * This file re-exports the same helpers for older example paths.
 *
 * Requires a Redis-compatible client; aiomatrix itself has no redis dependency.
 */
export {
  RedisAsyncNonceStore,
  RedisAsyncUsedTokenStore,
  RedisStorage,
  RedisTtlStringMap,
  createRedisSharedTokenStores,
} from "../../dist/redis-stores.js";
