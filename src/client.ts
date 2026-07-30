import * as fs from "node:fs";
import * as path from "node:path";
import { CryptoEngine, type HistoryVisibilityName } from "./crypto.js";
import { DispatchQueue, EventDeduper } from "./dispatch-queue.js";
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
export type FatalHandler = (err: unknown) => void;

function resolveSafeStoragePath(raw: string): string {
  if (raw.includes("..")) {
    throw new Error('storagePath must not contain ".." (path traversal refused)');
  }
  return path.resolve(raw);
}

function deviceJsonPath(storagePath: string): string {
  return path.join(storagePath, "device.json");
}

function loadPersistedDeviceId(storagePath: string): string | null {
  try {
    const file = deviceJsonPath(storagePath);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { device_id?: string };
    return typeof raw.device_id === "string" && raw.device_id ? raw.device_id : null;
  } catch {
    return null;
  }
}

function savePersistedDeviceId(storagePath: string, deviceId: string): void {
  fs.mkdirSync(storagePath, { recursive: true });
  fs.writeFileSync(
    deviceJsonPath(storagePath),
    JSON.stringify({ device_id: deviceId }, null, 2),
    "utf8",
  );
}

/** Strip tags + decode common HTML entities for plaintext fallback body. */
export function htmlToPlainBody(html: string): string {
  const stripped = html.replace(/<[^>]*>/g, "");
  return stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/**
 * Own Matrix Client-Server client (sync + send + optional CryptoEngine).
 */
export class MatrixClient {
  readonly http: MatrixHttp;
  readonly storagePath: string;
  crypto: CryptoEngine | null;
  private userId: string;
  private deviceId: string | null;
  private readonly autojoin: boolean;
  private readonly encryptedRooms = new Map<string, boolean>();
  private readonly historyVisibility = new Map<string, HistoryVisibilityName>();
  private syncLoop: SyncLoop | null = null;
  private onMessage: MessageHandler | null = null;
  private onFatal: FatalHandler | null = null;
  private readonly deduper = new EventDeduper(512);
  private readonly queue = new DispatchQueue(8);
  private directRoomsCache: Set<string> | null = null;

  constructor(options: {
    http: MatrixHttp;
    storagePath: string;
    userId: string;
    deviceId: string | null;
    crypto: CryptoEngine | null;
    autojoin?: boolean;
  }) {
    this.http = options.http;
    this.storagePath = options.storagePath;
    this.userId = options.userId;
    this.deviceId = options.deviceId;
    this.crypto = options.crypto;
    this.autojoin = options.autojoin !== false;
    this.crypto?.setHistoryVisibilityResolver((roomId) =>
      this.historyVisibility.get(roomId),
    );
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
    if (whoami.device_id) {
      this.deviceId = whoami.device_id;
      savePersistedDeviceId(this.storagePath, whoami.device_id);
    }
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

  /** Join by room id or alias. */
  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const resp = await this.http.request<{ room_id: string }>(
      "POST",
      `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`,
      null,
      {},
    );
    return resp.room_id;
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`,
      null,
      typing ? { typing: true, timeout: timeoutMs } : { typing: false },
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

  getHistoryVisibility(roomId: string): HistoryVisibilityName {
    return this.historyVisibility.get(roomId) ?? "shared";
  }

  /** Account-data m.direct cache (room ids). */
  async getDirectRoomIds(forceRefresh = false): Promise<Set<string>> {
    if (this.directRoomsCache && !forceRefresh) return this.directRoomsCache;
    try {
      const data = await this.http.request<Record<string, string[]>>(
        "GET",
        `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/m.direct`,
      );
      const set = new Set<string>();
      if (data && typeof data === "object") {
        for (const rooms of Object.values(data)) {
          if (Array.isArray(rooms)) {
            for (const r of rooms) {
              if (typeof r === "string") set.add(r);
            }
          }
        }
      }
      this.directRoomsCache = set;
      return set;
    } catch {
      this.directRoomsCache = this.directRoomsCache ?? new Set();
      return this.directRoomsCache;
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

  /**
   * Send HTML-formatted text. Plain body is tag-stripped + entity-decoded.
   * XSS trust boundary: bot author is responsible for HTML content sent to Matrix
   * (clients render formatted_body; we do not execute scripts).
   */
  async sendHtmlText(roomId: string, html: string): Promise<string> {
    const body = htmlToPlainBody(html);
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

  async start(onMessage: MessageHandler, onFatal?: FatalHandler): Promise<void> {
    if (this.syncLoop) {
      throw new Error("MatrixClient already started");
    }
    this.onMessage = onMessage;
    this.onFatal = onFatal ?? null;
    this.syncLoop = new SyncLoop({
      http: this.http,
      storagePath: this.storagePath,
      userId: this.userId,
      onSync: (resp, meta) => this.handleSync(resp, meta),
      onFatal: (err) => this.onFatal?.(err),
    });
    this.syncLoop.start();
  }

  async stop(): Promise<void> {
    const loop = this.syncLoop;
    this.syncLoop = null;
    this.onMessage = null;
    if (loop) {
      loop.stop();
      await loop.waitUntilStopped();
    }
  }

  private async handleSync(
    response: SyncResponse,
    meta: { isBootstrap: boolean },
  ): Promise<void> {
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

    if (this.autojoin) {
      const invites = response.rooms?.invite ?? {};
      for (const roomId of Object.keys(invites)) {
        try {
          await this.joinRoom(roomId);
          console.log(`[matrixbots] autojoined ${roomId}`);
        } catch (err) {
          console.warn(`[matrixbots] autojoin failed for ${roomId}:`, err);
        }
      }
    }

    const joined = response.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries(joined)) {
      const usersToTrack: string[] = [];
      let needMemberTrack = false;

      if (room.timeline?.limited === true) {
        this.encryptedRooms.delete(roomId);
        this.historyVisibility.delete(roomId);
        await this.refreshRoomCryptoState(roomId);
      }

      const stateEvents = room.state?.events ?? [];
      for (const ev of stateEvents) {
        if (this.noteTrackFromEvent(ev, usersToTrack)) needMemberTrack = true;
        this.applyStateEvent(roomId, ev);
      }

      const timeline = room.timeline?.events ?? [];
      for (const ev of timeline) {
        if (this.noteTrackFromEvent(ev, usersToTrack)) needMemberTrack = true;
        this.applyStateEvent(roomId, ev);
      }

      if (this.crypto) {
        if (needMemberTrack) {
          await this.trackRoomMembers(roomId);
        }
        if (usersToTrack.length > 0) {
          await this.crypto.updateTrackedUsers([...new Set(usersToTrack)]);
        }
      }

      // Bootstrap: crypto/state only — never dispatch historical timeline to handlers.
      if (meta.isBootstrap) continue;

      for (const ev of timeline) {
        await this.emitTimelineEvent(roomId, ev);
      }
    }
  }

  private async refreshRoomCryptoState(roomId: string): Promise<void> {
    try {
      const enc = (await this.getRoomStateEvent(roomId, "m.room.encryption", "")) as {
        algorithm?: string;
      };
      this.encryptedRooms.set(roomId, Boolean(enc?.algorithm));
    } catch {
      this.encryptedRooms.set(roomId, false);
    }
    try {
      const hv = (await this.getRoomStateEvent(
        roomId,
        "m.room.history_visibility",
        "",
      )) as { history_visibility?: string };
      this.cacheHistoryVisibility(roomId, hv?.history_visibility);
    } catch {
      // keep default shared
    }
  }

  private cacheHistoryVisibility(roomId: string, value: string | undefined): void {
    if (
      value === "invited" ||
      value === "joined" ||
      value === "shared" ||
      value === "world_readable"
    ) {
      this.historyVisibility.set(roomId, value);
    } else if (value != null) {
      this.historyVisibility.set(roomId, "shared");
    }
  }

  private applyStateEvent(roomId: string, ev: Record<string, unknown>): void {
    if (ev.type === "m.room.encryption") {
      const content = ev.content as { algorithm?: string } | undefined;
      this.encryptedRooms.set(roomId, Boolean(content?.algorithm));
    }
    if (ev.type === "m.room.history_visibility") {
      const content = ev.content as { history_visibility?: string } | undefined;
      this.cacheHistoryVisibility(roomId, content?.history_visibility);
    }
  }

  /** Returns true if encryption appeared (need full member track). */
  private noteTrackFromEvent(
    ev: Record<string, unknown>,
    out: string[],
  ): boolean {
    if (!this.crypto) return false;
    let needMembers = false;
    if (ev.type === "m.room.encryption") {
      const content = ev.content as { algorithm?: string } | undefined;
      if (content?.algorithm) needMembers = true;
    }
    if (ev.type === "m.room.member" && typeof ev.state_key === "string") {
      const membership = (ev.content as { membership?: string } | undefined)?.membership;
      if (membership === "join" || membership === "invite") {
        out.push(ev.state_key);
      }
    }
    return needMembers;
  }

  private async emitTimelineEvent(
    roomId: string,
    ev: Record<string, unknown>,
  ): Promise<void> {
    if (!this.onMessage) return;

    const eventId = typeof ev.event_id === "string" ? ev.event_id : "";
    if (eventId && this.deduper.seen(roomId, eventId)) return;

    await this.queue.run(roomId, async () => {
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

      // Own echo: skip (also covered in dispatcher); skip m.notice from self there.
      if (event.sender === this.userId) return;

      this.onMessage!(roomId, event as MatrixMessageEvent);
    });
  }

  /** After encryption state seen: track all joined members (awaited from handleSync). */
  async trackRoomMembers(roomId: string): Promise<void> {
    if (!this.crypto) return;
    try {
      const members = await this.getJoinedRoomMembers(roomId);
      await this.crypto.updateTrackedUsers(members);
    } catch (err) {
      console.warn("[matrixbots] track room members:", err);
    }
  }
}

/**
 * Build MatrixClient with optional CryptoEngine under storagePath/crypto.
 */
export async function createMatrixClient(
  options: BotCreateOptions,
): Promise<CreatedClient> {
  const storagePath = resolveSafeStoragePath(options.storagePath ?? "./data");
  fs.mkdirSync(storagePath, { recursive: true });

  const cryptoEnabled = options.crypto !== false;
  const http = new MatrixHttp(options.homeserverUrl, options.accessToken);
  const whoami = await http.request<{ user_id: string; device_id?: string }>(
    "GET",
    "/_matrix/client/v3/account/whoami",
  );
  const userId = whoami.user_id;
  const persisted = loadPersistedDeviceId(storagePath);
  const deviceId =
    options.deviceId ?? whoami.device_id ?? persisted ?? null;

  if (options.deviceId && whoami.device_id && options.deviceId !== whoami.device_id) {
    // Still allow create — Bot.start enforces match; persist configured id after prepare.
  }

  let crypto: CryptoEngine | null = null;
  if (cryptoEnabled) {
    if (!deviceId) {
      throw new Error(
        "deviceId is REQUIRED when crypto is enabled (set MATRIX_DEVICE_ID / BotCreateOptions.deviceId or storagePath/device.json)",
      );
    }
    const cryptoPath = path.join(storagePath, "crypto");
    fs.mkdirSync(cryptoPath, { recursive: true });
    crypto = await CryptoEngine.create({
      userId,
      deviceId,
      storePath: cryptoPath,
      http,
      storePassphrase: options.cryptoStorePassphrase ?? null,
    });
    savePersistedDeviceId(storagePath, deviceId);
  } else if (deviceId) {
    savePersistedDeviceId(storagePath, deviceId);
  }

  const client = new MatrixClient({
    http,
    storagePath,
    userId,
    deviceId,
    crypto,
    autojoin: options.autojoin !== false,
  });

  return {
    client,
    storagePath,
    cryptoEnabled,
    configuredDeviceId: options.deviceId ?? deviceId ?? undefined,
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
