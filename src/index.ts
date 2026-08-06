// ---------------------------------------------------------------- core API
export { Bot } from "./bot.js";
export type { BotHealth, BotCryptoHealth, MiniAppLaunch, MiniAppLaunchOptions, RunOptions } from "./bot.js";
export { Dispatcher } from "./dispatcher.js";
export type { DispatcherStats } from "./dispatcher.js";
export { Router, runChain } from "./router.js";
export { ContextFactory, detectDirectRoom } from "./context.js";
export type { ContextDeps, RoomEventMeta } from "./context.js";

// ---------------------------------------------------------------- filters
export {
  Command,
  CommandHelp,
  CommandStart,
  F,
  and,
  mentioned,
  not,
  or,
} from "./filters.js";
export type { CommandFilter, CommandOptions, Filter } from "./filters.js";

// ------------------------------------------------------------------ commands
export {
  COMMANDS_STATE_EVENT_TYPE,
  CommandRegistry,
  DEFAULT_COMMAND_PREFIXES,
  buildCommandsStateContent,
  buildHelpHtml,
  buildHelpText,
  defineCommands,
  matchCommand,
  normalizeCommandName,
  parseCommand,
  suggestCommands,
} from "./commands.js";
export type {
  CommandObject,
  CommandSpec,
  HelpTextOptions,
  ParseCommandOptions,
} from "./commands.js";

// ----------------------------------------------------------------------- FSM
export {
  FSMContext,
  JsonFileStorage,
  MemoryStorage,
  createStates,
  inStateGroup,
  storageKey,
} from "./fsm.js";
export type { Storage, StorageRecord } from "./fsm.js";

// ---------------------------------------------------------------- middleware
export {
  autoMarkRead,
  accessControl,
  commandThrottle,
  compose,
  errorReply,
  getTranslator,
  i18n,
  logging,
  once,
  rateLimitBackoff,
  roomThrottle,
  skipSelf,
  throttle,
  typingIndicator,
  userFacingErrors,
} from "./middleware.js";
export type {
  ErrorReplyOptions,
  I18nOptions,
  LoggingOptions,
  RateLimitBackoffOptions,
  ThrottleOptions,
  Translator,
  UserFacingErrorsOptions,
  UserFilterOptions,
} from "./middleware.js";

// ------------------------------------------------------------------ keyboards
export {
  CALLBACK_ANSWER_EVENT_TYPE,
  CALLBACK_EVENT_TYPE,
  CALLBACK_FALLBACK_COMMAND,
  CallbackRegistry,
  SignedCallbackRegistry,
  InlineKeyboard,
  PROGRESS_EVENT_TYPE,
  TOAST_EVENT_TYPE,
  buildCallbackContent,
  isSafeButtonUrl,
  KEYBOARD_CONTENT_KEY,
  KEYBOARD_SCHEMA_VERSION,
  MAX_BUTTON_TEXT_LENGTH,
  MAX_CALLBACK_DATA_BYTES,
  parseKeyboardContent,
  renderKeyboardFallback,
} from "./keyboards.js";
export type {
  ButtonStyle,
  CallbackIssueParams,
  CallbackRegistryOptions,
  CallbackTokenRecord,
  CallbackTokenStore,
  InlineButton,
  KeyboardContent,
  KeyboardFallback,
  SignedCallbackRegistryOptions,
} from "./keyboards.js";
export {
  MemoryAsyncUsedTokenStore,
  MemoryTtlStringMap,
  MemoryUsedTokenStore,
} from "./token-store.js";
export type { AsyncUsedTokenStore, TtlStringMap, UsedTokenStore } from "./token-store.js";
export {
  FileAsyncUsedTokenStore,
  FileTtlStringMap,
  FileUsedTokenStore,
  createFileSharedTokenStores,
} from "./file-ttl-map.js";
export type { FileSharedTokenStores } from "./file-ttl-map.js";
export {
  RedisAsyncNonceStore,
  RedisAsyncUsedTokenStore,
  RedisStorage,
  RedisTtlStringMap,
  createRedisSharedTokenStores,
} from "./redis-stores.js";
export type { RedisLike, RedisSharedTokenStores } from "./redis-stores.js";
export {
  AWARE_MESSAGE_DEFAULTS,
  AWARE_MINI_APP_DEFAULTS,
  BOT_CAPABILITIES_SCHEMA_VERSION,
  BOT_CAPABILITIES_STATE_EVENT_TYPE,
  buildBotCapabilitiesContent,
} from "./bot-capabilities.js";
export type {
  BotCapabilitiesContent,
  BuildBotCapabilitiesOptions,
} from "./bot-capabilities.js";

// ----------------------------------------------------------- command args
export { parseCommandArgs, tokenizeArgs } from "./command-args.js";
export type {
  CommandArgKind,
  CommandArgSpec,
  CommandArgsSchema,
  ParsedCommandArgs,
} from "./command-args.js";

