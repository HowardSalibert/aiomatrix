import type { Bot } from "./bot.js";
import type { MatrixClient } from "./client.js";
import { ConfigurationError, HandlerTimeoutError } from "./errors.js";
import { FSMContext, type Storage } from "./fsm.js";
import type { CallbackTokenStore, InlineKeyboard } from "./keyboards.js";
import type { Logger } from "./logger.js";
import { readAttachmentFromContent } from "./media.js";
import type { Membership, PowerLevels } from "./room-cache.js";
import { sendMessageWithOptions, type SendTarget } from "./send.js";
import type {
  AnyContext,
  BaseContext,
  CallbackContext,
  ContextData,
  MatrixEvent,
  MatrixMessageEvent,
  MembershipContext,
  MessageAttachment,
  MessageContext,
  MiniAppDataContext,
  PollResponseContext,
  RawEventContext,
  ReactionContext,
  RedactionContext,
  SendOptions,
  ToDeviceContext,
  UpdateType,
  FsmStrategy,
  MessageDefaults,
} from "./types.js";
import type { CommandObject } from "./commands.js";
import { isPlainObject, readString } from "./util.js";

export interface ContextDeps {
  bot: Bot;
  client: MatrixClient;
  logger: Logger;
  storage: Storage;
  callbacks: CallbackTokenStore;
  fsm?: { strategy?: FsmStrategy; namespace?: string; ttlMs?: number };
  messageDefaults?: MessageDefaults;
}

interface ContextInit {
  roomId: string;
  event: MatrixEvent;
  senderId: string;
  isDirect: boolean;
}

/** Shared implementation of every context type. */
abstract class ContextBase<T extends UpdateType> implements BaseContext<T> {
  abstract readonly updateType: T;
  readonly roomId: string;
  readonly event: MatrixEvent;
  readonly senderId: string;
  readonly eventId: string;
  readonly isDirect: boolean;
  readonly data: ContextData = {};
  readonly state: FSMContext;
  abortController: AbortController = new AbortController();

