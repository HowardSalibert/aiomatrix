import {
  Attachment,
  BackupDecryptionKey,
  DeviceId,
  DeviceLists,
  EncryptedAttachment,
  EncryptionAlgorithm,
  EncryptionSettings,
  HistoryVisibility,
  type KeysBackupRequest,
  type KeysClaimRequest,
  type KeysQueryRequest,
  type KeysUploadRequest,
  OlmMachine,
  RequestType,
  RoomId,
  type RoomMessageRequest,
  type SignatureUploadRequest,
  StoreType,
  ToDeviceRequest,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import {
  filterShareRecipients,
  normalizeToDeviceBody,
  parseToDeviceRecipients,
  resolveEncryptionSharePolicy,
} from "./crypto-policy.js";
import { RoomKeyWithheldError } from "./errors.js";
import type { MatrixHttp } from "./http.js";
import { createDefaultLogger, type Logger } from "./logger.js";
import type { HistoryVisibilityName } from "./room-cache.js";
import type { CryptoLogEvent, EncryptionSharePolicy } from "./types.js";
import { AsyncLock, LruCache, fingerprintSet, isPlainObject } from "./util.js";

export type { HistoryVisibilityName } from "./room-cache.js";
export {
  DEFAULT_ENCRYPTION_SHARE_POLICY,
  filterShareRecipients,
  normalizeToDeviceBody,
  parseToDeviceRecipients,
  resolveEncryptionSharePolicy,
} from "./crypto-policy.js";

/** Map a Matrix `history_visibility` string to the crypto enum (default Shared). */
export function mapHistoryVisibility(value: string | null | undefined): HistoryVisibility {
  switch (value) {
    case "invited":
      return HistoryVisibility.Invited;
    case "joined":
      return HistoryVisibility.Joined;
    case "world_readable":
      return HistoryVisibility.WorldReadable;
    default:
      return HistoryVisibility.Shared;
  }
}

type OutgoingRequest =
  | KeysUploadRequest
  | KeysQueryRequest
  | KeysClaimRequest
  | ToDeviceRequest
  | SignatureUploadRequest
  | RoomMessageRequest
  | KeysBackupRequest;

const WITHHELD_BODY_MAX = 500;

function truncateBodyPreview(body: string, max = WITHHELD_BODY_MAX): string {
  return body.length <= max ? body : `${body.slice(0, max)}…`;
}

export interface CryptoEngineCreateOptions {
  userId: string;
  deviceId: string;
  storePath: string;
  http: MatrixHttp;
  storePassphrase?: string | null;
  encryption?: EncryptionSharePolicy;
  onCryptoLog?: (event: CryptoLogEvent) => void;
  logger?: Logger;
  /** Enable server-side Megolm key backup so keys survive a store wipe. */
  keyBackup?: boolean;
  /** Existing backup recovery key (base64) to restore/attach to a backup version. */
  keyBackupRecoveryKey?: string;
}

/** A room event that could not be decrypted yet, queued for a retry. */
interface PendingDecrypt {
  roomId: string;
  event: Record<string, unknown>;
  sessionId: string | null;
  firstSeenAt: number;
  attempts: number;
}

interface ShareState {
  memberFingerprint: string;
  sharedAt: number;
  messages: number;
}

const MAX_PENDING_DECRYPT = 512;
const PENDING_DECRYPT_TTL_MS = 15 * 60 * 1000;
const MAX_DECRYPT_ATTEMPTS = 6;

/**
 * Wrapper around the Rust `OlmMachine` plus a Client-Server runner for its
 * outgoing requests. Does not depend on `matrix-bot-sdk`.
 */
export class CryptoEngine {
  readonly userId: string;
  readonly clientDeviceId: string;
  readonly sharePolicy: Required<EncryptionSharePolicy>;
  private readonly http: MatrixHttp;
  private readonly machine: OlmMachine;
  private readonly onCryptoLog: ((event: CryptoLogEvent) => void) | null;
  private readonly logger: Logger;
  private readonly lock = new AsyncLock();
  private _isReady = false;
  private _closed = false;
  private historyVisibilityForRoom:
    | ((roomId: string) => HistoryVisibilityName | null | undefined)
    | null = null;
  private readonly shareState = new LruCache<string, ShareState>(2_000);
  private readonly trackedUsers = new Set<string>();
  private readonly dirtyUsers = new Set<string>();
  private readonly pendingDecrypts = new Map<string, PendingDecrypt>();
  private onToDeviceEvents: ((events: Array<Record<string, unknown>>) => void) | null = null;
  private onDecryptRecovered:
    | ((roomId: string, event: Record<string, unknown>) => void)
    | null = null;
  private keyBackupVersion: string | null = null;

  private constructor(
    machine: OlmMachine,
    http: MatrixHttp,
    userId: string,
    deviceId: string,
    sharePolicy: Required<EncryptionSharePolicy>,
    onCryptoLog: ((event: CryptoLogEvent) => void) | null,
    logger: Logger,
  ) {
    this.machine = machine;
    this.http = http;
    this.userId = userId;
    this.clientDeviceId = deviceId;
    this.sharePolicy = sharePolicy;
    this.onCryptoLog = onCryptoLog;
    this.logger = logger;
  }

  get isReady(): boolean {
    return this._isReady && !this._closed;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  /** Curve25519/Ed25519 identity keys of this device (for diagnostics). */
  get identityKeys(): { curve25519: string; ed25519: string } {
    const keys = this.machine.identityKeys;
    return {
      curve25519: keys.curve25519.toBase64(),
      ed25519: keys.ed25519.toBase64(),
    };
  }

  static async create(options: CryptoEngineCreateOptions): Promise<CryptoEngine> {
    const logger = (options.logger ?? createDefaultLogger()).child("crypto");
    const passphrase = options.storePassphrase ?? null;
    if (!passphrase) {
      logger.warn(
        "crypto store passphrase is empty — the OlmMachine SQLite store is unencrypted on disk (set cryptoStorePassphrase)",
      );
    }
    const machine = await OlmMachine.initialize(
      new UserId(options.userId),
      new DeviceId(options.deviceId),
      options.storePath,
      passphrase,
      StoreType.Sqlite,
    );
    const engine = new CryptoEngine(
      machine,
      options.http,
      options.userId,
      options.deviceId,
      resolveEncryptionSharePolicy(options.encryption),
      options.onCryptoLog ?? null,
      logger,
    );
    if (options.keyBackup) {
      await engine.setupKeyBackup(options.keyBackupRecoveryKey).catch((err) => {
        logger.warn("key backup setup failed; continuing without backup", err);
      });
    }
    return engine;
  }

  /** Emit a structured crypto log event, mirroring important cases to the logger. */
  emitCryptoLog(event: CryptoLogEvent): void {
    switch (event.type) {
      case "withheld_detail":
        this.logger.warn(
          `withheld_detail room=${event.roomId} type=${event.eventType} body=${event.bodyPreview}`,
        );
        break;
      case "share_room_key":
        if (event.withheld > 0 || event.keyShares === 0) {
          this.logger.warn(
            `share_room_key room=${event.roomId} keyShares=${event.keyShares} withheld=${event.withheld} peers=${event.peers.length}`,
            { recipients: event.recipients, policy: event.policy },
          );
        } else {
          this.logger.debug(
            `share_room_key room=${event.roomId} keyShares=${event.keyShares} recipients=${event.recipients.length}`,
          );
        }
        break;
      case "peer_keys_missing":
        this.logger.error(
          `peer_keys_missing room=${event.roomId} peers=[${event.peers.join(", ")}]`,
        );
        break;
      case "decrypt_failed":
        this.logger.warn(
          `decrypt_failed room=${event.roomId} event=${event.eventId} queued=${event.queued}`,
          event.detail,
        );
        break;
      case "decrypt_recovered":
        this.logger.info(
          `decrypt_recovered room=${event.roomId} event=${event.eventId} after ${event.attempts} attempt(s)`,
        );
        break;
      case "encrypt_send":
        break;
      case "warn":
        this.logger.warn(event.message, event.detail);
        break;
      case "error":
        this.logger.error(event.message, event.detail);
        break;
      default:
        break;
    }
    try {
      this.onCryptoLog?.(event);
    } catch (err) {
      this.logger.warn("onCryptoLog hook threw", err);
    }
  }

  setHistoryVisibilityResolver(
    fn: (roomId: string) => HistoryVisibilityName | null | undefined,
  ): void {
    this.historyVisibilityForRoom = fn;
  }

  /** Receive decrypted to-device events (verification, custom payloads, withheld). */
  setToDeviceHandler(fn: (events: Array<Record<string, unknown>>) => void): void {
    this.onToDeviceEvents = fn;
  }

  /** Called when a previously undecryptable room event finally decrypts. */
  setDecryptRecoveredHandler(
    fn: (roomId: string, event: Record<string, unknown>) => void,
  ): void {
    this.onDecryptRecovered = fn;
  }

  /**
   * Flush outgoing requests until the queue drains, then mark the engine ready.
   */
  async prepare(
    roomIds: string[],
    getMembers: (roomId: string) => Promise<string[]>,
  ): Promise<void> {
    await this.lock.run(async () => {
      const tracked = new Set<string>();
      for (const roomId of roomIds) {
        try {
          for (const member of await getMembers(roomId)) tracked.add(member);
        } catch (err) {
          this.logger.warn(`prepare: cannot list members of ${roomId}`, err);
        }
      }
      tracked.add(this.userId);
      if (tracked.size > 0) {
        await this.machine.updateTrackedUsers([...tracked].map((u) => new UserId(u)));
        for (const user of tracked) this.trackedUsers.add(user);
      }
      for (let round = 0; round < 12; round++) {
        if ((await this.runOutgoingRequestsUnlocked()) === 0) break;
      }
      this._isReady = true;
    });
  }

  async runOutgoingRequests(): Promise<number> {
    return this.lock.run(() => this.runOutgoingRequestsUnlocked());
  }

  private async runOutgoingRequestsUnlocked(): Promise<number> {
    if (this._closed) return 0;
    const requests = (await this.machine.outgoingRequests()) as OutgoingRequest[];
    for (const request of requests) {
      await this.dispatchRequest(request);
    }
    return requests.length;
  }

  private async dispatchRequest(request: OutgoingRequest): Promise<void> {
    switch (request.type) {
      case RequestType.KeysUpload:
        await this.postAndMark(request, "/_matrix/client/v3/keys/upload", RequestType.KeysUpload);
        break;
      case RequestType.KeysQuery:
        await this.postAndMark(request, "/_matrix/client/v3/keys/query", RequestType.KeysQuery);
        break;
      case RequestType.KeysClaim:
        await this.sendKeysClaim(request as KeysClaimRequest);
        break;
      case RequestType.ToDevice:
        await this.sendToDeviceRequest(request as ToDeviceRequest);
        break;
      case RequestType.SignatureUpload:
        await this.postAndMark(
          request,
          "/_matrix/client/v3/keys/signatures/upload",
          RequestType.SignatureUpload,
        );
        break;
      case RequestType.RoomMessage: {
        const rm = request as RoomMessageRequest;
        const resp = await this.http.request(
          "PUT",
          `/_matrix/client/v3/rooms/${encodeURIComponent(rm.roomId)}/send/${encodeURIComponent(rm.eventType)}/${encodeURIComponent(rm.txnId)}`,
          null,
          JSON.parse(rm.body) as unknown,
          { idempotent: true },
        );
        await this.machine.markRequestAsSent(rm.id, RequestType.RoomMessage, JSON.stringify(resp));
        break;
      }
      case RequestType.KeysBackup:
        await this.sendKeysBackup(request as KeysBackupRequest);
        break;
      default: {
        const req = request as { id?: string; type?: unknown };
        this.logger.warn(
          `unsupported outgoing crypto request type ${String(req.type)} — marking sent to avoid a stalled queue`,
        );
        if (req.id != null && req.type != null) {
          try {
            await this.machine.markRequestAsSent(req.id, req.type as RequestType, "{}");
          } catch (err) {
            this.logger.warn("markRequestAsSent failed for unknown type", err);
          }
        }
      }
    }
  }

  private async postAndMark(
    request: OutgoingRequest,
    path: string,
    type: RequestType,
  ): Promise<void> {
    const body = JSON.parse((request as { body: string }).body) as unknown;
    const resp = await this.http.request("POST", path, null, body, { idempotent: true });
    await this.machine.markRequestAsSent(
      (request as { id: string }).id,
      type,
      JSON.stringify(resp),
    );
  }

  private async sendKeysClaim(request: KeysClaimRequest): Promise<void> {
    const resp = await this.http.request(
      "POST",
      "/_matrix/client/v3/keys/claim",
      null,
      JSON.parse(request.body) as unknown,
      { idempotent: true },
    );
    await this.machine.markRequestAsSent(
      request.id,
      RequestType.KeysClaim,
      JSON.stringify(resp),
    );
  }

  private async sendToDeviceRequest(request: ToDeviceRequest): Promise<void> {
    const body = normalizeToDeviceBody(JSON.parse(request.body) as unknown);
    const resp = await this.http.request(
      "PUT",
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(request.eventType)}/${encodeURIComponent(request.txnId)}`,
      null,
      body,
      { idempotent: true },
    );
    await this.machine.markRequestAsSent(
      request.id,
      RequestType.ToDevice,
      JSON.stringify(resp),
    );
  }

  private async sendKeysBackup(request: KeysBackupRequest): Promise<void> {
    if (!this.keyBackupVersion) {
      // No backup configured: acknowledge so the outgoing queue never stalls.
      await this.machine.markRequestAsSent(request.id, RequestType.KeysBackup, "{}");
      return;
    }
    try {
      const resp = await this.http.request(
        "PUT",
        "/_matrix/client/v3/room_keys/keys",
        { version: this.keyBackupVersion },
        JSON.parse(request.body) as unknown,
        { idempotent: true },
      );
      await this.machine.markRequestAsSent(
        request.id,
        RequestType.KeysBackup,
        JSON.stringify(resp),
      );
    } catch (err) {
      this.logger.warn("key backup upload failed", err);
      await this.machine.markRequestAsSent(request.id, RequestType.KeysBackup, "{}");
    }
  }

  /**
   * Create or attach to a server-side Megolm key backup so room keys survive a
   * local store wipe. Returns the recovery key (base64) — store it safely.
   */
  async setupKeyBackup(existingRecoveryKey?: string): Promise<{
    version: string;
    recoveryKey: string;
  } | null> {
    const existing = await this.http
      .request<{ version?: string; algorithm?: string; auth_data?: unknown }>(
        "GET",
        "/_matrix/client/v3/room_keys/version",
      )
      .catch(() => null);

    if (existing?.version && existingRecoveryKey) {
      const key = BackupDecryptionKey.fromBase64(existingRecoveryKey);
      await this.machine.saveBackupDecryptionKey(key, existing.version);
      await this.machine.enableBackupV1(key.megolmV1PublicKey.publicKeyBase64, existing.version);
      this.keyBackupVersion = existing.version;
      this.logger.info(`attached to existing key backup version ${existing.version}`);
      return { version: existing.version, recoveryKey: existingRecoveryKey };
    }

    if (existing?.version && !existingRecoveryKey) {
      const stored = await this.machine.getBackupKeys().catch(() => null);
      if (stored?.decryptionKeyBase64 && stored.backupVersion) {
        this.keyBackupVersion = stored.backupVersion;
        await this.machine.enableBackupV1(
          BackupDecryptionKey.fromBase64(stored.decryptionKeyBase64).megolmV1PublicKey
            .publicKeyBase64,
          stored.backupVersion,
        );
        this.logger.info(`resumed key backup version ${stored.backupVersion}`);
        return { version: stored.backupVersion, recoveryKey: stored.decryptionKeyBase64 };
      }
      this.logger.warn(
        `homeserver has key backup version ${existing.version} but no local recovery key — pass keyBackupRecoveryKey to reuse it`,
      );
      return null;
    }

    const decryptionKey = BackupDecryptionKey.createRandomKey();
    const publicKey = decryptionKey.megolmV1PublicKey;
    const created = await this.http.request<{ version: string }>(
      "POST",
      "/_matrix/client/v3/room_keys/version",
      null,
      {
        algorithm: publicKey.algorithm,
        auth_data: { public_key: publicKey.publicKeyBase64 },
      },
    );
    await this.machine.saveBackupDecryptionKey(decryptionKey, created.version);
    await this.machine.enableBackupV1(publicKey.publicKeyBase64, created.version);
    this.keyBackupVersion = created.version;
    const recoveryKey = decryptionKey.toBase64();
    this.logger.info(
      `created key backup version ${created.version} — store the recovery key from setupKeyBackup()`,
    );
    return { version: created.version, recoveryKey };
  }

  /**
   * Feed a `/sync` response into the machine. Returns the decrypted to-device
   * events so callers can route verification / custom payloads.
   */
  async receiveSync(
    toDeviceEventsJson: string,
    changed: string[],
    left: string[],
    oneTimeKeyCounts: Record<string, number>,
    unusedFallbackKeys: string[],
  ): Promise<Array<Record<string, unknown>>> {
    if (this._closed) return [];
    const decrypted = await this.lock.run(async () => {
      const deviceLists = new DeviceLists(
        changed.map((u) => new UserId(u)),
        left.map((u) => new UserId(u)),
      );
      const raw = await this.machine.receiveSyncChanges(
        toDeviceEventsJson,
        deviceLists,
        oneTimeKeyCounts,
        unusedFallbackKeys,
      );
      await this.runOutgoingRequestsUnlocked();
      return raw;
    });

    // A device-list change means a peer may have added/rotated a device; the
    // cached Megolm share for any room they are in is no longer complete.
    for (const user of changed) this.dirtyUsers.add(user);
    for (const user of left) {
      this.dirtyUsers.add(user);
      this.trackedUsers.delete(user);
    }
    if (changed.length > 0 || left.length > 0) this.invalidateSharesFor([...changed, ...left]);

    const events = parseToDeviceEvents(decrypted);
    if (events.length > 0) {
      try {
        this.onToDeviceEvents?.(events);
      } catch (err) {
        this.logger.warn("to-device handler threw", err);
      }
    }
    // New room keys may have arrived — retry anything that failed to decrypt.
    if (this.pendingDecrypts.size > 0) {
      await this.retryPendingDecrypts();
    }
    return events;
  }

  async updateTrackedUsers(userIds: string[]): Promise<void> {
    if (this._closed) return;
    const fresh = userIds.filter((u) => !this.trackedUsers.has(u));
    if (fresh.length === 0) return;
    await this.lock.run(async () => {
      await this.machine.updateTrackedUsers(fresh.map((u) => new UserId(u)));
      await this.runOutgoingRequestsUnlocked();
    });
    for (const user of fresh) this.trackedUsers.add(user);
  }

  /** Force the next send into `roomId` to re-share the Megolm session. */
  invalidateRoomShare(roomId: string): void {
    this.shareState.delete(roomId);
  }

  private invalidateSharesFor(users: string[]): void {
    if (users.length === 0) return;
    // Without a room→member index we cannot tell which rooms are affected, so
    // drop every cached share. Shares are cheap to re-establish; a stale share
    // means peers silently cannot decrypt.
    this.shareState.clear();
  }

  /**
   * Decide whether the cached Megolm share for this room is still good.
   */
  private shareIsFresh(roomId: string, peers: string[]): boolean {
    const policy = this.sharePolicy;
    if (policy.rotateEveryMessage) return false;
    const state = this.shareState.get(roomId);
    if (!state) return false;
    if (state.memberFingerprint !== fingerprintSet(peers)) return false;
    if (policy.reshareOnDeviceChange && peers.some((p) => this.dirtyUsers.has(p))) return false;
    if (state.messages >= policy.rotationPeriodMessages) return false;
    if (Date.now() - state.sharedAt >= policy.rotationPeriodMs) return false;
    return true;
  }

  /**
   * Claim missing Olm sessions and share the Megolm room key.
   *
   * Skips the expensive parts (device-list refresh, key claim, to-device fanout)
   * when the cached share is still valid for the current member set.
   */
  async ensureSessionsAndShare(roomId: string, userIds: string[]): Promise<void> {
    const peers = filterShareRecipients(this.userId, userIds);
    if (this.shareIsFresh(roomId, peers)) {
      const state = this.shareState.get(roomId);
      if (state) state.messages += 1;
      return;
    }

    await this.lock.run(async () => {
      const users = peers.map((u) => new UserId(u));
      const untracked = peers.filter((u) => !this.trackedUsers.has(u));
      if (untracked.length > 0) {
        await this.machine.updateTrackedUsers(untracked.map((u) => new UserId(u)));
        for (const user of untracked) this.trackedUsers.add(user);
        await this.runOutgoingRequestsUnlocked();
      }

      const policy = this.sharePolicy;

      // Refresh identity keys before share. When rotating every message, query
      // all peers (peer wipe / same device_id must not use a stale KeysQuery
      // cache). Otherwise only peers marked dirty by device-list sync.
      const stale = policy.rotateEveryMessage
        ? peers
        : peers.filter((u) => this.dirtyUsers.has(u));
      if (stale.length > 0) {
        await this.machine.receiveSyncChanges(
          "[]",
          new DeviceLists(
            stale.map((u) => new UserId(u)),
            [],
          ),
          {},
          [],
        );
        await this.runOutgoingRequestsUnlocked();
        for (const user of stale) this.dirtyUsers.delete(user);
      }

      const claim = await this.machine.getMissingSessions(users);
      if (claim) await this.sendKeysClaim(claim);
      const settings = new EncryptionSettings();
      settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
      settings.historyVisibility = mapHistoryVisibility(
        this.historyVisibilityForRoom?.(roomId),
      );
      settings.onlyAllowTrustedDevices = policy.onlyAllowTrustedDevices;
      settings.errorOnVerifiedUserProblem = policy.errorOnVerifiedUserProblem;
      settings.rotationPeriodMessages = BigInt(
        policy.rotateEveryMessage ? 1 : Math.max(1, policy.rotationPeriodMessages),
      );
      // The Rust API expects microseconds.
      settings.rotationPeriod = BigInt(Math.max(1, policy.rotationPeriodMs)) * 1000n;

      const toDeviceReqs = await this.machine.shareRoomKey(new RoomId(roomId), users, settings);
      let keyShares = 0;
      let withheld = 0;
      const recipients: string[] = [];
      for (const req of toDeviceReqs) {
        if (req.eventType === "m.room_key.withheld") {
          withheld += 1;
          let bodyPreview: string;
          try {
            bodyPreview = truncateBodyPreview(
              typeof req.body === "string" ? req.body : JSON.stringify(req.body),
            );
          } catch {
            bodyPreview = "(unreadable withheld body)";
          }
          this.emitCryptoLog({
            type: "withheld_detail",
            roomId,
            eventType: req.eventType,
            bodyPreview,
          });
        } else {
          keyShares += 1;
          try {
            recipients.push(...parseToDeviceRecipients(req.body));
          } catch {
            // unparseable share body — recipients list stays best-effort
          }
        }
        await this.sendToDeviceRequest(req);
      }

      this.emitCryptoLog({
        type: "share_room_key",
        roomId,
        keyShares,
        withheld,
        peers,
        recipients,
        policy,
      });

      if (keyShares === 0 && withheld > 0) {
        this.shareState.delete(roomId);
        this.emitCryptoLog({
          type: "error",
          message: `shareRoomKey for ${roomId}: 0 key shares, ${withheld} withheld — peers will not decrypt`,
          detail: { roomId, withheld, policy },
        });
        throw new RoomKeyWithheldError(roomId, withheld, policy);
      }
      if (withheld > 0) {
        this.emitCryptoLog({
          type: "warn",
          message: `shareRoomKey for ${roomId}: ${keyShares} key share(s), ${withheld} withheld (ghost/untrusted devices are expected)`,
          detail: { roomId, keyShares, withheld, policy },
        });
      }

      this.shareState.set(roomId, {
        memberFingerprint: fingerprintSet(peers),
        sharedAt: Date.now(),
        messages: 1,
      });
    });
  }

  async encryptMessage(
    roomId: string,
    eventType: string,
    content: unknown,
    userIds: string[],
  ): Promise<Record<string, unknown>> {
    await this.ensureSessionsAndShare(roomId, userIds);
    this.emitCryptoLog({ type: "encrypt_send", roomId, eventType });
    const encrypted = await this.lock.run(async () => {
      const raw = await this.machine.encryptRoomEvent(
        new RoomId(roomId),
        eventType,
        JSON.stringify(content),
      );
      await this.runOutgoingRequestsUnlocked();
      return raw;
    });
    return JSON.parse(encrypted) as Record<string, unknown>;
  }

  /**
   * Decrypt a room event. On failure the event is queued and retried when new
   * room keys arrive, so a late `m.room_key` still recovers the message instead
   * of dropping it forever.
   */
  async decryptRoomEvent(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const clear = await this.decryptOnce(roomId, event);
      const eventId = typeof event.event_id === "string" ? event.event_id : null;
      if (eventId) this.pendingDecrypts.delete(pendingKey(roomId, eventId));
      return clear;
    } catch (err) {
      const queued = this.queuePendingDecrypt(roomId, event);
      this.emitCryptoLog({
        type: "decrypt_failed",
        roomId,
        eventId: typeof event.event_id === "string" ? event.event_id : "(unknown)",
        queued,
        detail: err,
      });
      throw err;
    }
  }

  private async decryptOnce(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const decrypted = await this.machine.decryptRoomEvent(
      JSON.stringify(event),
      new RoomId(roomId),
    );
    const clear = JSON.parse(decrypted.event) as {
      type?: string;
      content?: Record<string, unknown>;
      [key: string]: unknown;
    };
    const shield = decrypted.shieldState(false);
    return {
      ...event,
      type: clear.type ?? "m.room.message",
      content: isPlainObject(clear.content) ? clear.content : {},
      aiomatrix_encryption: {
        senderDevice: decrypted.senderDevice?.toString() ?? null,
        senderCurve25519Key: decrypted.senderCurve25519Key ?? null,
        senderClaimedEd25519Key: decrypted.senderClaimedEd25519Key ?? null,
        shieldColor: shield?.color ?? null,
        shieldMessage: shield?.message ?? null,
        verified: shield == null,
      },
    };
  }

  private queuePendingDecrypt(roomId: string, event: Record<string, unknown>): boolean {
    const eventId = typeof event.event_id === "string" ? event.event_id : null;
    if (!eventId) return false;
    const key = pendingKey(roomId, eventId);
    const existing = this.pendingDecrypts.get(key);
    if (existing) {
      existing.attempts += 1;
      return existing.attempts < MAX_DECRYPT_ATTEMPTS;
    }
    if (this.pendingDecrypts.size >= MAX_PENDING_DECRYPT) {
      const oldest = this.pendingDecrypts.keys().next();
      if (!oldest.done) this.pendingDecrypts.delete(oldest.value);
    }
    const content = isPlainObject(event.content) ? event.content : {};
    this.pendingDecrypts.set(key, {
      roomId,
      event,
      sessionId: typeof content.session_id === "string" ? content.session_id : null,
      firstSeenAt: Date.now(),
      attempts: 1,
    });
    return true;
  }

  /** Retry queued undecryptable events; recovered ones go to the recovery handler. */
  async retryPendingDecrypts(): Promise<number> {
    if (this._closed || this.pendingDecrypts.size === 0) return 0;
    const now = Date.now();
    let recovered = 0;
    for (const [key, pending] of [...this.pendingDecrypts]) {
      if (now - pending.firstSeenAt > PENDING_DECRYPT_TTL_MS) {
        this.pendingDecrypts.delete(key);
        continue;
      }
      if (pending.attempts >= MAX_DECRYPT_ATTEMPTS) {
        this.pendingDecrypts.delete(key);
        continue;
      }
      try {
        const clear = await this.decryptOnce(pending.roomId, pending.event);
        this.pendingDecrypts.delete(key);
        recovered += 1;
        this.emitCryptoLog({
          type: "decrypt_recovered",
          roomId: pending.roomId,
          eventId: typeof pending.event.event_id === "string" ? pending.event.event_id : "?",
          attempts: pending.attempts,
        });
        try {
          this.onDecryptRecovered?.(pending.roomId, clear);
        } catch (err) {
          this.logger.warn("decrypt recovery handler threw", err);
        }
      } catch {
        pending.attempts += 1;
      }
    }
    return recovered;
  }

  /** Number of events still waiting for their Megolm key. */
  get pendingDecryptCount(): number {
    return this.pendingDecrypts.size;
  }

  /** Encrypt attachment bytes for an E2EE room; returns ciphertext + `file` info. */
  encryptAttachment(data: Uint8Array): {
    ciphertext: Uint8Array;
    info: Record<string, unknown>;
  } {
    const encrypted = Attachment.encrypt(data);
    const info = JSON.parse(encrypted.mediaEncryptionInfo ?? "{}") as Record<string, unknown>;
    return { ciphertext: encrypted.encryptedData, info };
  }

  /** Decrypt attachment bytes using the `file` block from an event. */
  decryptAttachment(ciphertext: Uint8Array, info: Record<string, unknown>): Uint8Array {
    const attachment = new EncryptedAttachment(ciphertext, JSON.stringify(info));
    return Attachment.decrypt(attachment);
  }

  /** Publish cross-signing keys so users can verify this bot's device. */
  async bootstrapCrossSigning(reset = false): Promise<void> {
    await this.lock.run(async () => {
      await this.machine.bootstrapCrossSigning(reset);
      await this.runOutgoingRequestsUnlocked();
    });
  }

  async crossSigningStatus(): Promise<{
    hasMaster: boolean;
    hasSelfSigning: boolean;
    hasUserSigning: boolean;
  }> {
    const status = await this.machine.crossSigningStatus();
    return {
      hasMaster: status.hasMaster,
      hasSelfSigning: status.hasSelfSigning,
      hasUserSigning: status.hasUserSigning,
    };
  }

  async roomKeyCounts(): Promise<{ total: number; backedUp: number }> {
    const counts = await this.machine.roomKeyCounts();
    return { total: counts.total, backedUp: counts.backedUp };
  }

  /**
   * Release the SQLite store and native handles. Required for clean process
   * exit and for tests/hosts that create more than one engine.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._isReady = false;
    await this.lock.run(async () => {
      try {
        this.machine.close();
      } catch (err) {
        this.logger.warn("OlmMachine.close() threw", err);
      }
    });
    this.pendingDecrypts.clear();
    this.shareState.clear();
    this.trackedUsers.clear();
    this.dirtyUsers.clear();
  }
}

function pendingKey(roomId: string, eventId: string): string {
  return `${roomId}\u0000${eventId}`;
}

function parseToDeviceEvents(raw: string): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isPlainObject);
    if (isPlainObject(parsed) && Array.isArray(parsed.events)) {
      return parsed.events.filter(isPlainObject);
    }
    return [];
  } catch {
    return [];
  }
}
