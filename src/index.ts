// ---------------------------------------------------------------- core API
export { Bot } from "./bot.js";
export type { BotHealth, MiniAppLaunch, MiniAppLaunchOptions, RunOptions } from "./bot.js";
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
  compose,
  errorReply,
  getTranslator,
  i18n,
  logging,
  rateLimitBackoff,
  skipSelf,
  throttle,
  typingIndicator,
} from "./middleware.js";
export type {
  ErrorReplyOptions,
  I18nOptions,
  LoggingOptions,
  RateLimitBackoffOptions,
  ThrottleOptions,
  Translator,
  UserFilterOptions,
} from "./middleware.js";

// ------------------------------------------------------------------ keyboards
export {
  CALLBACK_EVENT_TYPE,
  CALLBACK_FALLBACK_COMMAND,
  CallbackRegistry,
  SignedCallbackRegistry,
  InlineKeyboard,
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
export { buildMessageContent, markdownFormattedOrUndefined, sendMessageWithOptions } from "./send.js";
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
  MediaTooLargeError,
  MiniAppAuthError,
  PeerKeysMissingError,
  RateLimitedError,
  RequestTimeoutError,
  RoomKeyWithheldError,
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
  CryptoLogEvent,
  DispatcherOptions,
  EncryptionSharePolicy,
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