  protected constructor(
    protected readonly deps: ContextDeps,
    init: ContextInit,
  ) {
    this.roomId = init.roomId;
    this.event = init.event;
    this.senderId = init.senderId;
    this.eventId = typeof init.event.event_id === "string" ? init.event.event_id : "";
    this.isDirect = init.isDirect;
    this.state = new FSMContext(deps.storage, init.roomId, init.senderId, deps.fsm ?? {});
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get client(): MatrixClient {
    return this.deps.client;
  }

  get bot(): Bot {
    return this.deps.bot;
  }

  get logger(): Logger {
    return this.deps.logger;
  }

  get roomName(): string | undefined {
    return this.deps.client.rooms.get(this.roomId)?.name;
  }

  powerLevels(): PowerLevels {
    return this.deps.client.rooms.powerLevels(this.roomId);
  }

  powerLevelOf(userId?: string): number {
    return this.deps.client.rooms.powerLevelOf(this.roomId, userId ?? this.senderId);
  }

  /** Refuse sends after handler timeout or bot shutdown. */
  protected assertWritable(): void {
    if (this.signal.aborted) {
      const reason = this.signal.reason;
      if (reason instanceof HandlerTimeoutError) throw reason;
      throw new HandlerTimeoutError(0, `${this.updateType} in ${this.roomId || "(no room)"}`);
    }
    if (this.deps.bot.isStopping) {
      throw new ConfigurationError("Bot is stopped; refusing to send");
    }
  }

  /** Target used by every send helper on this context. */
  protected sendTarget(): SendTarget {
    this.assertWritable();
    return {
      client: this.deps.client,
      roomId: this.roomId,
      callbacks: this.deps.callbacks,
      triggerEventId: this.eventId || null,
      threadRootId: this.threadRoot(),
      callbackUserId: this.senderId || null,
    };
  }

  /** Thread root used when `thread: true` is passed to a send helper. */
  protected threadRoot(): string | null {
    return null;
  }

  /** Merge bot-level {@link MessageDefaults} under per-call options. */
  protected withDefaults(options?: SendOptions): SendOptions | undefined {
    const defaults = this.deps.messageDefaults;
    if (!defaults) return options;
    return {
      ...(defaults.keyboardFallback !== undefined
        ? { keyboardFallback: defaults.keyboardFallback }
        : {}),
      ...(defaults.parseMode !== undefined ? { parseMode: defaults.parseMode } : {}),
      ...options,
    };
  }

  answer(text: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(this.sendTarget(), { text }, this.withDefaults(options));
  }

  answerHtml(htmlBody: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(
      this.sendTarget(),
      { html: htmlBody },
      this.withDefaults(options),
    );
  }

  /** Like {@link answer} with `parseMode: "markdown"`. */
  answerMarkdown(text: string, options?: SendOptions): Promise<string> {
    return this.answer(text, { ...options, parseMode: "markdown" });
  }

  reply(text: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(
      this.sendTarget(),
      { text },
      this.withDefaults({ replyTo: true, ...options }),
    );
  }

  replyHtml(htmlBody: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(
      this.sendTarget(),
      { html: htmlBody },
      this.withDefaults({ replyTo: true, ...options }),
    );
  }

  /** Like {@link reply} with `parseMode: "markdown"`. */
  replyMarkdown(text: string, options?: SendOptions): Promise<string> {
    return this.reply(text, { ...options, parseMode: "markdown" });
  }

  async react(key: string): Promise<string> {
    if (!this.eventId) {
      throw new Error("Cannot react: the triggering event has no event_id");
    }
    return this.deps.client.sendReaction(this.roomId, this.eventId, key);
  }

  async typing(on = true, timeoutMs = 30_000): Promise<void> {
    await this.deps.client.setTyping(this.roomId, on, timeoutMs);
  }

  async withTyping<R>(fn: () => Promise<R>): Promise<R> {
    await this.typing(true).catch(() => undefined);
    try {
      return await fn();
    } finally {
      await this.typing(false).catch(() => undefined);
    }
  }

  async deleteMessage(reason?: string): Promise<string> {
    if (!this.eventId) {
      throw new Error("Cannot redact: the triggering event has no event_id");
    }
    return this.deps.client.redactEvent(this.roomId, this.eventId, reason);
  }

  async markRead(): Promise<void> {
    if (!this.eventId) return;
    await this.deps.client.sendReadReceipt(this.roomId, this.eventId);
  }
}

class MessageContextImpl
  extends ContextBase<"message" | "edited_message">
  implements MessageContext
{
  readonly updateType: "message" | "edited_message";
  override readonly event: MatrixMessageEvent;
  readonly text: string;
  readonly html: string | null;
  readonly msgtype: string;
  readonly replyToEventId: string | null;
  readonly threadRootId: string | null;
  readonly isEdit: boolean;
  readonly editsEventId: string | null;
  readonly mentions: { userIds: string[]; room: boolean };
  readonly attachment: MessageAttachment | null;
  command: CommandObject | null = null;
  commandName: string | null = null;
  commandArgs = "";

  constructor(deps: ContextDeps, init: ContextInit & { event: MatrixMessageEvent }) {
    super(deps, init);
    this.event = init.event;
    const content = init.event.content ?? {};
    const relation = isPlainObject(content["m.relates_to"]) ? content["m.relates_to"] : null;
    const newContent = isPlainObject(content["m.new_content"]) ? content["m.new_content"] : null;
    const relType = relation ? readString(relation, "rel_type") : undefined;

    this.isEdit = relType === "m.replace";
    this.updateType = this.isEdit ? "edited_message" : "message";
    this.editsEventId = this.isEdit && relation ? (readString(relation, "event_id") ?? null) : null;

    // For an edit the interesting text is the replacement, not the `* new text`
    // fallback body that legacy clients display.
    const effective = this.isEdit && newContent ? newContent : content;
    this.text = readString(effective, "body") ?? "";
    this.html =
      readString(effective, "format") === "org.matrix.custom.html"
        ? (readString(effective, "formatted_body") ?? null)
        : null;
    this.msgtype = readString(effective, "msgtype") ?? "m.text";

    this.threadRootId = relType === "m.thread" && relation
      ? (readString(relation, "event_id") ?? null)
      : null;
    const inReplyTo =
      relation && isPlainObject(relation["m.in_reply_to"]) ? relation["m.in_reply_to"] : null;
    this.replyToEventId =
      relType === "m.thread" && relation && relation.is_falling_back === true
        ? null
        : inReplyTo
          ? (readString(inReplyTo, "event_id") ?? null)
          : null;

    const rawMentions = isPlainObject(content["m.mentions"]) ? content["m.mentions"] : null;
    this.mentions = {
      userIds: Array.isArray(rawMentions?.user_ids)
        ? rawMentions.user_ids.filter((id): id is string => typeof id === "string")
        : [],
      room: rawMentions?.room === true,
    };

    this.attachment = readAttachmentFromContent(effective);
  }

  /** Alias kept for backwards compatibility with 0.1/0.2 handlers. */
  get body(): string {
    return this.text;
  }

  protected override threadRoot(): string | null {
    return this.threadRootId ?? null;
  }

  async downloadAttachment(): Promise<Uint8Array> {
    if (!this.attachment) {
      throw new Error("This message has no attachment");
    }
    return this.deps.client.downloadContent({
      url: this.attachment.url,
      file: this.attachment.file,
    });
  }

  editMessage(eventId: string, text: string, options?: SendOptions): Promise<string> {
    return this.deps.client.editMessage(this.roomId, eventId, {
      body: text,
      ...(options?.notice ? { notice: true } : {}),
    });
  }
}

class ReactionContextImpl extends ContextBase<"reaction"> implements ReactionContext {
  readonly updateType = "reaction" as const;
  readonly key: string;
  readonly targetEventId: string;

