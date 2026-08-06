import type { Bot } from "./bot.js";
import type { MatrixClient } from "./client.js";
import {
  ConfigurationError,
  HandlerTimeoutError,
  InsufficientPowerError,
  MiniAppAuthError,
} from "./errors.js";
import { FSMContext, type Storage } from "./fsm.js";
import {
  sendMessageWithOptions,
  editMessageWithOptions,
  sendEventWithOutbox,
  readExistingMessageSource,
  tokenizeKeyboard,
  type SendTarget,
} from "./send.js";
import { AIOMATRIX_SCHEMA } from "./schema-contract.js";
import { finalizeAiomatrixContent } from "./content-validate.js";
import {
  CALLBACK_ANSWER_EVENT_TYPE,
  KEYBOARD_CONTENT_KEY,
  PROGRESS_EVENT_TYPE,
  TOAST_EVENT_TYPE,
  renderKeyboardFallback,
  type CallbackTokenStore,
  type InlineKeyboard,
} from "./keyboards.js";
import { buildMediaInfo, guessMimeType, msgtypeForMime, readAttachmentFromContent } from "./media.js";
import type { ResolvedHostCapabilities } from "./host-capabilities.js";
import type { Logger } from "./logger.js";
import { buildMiniAppDataContent } from "./miniapp/events.js";
import type { Membership, PowerLevels } from "./room-cache.js";
import type {
  AnyContext,
  BaseContext,
  CallbackContext,
  ContextData,
  ContextFileOptions,
  EphemeralContext,
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
  WaitForOptions,
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

  protected roomCapability(): "stock" | "aware" {
    if (typeof this.deps.bot.capabilityForRoom === "function") {
      return this.deps.bot.capabilityForRoom(this.roomId);
    }
    return this.deps.bot.clientProfile === "aware" ? "aware" : "stock";
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
    const outbox = this.deps.bot.outboxStore;
    return {
      client: this.deps.client,
      roomId: this.roomId,
      callbacks: this.deps.callbacks,
      triggerEventId: this.eventId || null,
      threadRootId: this.threadRoot(),
      callbackUserId: this.senderId || null,
      ...(outbox ? { outbox } : {}),
      onContentWarn: (warnings) => {
        this.deps.logger.warn(`aiomatrix content schema: ${warnings.join("; ")}`);
      },
    };
  }

  /** Thread root used when `thread: true` is passed to a send helper. */
  protected threadRoot(): string | null {
    return null;
  }

  /** Merge bot-level {@link MessageDefaults} under per-call options. */
  protected withDefaults(options?: SendOptions): SendOptions | undefined {
    const botDefaults =
      typeof this.deps.bot.effectiveMessageDefaults === "function"
        ? this.deps.bot.effectiveMessageDefaults(this.roomId)
        : undefined;
    const defaults = botDefaults ?? this.deps.messageDefaults;
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

  /**
   * Aware-host ephemeral toast (`dev.aiomatrix.toast`). Stock profile falls
   * back to a notice unless `forceEvent` is set.
   */
  async toast(
    text: string,
    options?: { alert?: boolean; forceEvent?: boolean; userId?: string },
  ): Promise<string> {
    const useEvent =
      options?.forceEvent === true ||
      this.roomCapability() === "aware" ||
      this.hostCapabilities().toast;
    if (useEvent) {
      return sendEventWithOutbox(this.sendTarget(), TOAST_EVENT_TYPE, {
        version: AIOMATRIX_SCHEMA.toast,
        text,
        alert: options?.alert === true,
        user_id: options?.userId ?? this.senderId,
      });
    }
    return this.answer(text, { notice: !options?.alert });
  }

  /**
   * Aware-host progress indicator (`dev.aiomatrix.progress`).
   * `percent` null clears / completes the indicator on aware hosts.
   */
  async progress(
    text: string,
    options?: { percent?: number | null; forceEvent?: boolean },
  ): Promise<string> {
    const useEvent =
      options?.forceEvent === true ||
      this.roomCapability() === "aware" ||
      this.hostCapabilities().progress;
    if (useEvent) {
      return sendEventWithOutbox(this.sendTarget(), PROGRESS_EVENT_TYPE, {
        version: AIOMATRIX_SCHEMA.progress,
        text,
        percent: options?.percent ?? null,
        user_id: this.senderId,
      });
    }
    return this.answer(text, { notice: true });
  }

  /** Host capabilities from `dev.aiomatrix.host` room state (bot cache). */
  hostCapabilities(): ResolvedHostCapabilities {
    return this.deps.bot.getHostCapabilities(this.roomId);
  }

  waitFor(
    filter: (ctx: AnyContext) => boolean | Promise<boolean>,
    options?: WaitForOptions,
  ): Promise<AnyContext> {
    return this.deps.bot.waitFor(filter, {
      timeoutMs: options?.timeoutMs,
      roomId: options?.roomId === undefined ? this.roomId : options.roomId,
      senderId: options?.senderId === undefined ? this.senderId : options.senderId,
    });
  }

  answerFile(data: Uint8Array, options: ContextFileOptions): Promise<string> {
    return this.sendFileInternal(data, options, false);
  }

  replyPhoto(data: Uint8Array, options: ContextFileOptions): Promise<string> {
    return this.sendFileInternal(
      data,
      { ...options, msgtype: options.msgtype ?? "m.image" },
      true,
    );
  }

  replyDocument(data: Uint8Array, options: ContextFileOptions): Promise<string> {
    return this.sendFileInternal(
      data,
      { ...options, msgtype: options.msgtype ?? "m.file" },
      true,
    );
  }

  private async sendFileInternal(
    data: Uint8Array,
    options: ContextFileOptions,
    reply: boolean,
  ): Promise<string> {
    const target = this.sendTarget();
    const opts = this.withDefaults({
      ...(options.keyboard !== undefined ? { keyboard: options.keyboard } : {}),
      ...(options.extra !== undefined ? { extra: options.extra } : {}),
    });
    const minted: string[] = [];
    const contentType = options.contentType ?? guessMimeType(options.filename);
    const { upload, file } = await this.deps.client.uploadContent(data, {
      filename: options.filename,
      contentType,
      encryptForRoom: this.roomId,
    });
    const info = buildMediaInfo({
      mimetype: contentType,
      sizeBytes: data.byteLength,
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    });
    let body = options.caption ?? options.filename;
    let formatted: string | null = null;
    const content: Record<string, unknown> = {
      msgtype: options.msgtype ?? msgtypeForMime(contentType),
      body,
      filename: options.filename,
      info,
      ...(opts?.extra ?? {}),
    };
    if (file) content.file = file;
    else content.url = upload.contentUri;

    const replyTo =
      reply || options.replyTo === true
        ? this.eventId || null
        : typeof options.replyTo === "string"
          ? options.replyTo
          : null;
    if (replyTo) {
      content["m.relates_to"] = { "m.in_reply_to": { event_id: replyTo } };
    }

    if (opts?.keyboard && !opts.keyboard.isEmpty) {
      const keyboardContent = tokenizeKeyboard(opts.keyboard, target, minted);
      content[KEYBOARD_CONTENT_KEY] = keyboardContent;
      if (opts.keyboardFallback !== false) {
        const fallback = renderKeyboardFallback(keyboardContent);
        if (fallback.text) body = body ? `${body}\n\n${fallback.text}` : fallback.text;
        if (fallback.html) {
          formatted = `<p>${body.split("\n\n")[0] ?? ""}</p>${fallback.html}`;
          content.format = "org.matrix.custom.html";
          content.formatted_body = formatted;
        }
        content.body = body;
      }
    }

    const validated = finalizeAiomatrixContent(content);
    if (validated.warnings.length > 0) target.onContentWarn?.(validated.warnings);

    const eventId = await sendEventWithOutbox(target, "m.room.message", content);
    if (minted.length > 0) this.deps.callbacks.bindMessage(minted, eventId);
    return eventId;
  }

  async kick(userId: string, reason?: string): Promise<void> {
    this.assertAdminPower("kick", "kick");
    await this.deps.client.kickUser(this.roomId, userId, reason);
  }

  async ban(userId: string, reason?: string): Promise<void> {
    this.assertAdminPower("ban", "ban");
    await this.deps.client.banUser(this.roomId, userId, reason);
  }

  async invite(userId: string, reason?: string): Promise<void> {
    this.assertAdminPower("invite", "invite");
    await this.deps.client.inviteUser(this.roomId, userId, reason);
  }

  async setPower(userId: string, level: number): Promise<string> {
    this.assertAdminPower("set_power", "events_default", true);
    const selfLevel = this.powerLevelOf(this.deps.bot.selfId);
    const targetLevel = this.powerLevelOf(userId);
    if (userId !== this.deps.bot.selfId && targetLevel >= selfLevel) {
      throw new InsufficientPowerError("set_power", targetLevel + 1, selfLevel, this.roomId);
    }
    if (level >= selfLevel && userId !== this.deps.bot.selfId) {
      throw new InsufficientPowerError("set_power", level + 1, selfLevel, this.roomId);
    }
    return this.deps.client.setPowerLevel(this.roomId, userId, level);
  }

  /**
   * Gate room-admin helpers on the bot's own power — never on the triggering
   * sender — so handler authors cannot escalate via a high-power user message.
   */
  protected assertAdminPower(
    action: "kick" | "ban" | "invite" | "set_power" | "redact",
    field: "kick" | "ban" | "invite" | "events_default",
    asState = false,
  ): void {
    this.assertWritable();
    const levels = this.powerLevels();
    const required =
      field === "events_default"
        ? this.deps.client.rooms.requiredPowerFor(this.roomId, "m.room.power_levels", true)
        : (levels[field] ?? 50);
    const actual = this.powerLevelOf(this.deps.bot.selfId);
    if (actual < required) {
      this.deps.bot.noteMetric({
        name: "admin.denied",
        labels: { action, roomId: this.roomId },
      });
      throw new InsufficientPowerError(action, required, actual, this.roomId);
    }
    void asState;
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
    return editMessageWithOptions(
      this.sendTarget(),
      eventId,
      { text },
      this.withDefaults(options),
    );
  }

  /** Alias of {@link editMessage} with full {@link SendOptions} (keyboard, parseMode). */
  edit(eventId: string, text: string, options?: SendOptions): Promise<string> {
    return this.editMessage(eventId, text, options);
  }

  async getRepliedMessage(): Promise<MessageContext | null> {
    if (!this.replyToEventId) return null;
    try {
      const raw = await this.deps.client.getEvent(this.roomId, this.replyToEventId);
      const event = raw as MatrixMessageEvent;
      if (readString(event, "type") !== "m.room.message") return null;
      if (!readString(event.content, "msgtype")) return null;
      const senderId = typeof event.sender === "string" ? event.sender : "";
      return new MessageContextImpl(this.deps, {
        roomId: this.roomId,
        event,
        senderId,
        isDirect: this.isDirect,
      });
    } catch {
      return null;
    }
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
    timeline?: boolean;
    editText?: string;
    editHtml?: string;
    keyboard?: InlineKeyboard | null;
  }): Promise<void> {
    if (this.answered) return;
    this.answered = true;
    if (this.queryId) this.deps.callbacks.markAnswered(this.queryId);

    const wantsEdit =
      options?.editText !== undefined ||
      options?.editHtml !== undefined ||
      options?.keyboard !== undefined;
    if (wantsEdit && this.messageEventId) {
      let source: { text?: string; html?: string };
      if (options?.editHtml !== undefined) {
        source = { html: options.editHtml };
      } else if (options?.editText !== undefined) {
        source = { text: options.editText };
      } else {
        source = await readExistingMessageSource(this.sendTarget(), this.messageEventId);
      }
      await editMessageWithOptions(
        this.sendTarget(),
        this.messageEventId,
        source,
        {
          ...this.withDefaults(),
          ...(options?.keyboard !== undefined ? { keyboard: options.keyboard } : {}),
        },
      );
    }
    if (options?.text) {
      const useToast =
        options.timeline !== true &&
        (this.roomCapability() === "aware" || this.hostCapabilities().toast);
      if (useToast) {
        await sendEventWithOutbox(this.sendTarget(), CALLBACK_ANSWER_EVENT_TYPE, {
          version: AIOMATRIX_SCHEMA.callback_answer,
          text: options.text,
          alert: options.alert === true,
          query_id: this.queryId,
          user_id: this.senderId,
          message_id: this.messageEventId,
        });
      } else {
        // Stock clients: Matrix has no ephemeral toast — notice reply.
        await sendMessageWithOptions(
          this.sendTarget(),
          { text: options.text },
          this.withDefaults({
            notice: !options.alert,
            replyTo: this.messageEventId || undefined,
          }),
        );
      }
    }
  }

  editMessageText(text: string, options?: SendOptions): Promise<string> {
    const opts = this.withDefaults(options);
    if (!this.messageEventId) {
      return sendMessageWithOptions(this.sendTarget(), { text }, opts);
    }
    return editMessageWithOptions(this.sendTarget(), this.messageEventId, { text }, opts);
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

  async answerWebAppQuery(text: string, options?: SendOptions): Promise<string> {
    const opts = this.withDefaults(options);
    if (this.queryId) {
      const eventId = await this.deps.bot.answerMiniAppQuery(this.queryId, text, opts);
      if (eventId == null) {
        throw new MiniAppAuthError(
          "mini app query is unknown, expired, or already answered",
          "expired",
        );
      }
      return eventId;
    }
    return sendMessageWithOptions(this.sendTarget(), { text }, opts);
  }

  answerMiniAppQuery(text: string, options?: SendOptions): Promise<string> {
    return this.answerWebAppQuery(text, options);
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

class EphemeralContextImpl extends ContextBase<"ephemeral"> implements EphemeralContext {
  readonly updateType = "ephemeral" as const;
  readonly eventType: string;
  readonly isTyping: boolean;
  readonly isReceipt: boolean;
  readonly typingUserIds: string[];

  constructor(deps: ContextDeps, init: ContextInit) {
    super(deps, init);
    this.eventType = readString(init.event, "type") ?? "";
    this.isTyping = this.eventType === "m.typing";
    this.isReceipt = this.eventType === "m.receipt";
    const content = init.event.content ?? {};
    this.typingUserIds = Array.isArray(content.user_ids)
      ? content.user_ids.filter((id): id is string => typeof id === "string")
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

  /** Build a context for an ephemeral event (typing/receipt). */
  fromEphemeral(roomId: string, event: MatrixEvent): EphemeralContext {
    const senderId = typeof event.sender === "string" ? event.sender : "";
    return new EphemeralContextImpl(this.deps, {
      roomId,
      event,
      senderId,
      isDirect: this.deps.client.rooms.isDirect(roomId),
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
    const content = buildMiniAppDataContent({
      data: params.raw,
      queryId: params.queryId,
      appId: params.appId,
      messageId: params.messageId,
      hideFromStockClients: true,
    });
    const event: MatrixEvent = {
      type: "m.room.message",
      sender: params.userId,
      room_id: params.roomId,
      content,
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
