import { assertPeersHaveKeys } from "./crypto-guard.js";
import type { MatrixClient } from "./client.js";

export interface RoomSendReadiness {
  ok: boolean;
  encrypted: boolean | undefined;
  cryptoReady: boolean;
  peerKeysOk: boolean;
  reason?: string;
}

/**
 * Can this bot encrypt+send into `roomId` right now?
 * Power-level checks are separate ({@link import("./room-cache.js").RoomCache.canSend}).
 */
export async function canSendToRoom(
  client: MatrixClient,
  roomId: string,
): Promise<RoomSendReadiness> {
  const encrypted = client.rooms.isEncrypted(roomId);
  const cryptoReady = client.crypto?.isReady === true;
  if (encrypted === true && !cryptoReady) {
    return {
      ok: false,
      encrypted,
      cryptoReady: false,
      peerKeysOk: false,
      reason: "crypto_not_ready",
    };
  }
  if (encrypted !== true) {
    return {
      ok: true,
      encrypted: encrypted ?? false,
      cryptoReady,
      peerKeysOk: true,
    };
  }
  try {
    await assertPeersHaveKeys(client, roomId, { excludeUserId: client.selfId });
    return {
      ok: true,
      encrypted: true,
      cryptoReady: true,
      peerKeysOk: true,
    };
  } catch (err) {
    return {
      ok: false,
      encrypted: true,
      cryptoReady: true,
      peerKeysOk: false,
      reason: err instanceof Error ? err.message : "peer_keys_missing",
    };
  }
}
