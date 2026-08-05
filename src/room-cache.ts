import { LruCache, isPlainObject, readNumber, readString } from "./util.js";

export type HistoryVisibilityName = "invited" | "joined" | "shared" | "world_readable";

export type Membership = "join" | "invite" | "leave" | "ban" | "knock";

export interface PowerLevels {
  users: Record<string, number>;
  usersDefault: number;
  eventsDefault: number;
  stateDefault: number;
  events: Record<string, number>;
  invite: number;
  kick: number;
  ban: number;
  redact: number;
  notificationsRoom: number;
}

export const DEFAULT_POWER_LEVELS: PowerLevels = {
  users: {},
  usersDefault: 0,
  eventsDefault: 0,
  stateDefault: 50,
  events: {},
  invite: 0,
  kick: 50,
  ban: 50,
  redact: 50,
  notificationsRoom: 50,
};

export interface RoomInfo {
  roomId: string;
  /** `undefined` until the room's state has been observed. */
  encryptionAlgorithm?: string;
  /** True once a full state snapshot was seen, making "no m.room.encryption" authoritative. */
  stateSynced: boolean;
  historyVisibility: HistoryVisibilityName;
  name?: string;
  topic?: string;
  canonicalAlias?: string;
  avatarUrl?: string;
  creator?: string;
  version?: string;
  /** `m.room.tombstone` replacement room, when the room was upgraded. */
  replacedBy?: string;
  members: Map<string, Membership>;
  /**
   * True once the full joined-member list has been loaded and kept up to date
   * through membership deltas. Encryption decisions require this.
   */
  memberListComplete: boolean;
  /** True when the room carries `is_direct` / appears in `m.direct`. */
  isDirectHint: boolean;
  powerLevels: PowerLevels;
  /** Heroes/counts from the sync `summary` block, when lazy loading hides members. */
  joinedMemberCount?: number;
}

function emptyRoom(roomId: string): RoomInfo {
  return {
    roomId,
    stateSynced: false,
    historyVisibility: "shared",
    members: new Map(),
    memberListComplete: false,
    isDirectHint: false,
    powerLevels: { ...DEFAULT_POWER_LEVELS, users: {}, events: {} },
  };
}

function parseHistoryVisibility(value: unknown): HistoryVisibilityName | null {
  return value === "invited" || value === "joined" || value === "shared" || value === "world_readable"
    ? value
    : null;
}

function parsePowerLevels(content: unknown): PowerLevels {
  const base: PowerLevels = { ...DEFAULT_POWER_LEVELS, users: {}, events: {} };
  if (!isPlainObject(content)) return base;
  if (isPlainObject(content.users)) {
    for (const [user, level] of Object.entries(content.users)) {
      if (typeof level === "number") base.users[user] = level;
    }
  }
  if (isPlainObject(content.events)) {
    for (const [type, level] of Object.entries(content.events)) {
      if (typeof level === "number") base.events[type] = level;
    }
  }
  base.usersDefault = readNumber(content, "users_default") ?? base.usersDefault;
  base.eventsDefault = readNumber(content, "events_default") ?? base.eventsDefault;
  base.stateDefault = readNumber(content, "state_default") ?? base.stateDefault;
  base.invite = readNumber(content, "invite") ?? base.invite;
  base.kick = readNumber(content, "kick") ?? base.kick;
  base.ban = readNumber(content, "ban") ?? base.ban;
  base.redact = readNumber(content, "redact") ?? base.redact;
  if (isPlainObject(content.notifications)) {
    base.notificationsRoom = readNumber(content.notifications, "room") ?? base.notificationsRoom;
  }
  return base;
}

/**
 * In-memory projection of room state built from `/sync`.
 *
 * Every field here exists to avoid a Client-Server round trip on the hot path:
 * membership lists, encryption state, history visibility and power levels are
 * all needed per outgoing message.
 */
export class RoomCache {
  private readonly rooms: LruCache<string, RoomInfo>;
  private directRooms = new Set<string>();
  private directLoaded = false;

  constructor(capacity = 2_000) {
    this.rooms = new LruCache<string, RoomInfo>(capacity);
  }

  get(roomId: string): RoomInfo | undefined {
    return this.rooms.get(roomId);
  }

  ensure(roomId: string): RoomInfo {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const created = emptyRoom(roomId);
    this.rooms.set(roomId, created);
    return created;
  }

  forget(roomId: string): void {
    this.rooms.delete(roomId);
    this.directRooms.delete(roomId);
  }

  /** Drop cached state for a room so the next read re-reads it from the server. */
  invalidate(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.stateSynced = false;
    delete room.encryptionAlgorithm;
    room.members.clear();
    room.memberListComplete = false;
  }

