import { htmlToPlainBody, type MatrixClient } from "./client.js";
import {
  KEYBOARD_CONTENT_KEY,
  renderKeyboardFallback,
  type CallbackTokenStore,
  type InlineKeyboard,
  type KeyboardContent,
} from "./keyboards.js";
import type { SendOptions } from "./types.js";
import { escapeHtml } from "./util.js";

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

  let plain = source.text ?? (source.html ? htmlToPlainBody(source.html) : "");
  let formatted = source.html ?? null;
  let keyboardContent: KeyboardContent | null = null;

  if (opts.keyboard && !opts.keyboard.isEmpty) {
    keyboardContent = tokenizeKeyboard(opts.keyboard, target, tokens);
    const fallback = renderKeyboardFallback(keyboardContent);
    if (fallback.text) plain = plain ? `${plain}\n\n${fallback.text}` : fallback.text;
    if (fallback.html) {
      formatted = `${formatted ?? plainToHtml(source.text ?? "")}${fallback.html}`;
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
  return { content, tokens };
}

/**
 * Serialise a keyboard, replacing raw callback payloads with opaque tokens.
 *
 * Only the token travels through the text fallback, so a user cannot forge
 * arbitrary callback data by typing the fallback command by hand.
 */
function tokenizeKeyboard(
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
      return { ...button, token };
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
  const eventId = await target.client.sendEvent(target.roomId, "m.room.message", content);
  if (tokens.length > 0) target.callbacks?.bindMessage(tokens, eventId);
  return eventId;
}