  constructor(deps: ContextDeps, init: ContextInit) {
    super(deps, init);
    const relation = isPlainObject(init.event.content?.["m.relates_to"])
      ? (init.event.content["m.relates_to"] as Record<string, unknown>)
      : {};
    this.key = readString(relation, "key") ?? "";
    this.targetEventId = readString(relation, "event_id") ?? "";
  }

  async removeReaction(): Promise<string> {
    return this.deps.client.redactEvent(this.roomId, this.eventId);
  }
}

class RedactionContextImpl extends ContextBase<"redaction"> implements RedactionContext {
  readonly updateType = "redaction" as const;
  readonly redactedEventId: string;
  readonly reason: string | null;

  constructor(deps: ContextDeps, init: ContextInit) {
    super(deps, init);
    this.redactedEventId =
      readString(init.event, "redacts") ??
      readString(init.event.content, "redacts") ??
      "";
    this.reason = readString(init.event.content, "reason") ?? null;
  }
}

class MembershipContextImpl
  extends ContextBase<"membership" | "invite">
  implements MembershipContext
{
  readonly updateType: "membership" | "invite";
  readonly subjectId: string;
  readonly membership: Membership;
  readonly previousMembership: Membership | null;
  readonly displayName: string | null;
  readonly isSelf: boolean;

  constructor(
    deps: ContextDeps,
    init: ContextInit & { updateType: "membership" | "invite" },
  ) {
    super(deps, init);
    this.updateType = init.updateType;
    const content = init.event.content ?? {};
    this.subjectId = readString(init.event, "state_key") ?? "";
    this.membership = (readString(content, "membership") ?? "leave") as Membership;
    const prev = isPlainObject(init.event.unsigned?.prev_content)
      ? init.event.unsigned.prev_content
      : null;
    this.previousMembership = prev
      ? ((readString(prev, "membership") ?? null) as Membership | null)
      : null;
    this.displayName = readString(content, "displayname") ?? null;
    this.isSelf = this.subjectId === deps.client.selfId;
  }

  async join(): Promise<string> {
    return this.deps.client.joinRoom(this.roomId);
  }

  async leave(reason?: string): Promise<void> {
    await this.deps.client.leaveRoom(this.roomId, reason);
  }
}

class CallbackContextImpl extends ContextBase<"callback_query"> implements CallbackContext {
  readonly updateType = "callback_query" as const;
  readonly callbackData: string;
  readonly messageEventId: string;
  readonly queryId: string;
  private answered = false;

  constructor(
    deps: ContextDeps,
    init: ContextInit & { callbackData: string; messageEventId: string; queryId: string },
  ) {
    super(deps, init);
    this.callbackData = init.callbackData;
    this.messageEventId = init.messageEventId;
    this.queryId = init.queryId;
  }