  /** Force the next membership read to hit `/joined_members`. */
  invalidateMembers(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) room.memberListComplete = false;
  }

  /**
   * Apply a state event. `authoritative` marks the event as part of a full
   * state snapshot (bootstrap sync, new room, or an explicit `/state` refresh).
   */
  applyStateEvent(roomId: string, event: Record<string, unknown>): void {
    const type = readString(event, "type");
    if (!type) return;
    const room = this.ensure(roomId);
    const content = isPlainObject(event.content) ? event.content : {};
    const stateKey = readString(event, "state_key");

    switch (type) {
      case "m.room.encryption": {
        const algorithm = readString(content, "algorithm");
        if (algorithm) room.encryptionAlgorithm = algorithm;
        break;
      }
      case "m.room.history_visibility": {
        const visibility = parseHistoryVisibility(content.history_visibility);
        room.historyVisibility = visibility ?? "shared";
        break;
      }
      case "m.room.member": {
        if (typeof stateKey !== "string" || !stateKey) break;
        const membership = readString(content, "membership");
        if (
          membership === "join" ||
          membership === "invite" ||
          membership === "leave" ||
          membership === "ban" ||
          membership === "knock"
        ) {
          room.members.set(stateKey, membership);
        }
        if (content.is_direct === true) room.isDirectHint = true;
        break;
      }
      case "m.room.name": {
        const name = readString(content, "name");
        if (name !== undefined) room.name = name;
        break;
      }
      case "m.room.topic": {
        const topic = readString(content, "topic");
        if (topic !== undefined) room.topic = topic;
        break;
      }
      case "m.room.avatar": {
        const url = readString(content, "url");
        if (url !== undefined) room.avatarUrl = url;
        break;
      }
      case "m.room.canonical_alias": {
        const alias = readString(content, "alias");
        if (alias !== undefined) room.canonicalAlias = alias;
        break;
      }
      case "m.room.create": {
        const creator = readString(content, "creator") ?? readString(event, "sender");
        if (creator) room.creator = creator;
        const version = readString(content, "room_version");
        if (version) room.version = version;
        break;
      }
      case "m.room.tombstone": {
        const replacement = readString(content, "replacement_room");
        if (replacement) room.replacedBy = replacement;
        break;
      }
      case "m.room.power_levels": {
        room.powerLevels = parsePowerLevels(content);
        break;
      }
      default:
        break;
    }
  }

  /** Mark a room's state as fully known (absence of `m.room.encryption` is meaningful). */
  markStateSynced(roomId: string): void {
    this.ensure(roomId).stateSynced = true;
  }

  applySummary(roomId: string, summary: unknown): void {
    const count = readNumber(summary, "m.joined_member_count");
    if (count !== undefined) this.ensure(roomId).joinedMemberCount = count;
  }

  /** Replace the member list from an authoritative `/joined_members` response. */
  setJoinedMembers(roomId: string, members: string[]): void {
    const room = this.ensure(roomId);
    const incoming = new Set(members);
    for (const [user, membership] of [...room.members]) {
      if (membership === "join" && !incoming.has(user)) room.members.delete(user);
    }
    for (const member of members) room.members.set(member, "join");
    room.joinedMemberCount = members.length;
    room.memberListComplete = true;
  }

  joinedMembers(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const out: string[] = [];
    for (const [user, membership] of room.members) {
      if (membership === "join") out.push(user);
    }
    return out;
  }

  /**
   * Whether the member list can be trusted for encryption decisions. Lazy-loaded
   * syncs omit members, so the list is only complete after an explicit
   * `/joined_members` load kept current through membership deltas.
   */
  hasCompleteMemberList(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return room?.memberListComplete === true && room.members.size > 0;
  }

  /** `true` / `false` when known, `undefined` while still undetermined. */
  isEncrypted(roomId: string): boolean | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    if (room.encryptionAlgorithm) return true;
    return room.stateSynced ? false : undefined;
  }

  setEncrypted(roomId: string, algorithm: string | null): void {
    const room = this.ensure(roomId);
    if (algorithm) room.encryptionAlgorithm = algorithm;
    else delete room.encryptionAlgorithm;
    room.stateSynced = true;
  }

  historyVisibility(roomId: string): HistoryVisibilityName {
    return this.rooms.get(roomId)?.historyVisibility ?? "shared";
  }

  powerLevels(roomId: string): PowerLevels {
    return this.rooms.get(roomId)?.powerLevels ?? DEFAULT_POWER_LEVELS;
  }

  membershipOf(roomId: string, userId: string): Membership | undefined {
    return this.rooms.get(roomId)?.members.get(userId);
  }

  powerLevelOf(roomId: string, userId: string): number {
    const levels = this.powerLevels(roomId);
    return levels.users[userId] ?? levels.usersDefault;
  }

  /** Minimum power level required to send `eventType` in the room. */
  requiredPowerFor(roomId: string, eventType: string, isState = false): number {
    const levels = this.powerLevels(roomId);
    return levels.events[eventType] ?? (isState ? levels.stateDefault : levels.eventsDefault);
  }

  canSend(roomId: string, userId: string, eventType: string, isState = false): boolean {
    return this.powerLevelOf(roomId, userId) >= this.requiredPowerFor(roomId, eventType, isState);
  }

  /** Update the `m.direct` set from account data. */
  applyDirectAccountData(content: unknown): void {
    const next = new Set<string>();
    if (isPlainObject(content)) {
      for (const rooms of Object.values(content)) {
        if (!Array.isArray(rooms)) continue;
        for (const roomId of rooms) {
          if (typeof roomId === "string") next.add(roomId);
        }
      }
    }
    this.directRooms = next;
    this.directLoaded = true;
  }

  get directLoadedOnce(): boolean {
    return this.directLoaded;
  }

  directRoomIds(): Set<string> {
    return new Set(this.directRooms);
  }

  /**
   * Best-effort direct-room detection: `m.direct` account data, the `is_direct`
   * invite hint, or a two-member room.
   */
  isDirect(roomId: string): boolean {
    if (this.directRooms.has(roomId)) return true;
    const room = this.rooms.get(roomId);
    if (!room) return false;
    if (room.isDirectHint) return true;
    const joined = this.joinedMembers(roomId).length;
    const summaryCount = room.joinedMemberCount;
    if (summaryCount !== undefined) return summaryCount === 2;
    return joined === 2;
  }

  /** Number of rooms currently cached (for metrics / leak checks). */
  get size(): number {
    return this.rooms.size;
  }
}
