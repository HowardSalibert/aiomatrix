import type { MatrixClient } from "matrix-bot-sdk";
import {
  CryptoNotReadyError,
  DeviceMismatchError,
  EncryptedRoomWithoutCryptoError,
  PeerKeysMissingError,
} from "./errors.js";

export interface KeysQueryDevice {
  algorithms?: string[];
  device_id?: string;
  user_id?: string;
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
  unsigned?: Record<string, unknown>;
}

export interface KeysQueryResponse {
  device_keys?: Record<string, Record<string, KeysQueryDevice>>;
  failures?: Record<string, unknown>;
  master_keys?: Record<string, unknown>;
  self_signing_keys?: Record<string, unknown>;
  user_signing_keys?: Record<string, unknown>;
}

/**
 * POST /_matrix/client/v3/keys/query for the given users.
 */
export async function queryDeviceKeys(
  client: MatrixClient,
  userIds: string[],
  deviceFilter?: Record<string, string[]>,
): Promise<KeysQueryResponse> {
  const device_keys: Record<string, string[]> = {};
  for (const userId of userIds) {
    device_keys[userId] = deviceFilter?.[userId] ?? [];
  }
  return client.doRequest("POST", "/_matrix/client/v3/keys/query", {}, {
    timeout: 10000,
    device_keys,
  }) as Promise<KeysQueryResponse>;
}

export function countDevicesForUser(
  resp: KeysQueryResponse,
  userId: string,
): number {
  const devices = resp.device_keys?.[userId];
  if (!devices) return 0;
  return Object.keys(devices).length;
}

export function hasOwnDeviceKeys(
  resp: KeysQueryResponse,
  userId: string,
  deviceId: string,
): boolean {
  const device = resp.device_keys?.[userId]?.[deviceId];
  if (!device) return false;
  const keys = device.keys ?? {};
  return Object.keys(keys).length > 0;
}

/**
 * After crypto.prepare + engine flush, verify own device keys exist on HS.
 */
export async function assertOwnDeviceKeysReady(
  client: MatrixClient,
  userId: string,
  deviceId: string,
): Promise<void> {
  const resp = await queryDeviceKeys(client, [userId], { [userId]: [deviceId] });
  if (!hasOwnDeviceKeys(resp, userId, deviceId)) {
    // Retry once after a short wait — keys/upload may still be in flight.
    await new Promise((r) => setTimeout(r, 500));
    const retry = await queryDeviceKeys(client, [userId], { [userId]: [deviceId] });
    if (!hasOwnDeviceKeys(retry, userId, deviceId)) {
      throw new CryptoNotReadyError(
        `CryptoNotReadyError: own device keys missing for ${userId} / ${deviceId} after prepare+flush. Refusing to start half-broken.`,
      );
    }
  }
}

export function assertDeviceIdMatch(
  expected: string,
  actual: string | null | undefined,
): void {
  if (!actual || actual !== expected) {
    throw new DeviceMismatchError(expected, actual);
  }
}

/**
 * Heuristic: Matrix user localparts ending with "bot" or containing "_bot"/"-bot"
 * are treated as bots (optional skip). Humans = everyone else including self.
 */
export function isLikelyBotUserId(userId: string): boolean {
  const local = userId.replace(/^@/, "").split(":")[0]?.toLowerCase() ?? "";
  return local.endsWith("bot") || local.includes("_bot") || local.includes("-bot");
}

/**
 * Before send into an encrypted room: keys/query joined members (humans by default).
 * Throws PeerKeysMissingError if zero device keys for intended peers.
 */
export async function assertPeersHaveKeys(
  client: MatrixClient,
  roomId: string,
  options?: { includeBots?: boolean; excludeUserId?: string },
): Promise<void> {
  const members = await client.getJoinedRoomMembers(roomId);
  const exclude = options?.excludeUserId;
  let peers = members.filter((u) => u !== exclude);
  if (!options?.includeBots) {
    peers = peers.filter((u) => !isLikelyBotUserId(u));
  }
  // Still require at least one peer with keys — if only bots remain and includeBots=false,
  // fall back to all non-self members so we don't silently skip the check.
  if (peers.length === 0) {
    peers = members.filter((u) => u !== exclude);
  }
  if (peers.length === 0) {
    throw new PeerKeysMissingError(roomId, []);
  }

  const resp = await queryDeviceKeys(client, peers);
  let total = 0;
  for (const peer of peers) {
    total += countDevicesForUser(resp, peer);
  }
  if (total === 0) {
    console.error(
      `[matrixbots] PeerKeysMissingError: encrypted room ${roomId} — keys/query returned 0 device keys for peers: ${peers.join(", ")}. Message NOT sent.`,
    );
    throw new PeerKeysMissingError(roomId, peers);
  }
}

/**
 * Guarded send: never plaintext-fallback in encrypted rooms.
 */
export async function guardedSendText(
  client: MatrixClient,
  roomId: string,
  text: string,
  cryptoEnabled: boolean,
): Promise<string> {
  const encrypted = await isRoomEncryptedSafe(client, roomId);
  if (encrypted) {
    if (!cryptoEnabled || !client.crypto?.isReady) {
      throw new EncryptedRoomWithoutCryptoError(roomId);
    }
    const selfId = await client.getUserId();
    await assertPeersHaveKeys(client, roomId, { excludeUserId: selfId });
  }
  return client.sendText(roomId, text);
}

export async function guardedSendHtml(
  client: MatrixClient,
  roomId: string,
  html: string,
  cryptoEnabled: boolean,
): Promise<string> {
  const encrypted = await isRoomEncryptedSafe(client, roomId);
  if (encrypted) {
    if (!cryptoEnabled || !client.crypto?.isReady) {
      throw new EncryptedRoomWithoutCryptoError(roomId);
    }
    const selfId = await client.getUserId();
    await assertPeersHaveKeys(client, roomId, { excludeUserId: selfId });
  }
  return client.sendHtmlText(roomId, html);
}

async function isRoomEncryptedSafe(
  client: MatrixClient,
  roomId: string,
): Promise<boolean> {
  if (client.crypto?.isReady) {
    return client.crypto.isRoomEncrypted(roomId);
  }
  // Crypto disabled: still detect encryption via room state so we never fall back to plaintext.
  try {
    const ev = await client.getRoomStateEvent(roomId, "m.room.encryption", "");
    return Boolean(ev && (ev as { algorithm?: string }).algorithm);
  } catch {
    return false;
  }
}
