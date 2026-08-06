import * as fs from "node:fs";
import * as path from "node:path";
import { filterShareRecipients } from "./crypto-policy.js";
// Type-only: the native E2EE bindings are loaded on demand by `loadCryptoEngine`
// so a bot with `crypto: false` never needs a prebuilt binary for its platform.
import type { CryptoEngine } from "./crypto.js";
import { discoverHomeserver } from "./discovery.js";
import { DispatchQueue, EventDeduper } from "./dispatch-queue.js";
import {
  AuthenticationError,
  ConfigurationError,
  DeviceMismatchError,
  EncryptedRoomWithoutCryptoError,
  EncryptionStateUnknownError,
} from "./errors.js";
import { MatrixApiError, MatrixHttp } from "./http.js";
import { clearSession, loadSession, loginWithPassword, saveSession } from "./login.js";
import { createDefaultLogger, type Logger, type LogLevel } from "./logger.js";
import {
  buildEncryptedFileBlock,
  buildMediaInfo,
  downloadMedia,
  downloadThumbnail,
  guessMimeType,
  msgtypeForMime,
  splitEncryptedFileBlock,
  uploadMedia,
  type MediaInfo,
  type UploadResult,
} from "./media.js";
import { RoomCache, type HistoryVisibilityName, type PowerLevels } from "./room-cache.js";
import {
  createSessionRefreshHandler,
  loadPersistedDeviceId,
  resolveCryptoStorePassphrase,
  savePersistedDeviceId,
} from "./session-recovery.js";
import { SyncLoop, type JoinedRoomSync, type SyncResponse } from "./sync.js";
import type { BotCreateOptions, MatrixEvent, MatrixMessageEvent } from "./types.js";
import { escapeHtml, isPlainObject, readString, resolveStoragePath } from "./util.js";
import { shouldDispatchOnColdStart } from "./cold-start.js";
import { HOST_CAPABILITIES_STATE_EVENT_TYPE } from "./host-capabilities.js";

export interface CreatedClient {
  client: MatrixClient;
  storagePath: string;
  cryptoEnabled: boolean;
  configuredDeviceId?: string;
}

/** Legacy message-only listener kept for backwards compatibility. */
export type MessageHandler = (roomId: string, event: MatrixMessageEvent) => void;
export type FatalHandler = (err: unknown) => void;

export interface ClientEventMeta {
  /** True when the event arrived through a gap-filling / historical batch. */
  historical: boolean;
  /** True when the event was decrypted from `m.room.encrypted`. */
  decrypted: boolean;
  /** True when the event was recovered by a late Megolm key. */
  lateDecrypt: boolean;
  /**
   * True only for the first sync bootstrap (not timeline gaps).
   * Used with {@link import("./cold-start.js").shouldDispatchOnColdStart}.
   */
  bootstrap?: boolean;
}

export interface ClientHandlers {
  /** Every timeline event (already decrypted), including the bot's own echoes. */
  onRoomEvent?: (roomId: string, event: MatrixEvent, meta: ClientEventMeta) => void;
  /** Ephemeral events (typing/receipt) when `receiveEphemeral` is on. */
  onEphemeral?: (roomId: string, event: MatrixEvent) => void;
  /** Decrypted (or plaintext) to-device events. */
  onToDevice?: (event: MatrixEvent) => void;
  /** Room invite, with the stripped invite state. */
  onInvite?: (roomId: string, events: MatrixEvent[]) => void;
  /** The bot left / was removed from a room. */
  onLeave?: (roomId: string) => void;
  /** Global account data events. */
  onAccountData?: (event: MatrixEvent) => void;
  /** Unrecoverable sync error (bad token). */
  onFatal?: FatalHandler;
}

export interface SendEventOptions {
  /** Reuse a transaction id (safe retry of the same logical send). */
  txnId?: string;
  /** Never encrypt, even in an encrypted room (used for reactions/relations). */
  forcePlaintext?: boolean;
}

export interface MatrixClientOptions {
  http: MatrixHttp;
  storagePath: string;
  userId: string;
  deviceId: string | null;
  crypto: CryptoEngine | null;
  autojoin?: boolean;
  autojoinFrom?: string[];
  logger?: Logger;
  rooms?: RoomCache;
  concurrency?: number;
  syncTimeoutMs?: number;
  presence?: "online" | "offline" | "unavailable";
  receiveEphemeral?: boolean;
  timelineLimit?: number;
  /** Encrypt `m.reaction` events. Default false to match other Matrix clients. */
  encryptReactions?: boolean;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  amp: "&",
};

/** Strip tags and decode common entities to build a plaintext fallback body. */
export function htmlToPlainBody(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*li\s*>/gi, "• ");
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  return stripped
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Own Matrix Client-Server client: sync, send, room admin, media, E2EE. */
export class MatrixClient {
  readonly http: MatrixHttp;
  readonly storagePath: string;
  readonly rooms: RoomCache;
  crypto: CryptoEngine | null;
  private userId: string;
  private deviceId: string | null;
  private readonly autojoin: boolean;
  private readonly autojoinFrom: string[] | null;
  private readonly encryptReactions: boolean;
  private readonly logger: Logger;
  private readonly deduper = new EventDeduper(2_048);
  private readonly queue: DispatchQueue;
  private readonly knownRooms = new Set<string>();
  /**
   * Set on cold-start bootstrap. Timeline events with an earlier
   * `origin_server_ts` are ignored for the rest of this client session so
   * Synapse history replays (filter changes, limited syncs) cannot re-trigger
   * handlers after `sync.json` was wiped.
   */
  private coldStartNotBeforeMs: number | null = null;
  private readonly options: MatrixClientOptions;
  private syncLoop: SyncLoop | null = null;
  private handlers: ClientHandlers = {};
  private stopping = false;

  constructor(options: MatrixClientOptions) {
    this.options = options;
    this.http = options.http;
    this.storagePath = options.storagePath;
    this.userId = options.userId;
    this.deviceId = options.deviceId;
    this.crypto = options.crypto;
    this.autojoin = options.autojoin !== false;
    this.autojoinFrom = options.autojoinFrom?.length ? options.autojoinFrom : null;
    this.encryptReactions = options.encryptReactions === true;
    this.logger = (options.logger ?? createDefaultLogger()).child("client");
    this.rooms = options.rooms ?? new RoomCache();
    this.queue = new DispatchQueue(options.concurrency ?? 8);
    this.crypto?.setHistoryVisibilityResolver((roomId) => this.rooms.historyVisibility(roomId));
    this.crypto?.setToDeviceHandler((events) => {
      for (const event of events) this.handlers.onToDevice?.(event as MatrixEvent);
    });
    this.crypto?.setDecryptRecoveredHandler((roomId, event) => {
      this.handlers.onRoomEvent?.(roomId, event as MatrixEvent, {
        historical: false,
        decrypted: true,
        lateDecrypt: true,
      });
    });
  }

