import type { MatrixClient } from "./client.js";
import type { Bot } from "./bot.js";
import { guardedSendHtml, guardedSendText } from "./crypto-guard.js";
import { FSMContext, type Storage } from "./fsm.js";
import type { Context, MatrixMessageEvent } from "./types.js";

export async function detectDirectRoom(
  client: MatrixClient,
  roomId: string,
  senderId: string,
): Promise<boolean> {
  try {
    const directs = await client.getDirectRoomIds();
    if (directs.has(roomId)) return true;
  } catch {
    // ignore
  }
  try {
    const members = await client.getJoinedRoomMembers(roomId);
    if (members.length === 2 && members.includes(senderId)) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function createContext(params: {
  bot: Bot;
  client: MatrixClient;
  storage: Storage;
  roomId: string;
  event: MatrixMessageEvent;
  isDirect: boolean;
}): Context {
  const { bot, client, storage, roomId, event, isDirect } = params;
  const senderId = event.sender ?? "";
  const body = typeof event.content?.body === "string" ? event.content.body : "";
  const text = body;

  const state = new FSMContext(storage, roomId, senderId);

  const ctx: Context = {
    roomId,
    senderId,
    eventId: event.event_id ?? "",
    text,
    body,
    isDirect,
    commandArgs: "",
    commandName: null,
    event,
    client,
    bot,
    state,
    async reply(replyText: string): Promise<string> {
      return guardedSendText(client, roomId, replyText, bot.cryptoEnabled);
    },
    async replyHtml(html: string): Promise<string> {
      return guardedSendHtml(client, roomId, html, bot.cryptoEnabled);
    },
    async react(key: string): Promise<string> {
      const eventId = event.event_id;
      if (!eventId) {
        throw new Error("Cannot react: missing event_id");
      }
      // sendReaction → sendEvent → encrypt path in encrypted rooms
      return client.sendReaction(roomId, eventId, key);
    },
  };

  return ctx;
}
