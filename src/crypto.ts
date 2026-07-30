import {
  DeviceId,
  DeviceLists,
  EncryptionAlgorithm,
  EncryptionSettings,
  HistoryVisibility,
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
import type { MatrixHttp } from "./http.js";

export interface CryptoEngineCreateOptions {
  userId: string;
  deviceId: string;
  storePath: string;
  http: MatrixHttp;
}

type OutgoingRequest =
  | KeysUploadRequest
  | KeysQueryRequest
  | KeysClaimRequest
  | ToDeviceRequest
  | SignatureUploadRequest
  | RoomMessageRequest;

/**
 * Thin wrapper around OlmMachine + CS HTTP outgoing-request runner.
 * Does not use matrix-bot-sdk or RustSdkCryptoStorageProvider.
 */
export class CryptoEngine {
  readonly userId: string;
  readonly clientDeviceId: string;
  private readonly http: MatrixHttp;
  private readonly machine: OlmMachine;
  private _isReady = false;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    machine: OlmMachine,
    http: MatrixHttp,
    userId: string,
    deviceId: string,
  ) {
    this.machine = machine;
    this.http = http;
    this.userId = userId;
    this.clientDeviceId = deviceId;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  static async create(options: CryptoEngineCreateOptions): Promise<CryptoEngine> {
    const machine = await OlmMachine.initialize(
      new UserId(options.userId),
      new DeviceId(options.deviceId),
      options.storePath,
      null,
      StoreType.Sqlite,
    );
    return new CryptoEngine(machine, options.http, options.userId, options.deviceId);
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
    const requests = await this.machine.outgoingRequests();
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
      default:
        console.warn(`[matrixbots] unsupported outgoing crypto request type: ${request.type}`);
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
   * HTTP: PUT /sendToDevice/{eventType}/{txnId} with body JSON (messages).
   */
  private async sendToDeviceRequest(request: ToDeviceRequest): Promise<void> {
    const body = JSON.parse(request.body) as unknown;
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

      const settings = new EncryptionSettings();
      settings.algorithm = EncryptionAlgorithm.MegolmV1AesSha2;
      settings.historyVisibility = HistoryVisibility.Shared;

      const toDeviceReqs = await this.machine.shareRoomKey(
        new RoomId(roomId),
        users,
        settings,
      );
      for (const req of toDeviceReqs) {
        await this.sendToDeviceRequest(req);
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