  async answerCallback(options?: {
    text?: string;
    alert?: boolean;
    editText?: string;
    editHtml?: string;
    keyboard?: InlineKeyboard | null;
  }): Promise<void> {
    if (this.answered) return;
    this.answered = true;
    if (this.queryId) this.deps.callbacks.markAnswered(this.queryId);

    if (options?.editText !== undefined || options?.editHtml !== undefined) {
      if (this.messageEventId) {
        await this.deps.client.editMessage(this.roomId, this.messageEventId, {
          body: options.editText ?? "",
          ...(options.editHtml ? { formattedBody: options.editHtml } : {}),
        });
        if (options.keyboard === null) {
          this.deps.callbacks.revokeForMessage(this.messageEventId);
        }
      }
    }
    if (options?.text) {
      // Matrix has no ephemeral toast, so an acknowledgement is a notice reply.
      await sendMessageWithOptions(
        this.sendTarget(),
        { text: options.text },
        { notice: !options.alert, replyTo: this.messageEventId || undefined },
      );
    }
  }

  editMessageText(text: string, options?: SendOptions): Promise<string> {
    if (!this.messageEventId) {
      return sendMessageWithOptions(this.sendTarget(), { text }, options);
    }
    return this.deps.client.editMessage(this.roomId, this.messageEventId, {
      body: text,
      ...(options?.notice ? { notice: true } : {}),
    });
  }
}

class MiniAppDataContextImpl extends ContextBase<"mini_app_data"> implements MiniAppDataContext {
  readonly updateType = "mini_app_data" as const;
  readonly raw: string;
  readonly payload: unknown;
  readonly queryId: string | null;
  readonly appId: string | null;

  constructor(
    deps: ContextDeps,
    init: ContextInit & {
      raw: string;
      payload: unknown;
      queryId: string | null;
      appId: string | null;
    },
  ) {
    super(deps, init);
    this.raw = init.raw;
    this.payload = init.payload;
    this.queryId = init.queryId;
    this.appId = init.appId;
  }

  answerWebAppQuery(text: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(
      this.sendTarget(),
      { text },
      this.withDefaults(options),
    );
  }
}

class PollResponseContextImpl extends ContextBase<"poll_response"> implements PollResponseContext {
  readonly updateType = "poll_response" as const;
  readonly pollEventId: string;
  readonly answerIds: string[];

  constructor(deps: ContextDeps, init: ContextInit) {
    super(deps, init);
    const content = init.event.content ?? {};
    const relation = isPlainObject(content["m.relates_to"]) ? content["m.relates_to"] : {};
    this.pollEventId = readString(relation, "event_id") ?? "";
    const response = isPlainObject(content["org.matrix.msc3381.poll.response"])
      ? content["org.matrix.msc3381.poll.response"]
      : isPlainObject(content["m.poll.response"])
        ? content["m.poll.response"]
        : {};
    this.answerIds = Array.isArray(response.answers)
      ? response.answers.filter((id): id is string => typeof id === "string")
      : [];
  }
}

class ToDeviceContextImpl extends ContextBase<"to_device"> implements ToDeviceContext {
  readonly updateType = "to_device" as const;
  readonly eventType: string;
  readonly toDeviceContent: Record<string, unknown>;

  constructor(deps: ContextDeps, init: ContextInit) {
    super(deps, init);
    this.eventType = readString(init.event, "type") ?? "";
    this.toDeviceContent = isPlainObject(init.event.content) ? init.event.content : {};
  }
}

class RawEventContextImpl extends ContextBase<"raw_event"> implements RawEventContext {
  readonly updateType = "raw_event" as const;
  readonly eventType: string;

  constructor(deps: ContextDeps, init: ContextInit) {
    super(deps, init);
    this.eventType = readString(init.event, "type") ?? "";
  }
}

export interface RoomEventMeta {
  historical?: boolean;
  decrypted?: boolean;
  lateDecrypt?: boolean;
}

/**
 * Turns raw Matrix events into typed contexts.
 *
 * Classification happens here so routers and filters never touch raw event
 * shapes, and so a new update type only needs one place to be taught about.
 */
export class ContextFactory {
  constructor(private readonly deps: ContextDeps) {}

  /** Best-effort direct-room detection, cache-first. */
  async isDirectRoom(roomId: string): Promise<boolean> {
    const cache = this.deps.client.rooms;
    if (cache.isDirect(roomId)) return true;
    if (!cache.directLoadedOnce) {
      try {
        const direct = await this.deps.client.getDirectRoomIds();
        if (direct.has(roomId)) return true;
      } catch {
        // `m.direct` is optional; fall back to the member-count heuristic.
      }
    }
    return cache.isDirect(roomId);
  }

