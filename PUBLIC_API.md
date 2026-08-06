# Public API freeze (0.8)

Symbols below are **semver-stable** for the `aiomatrix` package root export.
Breaking removals require a major bump. Additive exports are fine in minors.

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
- `createRedisSharedTokenStores`, `RedisStorage` (also `aiomatrix/redis`)
- `createOtelMetricHandler`, `createOtelRequestHandler` (also `aiomatrix/otel`)

## 0.8 additions (stable)

- `AIOMATRIX_SCHEMA_VERSION`, `AIOMATRIX_SCHEMA`, `AWARE_CONTRACT`, `resolveCapabilityLevel`
- `pipelineAiomatrixContent`, `buildAiomatrixEnvelope`
- `COLD_START_DISPATCH`, `shouldDispatchOnColdStart`
- `StorageLock`, `FileOutboxStore`, `flushOutbox`
- `definePlugin`, `canSendToRoom`, `migrateStorage`
- `Bot.use`, `Bot.canSendToRoom`, `Bot.capabilityForRoom`
- `clientProfile: "hybrid"`, `storageLock`, `outbox`, `plugins` options

## CLI

- `aiomatrix doctor`
- `aiomatrix migrate`
- `aiomatrix create <dir>`

## Not frozen

- `packages/appservice` (separate package surface)
- Anything under `examples/`
- Test helpers
- Undocumented `@internal` members

CI enforces this list via `npm run check:api`.
