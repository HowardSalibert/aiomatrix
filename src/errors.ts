import type { EncryptionSharePolicy } from "./types.js";

/** Base error for matrixbots SDK. */
export class MatrixBotsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Crypto stack failed to publish/verify own device keys after prepare+flush.
 * Bot must not start in a half-broken E2EE state.
 */
export class CryptoNotReadyError extends MatrixBotsError {
  constructor(message = "Crypto not ready: own device keys missing on homeserver after prepare/flush") {
    super(message);
  }
}

/**
 * Configured MATRIX_DEVICE_ID does not match the device id from whoami/crypto store.
 */
export class DeviceMismatchError extends MatrixBotsError {
  constructor(
    public readonly expected: string,
    public readonly actual: string | null | undefined,
  ) {
    super(
      `Device ID mismatch: env/config deviceId=${expected}, client deviceId=${actual ?? "(none)"}. Refusing to start.`,
    );
  }
}

/**
 * Encrypted room has no decryptable peer device keys — sending would create
 * ciphertext nobody can read. Send is aborted.
 */
export class PeerKeysMissingError extends MatrixBotsError {
  constructor(
    public readonly roomId: string,
    public readonly peerUserIds: string[],
  ) {
    super(
      `PeerKeysMissingError: room ${roomId} is encrypted but keys/query returned zero device keys for intended peers [${peerUserIds.join(", ")}]. Message NOT sent.`,
    );
  }
}

/** Room is encrypted but client crypto is disabled/unavailable. */
export class EncryptedRoomWithoutCryptoError extends MatrixBotsError {
  constructor(roomId: string) {
    super(
      `Room ${roomId} is encrypted but bot crypto is disabled. Refusing plaintext fallback.`,
    );
  }
}

/**
 * shareRoomKey produced only m.room_key.withheld (zero actual key shares).
 * New outbound Megolm sessions would be undecryptable by peers.
 */
export class RoomKeyWithheldError extends MatrixBotsError {
  constructor(
    public readonly roomId: string,
    public readonly withheld: number,
    public readonly policy: Required<EncryptionSharePolicy>,
  ) {
    super(
      `RoomKeyWithheldError: room ${roomId}: 0 key shares, ${withheld} withheld ` +
        `(onlyAllowTrustedDevices=${policy.onlyAllowTrustedDevices}, ` +
        `errorOnVerifiedUserProblem=${policy.errorOnVerifiedUserProblem}). ` +
        `Peers will not decrypt — check onCryptoLog withheld_detail / device trust.`,
    );
  }
}