// ------------------------------------------------------------------- polls
export {
  POLL_END_EVENT_TYPES,
  POLL_START_EVENT_TYPES,
  buildPollEndContent,
  buildPollStartContent,
  pollEndEventType,
  pollStartEventType,
} from "./polls.js";
export type { PollAnswer, SendPollOptions } from "./polls.js";

// ------------------------------------------------------------------ metrics
export { emitMetric } from "./metrics.js";
export type { BotMetric, BotMetricName, MetricHandler } from "./metrics.js";

// ----------------------------------------------------------- crypto budget
export { createCryptoSoftBudget } from "./crypto-budget.js";
export type { CryptoSoftBudget, CryptoSoftBudgetOptions } from "./crypto-budget.js";

// ----------------------------------------------------------- conversations
export { Conversation, createConversation } from "./conversation.js";
export type { ConversationOptions, ConversationStep } from "./conversation.js";

// -------------------------------------------------------- host capabilities
export {
  HOST_CAPABILITIES_SCHEMA_VERSION,
  HOST_CAPABILITIES_STATE_EVENT_TYPE,
  buildHostCapabilitiesContent,
  parseHostCapabilities,
} from "./host-capabilities.js";
export type { HostCapabilitiesContent, ResolvedHostCapabilities } from "./host-capabilities.js";

// ---------------------------------------------------------------- error map
export { mapBotError } from "./error-map.js";

// ----------------------------------------------------------------------- otel
export { createOtelMetricHandler, createOtelRequestHandler } from "./otel.js";
export type {
  OtelAdapterOptions,
  OtelLikeCounter,
  OtelLikeHistogram,
} from "./otel.js";

// --------------------------------------------------------------------- HTML
export { MATRIX_ALLOWED_TAGS, fmt, html, markdownToHtml, sanitizeMatrixHtml } from "./html.js";
export type { SanitizeOptions } from "./html.js";

// ------------------------------------------------------------------- MiniApp
export * from "./miniapp/index.js";

// -------------------------------------------------------------------- client
export {
  MatrixClient,
  createMatrixClient,
  htmlToPlainBody,
  loadCryptoEngine,
  prepareCrypto,
  resolveDeviceId,
} from "./client.js";
export type {
  ClientEventMeta,
  ClientHandlers,
  CreatedClient,
  FatalHandler,
  MatrixClientOptions,
  MessageHandler,
  SendEventOptions,
} from "./client.js";
export { buildMessageContent, editMessageWithOptions, markdownFormattedOrUndefined, sendMessageWithOptions, tokenizeKeyboard, txnIdFromIdempotencyKey } from "./send.js";
export type { MessageSource, SendTarget } from "./send.js";

// --------------------------------------------------------------------- infra
export { MatrixApiError, MatrixHttp, normalizeHomeserverUrl } from "./http.js";
export type {
  MatrixHttpOptions,
  MatrixHttpRequestOptions,
  RequestTelemetry,
} from "./http.js";
export {
  buildBootstrapFilter,
  buildRuntimeFilter,
  SyncLoop,
  loadSyncState,
  saveSyncState,
} from "./sync.js";
export type {
  JoinedRoomSync,
  SyncFilterKind,
  SyncFilterOptions,
  SyncLoopOptions,
  SyncResponse,
  SyncState,
  SyncTimeline,
} from "./sync.js";
export { discoverHomeserver, getServerVersions, isUserId, serverNameFromUserId } from "./discovery.js";
export type { DiscoveryResult } from "./discovery.js";
export {
  clearSession,
  deleteDevice,
  deleteDevices,
  listDevices,
  loadSession,
  loginWithPassword,
  logout,
  pruneOtherDevices,
  refreshAccessToken,
  saveSession,
} from "./login.js";
export type {
  MatrixDeviceInfo,
  MatrixSession,
  PasswordLoginOptions,
  PruneOtherDevicesOptions,
} from "./login.js";
export {
  createSessionRefreshHandler,
  diagnoseSession,
  loadPersistedDeviceId,
  relocateSession,
  resolveCryptoStorePassphrase,
  savePersistedDeviceId,
  wipeCryptoStore,
} from "./session-recovery.js";
export type {
  RelocateSessionOptions,
  SessionDiagnosis,
  SessionRefreshHandlerOptions,
  SessionSuggestedAction,
} from "./session-recovery.js";
export { DEFAULT_POWER_LEVELS, RoomCache } from "./room-cache.js";
export type { HistoryVisibilityName, Membership, PowerLevels, RoomInfo } from "./room-cache.js";
export { DispatchQueue, EventDeduper } from "./dispatch-queue.js";
export { Scheduler } from "./scheduler.js";
export type { ScheduledJob, SchedulerOptions } from "./scheduler.js";
export { ConsoleLogger, createDefaultLogger, parseLogLevel } from "./logger.js";
export type { LogLevel, Logger } from "./logger.js";

