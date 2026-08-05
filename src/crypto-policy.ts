import type { EncryptionSharePolicy } from "./types.js";
import { isPlainObject } from "./util.js";

/**
 * Pure E2EE policy helpers.
 *
 * Deliberately free of any dependency on the native crypto bindings so that
 * `import 'aiomatrix'` works on platforms where `@matrix-org/matrix-sdk-crypto-nodejs`
 * has no prebuilt binary — bots running with `crypto: false` must not pay for E2EE.
 */

/**
 * Bot defaults. `rotateEveryMessage: true` is intentional for correctness in
 * small rooms / DMs: after a human crypto wipe the Rust machine often believes
 * the outbound Megolm session was "already shared" to the same device_id and
 * skips the to-device fanout — peers see ciphertext that only decrypts after a
 * later key exchange.
 *
 * {@link DEFAULT_ENCRYPTION_SHARE_POLICY.rotateEveryMessageMaxPeers} caps the
 * per-message path so large rooms do not KeysQuery+reshare on every send.
 * Override with `rotateEveryMessage: false` or raise/lower the peer cap.
 */
export const DEFAULT_ENCRYPTION_SHARE_POLICY: Required<EncryptionSharePolicy> = {
  onlyAllowTrustedDevices: false,
  errorOnVerifiedUserProblem: false,
  rotateEveryMessage: true,
  rotateEveryMessageMaxPeers: 32,
  rotationPeriodMessages: 100,
  rotationPeriodMs: 7 * 24 * 60 * 60 * 1000,
  reshareOnDeviceChange: true,
};

export function resolveEncryptionSharePolicy(
  policy?: EncryptionSharePolicy | null,
): Required<EncryptionSharePolicy> {
  const d = DEFAULT_ENCRYPTION_SHARE_POLICY;
  return {
    onlyAllowTrustedDevices: policy?.onlyAllowTrustedDevices ?? d.onlyAllowTrustedDevices,
    errorOnVerifiedUserProblem:
      policy?.errorOnVerifiedUserProblem ?? d.errorOnVerifiedUserProblem,
    rotateEveryMessage: policy?.rotateEveryMessage ?? d.rotateEveryMessage,
    rotateEveryMessageMaxPeers:
      policy?.rotateEveryMessageMaxPeers ?? d.rotateEveryMessageMaxPeers,
    rotationPeriodMessages: policy?.rotationPeriodMessages ?? d.rotationPeriodMessages,
    rotationPeriodMs: policy?.rotationPeriodMs ?? d.rotationPeriodMs,
    reshareOnDeviceChange: policy?.reshareOnDeviceChange ?? d.reshareOnDeviceChange,
  };
}

/**
 * Whether this encrypt should start a fresh Megolm session (per-message rotate).
 * Large rooms above `rotateEveryMessageMaxPeers` use period rotation instead
 * unless the max is `0` (always rotate when `rotateEveryMessage` is true).
 */
export function shouldRotateEveryMessage(
  policy: Required<EncryptionSharePolicy>,
  peerCount: number,
): boolean {
  if (!policy.rotateEveryMessage) return false;
  const max = policy.rotateEveryMessageMaxPeers;
  if (max <= 0) return true;
  return peerCount <= max;
}

/** Drop the bot's own user id from megolm share recipients. */
export function filterShareRecipients(selfId: string, members: string[]): string[] {
  if (!selfId) return [...members];
  return members.filter((m) => m !== selfId);
}

/**
 * Parse to-device `{ messages: { userId: { deviceId: … } } }` into `userId/deviceId`.
 * Accepts a raw body string/object or an already-normalized `{ messages }`.
 */
export function parseToDeviceRecipients(body: unknown): string[] {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return [];
    }
  }
  const { messages } = normalizeToDeviceBody(parsed);
  if (!isPlainObject(messages)) return [];
  const out: string[] = [];
  for (const [userId, devices] of Object.entries(messages)) {
    if (!isPlainObject(devices)) continue;
    for (const deviceId of Object.keys(devices)) {
      out.push(`${userId}/${deviceId}`);
    }
  }
  return out;
}

/** Normalize `ToDeviceRequest.body` to the HTTP PUT shape `{ messages: … }`. */
export function normalizeToDeviceBody(parsed: unknown): { messages: unknown } {
  if (isPlainObject(parsed)) {
    if ("messages" in parsed) return { messages: parsed.messages };
    if (isPlainObject(parsed.content) && "messages" in parsed.content) {
      return { messages: parsed.content.messages };
    }
    return { messages: parsed };
  }
  return { messages: {} };
}