  // ---------------------------------------------------------------- identity

  getUserId(): Promise<string> {
    return Promise.resolve(this.userId);
  }

  /** Synchronous accessor for the bot's own user id. */
  get selfId(): string {
    return this.userId;
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

  async getProfile(userId?: string): Promise<{ displayname?: string; avatar_url?: string }> {
    return this.http.request(
      "GET",
      `/_matrix/client/v3/profile/${encodeURIComponent(userId ?? this.userId)}`,
    );
  }

  async setDisplayName(displayName: string): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/profile/${encodeURIComponent(this.userId)}/displayname`,
      null,
      { displayname: displayName },
    );
  }

  async setAvatarUrl(mxcUri: string): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/profile/${encodeURIComponent(this.userId)}/avatar_url`,
      null,
      { avatar_url: mxcUri },
    );
  }

  // ------------------------------------------------------------------- rooms

  async getJoinedRooms(): Promise<string[]> {
    const resp = await this.http.request<{ joined_rooms?: string[] }>(
      "GET",
      "/_matrix/client/v3/joined_rooms",
    );
    return resp.joined_rooms ?? [];
  }

  /**
   * Joined members of a room. Served from the sync-backed cache when the member
   * list is complete, so the hot send path costs no HTTP request.
   */
  async getJoinedRoomMembers(roomId: string, forceRefresh = false): Promise<string[]> {
    if (!forceRefresh && this.rooms.hasCompleteMemberList(roomId)) {
      return this.rooms.joinedMembers(roomId);
    }
    const resp = await this.http.request<{ joined?: Record<string, unknown> }>(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    const members = Object.keys(resp.joined ?? {});
    this.rooms.setJoinedMembers(roomId, members);
    return members;
  }

  async getRoomStateEvent(roomId: string, type: string, stateKey = ""): Promise<unknown> {
    return this.http.request(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
    );
  }

  /** Full current room state. */
  async getRoomState(roomId: string): Promise<MatrixEvent[]> {
    const resp = await this.http.request<MatrixEvent[]>(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
    );
    if (Array.isArray(resp)) {
      for (const event of resp) this.rooms.applyStateEvent(roomId, event);
      this.rooms.markStateSynced(roomId);
    }
    return Array.isArray(resp) ? resp : [];
  }

  async sendStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
    content: Record<string, unknown>,
  ): Promise<string> {
    const resp = await this.http.request<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
      null,
      content,
      { idempotent: true },
    );
    return resp.event_id;
  }

  /** Join by room id or alias. */
  async joinRoom(roomIdOrAlias: string, options?: { reason?: string }): Promise<string> {
    const resp = await this.http.request<{ room_id: string }>(
      "POST",
      `/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`,
      null,
      options?.reason ? { reason: options.reason } : {},
      { idempotent: true },
    );
    return resp.room_id;
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`,
      null,
      reason ? { reason } : {},
      { idempotent: true },
    );
    this.rooms.forget(roomId);
    this.knownRooms.delete(roomId);
  }

  async forgetRoom(roomId: string): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`,
      null,
      {},
      { idempotent: true },
    );
  }

  async inviteUser(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      null,
      { user_id: userId, ...(reason ? { reason } : {}) },
      { idempotent: true },
    );
  }

  async kickUser(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/kick`,
      null,
      { user_id: userId, ...(reason ? { reason } : {}) },
      { idempotent: true },
    );
  }

  async banUser(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/ban`,
      null,
      { user_id: userId, ...(reason ? { reason } : {}) },
      { idempotent: true },
    );
  }

  async unbanUser(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/unban`,
      null,
      { user_id: userId, ...(reason ? { reason } : {}) },
      { idempotent: true },
    );
  }

  /** Set a user's power level, preserving the rest of `m.room.power_levels`. */
  async setPowerLevel(roomId: string, userId: string, level: number): Promise<string> {
    const current = (await this.getRoomStateEvent(roomId, "m.room.power_levels", "").catch(
      () => ({}),
    )) as Record<string, unknown>;
    const users = isPlainObject(current.users) ? { ...current.users } : {};
    users[userId] = level;
    const next = { ...current, users };
    const eventId = await this.sendStateEvent(roomId, "m.room.power_levels", "", next);
    this.rooms.applyStateEvent(roomId, { type: "m.room.power_levels", content: next });
    return eventId;
  }

  async createRoom(options: {
    name?: string;
    topic?: string;
    invite?: string[];
    isDirect?: boolean;
    /** Enable E2EE via an initial `m.room.encryption` state event. Default true for DMs. */
    encrypted?: boolean;
    preset?: "private_chat" | "trusted_private_chat" | "public_chat";
    alias?: string;
    initialState?: Array<{ type: string; state_key?: string; content: Record<string, unknown> }>;
    powerLevelOverride?: Record<string, unknown>;
  } = {}): Promise<string> {
    const initialState = [...(options.initialState ?? [])];
    const wantEncryption = options.encrypted ?? options.isDirect === true;
    if (wantEncryption && !initialState.some((s) => s.type === "m.room.encryption")) {
      initialState.push({
        type: "m.room.encryption",
        state_key: "",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      });
    }
    const body: Record<string, unknown> = {
      preset: options.preset ?? (options.isDirect ? "trusted_private_chat" : "private_chat"),
    };
    if (options.name) body.name = options.name;
    if (options.topic) body.topic = options.topic;
    if (options.invite?.length) body.invite = options.invite;
    if (options.isDirect) body.is_direct = true;
    if (options.alias) body.room_alias_name = options.alias;
    if (initialState.length > 0) body.initial_state = initialState;
    if (options.powerLevelOverride) body.power_level_content_override = options.powerLevelOverride;

    const resp = await this.http.request<{ room_id: string }>(
      "POST",
      "/_matrix/client/v3/createRoom",
      null,
      body,
    );
    if (options.isDirect && options.invite?.length) {
      await this.markDirect(resp.room_id, options.invite).catch((err) => {
        this.logger.warn("failed to record m.direct for new DM", err);
      });
    }
    return resp.room_id;
  }

  /** Find an existing DM with `userId` or create one. */
  async getOrCreateDirectRoom(userId: string, options?: { encrypted?: boolean }): Promise<string> {
    for (const roomId of this.rooms.directRoomIds()) {
      const members = this.rooms.joinedMembers(roomId);
      if (members.includes(userId)) return roomId;
    }
    const direct = await this.getDirectRoomMap().catch(() => ({}) as Record<string, string[]>);
    for (const [peer, roomIds] of Object.entries(direct)) {
      if (peer === userId && roomIds.length > 0 && roomIds[0]) return roomIds[0];
    }
    return this.createRoom({
      invite: [userId],
      isDirect: true,
      encrypted: options?.encrypted ?? true,
    });
  }

  async resolveRoomAlias(alias: string): Promise<{ room_id: string; servers?: string[] }> {
    return this.http.request(
      "GET",
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    );
  }

  async setTyping(roomId: string, typing: boolean, timeoutMs = 30_000): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`,
      null,
      typing ? { typing: true, timeout: timeoutMs } : { typing: false },
      { idempotent: true, maxRetries: 0 },
    );
  }

  /** Send a read receipt (and optionally advance the read marker). */
  async sendReadReceipt(
    roomId: string,
    eventId: string,
    options?: { private?: boolean; threadId?: string },
  ): Promise<void> {
    const receiptType = options?.private ? "m.read.private" : "m.read";
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/${encodeURIComponent(receiptType)}/${encodeURIComponent(eventId)}`,
      null,
      options?.threadId ? { thread_id: options.threadId } : {},
      { idempotent: true, maxRetries: 1 },
    );
  }

  async setReadMarker(
    roomId: string,
    eventId: string,
    options?: { read?: string; privateRead?: string },
  ): Promise<void> {
    await this.http.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      null,
      {
        "m.fully_read": eventId,
        ...(options?.read ? { "m.read": options.read } : { "m.read": eventId }),
        ...(options?.privateRead ? { "m.read.private": options.privateRead } : {}),
      },
      { idempotent: true, maxRetries: 1 },
    );
  }

  // -------------------------------------------------------------- encryption

  /**
   * Whether the room is end-to-end encrypted.
   *
   * A missing `m.room.encryption` state event (404) means "not encrypted"; any
   * other failure leaves the answer unknown and throws
   * {@link EncryptionStateUnknownError} rather than risking a plaintext send
   * into an encrypted room.
   */
  async isRoomEncrypted(roomId: string): Promise<boolean> {
    const cached = this.rooms.isEncrypted(roomId);
    if (cached !== undefined) return cached;
    try {
      const event = await this.getRoomStateEvent(roomId, "m.room.encryption", "");
      const algorithm = readString(event, "algorithm") ?? null;
      this.rooms.setEncrypted(roomId, algorithm);
      return algorithm !== null;
    } catch (err) {
      if (err instanceof MatrixApiError && err.isNotFound) {
        this.rooms.setEncrypted(roomId, null);
        return false;
      }
      throw new EncryptionStateUnknownError(roomId, { cause: err });
    }
  }

  getHistoryVisibility(roomId: string): HistoryVisibilityName {
    return this.rooms.historyVisibility(roomId);
  }

  getPowerLevels(roomId: string): PowerLevels {
    return this.rooms.powerLevels(roomId);
  }

  /** Raw `m.direct` account data (`{ userId: roomId[] }`). */
  async getDirectRoomMap(): Promise<Record<string, string[]>> {
    const data = await this.getAccountData("m.direct").catch(() => null);
    if (!isPlainObject(data)) return {};
    const out: Record<string, string[]> = {};
    for (const [user, rooms] of Object.entries(data)) {
      if (Array.isArray(rooms)) {
        out[user] = rooms.filter((r): r is string => typeof r === "string");
      }
    }
    return out;
  }

  /** Cached set of `m.direct` room ids. */
  async getDirectRoomIds(forceRefresh = false): Promise<Set<string>> {
    if (this.rooms.directLoadedOnce && !forceRefresh) return this.rooms.directRoomIds();
    const map = await this.getDirectRoomMap().catch(() => ({}) as Record<string, string[]>);
    this.rooms.applyDirectAccountData(map);
    return this.rooms.directRoomIds();
  }

  /** Record a room as a DM with the given peers in `m.direct`. */
  async markDirect(roomId: string, peerUserIds: string[]): Promise<void> {
    const map = await this.getDirectRoomMap();
    for (const peer of peerUserIds) {
      const list = new Set(map[peer] ?? []);
      list.add(roomId);
      map[peer] = [...list];
    }
    await this.setAccountData("m.direct", map);
    this.rooms.applyDirectAccountData(map);
  }

  // ------------------------------------------------------------ account data

  async getAccountData(type: string): Promise<unknown> {
    return this.http.request(
      "GET",
      `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent(type)}`,
    );
  }

  async setAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/account_data/${encodeURIComponent(type)}`,
      null,
      content,
      { idempotent: true },
    );
  }

  async getRoomAccountData(roomId: string, type: string): Promise<unknown> {
    return this.http.request(
      "GET",
      `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(type)}`,
    );
  }

  async setRoomAccountData(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/user/${encodeURIComponent(this.userId)}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(type)}`,
      null,
      content,
      { idempotent: true },
    );
  }

  // ------------------------------------------------------------------ escape

  /** Escape hatch for endpoints the SDK does not wrap yet. */
  doRequest(
    method: string,
    requestPath: string,
    query?: Record<string, string | number | boolean | undefined | null> | null,
    body?: unknown,
  ): Promise<unknown> {
    return this.http.request(method, requestPath, query, body);
  }

  // -------------------------------------------------------------- read paths

  /** Fetch a single room event by id. */
  async getEvent(roomId: string, eventId: string): Promise<Record<string, unknown>> {
    const event = await this.http.request<Record<string, unknown>>(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    );
    if (event?.type === "m.room.encrypted" && this.crypto?.isReady) {
      try {
        return await this.crypto.decryptRoomEvent(roomId, event);
      } catch {
        return event;
      }
    }
    return event;
  }

  /** Paginate a room's timeline (`/messages`). */
  async getMessages(
    roomId: string,
    options: {
      from?: string;
      to?: string;
      dir?: "b" | "f";
      limit?: number;
      /** Decrypt `m.room.encrypted` events when crypto is available. Default true. */
      decrypt?: boolean;
    } = {},
  ): Promise<{ chunk: MatrixEvent[]; start?: string; end?: string }> {
    const resp = await this.http.request<{
      chunk?: MatrixEvent[];
      start?: string;
      end?: string;
    }>("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`, {
      dir: options.dir ?? "b",
      limit: options.limit ?? 50,
      from: options.from,
      to: options.to,
    });
    const chunk = Array.isArray(resp.chunk) ? resp.chunk : [];
    const decrypt = options.decrypt !== false && this.crypto?.isReady === true;
    const out: MatrixEvent[] = [];
    for (const event of chunk) {
      if (decrypt && event.type === "m.room.encrypted") {
        out.push(
          (await this.crypto!.decryptRoomEvent(roomId, event as Record<string, unknown>).catch(
            () => event,
          )) as MatrixEvent,
        );
      } else {
        out.push(event);
      }
    }
    const result: { chunk: MatrixEvent[]; start?: string; end?: string } = { chunk: out };
    if (resp.start) result.start = resp.start;
    if (resp.end) result.end = resp.end;
    return result;
  }

  /** Fetch events related to `eventId` (thread replies, edits, reactions). */
  async getRelations(
    roomId: string,
    eventId: string,
    options: { relType?: string; eventType?: string; limit?: number; from?: string } = {},
  ): Promise<{ chunk: MatrixEvent[]; next_batch?: string }> {
    const segments = [
      `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}`,
    ];
    if (options.relType) segments.push(encodeURIComponent(options.relType));
    if (options.relType && options.eventType) segments.push(encodeURIComponent(options.eventType));
    const resp = await this.http.request<{ chunk?: MatrixEvent[]; next_batch?: string }>(
      "GET",
      segments.join("/"),
      { limit: options.limit ?? 50, from: options.from },
    );
    const result: { chunk: MatrixEvent[]; next_batch?: string } = {
      chunk: Array.isArray(resp.chunk) ? resp.chunk : [],
    };
    if (resp.next_batch) result.next_batch = resp.next_batch;
    return result;
  }

  // -------------------------------------------------------------- send paths

  async sendText(roomId: string, text: string): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", { msgtype: "m.text", body: text });
  }

  async sendNotice(roomId: string, text: string): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", { msgtype: "m.notice", body: text });
  }

  /**
   * Send `m.room.message` with a pre-built content object (must include `msgtype`).
   */
  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", content);
  }

  /**
   * Send HTML-formatted text. The plaintext fallback is derived from the markup.
   *
   * XSS trust boundary: this library does not execute HTML, but Matrix clients
   * render `formatted_body`. Sanitize untrusted input with `sanitizeMatrixHtml`.
   */
  async sendHtmlText(
    roomId: string,
    html: string,
    options?: { notice?: boolean; plainBody?: string },
  ): Promise<string> {
    return this.sendEvent(roomId, "m.room.message", {
      msgtype: options?.notice ? "m.notice" : "m.text",
      format: "org.matrix.custom.html",
      formatted_body: html,
      body: options?.plainBody ?? htmlToPlainBody(html),
    });
  }

  /**
   * Send a reaction. Reactions stay unencrypted by default because the relation
   * must be visible for clients to aggregate them (this matches Element and
   * other mainstream clients); set `encryptReactions` to change that.
   */
  async sendReaction(roomId: string, eventId: string, key: string): Promise<string> {
    return this.sendEvent(
      roomId,
      "m.reaction",
      {
        "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
      },
      { forcePlaintext: !this.encryptReactions },
    );
  }

  /** Redact an event. */
  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<string> {
    const txnId = this.http.txnId();
    const resp = await this.http.request<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
      null,
      reason ? { reason } : {},
      { idempotent: true },
    );
    return resp.event_id;
  }

  /** Replace a previously sent message (`m.replace`). */
  async editMessage(
    roomId: string,
    eventId: string,
    content: { body: string; formattedBody?: string; notice?: boolean },
  ): Promise<string> {
    const msgtype = content.notice ? "m.notice" : "m.text";
    const newContent: Record<string, unknown> = { msgtype, body: content.body };
    if (content.formattedBody) {
      newContent.format = "org.matrix.custom.html";
      newContent.formatted_body = content.formattedBody;
    }
    return this.sendEvent(roomId, "m.room.message", {
      msgtype,
      body: `* ${content.body}`,
      ...(content.formattedBody
        ? { format: "org.matrix.custom.html", formatted_body: `* ${content.formattedBody}` }
        : {}),
      "m.new_content": newContent,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
  }

  /** Send a custom to-device event (Olm-encrypted when crypto is enabled). */
  async sendToDevice(
    eventType: string,
    messages: Record<string, Record<string, Record<string, unknown>>>,
  ): Promise<void> {
    await this.http.request(
      "PUT",
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(this.http.txnId())}`,
      null,
      { messages },
      { idempotent: true },
    );
  }

  /**
   * Send an event. In encrypted rooms the payload is Megolm-encrypted and never
   * falls back to plaintext.
   */
  async sendEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    options?: SendEventOptions,
  ): Promise<string> {
    const encrypted = options?.forcePlaintext ? false : await this.isRoomEncrypted(roomId);
    if (!encrypted) {
      return this.putRoomEvent(roomId, type, content, options?.txnId);
    }
    if (!this.crypto?.isReady) {
      throw new EncryptedRoomWithoutCryptoError(roomId);
    }
    const members = await this.getJoinedRoomMembers(roomId);
    // Never share Megolm with the bot's own user: ghost devices only generate
    // `m.no_olm` withheld noise.
    const recipients = filterShareRecipients(this.userId, members);
    const encContent = await this.crypto.encryptMessage(roomId, type, content, recipients);
    // Relations must stay readable by the server/clients for aggregation.
    if (content["m.relates_to"] !== undefined) {
      encContent["m.relates_to"] = content["m.relates_to"];
    }
    return this.putRoomEvent(roomId, "m.room.encrypted", encContent, options?.txnId);
  }

  private async putRoomEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    txnId?: string,
  ): Promise<string> {
    // Reusing one transaction id across retries is what makes a timed-out send
    // safe: the homeserver deduplicates instead of double-posting.
    const transactionId = txnId ?? this.http.txnId();
    const resp = await this.http.request<{ event_id: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(transactionId)}`,
      null,
      content,
      { idempotent: true },
    );
    return resp.event_id;
  }

  // ------------------------------------------------------------------- media

  /** Upload bytes, encrypting them first when the target room is encrypted. */
  async uploadContent(
    data: Uint8Array,
    options: { filename?: string; contentType?: string; encryptForRoom?: string } = {},
  ): Promise<{ upload: UploadResult; file: Record<string, unknown> | null }> {
    const encryptFor = options.encryptForRoom;
    if (encryptFor && (await this.isRoomEncrypted(encryptFor))) {
      if (!this.crypto?.isReady) throw new EncryptedRoomWithoutCryptoError(encryptFor);
      const { ciphertext, info } = this.crypto.encryptAttachment(data);
      const upload = await uploadMedia(this.http, ciphertext, {
        ...(options.filename ? { filename: options.filename } : {}),
        contentType: "application/octet-stream",
      });
      return { upload, file: buildEncryptedFileBlock(info, upload.contentUri) };
    }
    const uploadOptions: { filename?: string; contentType?: string } = {};
    if (options.filename) uploadOptions.filename = options.filename;
    if (options.contentType) uploadOptions.contentType = options.contentType;
    const upload = await uploadMedia(this.http, data, uploadOptions);
    return { upload, file: null };
  }

  /** Download media, transparently decrypting an `EncryptedFile` block. */
  async downloadContent(
    source: { url?: string | null; file?: Record<string, unknown> | null },
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    if (source.file) {
      const split = splitEncryptedFileBlock(source.file);
      if (!split) throw new ConfigurationError("Encrypted file block has no url");
      if (!this.crypto) {
        throw new ConfigurationError(
          "Cannot decrypt attachment: crypto is disabled on this client",
        );
      }
      const ciphertext = await downloadMedia(this.http, split.url, options ?? {});
      return this.crypto.decryptAttachment(ciphertext, split.encryptionInfo);
    }
    if (!source.url) throw new ConfigurationError("No url or file block to download");
    return downloadMedia(this.http, source.url, options ?? {});
  }

  async downloadThumbnail(
    mxcUri: string,
    params: { width: number; height: number; method?: "crop" | "scale" },
  ): Promise<Uint8Array> {
    return downloadThumbnail(this.http, mxcUri, params);
  }

  /**
   * Upload and post a file. Encrypted rooms get an encrypted attachment.
   */
  async sendFile(
    roomId: string,
    data: Uint8Array,
    options: {
      filename: string;
      contentType?: string;
      msgtype?: "m.file" | "m.image" | "m.audio" | "m.video";
      caption?: string;
      width?: number;
      height?: number;
      durationMs?: number;
      extra?: Record<string, unknown>;
    },
  ): Promise<string> {
    const contentType = options.contentType ?? guessMimeType(options.filename);
    const { upload, file } = await this.uploadContent(data, {
      filename: options.filename,
      contentType,
      encryptForRoom: roomId,
    });
    const info: MediaInfo = buildMediaInfo({
      mimetype: contentType,
      sizeBytes: data.byteLength,
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    });
    const content: Record<string, unknown> = {
      msgtype: options.msgtype ?? msgtypeForMime(contentType),
      body: options.caption ?? options.filename,
      filename: options.filename,
      info,
      ...(options.extra ?? {}),
    };
    if (file) content.file = file;
    else content.url = upload.contentUri;
    return this.sendEvent(roomId, "m.room.message", content);
  }

  /** Read a file from disk and post it. */
  async sendFileFromPath(
    roomId: string,
    filePath: string,
    options?: { caption?: string; msgtype?: "m.file" | "m.image" | "m.audio" | "m.video" },
  ): Promise<string> {
    const data = await fs.promises.readFile(filePath);
    return this.sendFile(roomId, new Uint8Array(data), {
      filename: path.basename(filePath),
      ...(options?.caption !== undefined ? { caption: options.caption } : {}),
      ...(options?.msgtype !== undefined ? { msgtype: options.msgtype } : {}),
    });
  }

  /** Post a `m.sticker` event. */
  async sendSticker(
    roomId: string,
    options: { body: string; mxcUri: string; width: number; height: number; mimetype?: string },
  ): Promise<string> {
    return this.sendEvent(roomId, "m.sticker", {
      body: options.body,
      url: options.mxcUri,
      info: {
        w: options.width,
        h: options.height,
        mimetype: options.mimetype ?? "image/png",
      },
    });
  }

  /** Post a geo URI location. */
  async sendLocation(
    roomId: string,
    options: { latitude: number; longitude: number; description?: string },
  ): Promise<string> {
    const geoUri = `geo:${options.latitude},${options.longitude}`;
    return this.sendEvent(roomId, "m.room.message", {
      msgtype: "m.location",
      body: options.description ?? geoUri,
      geo_uri: geoUri,
      "org.matrix.msc3488.location": { uri: geoUri, description: options.description },
    });
  }

  /** Render a matrix.to permalink to a user, with an HTML pill. */
  mentionPill(userId: string, displayName?: string): string {
    const label = escapeHtml(displayName ?? userId);
    return `<a href="https://matrix.to/#/${encodeURIComponent(userId)}">${label}</a>`;
  }

  // ------------------------------------------------------------------ syncing

  /**
   * Start syncing.
   *
   * Accepts either the legacy message-only callback or a {@link ClientHandlers}
   * object with per-category listeners.
   */
  async start(
    handlersOrOnMessage: ClientHandlers | MessageHandler,
    legacyOnFatal?: FatalHandler,
  ): Promise<void> {
    if (this.syncLoop) {
      throw new ConfigurationError("MatrixClient already started");
    }
    this.stopping = false;

    if (typeof handlersOrOnMessage === "function") {
      const onMessage = handlersOrOnMessage;
      const handlers: ClientHandlers = {
        onRoomEvent: (roomId, event) => {
          if (event.type !== "m.room.message") return;
          if (!isPlainObject(event.content) || !event.content.msgtype) return;
          if (event.sender === this.userId) return;
          onMessage(roomId, event as MatrixMessageEvent);
        },
      };
      if (legacyOnFatal) handlers.onFatal = legacyOnFatal;
      this.handlers = handlers;
    } else {
      this.handlers = handlersOrOnMessage;
    }

    const syncOptions = {
      http: this.http,
      storagePath: this.storagePath,
      userId: this.userId,
      onSync: (resp: SyncResponse, meta: { isBootstrap: boolean }) =>
        this.handleSync(resp, meta),
      onFatal: (err: unknown) => this.handlers.onFatal?.(err),
      logger: this.options.logger,
      filter: {
        timelineLimit: this.options.timelineLimit ?? 50,
        includeEphemeral: this.options.receiveEphemeral === true,
      },
      presence: this.options.presence ?? "offline",
      ...(this.options.syncTimeoutMs ? { timeoutMs: this.options.syncTimeoutMs } : {}),
    };
    this.syncLoop = new SyncLoop(syncOptions);
    this.syncLoop.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.queue.close();
    const loop = this.syncLoop;
    this.syncLoop = null;
    if (loop) {
      loop.stop();
      await loop.waitUntilStopped();
    }
    await this.queue.drain(5_000);
    this.handlers = {};
    this.coldStartNotBeforeMs = null;
  }

  /** Epoch ms of the last successful sync (0 before the first one). */
  get lastSyncAt(): number {
    return this.syncLoop?.getLastSyncAt() ?? 0;
  }

  get isSyncing(): boolean {
    return this.syncLoop?.isRunning === true;
  }

  private async handleSync(
    response: SyncResponse,
    meta: { isBootstrap: boolean },
  ): Promise<void> {
    if (meta.isBootstrap && this.coldStartNotBeforeMs == null) {
      this.coldStartNotBeforeMs = Date.now();
    }

    if (this.crypto) {
      await this.crypto.receiveSync(
        JSON.stringify(response.to_device?.events ?? []),
        response.device_lists?.changed ?? [],
        response.device_lists?.left ?? [],
        response.device_one_time_keys_count ?? {},
        response.device_unused_fallback_key_types ?? [],
      );
    } else {
      for (const event of response.to_device?.events ?? []) {
        this.handlers.onToDevice?.(event as MatrixEvent);
      }
    }

    for (const event of response.account_data?.events ?? []) {
      if (event.type === "m.direct") {
        this.rooms.applyDirectAccountData(event.content);
      }
      this.handlers.onAccountData?.(event as MatrixEvent);
    }

    for (const [roomId, room] of Object.entries(response.rooms?.leave ?? {})) {
      void room;
      this.rooms.forget(roomId);
      this.knownRooms.delete(roomId);
      this.handlers.onLeave?.(roomId);
    }

    const invites = Object.entries(response.rooms?.invite ?? {});
    for (const [roomId, invite] of invites) {
      const events = (invite.invite_state?.events ?? []) as MatrixEvent[];
      for (const event of events) this.rooms.applyStateEvent(roomId, event);
      // COLD_START_DISPATCH.invite = after_bootstrap — do not dispatch invites
      // during the first sync, but still allow autojoin.
      if (!meta.isBootstrap) {
        this.handlers.onInvite?.(roomId, events);
      }
      if (this.autojoin && this.shouldAutojoin(roomId, events)) {
        try {
          await this.joinRoom(roomId);
          this.logger.info(`autojoined ${roomId}`);
        } catch (err) {
          this.logger.warn(`autojoin failed for ${roomId}`, err);
        }
      }
    }

    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      await this.handleJoinedRoom(roomId, room, meta.isBootstrap);
    }
  }

  private shouldAutojoin(roomId: string, inviteState: MatrixEvent[]): boolean {
    if (!this.autojoinFrom) return true;
    const inviter = inviteState.find(
      (event) => event.type === "m.room.member" && event.state_key === this.userId,
    )?.sender;
    if (!inviter) {
      this.logger.warn(`refusing autojoin for ${roomId}: cannot determine the inviter`);
      return false;
    }
    const server = inviter.split(":")[1] ?? "";
    const allowed = this.autojoinFrom.some(
      (entry) => entry === inviter || entry === server || entry === `:${server}`,
    );
    if (!allowed) {
      this.logger.info(`ignoring invite to ${roomId} from ${inviter} (not in autojoinFrom)`);
    }
    return allowed;
  }

  private async handleJoinedRoom(
    roomId: string,
    room: JoinedRoomSync,
    isBootstrap: boolean,
  ): Promise<void> {
    const isNewRoom = !this.knownRooms.has(roomId);
    this.knownRooms.add(roomId);
    this.rooms.applySummary(roomId, room.summary);

    const gapped = room.timeline?.limited === true;
    if (gapped && !isNewRoom) {
      // A gap means the `state` block is only a delta; re-read the parts that
      // matter for encryption decisions.
      this.rooms.invalidateMembers(roomId);
      await this.refreshRoomCryptoState(roomId);
    }

    const membershipEvents: MatrixEvent[] = [];
    const trackUsers: string[] = [];
    let encryptionAppeared = false;

    const applyEvent = (event: Record<string, unknown>, fromState: boolean): void => {
      if (typeof event.state_key === "string") {
        this.rooms.applyStateEvent(roomId, event);
      }
      if (event.type === "m.room.encryption") encryptionAppeared = true;
      if (event.type === "m.room.member" && typeof event.state_key === "string") {
        const membership = readString(event.content, "membership");
        if (membership === "join" || membership === "invite") trackUsers.push(event.state_key);
        if (!fromState) membershipEvents.push(event as MatrixEvent);
      }
    };

    for (const event of room.state?.events ?? []) applyEvent(event, true);
    if (isNewRoom || isBootstrap) this.rooms.markStateSynced(roomId);

    const timeline = room.timeline?.events ?? [];
    for (const event of timeline) applyEvent(event, false);

    // Aware-host capability state must be visible even when it only appears in
    // the state block (not the timeline). Honour COLD_START_DISPATCH.
    for (const event of room.state?.events ?? []) {
      if (event.type === HOST_CAPABILITIES_STATE_EVENT_TYPE) {
        if (!shouldDispatchOnColdStart("host_capabilities_state", isBootstrap)) continue;
        this.handlers.onRoomEvent?.(roomId, event as MatrixEvent, {
          historical: isBootstrap,
          bootstrap: isBootstrap,
          decrypted: false,
          lateDecrypt: false,
        });
      }
    }

    if (this.crypto) {
      if (encryptionAppeared || (isNewRoom && this.rooms.isEncrypted(roomId))) {
        await this.trackRoomMembers(roomId);
      }
      if (trackUsers.length > 0) {
        await this.crypto.updateTrackedUsers([...new Set(trackUsers)]);
      }
    }

    // Bootstrap: warm crypto/state only, never replay history into handlers.
    // Normative: COLD_START_DISPATCH (message/callback/… = after_bootstrap).
    if (isBootstrap) return;

    for (const event of timeline) {
      await this.emitTimelineEvent(roomId, event, gapped);
    }

    if (this.options.receiveEphemeral === true) {
      for (const event of room.ephemeral?.events ?? []) {
        this.handlers.onEphemeral?.(roomId, event as MatrixEvent);
      }
    }
  }

  private async refreshRoomCryptoState(roomId: string): Promise<void> {
    try {
      const encryption = await this.getRoomStateEvent(roomId, "m.room.encryption", "");
      this.rooms.setEncrypted(roomId, readString(encryption, "algorithm") ?? null);
    } catch (err) {
      if (err instanceof MatrixApiError && err.isNotFound) {
        this.rooms.setEncrypted(roomId, null);
      } else {
        this.logger.debug(`cannot refresh encryption state for ${roomId}`, err);
      }
    }
    try {
      const visibility = await this.getRoomStateEvent(roomId, "m.room.history_visibility", "");
      this.rooms.applyStateEvent(roomId, {
        type: "m.room.history_visibility",
        content: isPlainObject(visibility) ? visibility : {},
      });
    } catch {
      // Keep the default (`shared`).
    }
  }

  private async emitTimelineEvent(
    roomId: string,
    raw: Record<string, unknown>,
    historical: boolean,
  ): Promise<void> {
    if (this.stopping || !this.handlers.onRoomEvent) return;

    const eventId = typeof raw.event_id === "string" ? raw.event_id : "";
    if (eventId && this.deduper.seen(roomId, eventId)) return;

    const ts = typeof raw.origin_server_ts === "number" ? raw.origin_server_ts : null;
    if (
      this.coldStartNotBeforeMs != null &&
      ts != null &&
      ts < this.coldStartNotBeforeMs
    ) {
      this.logger.debug(
        `skipping pre-cold-start event ${eventId || "(no id)"} in ${roomId}`,
      );
      return;
    }

    try {
      await this.queue.run(roomId, async () => {
        if (this.stopping || !this.handlers.onRoomEvent) return;
        let event: Record<string, unknown> = raw;
        let decrypted = false;
        if (raw.type === "m.room.encrypted") {
          if (!this.crypto?.isReady) {
            this.logger.warn(`skipping encrypted event in ${roomId}: crypto is not ready`);
            return;
          }
          try {
            event = await this.crypto.decryptRoomEvent(roomId, raw);
            decrypted = true;
          } catch (err) {
            this.logger.warn(
              `decrypt failed in ${roomId}; queued for retry when the key arrives`,
              err,
            );
            return;
          }
        }
        this.handlers.onRoomEvent?.(roomId, event as MatrixEvent, {
          historical,
          decrypted,
          lateDecrypt: false,
        });
      });
    } catch (err) {
      if (this.stopping && err instanceof ConfigurationError) return;
      throw err;
    }
  }

  /** Track all joined members of a room for E2EE device discovery. */
  async trackRoomMembers(roomId: string): Promise<void> {
    if (!this.crypto) return;
    try {
      const members = await this.getJoinedRoomMembers(roomId, true);
      await this.crypto.updateTrackedUsers(members);
    } catch (err) {
      this.logger.warn(`cannot track members of ${roomId}`, err);
    }
  }
}

