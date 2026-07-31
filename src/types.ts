import type { Bot } from "./bot.js";
import type { MatrixClient } from "./client.js";
import type { CommandObject } from "./commands.js";
import type { FSMContext, Storage } from "./fsm.js";
import type { InlineKeyboard } from "./keyboards.js";
import type { Logger } from "./logger.js";
import type { Membership, PowerLevels } from "./room-cache.js";

/** Any Matrix event as delivered by `/sync` (subset that is always present). */
export interface MatrixEvent {
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  type?: string;
  state_key?: string;
  room_id?: string;
  content?: Record<string, unknown>;
  unsigned?: {
    age?: number;
    transaction_id?: string;
    redacted_because?: unknown;
    prev_content?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Raw Matrix room message event. */
export interface MatrixMessageEvent extends MatrixEvent {
  content?: {
    msgtype?: string;
    body?: string;
    formatted_body?: string;
    format?: string;
    "m.relates_to"?: unknown;
    "m.mentions"?: { user_ids?: string[]; room?: boolean };
    [key: string]: unknown;
  };
}

export type UpdateType =
  | "message"
  | "edited_message"
  | "reaction"
  | "redaction"
  | "membership"
  | "invite"
  | "callback_query"
  | "mini_app_data"
  | "poll_response"
  | "to_device"
  | "raw_event";

/** Free-form per-update bag for middleware → handler data passing (aiogram's `data`). */
export type ContextData = Record<string, unknown>;

export interface SendOptions {
  /** Send as `m.notice` instead of `m.text` (bots should prefer notices in groups). */
  notice?: boolean;
  /** Quote the triggering event with a rich reply (`m.in_reply_to`). */
  replyTo?: string | boolean;
  /** Send into a thread (`m.thread`). Pass `true` to use the current thread root. */
  thread?: string | boolean;
  /** Attach an inline keyboard. */
  keyboard?: InlineKeyboard;
  /** Mark specific users / the room as intentionally mentioned (`m.mentions`). */
  mentions?: { userIds?: string[]; room?: boolean };
  /** Extra content fields merged into the event content. */
  extra?: Record<string, unknown>;
  /** Do not fall back to plain text when HTML is provided. */
  htmlOnly?: boolean;
}

/** Common surface of every context object. */
export interface BaseContext<T extends UpdateType = UpdateType> {
  readonly updateType: T;
  readonly roomId: string;
  readonly event: MatrixEvent;
  readonly client: MatrixClient;
  readonly bot: Bot;
  readonly logger: Logger;
  /** Middleware scratch space (`ctx.data.foo = …`). */
  readonly data: ContextData;
  readonly isDirect: boolean;
  /** FSM context bound to this room/user pair. */
  readonly state: FSMContext;
  /** Sender of the triggering event (`""` for events without a sender). */
  readonly senderId: string;
  /** Event id of the triggering event (`""` when absent). */
  readonly eventId: string;
  /** Room display name, when known from sync state. */
  readonly roomName: string | undefined;
  /** Power levels for the room, from the sync-backed cache. */
  powerLevels(): PowerLevels;
  /** Power level of `userId` (defaults to the sender). */
  powerLevelOf(userId?: string): number;
  /** Send a plain-text message into the room. */
  answer(text: string, options?: SendOptions): Promise<string>;
  /** Send an HTML message (plain-text fallback derived automatically). */
  answerHtml(html: string, options?: SendOptions): Promise<string>;
  /** Send a message as a rich reply to the triggering event. */
  reply(text: string, options?: SendOptions): Promise<string>;
  replyHtml(html: string, options?: SendOptions): Promise<string>;
  /** React to the triggering event. */
  react(key: string): Promise<string>;
  /** Show/hide the typing indicator. */
  typing(on?: boolean, timeoutMs?: number): Promise<void>;
  /** Run `fn` while the typing indicator is shown. */
  withTyping<R>(fn: () => Promise<R>): Promise<R>;
  /** Redact the triggering event. */
  deleteMessage(reason?: string): Promise<string>;
  /** Mark the triggering event as read. */
  markRead(): Promise<void>;
}

/** Context for `m.room.message` (and decrypted equivalents). */
export interface MessageContext extends BaseContext<"message" | "edited_message"> {
  readonly event: MatrixMessageEvent;
  /** Plain-text body (never `undefined`). */
  readonly text: string;
  /** Alias of {@link text} kept for backwards compatibility. */
  readonly body: string;
  readonly html: string | null;
  readonly msgtype: string;
  /** Parsed command, when the message matched a `Command(...)` filter. */
  command: CommandObject | null;
  /** Matched command name without prefix. */
  commandName: string | null;
  /** Raw argument string after the command token. */
  commandArgs: string;
  /** Event id this message replies to, when it is a rich reply. */
  readonly replyToEventId: string | null;
  /** Thread root when the message belongs to a thread. */
  readonly threadRootId: string | null;
  /** True when the event is an edit (`m.replace`). */
  readonly isEdit: boolean;
  /** Event id the edit replaces. */
  readonly editsEventId: string | null;
  /** Explicit mentions from `m.mentions`. */
  readonly mentions: { userIds: string[]; room: boolean };
  /** Attachment descriptor for media msgtypes. */
  readonly attachment: MessageAttachment | null;
  /** Download the attachment bytes (decrypting when necessary). */
  downloadAttachment(): Promise<Uint8Array>;
  /** Edit a message previously sent by this bot. */
  editMessage(eventId: string, text: string, options?: SendOptions): Promise<string>;
}

export interface MessageAttachment {
  msgtype: string;
  body: string;
  /** `mxc://` URI for unencrypted media. */
  url: string | null;
  /** `file` block for encrypted media. */
  file: Record<string, unknown> | null;
  mimetype: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface ReactionContext extends BaseContext<"reaction"> {
  /** Reaction key (emoji or shortcode). */
  readonly key: string;
  /** Event the reaction annotates. */
  readonly targetEventId: string;
  /** Remove this reaction (redact it). */
  removeReaction(): Promise<string>;
}

export interface RedactionContext extends BaseContext<"redaction"> {
  readonly redactedEventId: string;
  readonly reason: string | null;
}

export interface MembershipContext extends BaseContext<"membership" | "invite"> {
  readonly subjectId: string;
  readonly membership: Membership;
  readonly previousMembership: Membership | null;
  readonly displayName: string | null;
  readonly isSelf: boolean;
  /** Accept an invite. */
  join(): Promise<string>;
  /** Decline an invite / leave the room. */
  leave(reason?: string): Promise<void>;
}

/** Inline-keyboard button press (matrixbots' analogue of a Telegram callback query). */
export interface CallbackContext extends BaseContext<"callback_query"> {
  /** Opaque payload attached to the pressed button. */
  readonly callbackData: string;
  /** Event id of the message carrying the keyboard. */
  readonly messageEventId: string;
  /** Correlation id for `answer`-style acknowledgement. */
  readonly queryId: string;
  /** Acknowledge the press; optionally show text to the user. */
  answerCallback(options?: {
    text?: string;
    alert?: boolean;
    /** Replace the keyboard message text. */
    editText?: string;
    editHtml?: string;
    keyboard?: InlineKeyboard | null;
  }): Promise<void>;
  /** Update the keyboard message in place. */
  editMessageText(text: string, options?: SendOptions): Promise<string>;
}

/** Data sent by a MiniApp through `WebApp.sendData` / `answerMiniAppQuery`. */
export interface MiniAppDataContext extends BaseContext<"mini_app_data"> {
  /** Raw string exactly as the mini app sent it. */
  readonly raw: string;
  /** Parsed JSON payload when the data was JSON, otherwise `null`. */
  readonly payload: unknown;
  /** Correlation id for `answerMiniAppQuery`. */
  readonly queryId: string | null;
  /** Mini app that produced the data. */
  readonly appId: string | null;
  /** Reply to the mini app query with a message. */
  answerWebAppQuery(text: string, options?: SendOptions): Promise<string>;
}

export interface PollResponseContext extends BaseContext<"poll_response"> {
  readonly pollEventId: string;
  readonly answerIds: string[];
}

export interface ToDeviceContext extends BaseContext<"to_device"> {
  readonly eventType: string;
  readonly toDeviceContent: Record<string, unknown>;
}

/** Fallback context for any other room event (custom state/message types). */
export interface RawEventContext extends BaseContext<"raw_event"> {
  readonly eventType: string;
}

export type AnyContext =
  | MessageContext
  | ReactionContext
  | RedactionContext
  | MembershipContext
  | CallbackContext
  | MiniAppDataContext
  | PollResponseContext
  | ToDeviceContext
  | RawEventContext;

/** Backwards-compatible alias: `Context` used to mean the message context. */
export type Context = MessageContext;

export type Filter<C extends BaseContext = MessageContext> = (
  ctx: C,
) => boolean | Promise<boolean>;

export type FilterFn = Filter<MessageContext>;

export type Handler<C extends BaseContext = MessageContext> = (
  ctx: C,
) => void | Promise<void>;

export type Middleware<C extends BaseContext = AnyContext> = (
  ctx: C,
  next: () => Promise<void>,
) => void | Promise<void>;

/**
 * Handle an error raised by a handler or middleware.
 * Return `true` to mark it handled; anything else re-raises it upwards.
 */
export type ErrorHandler = (
  error: unknown,
  ctx: AnyContext | null,
) => void | boolean | Promise<void | boolean>;

/**
 * Bot-side OlmMachine `EncryptionSettings` for Megolm key sharing.
 * These are NOT homeserver settings — they only control how this bot shares keys.
 */
export interface EncryptionSharePolicy {
  /** Default false for bots — share Megolm with unverified devices. */
  onlyAllowTrustedDevices?: boolean;
  /** Default false — don't fail the share on verified-user/unverified-device problems. */
  errorOnVerifiedUserProblem?: boolean;
  /**
   * Default **false**. When true, every encrypt starts a new outbound Megolm
   * session and re-shares it to every device of every member. Correct but very
   * expensive; only enable it for tiny rooms with hostile key hygiene.
   */
  rotateEveryMessage?: boolean;
  /** Messages before the outbound session rotates. Default 100. */
  rotationPeriodMessages?: number;
  /** Session lifetime in ms before rotation. Default 7 days. */
  rotationPeriodMs?: number;
  /** Re-share when a peer's device list changes. Default true. */
  reshareOnDeviceChange?: boolean;
}

/** Structured crypto lifecycle events for bot authors. */
export type CryptoLogEvent =
  | {
      type: "share_room_key";
      roomId: string;
      keyShares: number;
      withheld: number;
      peers: string[];
      /** Actual `m.room_key` to-device targets as `userId/deviceId`. */
      recipients: string[];
      policy: Required<EncryptionSharePolicy>;
    }
  | { type: "withheld_detail"; roomId: string; eventType: string; bodyPreview: string }
  | { type: "peer_keys_missing"; roomId: string; peers: string[] }
  | { type: "encrypt_send"; roomId: string; eventType: string }
  | { type: "decrypt_failed"; roomId: string; eventId: string; queued: boolean; detail?: unknown }
  | { type: "decrypt_recovered"; roomId: string; eventId: string; attempts: number }
  | { type: "warn"; message: string; detail?: unknown }
  | { type: "error"; message: string; detail?: unknown };

export interface MiniAppOptions {
  /**
   * Secret used to sign MiniApp `initData`. Anything with >=32 bytes of entropy.
   * Required to enable signed launches; keep it out of the mini app bundle.
   */
  secret?: string;
  /** Origins allowed to host mini apps for this bot (`https://app.example.org`). */
  allowedOrigins?: string[];
  /** Default mini app URL used by `ctx.sendMiniApp()` without an explicit url. */
  defaultUrl?: string;
  /** `initData` lifetime in seconds. Default 3600. */
  initDataTtlSeconds?: number;
  /** Keep answered/expired query ids for replay protection. Default 4096. */
  queryCacheSize?: number;
}

export interface RetryOptions {
  /** Attempts after the first try. Default 4. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default 500. */
  retryBaseMs?: number;
  /** Ceiling for a single backoff delay in ms. Default 30000. */
  maxRetryDelayMs?: number;
}

export interface BotCreateOptions {
  /**
   * Homeserver URL, bare server name (`example.org`), or the bot's user id
   * (`@bot:example.org`). Server names/user ids are resolved through
   * `/.well-known/matrix/client`.
   */
  homeserverUrl: string;
  /** Access token. Optional when `password` is provided. */
  accessToken?: string;
  /** Password login (recommended: guarantees a matching device id). */
  password?: string;
  /** User id/localpart for password login. Inferred from `homeserverUrl` when it is a user id. */
  userId?: string;
  /** Device name shown in the account's device list on password login. */
  deviceDisplayName?: string;
  /** Required when crypto is enabled and no session/`device.json` exists. */
  deviceId?: string;
  /** Directory for sync token, device id, session and crypto store. Default `./data`. */
  storagePath?: string;
  /** Initialize Rust crypto and enforce the E2EE contract. Default true. */
  crypto?: boolean;
  /** Passphrase encrypting the crypto store at rest. */
  cryptoStorePassphrase?: string;
  /** Enable server-side Megolm key backup. Default false. */
  keyBackup?: boolean;
  /** Existing key-backup recovery key (base64). */
  keyBackupRecoveryKey?: string;
  /** Publish cross-signing keys on start so users can verify the bot. Default false. */
  bootstrapCrossSigning?: boolean;
  /** Megolm share policy. */
  encryption?: EncryptionSharePolicy;
  /** Rich crypto diagnostics. */
  onCryptoLog?: (event: CryptoLogEvent) => void;
  /** Auto-join invited rooms. Default true. */
  autojoin?: boolean;
  /** Restrict autojoin to these user ids / server names (invite sender). */
  autojoinFrom?: string[];
  /** Logger, or a log level for the built-in console logger. */
  logger?: Logger | "trace" | "debug" | "info" | "warn" | "error" | "silent";
  /** Allow plain HTTP homeservers without a warning (dev/self-hosted). */
  allowInsecureHomeserver?: boolean;
  /** HTTP retry tuning. */
  retry?: RetryOptions;
  /** Default per-request timeout in ms. Default 60000. */
  requestTimeoutMs?: number;
  /** Long-poll `/sync` timeout in ms. Default 30000. */
  syncTimeoutMs?: number;
  /** Presence reported on `/sync`. Default `offline` so bots stay invisible. */
  presence?: "online" | "offline" | "unavailable";
  /** Receive typing/receipt events. Default false. */
  receiveEphemeral?: boolean;
  /** Timeline events per room per sync. Default 50. */
  timelineLimit?: number;
  /** Max concurrent handler dispatches across all rooms. Default 8. */
  concurrency?: number;
  /** Abandon a handler after this many ms (0 disables). Default 0. */
  handlerTimeoutMs?: number;
  /** MiniApp platform configuration. */
  miniApp?: MiniAppOptions;
  /** How FSM state is scoped and namespaced. */
  fsm?: { strategy?: FsmStrategy; namespace?: string; ttlMs?: number };
  /** Called when syncing dies unrecoverably (invalid token, revoked device). */
  onFatal?: (error: unknown) => void;
  /** Injected fetch implementation (tests, proxies, custom agents). */
  fetchImpl?: typeof fetch;
  /** Observability hook for every HTTP attempt. */
  onRequest?: (info: {
    method: string;
    path: string;
    status: number | null;
    durationMs: number;
    attempt: number;
    retried: boolean;
    error?: unknown;
  }) => void;
}

export interface DispatcherOptions {
  storage?: Storage;
  /** How FSM keys are derived. Default `"user_in_room"`. */
  fsmStrategy?: FsmStrategy;
  /** Namespace prefix for FSM keys — set when several bots share one storage. */
  fsmNamespace?: string;
}

/** How FSM state is scoped, mirroring aiogram's `FSMStrategy`. */
export type FsmStrategy = "user_in_room" | "room" | "user" | "global";

export interface StateRef {
  readonly group: string;
  readonly name: string;
  /** Filter: current FSM state equals this state. */
  (ctx: BaseContext): boolean | Promise<boolean>;
}
