import { htmlToPlainBody, type MatrixClient } from "./client.js";
import { markdownToHtml } from "./html.js";
import {
  KEYBOARD_CONTENT_KEY,
  renderKeyboardFallback,
  type CallbackTokenStore,
  type InlineKeyboard,
  type KeyboardContent,
} from "./keyboards.js";
import type { ParseMode, SendOptions } from "./types.js";
import { createHash } from "node:crypto";
import { escapeHtml } from "./util.js";
import { finalizeAiomatrixContent } from "./content-validate.js";
import type { OutboxStore } from "./outbox.js";
import { RateLimitedError, RequestTimeoutError } from "./errors.js";
import { MatrixApiError } from "./http.js";

export interface MessageSource {
  /** Plain-text body. */
  text?: string;
  /** HTML body; the plain-text fallback is derived unless `text` is given. */
  html?: string;
}

export interface SendTarget {
  client: MatrixClient;
  roomId: string;
  /** Registry used to mint callback tokens for keyboard buttons. */
  callbacks?: CallbackTokenStore;
  /** Event id used when `replyTo: true`. */
  triggerEventId?: string | null;
  /** Thread root used when `thread: true`. */
  threadRootId?: string | null;
  /** Restrict keyboard buttons to this user id. */
  callbackUserId?: string | null;
  /** Optional outbox for transient send failures. */
  outbox?: OutboxStore | null;
  /** Called when schema validation warns (newer host fields). */
  onContentWarn?: (warnings: string[]) => void;
}

/** Deterministic Matrix txn id from an opaque idempotency key (safe charset). */
export function txnIdFromIdempotencyKey(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `aio${digest}`;
}

function resolveTxnId(options?: SendOptions): string | undefined {
  if (options?.txnId) return options.txnId;
  if (options?.idempotencyKey) return txnIdFromIdempotencyKey(options.idempotencyKey);
  return undefined;
}

/**
 * Build `m.room.message` content from a text/HTML source plus {@link SendOptions}.
 *
 * Returns the content together with the callback tokens that were minted, so
 * the caller can bind them to the event id once the send succeeds.
 */
export function buildMessageContent(
  source: MessageSource,
  options: SendOptions | undefined,
  target: SendTarget,
): { content: Record<string, unknown>; tokens: string[] } {
  const opts = options ?? {};
  const tokens: string[] = [];
  const parseMode: ParseMode = opts.parseMode ?? "plain";
  const keyboardFallback = opts.keyboardFallback !== false;

  let plain = source.text ?? (source.html ? htmlToPlainBody(source.html) : "");
  let formatted: string | null =
    source.html ??
    (source.text && parseMode !== "plain" ? formatPlain(source.text, parseMode) : null);
  let keyboardContent: KeyboardContent | null = null;

  if (opts.keyboard && !opts.keyboard.isEmpty) {
    keyboardContent = tokenizeKeyboard(opts.keyboard, target, tokens);
    if (keyboardFallback) {
      const fallback = renderKeyboardFallback(keyboardContent);
      if (fallback.text) plain = plain ? `${plain}\n\n${fallback.text}` : fallback.text;
      if (fallback.html) {
        const base =
          formatted ??
          (source.text
            ? formatPlain(source.text, parseMode) ?? plainToHtml(source.text)
            : plainToHtml(""));
        formatted = `${base}${fallback.html}`;
      }
    }
  }

  const content: Record<string, unknown> = {
    msgtype: opts.notice ? "m.notice" : "m.text",
    body: plain,
  };
  if (formatted !== null) {
    content.format = "org.matrix.custom.html";
    content.formatted_body = formatted;
  }
  if (keyboardContent) content[KEYBOARD_CONTENT_KEY] = keyboardContent;

  const relation = buildRelation(opts, target);
  if (relation) content["m.relates_to"] = relation;

  if (opts.mentions) {
    const mentions: Record<string, unknown> = {};
    if (opts.mentions.userIds?.length) mentions.user_ids = [...new Set(opts.mentions.userIds)];
    if (opts.mentions.room) mentions.room = true;
    if (Object.keys(mentions).length > 0) content["m.mentions"] = mentions;
  }

  if (opts.extra) Object.assign(content, opts.extra);

  const validated = finalizeAiomatrixContent(content);
  if (validated.warnings.length > 0) target.onContentWarn?.(validated.warnings);

  return { content, tokens };
}

/**
 * Serialise a keyboard, replacing raw callback payloads with opaque tokens.
 *
 * Structured JSON keeps the full (possibly signed) token; plaintext fallback
 * uses a short alias when the registry provides one.
 */
export function tokenizeKeyboard(
  keyboard: InlineKeyboard,
  target: SendTarget,
  minted: string[],
): KeyboardContent {
  const content = keyboard.toContent();
  if (!target.callbacks) return content;
  const registry = target.callbacks;
  content.inline = content.inline.map((row) =>
    row.map((button) => {
      if (button.kind !== "callback") return button;
      const token = registry.issue({
        data: button.data,
        roomId: target.roomId,
        messageEventId: "",
        ...(target.callbackUserId ? { userId: target.callbackUserId } : {}),
      });
      minted.push(token);
      const fallback = registry.fallbackOf?.(token);
      return {
        ...button,
        token,
        ...(fallback && fallback !== token ? { fallback } : {}),
      };
    }),
  );
  return content;
}