// ----------------------------------------------------------- 0.8 contracts
export {
  AIOMATRIX_SCHEMA_VERSION,
  AIOMATRIX_EVENT_TYPES,
  AIOMATRIX_CONTENT_KEYS,
  AWARE_CONTRACT,
  resolveCapabilityLevel,
} from "./schema.js";
export type { CapabilityLevel, ContractRequirement } from "./schema.js";
export {
  AIOMATRIX_SCHEMA,
  checkSchemaVersion,
  readSchemaVersion,
} from "./schema-contract.js";
export type { AiomatrixSchemaKey, SchemaVersionInfo } from "./schema-contract.js";
export {
  pipelineAiomatrixContent,
  buildAiomatrixEnvelope,
} from "./content-pipeline.js";
export type { AiomatrixEnvelope } from "./content-pipeline.js";
export { COLD_START_DISPATCH, shouldDispatchOnColdStart } from "./cold-start.js";
export type { ColdStartUpdateKind } from "./cold-start.js";
export { StorageLock } from "./storage-lock.js";
export type { StorageLockInfo } from "./storage-lock.js";
export { FileOutboxStore, flushOutbox } from "./outbox.js";
export type { OutboxEntry, OutboxOptions, OutboxStore } from "./outbox.js";
export { definePlugin } from "./plugin.js";
export type { BotPlugin, PluginContext } from "./plugin.js";
export { canSendToRoom } from "./send-readiness.js";
export type { RoomSendReadiness } from "./send-readiness.js";
export { migrateStorage } from "./cli/migrate.js";
export type { MigrateResult } from "./cli/migrate.js";

// -------------------------------------------------------------------- media
export {
  DEFAULT_MEDIA_LIMIT_BYTES,
  buildEncryptedFileBlock,
  buildMediaInfo,
  downloadMedia,
  downloadThumbnail,
  guessMimeType,
  msgtypeForMime,
  parseMxcUri,
  readAttachmentFromContent,
  splitEncryptedFileBlock,
  uploadMedia,
} from "./media.js";
export type { DownloadOptions, MediaInfo, MxcUri, UploadOptions, UploadResult } from "./media.js";

// -------------------------------------------------------------------- crypto
// Only policy helpers are re-exported eagerly. `CryptoEngine` pulls in the
// native E2EE bindings, so it stays behind `loadCryptoEngine()` (or a direct
// `aiomatrix/crypto` import) to keep this entry point installable everywhere.
export {
  DEFAULT_ENCRYPTION_SHARE_POLICY,
  filterShareRecipients,
  normalizeToDeviceBody,
  parseToDeviceRecipients,
  resolveEncryptionSharePolicy,
  shouldRotateEveryMessage,
} from "./crypto-policy.js";
export type { ResolvedEncryptionSharePolicy } from "./crypto-policy.js";
export type { CryptoEngine, CryptoEngineCreateOptions } from "./crypto.js";
export {
  assertDeviceIdMatch,
  assertOwnDeviceKeysReady,
  assertPeersHaveKeys,
  countDevicesForUser,
  guardedSendHtml,
  guardedSendText,
  hasOwnDeviceKeys,
  isLikelyBotUserId,
  queryDeviceKeys,
} from "./crypto-guard.js";
export type { KeysQueryDevice, KeysQueryResponse } from "./crypto-guard.js";

// -------------------------------------------------------------------- errors
export {
  AuthenticationError,
  ConfigurationError,
  CryptoNotReadyError,
  DeviceMismatchError,
  DiscoveryError,
  EncryptedRoomWithoutCryptoError,
  EncryptionStateUnknownError,
  HandlerTimeoutError,
  aiomatrixError,
  InsufficientPowerError,
  MediaTooLargeError,
  MiniAppAuthError,
  PeerKeysMissingError,
  RateLimitedError,
  RequestTimeoutError,
  RoomKeyWithheldError,
  WaitForTimeoutError,
} from "./errors.js";
export type { DeviceMismatchRecovery, DeviceMismatchSuggested } from "./errors.js";

// --------------------------------------------------------------------- types
export type {
  AnyContext,
  BaseContext,
  BotCreateOptions,
  CallbackContext,
  Context,
  ContextData,
  ContextFileOptions,
  CryptoLogEvent,
  DispatcherOptions,
  EncryptionSharePolicy,
  EphemeralContext,
  ErrorHandler,
  FilterFn,
  FsmStrategy,
  Handler,
  MatrixEvent,
  MatrixMessageEvent,
  MembershipContext,
  MessageAttachment,
  MessageContext,
  MessageDefaults,
  Middleware,
  MiniAppDataContext,
  MiniAppOptions,
  ParseMode,
  ClientProfile,
  PollResponseContext,
  RawEventContext,
  ReactionContext,
  RedactionContext,
  RetryOptions,
  SendOptions,
  StateRef,
  ToDeviceContext,
  UpdateType,
  WaitForOptions,
} from "./types.js";

// -------------------------------------------------------------------- utils
export {
  AsyncLock,
  LruCache,
  clamp,
  escapeHtml,
  fingerprintSet,
  isPlainObject,
  jitter,
  randomId,
  readJsonSafe,
  readNumber,
  readString,
  resolveStoragePath,
  sleep,
  timingSafeEqualStrings,
  writeJsonAtomic,
} from "./util.js";
