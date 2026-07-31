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
 * Bot defaults. `rotateEveryMessage: true` is intentional for correctness:
 * after a human crypto wipe the Rust machine often believes the outbound
 * Megolm session was "already shared" to the same device_id and skips the
 * to-device fanout — peers see ciphertext that only decrypts after a later
 * key exchange (feels like "bot replies on my second message"). Fresh session
 * per encrypt forces a real share to current devices.
 *
 * Large rooms that need the cheaper path can set `rotateEveryMessage: false`
 * and rely on `reshareOnDeviceChange` + rotation periods — accept the wipe
 * edge case or call `invalidateRoomShare(roomId)` after known peer resets.
 */
export const DEFAULT_ENCRYPTION_SHARE_POLICY: Required<EncryptionSharePolicy> = {
  onlyAllowTrustedDevices: false,
  errorOnVerifiedUserProblem: false,
  rotateEveryMessage: true,
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
    rotationPeriodMessages: policy?.rotationPeriodMessages ?? d.rotationPeriodMessages,
    rotationPeriodMs: policy?.rotationPeriodMs ?? d.rotationPeriodMs,
    reshareOnDeviceChange: policy?.reshareOnDeviceChange ?? d.reshareOnDeviceChange,
  };
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
