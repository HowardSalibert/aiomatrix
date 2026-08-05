import { MiniAppAuthError } from "../errors.js";
import type { Membership } from "../room-cache.js";
import type { MiniAppSession } from "./server.js";

/**
 * Fail closed when the MiniApp session has no join membership snapshot.
 * Sessions minted before 0.5.0 have `membership == null` — treat as unknown
 * and reject unless you re-auth or supply `resolveRoomAuth`.
 */
export function assertMiniAppJoined(session: MiniAppSession): void {
  if (session.membership == null) {
    throw new MiniAppAuthError(
      "MiniApp session has no membership snapshot; re-auth or use resolveRoomAuth",
      "forbidden",
    );
  }
  if (session.membership !== "join") {
    throw new MiniAppAuthError(
      `MiniApp user is not joined (membership=${session.membership})`,
      "forbidden",
    );
  }
}

/**
 * Fail closed when power level is unknown or below `minLevel`.
 * Prefer live `resolveRoomAuth` for moderator-gated writes.
 */
export function assertMiniAppPower(session: MiniAppSession, minLevel: number): void {
  if (session.powerLevel == null || !Number.isFinite(session.powerLevel)) {
    throw new MiniAppAuthError(
      "MiniApp session has no powerLevel snapshot; re-auth or use resolveRoomAuth",
      "forbidden",
    );
  }
  if (session.powerLevel < minLevel) {
    throw new MiniAppAuthError(
      `MiniApp power level ${session.powerLevel} is below required ${minLevel}`,
      "forbidden",
    );
  }
}

export function miniAppMembershipIs(
  session: MiniAppSession,
  ...allowed: Membership[]
): boolean {
  return session.membership != null && allowed.includes(session.membership as Membership);
}

export function miniAppHasPower(session: MiniAppSession, minLevel: number): boolean {
  return session.powerLevel != null && session.powerLevel >= minLevel;
}