  /** Build a context for a timeline event, or `null` when it is not routable. */
  async fromRoomEvent(
    roomId: string,
    event: MatrixEvent,
    meta: RoomEventMeta = {},
  ): Promise<AnyContext | null> {
    const senderId = typeof event.sender === "string" ? event.sender : "";
    const isDirect = await this.isDirectRoom(roomId);
    const init: ContextInit = { roomId, event, senderId, isDirect };
    const type = typeof event.type === "string" ? event.type : "";
    const content = isPlainObject(event.content) ? event.content : {};

    // Button presses arrive either as a dedicated event or as the text fallback
    // command, so both are resolved before anything else looks at the event.
    const callback = await this.deps.bot.readCallbackEvent(roomId, event);
    if (callback) {
      return new CallbackContextImpl(this.deps, { ...init, ...callback });
    }

    const miniAppData = this.deps.bot.readMiniAppData(event);
    if (miniAppData) {
      return new MiniAppDataContextImpl(this.deps, { ...init, ...miniAppData });
    }

    switch (type) {
      case "m.room.message": {
        if (!readString(content, "msgtype")) return null;
        return new MessageContextImpl(this.deps, {
          ...init,
          event: event as MatrixMessageEvent,
        });
      }
      case "m.reaction":
        return new ReactionContextImpl(this.deps, init);
      case "m.room.redaction":
        return new RedactionContextImpl(this.deps, init);
      case "m.room.member":
        return new MembershipContextImpl(this.deps, {
          ...init,
          updateType: readString(content, "membership") === "invite" ? "invite" : "membership",
        });
      case "org.matrix.msc3381.poll.response":
      case "m.poll.response":
        return new PollResponseContextImpl(this.deps, init);
      default:
        break;
    }

    void meta;
    return new RawEventContextImpl(this.deps, init);
  }

  /** Build a context for an invite (`m.room.member` from the invite state). */
  async fromInvite(roomId: string, event: MatrixEvent): Promise<MembershipContext> {
    const senderId = typeof event.sender === "string" ? event.sender : "";
    return new MembershipContextImpl(this.deps, {
      roomId,
      event,
      senderId,
      isDirect: readString(event.content, "is_direct") === "true" || event.content?.is_direct === true,
      updateType: "invite",
    });
  }

  /** Build a context for a to-device event. */
  fromToDevice(event: MatrixEvent): ToDeviceContext {
    return new ToDeviceContextImpl(this.deps, {
      roomId: "",
      event,
      senderId: typeof event.sender === "string" ? event.sender : "",
      isDirect: false,
    });
  }

  /** Build a synthetic mini app data context (used by the MiniApp HTTP bridge). */
  buildMiniAppData(params: {
    roomId: string;
    userId: string;
    raw: string;
    payload: unknown;
    queryId: string | null;
    appId: string | null;
    messageId: string | null;
  }): MiniAppDataContext {
    const event: MatrixEvent = {
      type: "m.room.message",
      sender: params.userId,
      room_id: params.roomId,
      content: { msgtype: "dev.aiomatrix.mini_app_data", body: params.raw },
      ...(params.messageId ? { event_id: params.messageId } : {}),
    };
    return new MiniAppDataContextImpl(this.deps, {
      roomId: params.roomId,
      event,
      senderId: params.userId,
      isDirect: this.deps.client.rooms.isDirect(params.roomId),
      raw: params.raw,
      payload: params.payload,
      queryId: params.queryId,
      appId: params.appId,
    });
  }
}

/** Backwards-compatible helper: detect whether a room is a DM. */
export async function detectDirectRoom(
  client: MatrixClient,
  roomId: string,
  senderId: string,
): Promise<boolean> {
  if (client.rooms.isDirect(roomId)) return true;
  try {
    const direct = await client.getDirectRoomIds();
    if (direct.has(roomId)) return true;
  } catch {
    // fall through to the member heuristic
  }
  try {
    const members = await client.getJoinedRoomMembers(roomId);
    return members.length === 2 && members.includes(senderId);
  } catch {
    return false;
  }
}
