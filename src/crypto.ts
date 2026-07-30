import {
  DeviceId,
  DeviceLists,
  EncryptionAlgorithm,
  EncryptionSettings,
  HistoryVisibility,
  KeysBackupRequest,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  RequestType,
  RoomId,
  RoomMessageRequest,
  SignatureUploadRequest,
  StoreType,
  ToDeviceRequest,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
import { RoomKeyWithheldError } from "./errors.js";
import type { MatrixHttp } from "./http.js";
import type {
  CryptoLogEvent,
  EncryptionSharePolicy,
} from "./types.js";

export const DEFAULT_ENCRYPTION_SHARE_POLICY: Required<EncryptionSharePolicy> = {
  onlyAllowTrustedDevices: false,
  errorOnVerifiedUserProblem: false,
};

export function resolveEncryptionSharePolicy(
  policy?: EncryptionSharePolicy | null,
): Required<EncryptionSharePolicy> {
  return {
    onlyAllowTrustedDevices:
      policy?.onlyAllowTrustedDevices ??
      DEFAULT_ENCRYPTION_SHARE_POLICY.onlyAllowTrustedDevices,
    errorOnVerifiedUserProblem:
      policy?.errorOnVerifiedUserProblem ??
      DEFAULT_ENCRYPTION_SHARE_POLICY.errorOnVerifiedUserProblem,
  };
}

export interface CryptoEngineCreateOptions {
  userId: string;
  deviceId: string;
  storePath: string;
  http: MatrixHttp;
  /** Optional passphrase for encrypting the crypto store on disk. */
  storePassphrase?: string | null;
  /** Megolm share policy (OlmMachine EncryptionSettings). */
  encryption?: EncryptionSharePolicy;
  /** Optional structured crypto logger. */
  onCryptoLog?: (event: CryptoLogEvent) => void;
}

const WITHHELD_BODY_MAX = 500;

function truncateBodyPreview(body: string, max = WITHHELD_BODY_MAX): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}…`;
}

type OutgoingRequest =
  | KeysUploadRequest
  | KeysQueryRequest
  | KeysClaimRequest
  | ToDeviceRequest
  | SignatureUploadRequest
  | RoomMessageRequest
  | KeysBackupRequest;

export type HistoryVisibilityName =
  | "invited"
  | "joined"
  | "shared"
  | "world_readable";

/** Map Matrix history_visibility string → crypto-nodejs enum (default Shared). */
export function mapHistoryVisibility(
  value: string | null | undefined,
): HistoryVisibility {
  switch (value) {
    case "invited":
      return HistoryVisibility.Invited;
    case "joined":
      return HistoryVisibility.Joined;
    case "world_readable":
      return HistoryVisibility.WorldReadable;
    case "shared":
    default:
      return HistoryVisibility.Shared;
  }
}

/**
 * Normalize ToDeviceRequest.body to HTTP PUT shape `{ messages: ... }`.
 * Exported for unit tests.
 */
export function normalizeToDeviceBody(parsed: unknown): { messages: unknown } {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if ("messages" in obj) {
      return { messages: obj.messages };
    }
    // Some builds nest as { content: { messages } } or body already is the map
    if (
      obj.content &&
      typeof obj.content === "object" &&
      obj.content !== null &&
      "messages" in (obj.content as object)
    ) {
      return { messages: (obj.content as { messages: unknown }).messages };
    }
    // Assume the object itself is the user→device→content map
    return { messages: obj };
  }
  return { messages: {} };
}

/**
 * Thin wrapper around OlmMachine + CS HTTP outgoing-request runner.
 * Does not use matrix-bot-sdk or RustSdkCryptoStorageProvider.
 */
export class CryptoEngine {
  readonly userId: string;
  readonly clientDeviceId: string;
  readonly sharePolicy: Required<EncryptionSharePolicy>;
  private readonly http: MatrixHttp;
  private readonly machine: OlmMachine;
  private readonly onCryptoLog: ((event: CryptoLogEvent) => void) | null;
  private _isReady = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Optional resolver for per-room history visibility (default Shared). */
  private historyVisibilityForRoom:
    | ((roomId: string) => HistoryVisibilityName | null | undefined)
    | null = null;

  private constructor(
    machine: OlmMachine,
    http: MatrixHttp,
    userId: string,
    deviceId: string,
    sharePolicy: Required<EncryptionSharePolicy>,
    onCryptoLog: ((event: CryptoLogEvent) => void) | null,
  ) {
    this.machine = machine;
    this.http = http;
    this.userId = userId;
    this.clientDeviceId = deviceId;
    this.sharePolicy = sharePolicy;
    this.onCryptoLog = onCryptoLog;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  /** Emit a structured crypto log event; always mirrors important cases to console. */
  emitCryptoLog(event: CryptoLogEvent): void {
    switch (event.type) {
      case "withheld_detail":
        console.warn(
          `[matrixbots] withheld_detail room=${event.roomId} type=${event.eventType} body=${event.bodyPreview}`,
        );
        break;
      case "share_room_key":
        if (event.withheld > 0 || event.keyShares === 0) {
          console.warn(
            `[matrixbots] share_room_key room=${event.roomId} keyShares=${event.keyShares} withheld=${event.withheld} peers=${event.peers.length} policy=${JSON.stringify(event.policy)}`,
          );
        }
        break;
      case "peer_keys_missing":
        console.error(
          `[matrixbots] peer_keys_missing room=${event.roomId} peers=[${event.peers.join(", ")}]`,
        );
        break;
      case "encrypt_send":
        // Quiet by default — use onCryptoLog for verbose traces.
        break;
      case "warn":
        console.warn(`[matrixbots] ${event.message}`, event.detail ?? "");
        break;
      case "error":
        console.error(`[matrixbots] ${event.message}`, event.detail ?? "");
        break;
      default:
        break;
    }
    try {
      this.onCryptoLog?.(event);
    } catch (err) {
      console.warn("[matrixbots] onCryptoLog hook threw:", err);
    }
  }

  setHistoryVisibilityResolver(
    fn: (roomId: string) => HistoryVisibilityName | null | undefined,
  ): void {
    this.historyVisibilityForRoom = fn;
  }

  static async create(options: CryptoEngineCreateOptions): Promise<CryptoEngine> {
    const passphrase = options.storePassphrase ?? null;
    if (!passphrase) {
      console.warn(
        "[matrixbots] crypto store passphrase is empty — OlmMachine SQLite store is unencrypted on disk",
      );
    }
    const machine = await OlmMachine.initialize(
      new UserId(options.userId),
      new DeviceId(options.deviceId),
      options.storePath,
      passphrase,
      StoreType.Sqlite,
    );
    return new CryptoEngine(
      machine,
      options.http,
      options.userId,
      options.deviceId,
      resolveEncryptionSharePolicy(options.encryption),
      options.onCryptoLog ?? null,
    );
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Flush outgoing requests until empty (or max rounds), then mark ready.
   * Optionally track users from joined rooms.
   */
  async prepare(
    roomIds: string[],
    getMembers: (roomId: string) => Promise<string[]>,
  ): Promise<void> {
    await this.withLock(async () => {
      const tracked = new Set<string>();
      for (const roomId of roomIds) {
        try {
          const members = await getMembers(roomId);
          for (const m of members) tracked.add(m);
        } catch (err) {
          console.warn(`[matrixbots] prepare: members for ${roomId}:`, err);
        }
      }
      if (tracked.size > 0) {
        await this.machine.updateTrackedUsers([...tracked].map((u) => new UserId(u)));
      }
      for (let round = 0; round < 12; round++) {
        const n = await this.runOutgoingRequestsUnlocked();
        if (n === 0) break;
      }
      this._isReady = true;
    });
  }

  async runOutgoingRequests(): Promise<number> {
    return this.withLock(() => this.runOutgoingRequestsUnlocked());
  }

  private async runOutgoingRequestsUnlocked(): Promise<number> {
    const requests = (await this.machine.outgoingRequests()) as OutgoingRequest[];
    for (const request of requests) {
      await this.dispatchRequest(request);
    }
    return requests.length;
  }

  private async dispatchRequest(request: OutgoingRequest): Promise<void> {
    switch (request.type) {
      case RequestType.KeysUpload: {
        const body = JSON.parse(request.body) as unknown;
        const resp = await this.http.request(
          "POST",
          "/_matrix/client/v3/keys/upload",
          null,
          body,
        );
        await this.machine.markRequestAsSent(
          request.id,
          RequestType.KeysUpload,
          JSON.stringify(resp),
        );
        break;
      }
      case RequestType.KeysQuery: {
        const body = JSON.parse(request.body) as unknown;
        const resp = await this.http.request(
          "POST",
          "/_matrix/client/v3/keys/query",
          null,
          body,
        );
        await this.machine.markRequestAsSent(
          request.id,
          RequestType.KeysQuery,
          JSON.stringify(resp),
        );
        break;
      }
      case RequestType.KeysClaim: {
        await this.sendKeysClaim(request as KeysClaimRequest);
        break;
      }
      case RequestType.ToDevice: {
        await this.sendToDeviceRequest(request as ToDeviceRequest);
        break;
      }
      case RequestType.SignatureUpload: {
        const body = JSON.parse(request.body) as unknown;
        const resp = await this.http.request(
          "POST",
          "/_matrix/client/v3/keys/signatures/upload",
          null,
          body,
        );
        await this.machine.markRequestAsSent(
          request.id,
          RequestType.SignatureUpload,
          JSON.stringify(resp),
        );
        break;
      }
      case RequestType.RoomMessage: {
        const rm = request as RoomMessageRequest;
        const body = JSON.parse(rm.body) as unknown;
        const resp = await this.http.request(
          "PUT",
          `/_matrix/client/v3/rooms/${encodeURIComponent(rm.roomId)}/send/${encodeURIComponent(rm.eventType)}/${encodeURIComponent(rm.txnId)}`,
          null,
          body,
        );
        await this.machine.markRequestAsSent(
          rm.id,
          RequestType.RoomMessage,
          JSON.stringify(resp),
        );
        break;
      }
      case RequestType.KeysBackup: {
        // No key-backup setup in this SDK — mark sent so the queue never stalls.
        console.warn(
          "[matrixbots] KeysBackup outgoing request skipped (key backup not configured); marking sent",
        );
        await this.machine.markRequestAsSent(
          request.id,
          RequestType.KeysBackup,
          "{}",
        );
        break;
      }
      default: {
        const req = request as { id?: string; type?: unknown };
        console.warn(
          `[matrixbots] unsupported outgoing crypto request type: ${String(req.type)} — marking sent to avoid stall`,
        );
        if (req.id != null && req.type != null) {
          try {
            await this.machine.markRequestAsSent(
              req.id,
              req.type as RequestType,
              "{}",
            );
          } catch (err) {
            console.warn("[matrixbots] markRequestAsSent failed for unknown type:", err);
          }
        }
      }
    }
  }

  private async sendKeysClaim(request: KeysClaimRequest): Promise<void> {
    const body = JSON.parse(request.body) as unknown;
    const resp = await this.http.request(
      "POST",
      "/_matrix/client/v3/keys/claim",
      null,
      body,
    );
    await this.machine.markRequestAsSent(
      request.id,
      RequestType.KeysClaim,
      JSON.stringify(resp),
    );
  }

  /**
   * ToDeviceRequest fields (crypto-nodejs 0.4): id, eventType, txnId, body, type.
   * HTTP: PUT /sendToDevice/{eventType}/{txnId} with body `{ messages: ... }`.
   */
  private async sendToDeviceRequest(request: ToDeviceRequest): Promise<void> {
    const parsed = JSON.parse(request.body) as unknown;
    const body = normalizeToDeviceBody(parsed);
    const resp = await this.http.request(
      "PUT",
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(request.eventType)}/${encodeURIComponent(request.txnId)}`,
      null,
      body,
    );
    await this.machine.markRequestAsSent(
      request.id,
      RequestType.ToDevice,
      JSON.stringify(resp),
    );
  }

  async receiveSync(
    toDeviceEventsJson: string,
    changed: string[],
    left: string[],
    oneTimeKeyCounts: Record<string, number>,
    unusedFallbackKeys: string[],
  ): Promise<void> {
    await this.withLock(async () => {
      const deviceLists = new DeviceLists(
        changed.map((u) => new UserId(u)),
        left.map((u) => new UserId(u)),
      );
      await this.machine.receiveSyncChanges(
        toDeviceEventsJson,
        deviceLists,
        oneTimeKeyCounts,
        unusedFallbackKeys,
      );
      await this.runOutgoingRequestsUnlocked();
    });
  }

  async updateTrackedUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.withLock(async () => {
      await this.machine.updateTrackedUsers(userIds.map((u) => new UserId(u)));
      await this.runOutgoingRequestsUnlocked();
    });
  }

  /**
   * Claim missing Olm sessions and share Megolm room key (no plaintext fallback).
   * Uses {@link sharePolicy} (bot EncryptionSettings — not Synapse config).
   */
  async ensureSessionsAndShare(roomId: string, userIds: string[]): Promise<void> {
    await this.withLock(async () => {
      const users = userIds.map((u) => new UserId(u));
      await this.machine.updateTrackedUsers(users);
      await this.runOutgoingRequestsUnlocked();

      const claim = await this.machine.getMissingSessions(users);
      if (claim) {
        await this.sendKeysClaim(claim);
      }

      const policy = this.sharePolicy;
      const settings = new EncryptionSettings();
      settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
      const hvName = this.historyVisibilityForRoom?.(roomId);
      settings.historyVisibility = mapHistoryVisibility(hvName);
      settings.onlyAllowTrustedDevices = policy.onlyAllowTrustedDevices;
      settings.errorOnVerifiedUserProblem = policy.errorOnVerifiedUserProblem;

      const toDeviceReqs = await this.machine.shareRoomKey(
        new RoomId(roomId),
        users,
        settings,
      );
      let keyShares = 0;
      let withheld = 0;
      for (const req of toDeviceReqs) {
        if (req.eventType === "m.room_key.withheld") {
          withheld += 1;
          let bodyPreview = "";
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
        }
        await this.sendToDeviceRequest(req);
      }

      this.emitCryptoLog({
        type: "share_room_key",
        roomId,
        keyShares,
        withheld,
        peers: userIds,
        policy,
      });

      if (keyShares === 0 && withheld > 0) {
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
          message: `shareRoomKey for ${roomId}: ${keyShares} key share(s), ${withheld} withheld (ghost/untrusted devices OK)`,
          detail: { roomId, keyShares, withheld, policy },
        });
      }
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
    const encrypted = await this.withLock(async () => {
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

  async decryptRoomEvent(
    roomId: string,
    event: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const decrypted = await this.machine.decryptRoomEvent(
      JSON.stringify(event),
      new RoomId(roomId),
    );
    // DecryptedRoomEvent.event is the JSON-encoded clear event (type + content).
    const clear = JSON.parse(decrypted.event) as {
      type?: string;
      content?: Record<string, unknown>;
      [key: string]: unknown;
    };
    return {
      ...event,
      type: clear.type ?? "m.room.message",
      content: typeof clear.content === "object" && clear.content ? clear.content : {},
    };
  }
}
