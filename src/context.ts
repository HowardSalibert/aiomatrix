import type { MatrixClient } from "matrix-bot-sdk";
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
    // Prefer m.direct account data map when available.
    const dms = (client as MatrixClient & { dms?: { getDmRoomId?: (u: string) => string | null | undefined; isDm?: (roomId: string) => boolean } }).dms;
    if (dms && typeof (dms as { getOrCreateDm?: unknown }).getOrCreateDm === "function") {
      // matrix-bot-sdk DMs has cached map — check via getJoinedRoomMembers fallback below
    }
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
      return client.sendEvent(roomId, "m.reaction", {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: eventId,
          key,
        },
      });
    },
  };

  return ctx;
}
