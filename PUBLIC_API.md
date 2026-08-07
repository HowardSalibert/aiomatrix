# Public API freeze (0.8)

Symbols below are semver-stable for the `aiomatrix` root export.
Breaking removals require a major bump.

## Core

- `Bot`, `Dispatcher`, `Router`, `ContextFactory`
- `Command`, `CommandStart`, `CommandHelp`, `F`, `and`, `or`, `not`, `mentioned`
- `FSMContext`, `MemoryStorage`, `JsonFileStorage`, `createStates`, `inStateGroup`
- `InlineKeyboard`, `CallbackRegistry`, `SignedCallbackRegistry`
- `autoMarkRead`, `logging`, `skipSelf`, `throttle`, `roomThrottle`, `commandThrottle`
- `rateLimitBackoff`, `userFacingErrors`, `once`, `typingIndicator`, `accessControl`
- `Conversation`, `createConversation`
- `parseCommandArgs`, `tokenizeArgs`
- `mapBotError`, `emitMetric`
- `normalizeAiomatrixContent`, `formatMessagePreview`, `classifyAiomatrixContent`
- `buildBotCapabilitiesContent`, `parseHostCapabilities`

## Subpaths (not root)

- `aiomatrix/redis` — `createRedisSharedTokenStores`, `RedisStorage`, `RedisOnceStore`, …
- `aiomatrix/otel` — `createOtelMetricHandler`, `createOtelRequestHandler` (callback shims; no OTel SDK)

## 0.8

- `AIOMATRIX_SCHEMA_VERSION`, `AIOMATRIX_SCHEMA`, `AWARE_CONTRACT`, `resolveCapabilityLevel`
- `pipelineAiomatrixContent`, `buildAiomatrixEnvelope`, `finalizeAiomatrixContent`
- `COLD_START_DISPATCH`, `shouldDispatchOnColdStart`
- `StorageLock`, `FileOutboxStore`, `flushOutbox`
- `definePlugin`, `canSendToRoom`, `migrateStorage`
- `Bot.use`, `Bot.canSendToRoom`, `Bot.capabilityForRoom`, `Bot.outboxStore`
- `clientProfile: "hybrid"`, `storageLock`, `outbox`, `plugins`

## CLI

- `aiomatrix doctor | migrate | create`
- `create-aiomatrix`

## Not frozen / deprecated

- [aiomatrix-appservice](https://github.com/FakeHoward/aiomatrix-appservice) (external)
- `examples/`
- test helpers
- `guardedSendText` / `guardedSendHtml` — deprecated; prefer `ctx.answer` / `client.sendText`
- `rotateMegolmNow` — deprecated alias of `invalidateMegolmShare`
- `buildBootstrapFilter` — for custom sync loops only; SyncLoop uses runtime filter + bootstrap skip

CI: `npm run check:api`.