function resolveLogger(option: BotCreateOptions["logger"]): Logger {
  if (!option) return createDefaultLogger();
  if (typeof option === "string") return createDefaultLogger(option as LogLevel);
  return option;
}

/**
 * Load the E2EE engine on first use.
 *
 * `@matrix-org/matrix-sdk-crypto-nodejs` is a native module with prebuilt
 * binaries for a limited set of platforms, so it is an optional dependency:
 * unencrypted bots stay installable everywhere, and encrypted bots get an
 * actionable error instead of a module-resolution stack trace.
 */
export async function loadCryptoEngine(): Promise<typeof import("./crypto.js").CryptoEngine> {
  try {
    const mod = await import("./crypto.js");
    return mod.CryptoEngine;
  } catch (err) {
    throw new ConfigurationError(
      "End-to-end encryption needs the optional `@matrix-org/matrix-sdk-crypto-nodejs` package, " +
        "which has no prebuilt binary for this platform or failed to load. " +
        "Install it, or create the bot with `crypto: false` to run unencrypted.",
      { cause: err },
    );
  }
}

/**
 * Build a {@link MatrixClient}, resolving the homeserver, session and crypto
 * store under `storagePath`.
 */
export async function createMatrixClient(options: BotCreateOptions): Promise<CreatedClient> {
  const logger = resolveLogger(options.logger);
  const storagePath = resolveStoragePath(options.storagePath ?? "./data");
  fs.mkdirSync(storagePath, { recursive: true });

  const cryptoEnabled = options.crypto !== false;
  const persistedSession = loadSession(storagePath);
  const autoRelogin =
    options.autoReloginOnAuthFailure ?? Boolean(options.password);

  const discovery = await discoverHomeserver(options.homeserverUrl, {
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.allowInsecureHomeserver ? { allowInsecure: true } : {}),
  });
  let homeserverUrl = discovery.homeserverUrl;

  let accessToken = options.accessToken ?? "";
  let sessionDeviceId: string | null = null;
  let sessionUserId: string | null = null;

  const loginUser =
    options.userId ??
    (options.homeserverUrl.startsWith("@") ? options.homeserverUrl : undefined);

  async function passwordLogin(deviceId?: string | null): Promise<void> {
    if (!options.password) {
      throw new ConfigurationError("password login requires `password`");
    }
    if (!loginUser) {
      throw new ConfigurationError(
        "password login requires `userId` (or pass the bot's user id as homeserverUrl)",
      );
    }
    const preferredDevice =
      deviceId ?? options.deviceId ?? loadPersistedDeviceId(storagePath) ?? undefined;
    const session = await loginWithPassword({
      homeserverUrl,
      user: loginUser,
      password: options.password,
      logger,
      ...(preferredDevice ? { deviceId: preferredDevice } : {}),
      ...(options.deviceDisplayName
        ? { initialDeviceDisplayName: options.deviceDisplayName }
        : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.allowInsecureHomeserver ? { allowInsecure: true } : {}),
    });
    saveSession(storagePath, session);
    accessToken = session.accessToken;
    sessionDeviceId = session.deviceId;
    sessionUserId = session.userId;
    homeserverUrl = session.homeserverUrl;
  }

  if (!accessToken && options.password) {
    if (!loginUser) {
      throw new ConfigurationError(
        "password login requires `userId` (or pass the bot's user id as homeserverUrl)",
      );
    }
    const reusable =
      persistedSession && persistedSession.userId === loginUser ? persistedSession : null;
    if (reusable) {
      accessToken = reusable.accessToken;
      sessionDeviceId = reusable.deviceId;
      sessionUserId = reusable.userId;
      homeserverUrl = reusable.homeserverUrl;
      logger.debug("reusing persisted session");
    } else {
      await passwordLogin(options.deviceId ?? loadPersistedDeviceId(storagePath));
    }
  }

  if (!accessToken) {
    throw new ConfigurationError(
      "Provide either `accessToken` or `password` (+ `userId`) to create a client",
    );
  }

  let http!: MatrixHttp;
  const httpOptions: ConstructorParameters<typeof MatrixHttp>[1] = {
    accessToken,
    logger,
    onTokenExpired: createSessionRefreshHandler({
      storagePath,
      homeserverUrl: () => homeserverUrl,
      onHomeserverUrl: (url) => {
        homeserverUrl = url;
        http.setBaseUrl(url);
      },
      logger,
      autoRelogin,
      ...(loginUser ? { userId: loginUser } : {}),
      ...(options.password ? { password: options.password } : {}),
      ...(options.deviceDisplayName
        ? { deviceDisplayName: options.deviceDisplayName }
        : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.allowInsecureHomeserver ? { allowInsecure: true } : {}),
    }),
    ...(options.allowInsecureHomeserver ? { allowInsecure: true } : {}),
    ...(options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : {}),
    ...(options.retry?.maxRetries !== undefined ? { maxRetries: options.retry.maxRetries } : {}),
    ...(options.retry?.retryBaseMs !== undefined
      ? { retryBaseMs: options.retry.retryBaseMs }
      : {}),
    ...(options.retry?.maxRetryDelayMs !== undefined
      ? { maxRetryDelayMs: options.retry.maxRetryDelayMs }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onRequest ? { onRequest: options.onRequest } : {}),
  };
  http = new MatrixHttp(homeserverUrl, httpOptions);

  let whoami: { user_id: string; device_id?: string };
  try {
    whoami = await http.request<{ user_id: string; device_id?: string }>(
      "GET",
      "/_matrix/client/v3/account/whoami",
    );
  } catch (err) {
    const authFailed =
      err instanceof AuthenticationError ||
      (err instanceof MatrixApiError && (err.status === 401 || err.errcode === "M_UNKNOWN_TOKEN"));
    if (authFailed && autoRelogin && options.password) {
      logger.warn("persisted session rejected by homeserver; password re-login");
      clearSession(storagePath);
      await passwordLogin(sessionDeviceId ?? loadPersistedDeviceId(storagePath));
      http.setAccessToken(accessToken);
      http.setBaseUrl(homeserverUrl);
      whoami = await http.request<{ user_id: string; device_id?: string }>(
        "GET",
        "/_matrix/client/v3/account/whoami",
      );
    } else {
      throw err;
    }
  }

  const userId = whoami.user_id || sessionUserId || "";
  if (!userId) {
    throw new ConfigurationError("Homeserver whoami did not return a user_id");
  }

  const persistedDeviceId = loadPersistedDeviceId(storagePath);
  const deviceId =
    options.deviceId ?? whoami.device_id ?? sessionDeviceId ?? persistedDeviceId ?? null;

  if (options.deviceId && whoami.device_id && options.deviceId !== whoami.device_id) {
    throw new DeviceMismatchError(options.deviceId, whoami.device_id, {
      storagePath,
      keepDeviceId: whoami.device_id,
    });
  }

  let crypto: CryptoEngine | null = null;
  if (cryptoEnabled) {
    if (!deviceId) {
      throw new ConfigurationError(
        "deviceId is REQUIRED when crypto is enabled — set BotCreateOptions.deviceId, use password login, or keep storagePath/device.json",
      );
    }
    const cryptoPath = path.join(storagePath, "crypto");
    fs.mkdirSync(cryptoPath, { recursive: true });
    const storePassphrase = resolveCryptoStorePassphrase(
      storagePath,
      options.cryptoStorePassphrase,
      {
        ...(options.allowUnencryptedCryptoStore ? { allowUnencrypted: true } : {}),
        logger,
      },
    );
    const Engine = await loadCryptoEngine();
    crypto = await Engine.create({
      userId,
      deviceId,
      storePath: cryptoPath,
      http,
      storePassphrase,
      logger,
      ...(options.encryption ? { encryption: options.encryption } : {}),
      ...(options.onCryptoLog ? { onCryptoLog: options.onCryptoLog } : {}),
      ...(options.keyBackup ? { keyBackup: true } : {}),
      ...(options.keyBackupRecoveryKey
        ? { keyBackupRecoveryKey: options.keyBackupRecoveryKey }
        : {}),
    });
    savePersistedDeviceId(storagePath, deviceId);
  } else if (deviceId) {
    savePersistedDeviceId(storagePath, deviceId);
  }

  const clientOptions: MatrixClientOptions = {
    http,
    storagePath,
    userId,
    deviceId,
    crypto,
    autojoin: options.autojoin !== false,
    logger,
    ...(options.autojoinFrom ? { autojoinFrom: options.autojoinFrom } : {}),
    ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
    ...(options.syncTimeoutMs !== undefined ? { syncTimeoutMs: options.syncTimeoutMs } : {}),
    ...(options.presence ? { presence: options.presence } : {}),
    ...(options.receiveEphemeral !== undefined
      ? { receiveEphemeral: options.receiveEphemeral }
      : {}),
    ...(options.timelineLimit !== undefined ? { timelineLimit: options.timelineLimit } : {}),
  };
  const client = new MatrixClient(clientOptions);

  return {
    client,
    storagePath,
    cryptoEnabled,
    ...(options.deviceId ?? deviceId
      ? { configuredDeviceId: (options.deviceId ?? deviceId) as string }
      : {}),
  };
}

/** Resolve the active device id after crypto prepare (or from whoami). */
export async function resolveDeviceId(client: MatrixClient): Promise<string | null> {
  if (client.crypto?.clientDeviceId) return client.crypto.clientDeviceId;
  const fromClient = client.getDeviceId();
  if (fromClient) return fromClient;
  try {
    return (await client.getWhoAmI()).device_id ?? null;
  } catch {
    return null;
  }
}

/** Track room members and flush the OlmMachine outgoing queue. */
export async function prepareCrypto(client: MatrixClient): Promise<void> {
  if (!client.crypto) {
    throw new ConfigurationError("prepareCrypto called but crypto is not enabled");
  }
  const rooms = await client.getJoinedRooms();
  await client.crypto.prepare(rooms, (roomId) => client.getJoinedRoomMembers(roomId, true));
}