function buildRelation(
  options: SendOptions,
  target: SendTarget,
): Record<string, unknown> | null {
  const replyTo =
    options.replyTo === true
      ? (target.triggerEventId ?? null)
      : typeof options.replyTo === "string"
        ? options.replyTo
        : null;
  const threadRoot =
    options.thread === true
      ? (target.threadRootId ?? target.triggerEventId ?? null)
      : typeof options.thread === "string"
        ? options.thread
        : null;

  if (threadRoot) {
    // Thread relations carry a reply fallback so clients without thread support
    // still render the message in a sensible place.
    const fallbackTarget = replyTo ?? target.triggerEventId ?? threadRoot;
    return {
      rel_type: "m.thread",
      event_id: threadRoot,
      is_falling_back: replyTo === null,
      "m.in_reply_to": { event_id: fallbackTarget },
    };
  }
  if (replyTo) return { "m.in_reply_to": { event_id: replyTo } };
  return null;
}

function formatPlain(text: string, parseMode: ParseMode): string | null {
  if (!text) return null;
  if (parseMode === "html") return text;
  if (parseMode === "markdown") return markdownFormattedOrUndefined(text) ?? null;
  return null;
}

/**
 * Convert markdown to HTML only when the text actually contains markup.
 * Plain `"ok"` stays without `formatted_body` even under `parseMode: "markdown"`.
 */
export function markdownFormattedOrUndefined(text: string): string | undefined {
  if (!text || !looksLikeMarkdown(text)) return undefined;
  return markdownToHtml(text);
}

function looksLikeMarkdown(text: string): boolean {
  return (
    /```/.test(text) ||
    /`[^`\n]+`/.test(text) ||
    /\*\*[^*]+\*\*/.test(text) ||
    /(^|[^*])\*[^*\n]+\*([^*]|$)/.test(text) ||
    /(^|[^_])_[^_\n]+_([^_]|$)/.test(text) ||
    /\[[^\]]+\]\(https?:\/\/[^)\s]+\)/.test(text)
  );
}

function plainToHtml(text: string): string {
  return text ? `<p>${escapeHtml(text).replace(/\n/g, "<br/>")}</p>` : "";
}

/** Send a message built from {@link SendOptions}, binding keyboard tokens. */
export async function sendMessageWithOptions(
  target: SendTarget,
  source: MessageSource,
  options?: SendOptions,
): Promise<string> {
  const { content, tokens } = buildMessageContent(source, options, target);
  const txnId = resolveTxnId(options);
  try {
    const eventId = await target.client.sendEvent(
      target.roomId,
      "m.room.message",
      content,
      txnId ? { txnId } : undefined,
    );
    if (tokens.length > 0) target.callbacks?.bindMessage(tokens, eventId);
    return eventId;
  } catch (err) {
    if (target.outbox && isTransientSendError(err)) {
      await target.outbox.enqueue({
        roomId: target.roomId,
        eventType: "m.room.message",
        content,
        ...(txnId ? { txnId } : {}),
      });
    }
    throw err;
  }
}

function isTransientSendError(err: unknown): boolean {
  if (err instanceof RateLimitedError) return true;
  if (err instanceof RequestTimeoutError) return true;
  if (err instanceof MatrixApiError) {
    return err.status === 429 || err.status >= 500 || err.status === 0;
  }
  if (err instanceof TypeError) return true;
  if (err instanceof Error && /fetch|network|ECONN|ETIMEDOUT|socket/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Edit a previously sent message, optionally replacing the inline keyboard.
 * Revokes tokens for the original event when a new keyboard is attached or
 * `keyboard: null` is passed.
 */
export async function editMessageWithOptions(
  target: SendTarget,
  eventId: string,
  source: MessageSource,
  options?: SendOptions & { keyboard?: InlineKeyboard | null },
): Promise<string> {
  const opts = options ?? {};
  const minted: string[] = [];
  const parseMode: ParseMode = opts.parseMode ?? "plain";
  let plain = source.text ?? (source.html ? htmlToPlainBody(source.html) : "");
  let formatted: string | null =
    source.html ??
    (source.text && parseMode !== "plain" ? formatPlain(source.text, parseMode) : null);

  let keyboardContent: KeyboardContent | null | undefined;
  if (opts.keyboard === null) {
    keyboardContent = null;
    target.callbacks?.revokeForMessage?.(eventId);
  } else if (opts.keyboard && !opts.keyboard.isEmpty) {
    target.callbacks?.revokeForMessage?.(eventId);
    keyboardContent = tokenizeKeyboard(opts.keyboard, target, minted);
    if (opts.keyboardFallback !== false) {
      const fallback = renderKeyboardFallback(keyboardContent);
      if (fallback.text) plain = plain ? `${plain}\n\n${fallback.text}` : fallback.text;
      if (fallback.html) {
        const base = formatted ?? plainToHtml(source.text ?? "");
        formatted = `${base}${fallback.html}`;
      }
    }
  }

  const newContent: Record<string, unknown> = {
    msgtype: opts.notice ? "m.notice" : "m.text",
    body: plain,
  };
  if (formatted !== null) {
    newContent.format = "org.matrix.custom.html";
    newContent.formatted_body = formatted;
  }
  if (keyboardContent) newContent[KEYBOARD_CONTENT_KEY] = keyboardContent;
  if (opts.extra) Object.assign(newContent, opts.extra);

  const txnId = resolveTxnId(opts);
  const replacementId = await target.client.sendEvent(
    target.roomId,
    "m.room.message",
    {
      ...newContent,
      body: `* ${plain}`,
      ...(formatted
        ? {
            format: "org.matrix.custom.html",
            formatted_body: `* ${formatted}`,
          }
        : {}),
      "m.new_content": newContent,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    },
    txnId ? { txnId } : undefined,
  );
  if (minted.length > 0) target.callbacks?.bindMessage(minted, eventId);
  return replacementId;
}
