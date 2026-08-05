import { MiniAppAuthError } from "../errors.js";
import type { Membership } from "../room-cache.js";
import type { MiniAppSession } from "./server.js";

export type RoomAuthSnapshot = {
  membership: string | null;
  powerLevel: number | null;
};

/**
 * Merge a live `resolveRoomAuth` result into a session copy so moderator gates
 * do not rely on a stale launch snapshot.
 */
export async function refreshMiniAppSessionRoomAuth(
  session: MiniAppSession,
  resolveRoomAuth:
    | ((
        userId: string,
        roomId: string,
      ) => RoomAuthSnapshot | Promise<RoomAuthSnapshot | null> | null)
    | undefined,
): Promise<MiniAppSession> {
  if (!resolveRoomAuth || !session.roomId) return session;
  const live = await resolveRoomAuth(session.userId, session.roomId);
  if (!live) return session;
  return {
    ...session,
    membership: live.membership,
    powerLevel: live.powerLevel,
  };
}

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
 * Prefer live `resolveRoomAuth` (and {@link refreshMiniAppSessionRoomAuth}) for
 * moderator-gated writes.
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

/**
 * Live-refresh then assert join. Use on privileged MiniApp routes when
 * `resolveRoomAuth` is configured.
 */
export async function assertMiniAppJoinedLive(
  session: MiniAppSession,
  resolveRoomAuth: (
    userId: string,
    roomId: string,
  ) => RoomAuthSnapshot | Promise<RoomAuthSnapshot | null> | null,
): Promise<MiniAppSession> {
  const fresh = await refreshMiniAppSessionRoomAuth(session, resolveRoomAuth);
  assertMiniAppJoined(fresh);
  return fresh;
}

/**
 * Live-refresh then assert power level.
 */
export async function assertMiniAppPowerLive(
  session: MiniAppSession,
  minLevel: number,
  resolveRoomAuth: (
    userId: string,
    roomId: string,
  ) => RoomAuthSnapshot | Promise<RoomAuthSnapshot | null> | null,
): Promise<MiniAppSession> {
  const fresh = await refreshMiniAppSessionRoomAuth(session, resolveRoomAuth);
  assertMiniAppPower(fresh, minLevel);
  return fresh;
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
