import type { EncryptionSharePolicy } from "./types.js";

/** Base error for matrixbots SDK. All library errors extend this. */
export class MatrixBotsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    // Keep prototype chain intact when the package is transpiled to ES5-ish targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Bad SDK usage (missing/conflicting options). Never retryable. */
export class ConfigurationError extends MatrixBotsError {}

/**
 * Crypto stack failed to publish/verify own device keys after prepare+flush.
 * Bot must not start in a half-broken E2EE state.
 */
export class CryptoNotReadyError extends MatrixBotsError {
  constructor(
    message = "Crypto not ready: own device keys missing on homeserver after prepare/flush",
  ) {
    super(message);
  }
}

/** Configured deviceId does not match the device id from whoami/crypto store. */
export class DeviceMismatchError extends MatrixBotsError {
  constructor(
    readonly expected: string,
    readonly actual: string | null | undefined,
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
    readonly roomId: string,
    readonly peerUserIds: string[],
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
 * Encryption state for a room could not be determined (transient HS error).
 * Sending is refused because a plaintext fallback could leak into an E2EE room.
 */
export class EncryptionStateUnknownError extends MatrixBotsError {
  constructor(
    readonly roomId: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Cannot determine whether room ${roomId} is encrypted (homeserver error). Refusing to send to avoid a plaintext leak.`,
      options,
    );
  }
}

/**
 * shareRoomKey produced only m.room_key.withheld (zero actual key shares).
 * New outbound Megolm sessions would be undecryptable by peers.
 */
export class RoomKeyWithheldError extends MatrixBotsError {
  constructor(
    readonly roomId: string,
    readonly withheld: number,
    readonly policy: Required<EncryptionSharePolicy>,
  ) {
    super(
      `RoomKeyWithheldError: room ${roomId}: 0 key shares, ${withheld} withheld ` +
        `(onlyAllowTrustedDevices=${policy.onlyAllowTrustedDevices}, ` +
        `errorOnVerifiedUserProblem=${policy.errorOnVerifiedUserProblem}, ` +
        `rotateEveryMessage=${policy.rotateEveryMessage}). ` +
        `Peers will not decrypt — check onCryptoLog withheld_detail / device trust.`,
    );
  }
}

/** Homeserver returned 429 / M_LIMIT_EXCEEDED and retries were exhausted. */
export class RateLimitedError extends MatrixBotsError {
  constructor(
    readonly retryAfterMs: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(
      `Rate limited by homeserver on ${method} ${path}; retry after ${retryAfterMs}ms (retries exhausted).`,
    );
  }
}

/** Request exceeded its timeout budget. */
export class RequestTimeoutError extends MatrixBotsError {
  constructor(
    readonly timeoutMs: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Matrix HTTP timeout after ${timeoutMs}ms: ${method} ${path}`);
  }
}

/** Access token is invalid/expired and could not be refreshed. */
export class AuthenticationError extends MatrixBotsError {
  constructor(
    message: string,
    readonly softLogout: boolean = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** `.well-known` / homeserver resolution failed. */
export class DiscoveryError extends MatrixBotsError {}

/** Media upload/download exceeded the configured size limit. */
export class MediaTooLargeError extends MatrixBotsError {
  constructor(
    readonly bytes: number,
    readonly limitBytes: number,
  ) {
    super(`Media size ${bytes} bytes exceeds limit ${limitBytes} bytes.`);
  }
}

/** MiniApp `initData` failed signature/expiry validation. */
export class MiniAppAuthError extends MatrixBotsError {
  constructor(
    message: string,
    readonly reason:
      | "missing_hash"
      | "bad_signature"
      | "expired"
      | "malformed"
      | "replayed"
      | "untrusted_origin",
  ) {
    super(message);
  }
}

/** A handler exceeded its allotted runtime and was abandoned. */
export class HandlerTimeoutError extends MatrixBotsError {
  constructor(
    readonly timeoutMs: number,
    readonly where: string,
  ) {
    super(`Handler at ${where} exceeded ${timeoutMs}ms and was abandoned.`);
  }
}
