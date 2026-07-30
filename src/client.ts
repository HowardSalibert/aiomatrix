import * as fs from "node:fs";
import * as path from "node:path";
import { CryptoEngine } from "./crypto.js";
import { EncryptedRoomWithoutCryptoError } from "./errors.js";
import { MatrixHttp } from "./http.js";
import { SyncLoop, type SyncResponse } from "./sync.js";
import type { BotCreateOptions, MatrixMessageEvent } from "./types.js";

export interface CreatedClient {
  client: MatrixClient;
  storagePath: string;
  cryptoEnabled: boolean;
  configuredDeviceId?: string;
}

export type MessageHandler = (roomId: string, event: MatrixMessageEvent) => void;

/**
 * Own Matrix Client-Server client (sync + send + optional CryptoEngine).
 */
export class MatrixClient {
  readonly http: MatrixHttp;
  readonly storagePath: string;
  crypto: CryptoEngine | null;
  private userId: string;
  private deviceId: string | null;
  private readonly encryptedRooms = new Map<string, boolean>();
  private syncLoop: SyncLoop | null = null;
  private onMessage: MessageHandler | null = null;

  constructor(options: {
    http: MatrixHttp;
    storagePath: string;
    userId: string;
    deviceId: string | null;
    crypto: CryptoEngine | null;
  }) {
    this.http = options.http;
    this.storagePath = options.storagePath;
    this.userId = options.userId;
    this.deviceId = options.deviceId;
    this.crypto = options.crypto;
  }

  getUserId(): Promise<string> {
    return Promise.resolve(this.userId);
  }

  getDeviceId(): string | null {
    return this.crypto?.clientDeviceId ?? this.deviceId;
  }

  async getWhoAmI(): Promise<{ user_id: string; device_id?: string }> {
    const whoami = await this.http.request<{ user_id: string; device_id?: string }>(
      "GET",
      "/_matrix/client/v3/account/whoami",
    );
    this.userId = whoami.user_id;
    if (whoami.device_id) this.deviceId = whoami.device_id;
    return whoami;
  }

  async getJoinedRooms(): Promise<string[]> {
    const resp = await this.http.request<{ joined_rooms: string[] }>(
      "GET",
      "/_matrix/client/v3/joined_rooms",
    );
    return resp.joined_rooms ?? [];
  }

  async getJoinedRoomMembers(roomId: string): Promise<string[]> {
    const resp = await this.http.request<{
      joined: Record<string, unknown>;
    }>("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
    return Object.keys(resp.joined ?? {});
  }

  async getRoomStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
  ): Promise<unknown> {
    return this.http.request(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
    );
  }

  async isRoomEncrypted(roomId: string): Promise<boolean> {
    if (this.encryptedRooms.has(roomId)) {
      return this.encryptedRooms.get(roomId) === true;
    }
    try {
      const ev = (await this.getRoomStateEvent(roomId, "m.room.encryption", "")) as {
        algorithm?: string;
      };
      const encrypted = Boolean(ev?.algorithm);
      this.encryptedRooms.set(roomId, encrypted);
      return encrypted;
    } catch {
      this.encryptedRooms.set(roomId, false);
      return false;
    }
  }

  doRequest(
    method: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null> | null,
    body?: unknown,
  ): Promise<unknown> {
    return this.http.request(method, path, query, body);
  }

  async sendText(roomId: string, text: string): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: text,
    });
  }

  async sendHtmlText(roomId: string, html: string): Promise<string> {
    const body = html.replace(/<[^>]*>/g, "");
    return this.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body: html,
      body,
    });
  }

  async sendReaction(roomId: string, eventId: string, key: string): Promise<string> {
    return this.sendEvent(roomId, "m.reaction", {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key,
      },
    });
  }

  /**
   * Send an event. Encrypted rooms: Megolm encrypt, never plaintext fallback.
   */
  async sendEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const encrypted = await this.isRoomEncrypted(roomId);
    if (encrypted) {
      if (!this.crypto?.isReady) {
        throw new EncryptedRoomWithoutCryptoError(roomId);
      }
      const members = await this.getJoinedRoomMembers(roomId);
      const encContent = await this.crypto.encryptMessage(roomId, type, content, members);
      return this.putRoomEvent(roomId, "m.room.encrypted", encContent);
    }
    return this.putRoomEvent(roomId, type, content);
  }

  private async putRoomEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const txnId = this.http.txnId();
    const resp = await this.http.request<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`,
      null,
      content,
    );
    return resp.event_id;
  }

  async start(onMessage: MessageHandler): Promise<void> {
    if (this.syncLoop) {
      throw new Error("MatrixClient already started");
    }
    this.onMessage = onMessage;
    this.syncLoop = new SyncLoop({
      http: this.http,
      storagePath: this.storagePath,
      onSync: (resp) => this.handleSync(resp),
    });
    this.syncLoop.start();
  }

  stop(): void {
    this.syncLoop?.stop();
    this.syncLoop = null;
    this.onMessage = null;
  }

  private async handleSync(response: SyncResponse): Promise<void> {
    if (this.crypto) {
      const toDevice = response.to_device?.events ?? [];
      const changed = response.device_lists?.changed ?? [];
      const left = response.device_lists?.left ?? [];
      const otk = response.device_one_time_keys_count ?? {};
      const unused = response.device_unused_fallback_key_types ?? [];
      await this.crypto.receiveSync(
        JSON.stringify(toDevice),
        changed,
        left,
        otk,
        unused,
      );
    }

    const joined = response.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries(joined)) {
      const stateEvents = room.state?.events ?? [];
      for (const ev of stateEvents) {
        this.noteStateEvent(roomId, ev);
      }

      const timeline = room.timeline?.events ?? [];
      for (const ev of timeline) {
        this.noteStateEvent(roomId, ev);
        await this.emitTimelineEvent(roomId, ev);
      }
    }
  }

  private noteStateEvent(roomId: string, ev: Record<string, unknown>): void {
    if (ev.type === "m.room.encryption" && typeof ev.state_key === "string") {
      const content = ev.content as { algorithm?: string } | undefined;
      this.encryptedRooms.set(roomId, Boolean(content?.algorithm));
      if (this.crypto && content?.algorithm) {
        void this.getJoinedRoomMembers(roomId)
          .then((members) => this.crypto!.updateTrackedUsers(members))
          .catch((err) => console.warn("[matrixbots] track room members:", err));
      }
    }
    if (ev.type === "m.room.member" && this.crypto && typeof ev.state_key === "string") {
      const membership = (ev.content as { membership?: string } | undefined)?.membership;
      if (membership === "join" || membership === "invite") {
        void this.crypto.updateTrackedUsers([ev.state_key]).catch((err) => {
          console.warn("[matrixbots] updateTrackedUsers:", err);
        });
      }
    }
  }

  private async emitTimelineEvent(
    roomId: string,
    ev: Record<string, unknown>,
  ): Promise<void> {
    if (!this.onMessage) return;

    let event: Record<string, unknown> = ev;
    if (ev.type === "m.room.encrypted") {
      if (!this.crypto?.isReady) {
        console.warn(`[matrixbots] skip encrypted event in ${roomId}: crypto not ready`);
        return;
      }
      try {
        event = await this.crypto.decryptRoomEvent(roomId, ev);
      } catch (err) {
        console.warn(`[matrixbots] decrypt failed in ${roomId}:`, err);
        return;
      }
    }

    if (event.type !== "m.room.message") return;
    const content = event.content as { msgtype?: string } | undefined;
    if (!content?.msgtype) return;

    this.onMessage(roomId, event as MatrixMessageEvent);
  }
}

/**
 * Build MatrixClient with optional CryptoEngine under storagePath/crypto.
 */
export async function createMatrixClient(
  options: BotCreateOptions,
): Promise<CreatedClient> {
  const storagePath = path.resolve(options.storagePath ?? "./data");
  fs.mkdirSync(storagePath, { recursive: true });

  const cryptoEnabled = options.crypto !== false;
  const http = new MatrixHttp(options.homeserverUrl, options.accessToken);
  const whoami = await http.request<{ user_id: string; device_id?: string }>(
    "GET",
    "/_matrix/client/v3/account/whoami",
  );
  const userId = whoami.user_id;
  const deviceId = options.deviceId ?? whoami.device_id ?? null;

  let crypto: CryptoEngine | null = null;
  if (cryptoEnabled) {
    if (!deviceId) {
      throw new Error(
        "deviceId is REQUIRED when crypto is enabled (set MATRIX_DEVICE_ID / BotCreateOptions.deviceId)",
      );
    }
    const cryptoPath = path.join(storagePath, "crypto");
    fs.mkdirSync(cryptoPath, { recursive: true });
    crypto = await CryptoEngine.create({
      userId,
      deviceId,
      storePath: cryptoPath,
      http,
    });
  }

  const client = new MatrixClient({
    http,
    storagePath,
    userId,
    deviceId,
    crypto,
  });

  return {
    client,
    storagePath,
    cryptoEnabled,
    configuredDeviceId: options.deviceId,
  };
}

/** Resolve the active device id after crypto prepare (or from whoami). */
export async function resolveDeviceId(client: MatrixClient): Promise<string | null> {
  if (client.crypto?.clientDeviceId) {
    return client.crypto.clientDeviceId;
  }
  const fromClient = client.getDeviceId();
  if (fromClient) return fromClient;
  try {
    const whoami = await client.getWhoAmI();
    return whoami.device_id ?? null;
  } catch {
    return null;
  }
}

/** Explicit prepareCrypto: track room members + flush outgoing OlmMachine requests. */
export async function prepareCrypto(client: MatrixClient): Promise<void> {
  if (!client.crypto) {
    throw new Error("prepareCrypto called but crypto is not enabled on MatrixClient");
  }
  const rooms = await client.getJoinedRooms();
  await client.crypto.prepare(rooms, (roomId) => client.getJoinedRoomMembers(roomId));
}
