import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POWER_LEVELS, RoomCache } from "../dist/index.js";

const ROOM = "!room:example.org";

function state(type, content, stateKey = "") {
  return { type, state_key: stateKey, content, sender: "@admin:example.org" };
}

describe("RoomCache encryption state", () => {
  it("stays undetermined until state is observed", () => {
    const cache = new RoomCache();
    assert.equal(cache.isEncrypted(ROOM), undefined);
    cache.ensure(ROOM);
    assert.equal(cache.isEncrypted(ROOM), undefined, "an empty room proves nothing");
  });

  it("reports true as soon as m.room.encryption is seen", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.encryption", { algorithm: "m.megolm.v1.aes-sha2" }));
    assert.equal(cache.isEncrypted(ROOM), true);
  });

  it("only reports false once the full state snapshot is in", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.name", { name: "General" }));
    assert.equal(cache.isEncrypted(ROOM), undefined, "absence is not evidence yet");
    cache.markStateSynced(ROOM);
    assert.equal(cache.isEncrypted(ROOM), false);
  });

  it("accepts an explicit answer from a /state lookup", () => {
    const cache = new RoomCache();
    cache.setEncrypted(ROOM, "m.megolm.v1.aes-sha2");
    assert.equal(cache.isEncrypted(ROOM), true);
    cache.setEncrypted(ROOM, null);
    assert.equal(cache.isEncrypted(ROOM), false);
  });

  it("returns to undetermined after invalidation", () => {
    const cache = new RoomCache();
    cache.setEncrypted(ROOM, null);
    cache.invalidate(ROOM);
    assert.equal(cache.isEncrypted(ROOM), undefined);
  });
});

describe("RoomCache membership", () => {
  it("tracks memberships from state events", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.member", { membership: "join" }, "@a:hs"));
    cache.applyStateEvent(ROOM, state("m.room.member", { membership: "invite" }, "@b:hs"));
    cache.applyStateEvent(ROOM, state("m.room.member", { membership: "leave" }, "@c:hs"));
    assert.deepEqual(cache.joinedMembers(ROOM), ["@a:hs"]);
  });

  it("does not trust a lazily-loaded member list for encryption", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.member", { membership: "join" }, "@a:hs"));
    assert.equal(cache.hasCompleteMemberList(ROOM), false);
    cache.setJoinedMembers(ROOM, ["@a:hs", "@b:hs"]);
    assert.equal(cache.hasCompleteMemberList(ROOM), true);
  });

  it("drops members missing from an authoritative list", () => {
    const cache = new RoomCache();
    cache.setJoinedMembers(ROOM, ["@a:hs", "@b:hs"]);
    cache.setJoinedMembers(ROOM, ["@a:hs"]);
    assert.deepEqual(cache.joinedMembers(ROOM), ["@a:hs"]);
    assert.equal(cache.get(ROOM).joinedMemberCount, 1);
  });

  it("keeps invited members when refreshing the joined list", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.member", { membership: "invite" }, "@invitee:hs"));
    cache.setJoinedMembers(ROOM, ["@a:hs"]);
    assert.equal(cache.get(ROOM).members.get("@invitee:hs"), "invite");
  });

  it("forces a refresh after invalidateMembers", () => {
    const cache = new RoomCache();
    cache.setJoinedMembers(ROOM, ["@a:hs"]);
    cache.invalidateMembers(ROOM);
    assert.equal(cache.hasCompleteMemberList(ROOM), false);
  });

  it("ignores member events without a state key", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, { type: "m.room.member", content: { membership: "join" } });
    assert.deepEqual(cache.joinedMembers(ROOM), []);
  });
});

describe("RoomCache power levels", () => {
  it("falls back to spec defaults", () => {
    const cache = new RoomCache();
    assert.deepEqual(cache.powerLevels(ROOM), DEFAULT_POWER_LEVELS);
    assert.equal(cache.powerLevelOf(ROOM, "@nobody:hs"), 0);
    assert.equal(cache.requiredPowerFor(ROOM, "m.room.message"), 0);
    assert.equal(cache.requiredPowerFor(ROOM, "m.room.topic", true), 50);
  });

  it("parses m.room.power_levels", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(
      ROOM,
      state("m.room.power_levels", {
        users: { "@admin:hs": 100, "@mod:hs": 50, "@bad:hs": "high" },
        users_default: 5,
        events: { "m.reaction": 25 },
        events_default: 10,
        state_default: 70,
        kick: 60,
        notifications: { room: 80 },
      }),
    );
    const levels = cache.powerLevels(ROOM);
    assert.equal(levels.users["@admin:hs"], 100);
    assert.equal(levels.users["@bad:hs"], undefined, "non-numeric levels are ignored");
    assert.equal(levels.usersDefault, 5);
    assert.equal(levels.kick, 60);
    assert.equal(levels.notificationsRoom, 80);
    assert.equal(cache.powerLevelOf(ROOM, "@mod:hs"), 50);
    assert.equal(cache.powerLevelOf(ROOM, "@rando:hs"), 5);
    assert.equal(cache.requiredPowerFor(ROOM, "m.reaction"), 25);
    assert.equal(cache.requiredPowerFor(ROOM, "m.room.message"), 10);
    assert.equal(cache.requiredPowerFor(ROOM, "m.room.name", true), 70);
  });

  it("answers canSend against the parsed levels", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(
      ROOM,
      state("m.room.power_levels", { users: { "@bot:hs": 50 }, events: { "m.room.message": 25 } }),
    );
    assert.equal(cache.canSend(ROOM, "@bot:hs", "m.room.message"), true);
    assert.equal(cache.canSend(ROOM, "@rando:hs", "m.room.message"), false);
    assert.equal(cache.canSend(ROOM, "@bot:hs", "m.room.name", true), true);
  });
});

describe("RoomCache direct rooms", () => {
  it("uses m.direct account data", () => {
    const cache = new RoomCache();
    assert.equal(cache.directLoadedOnce, false);
    cache.applyDirectAccountData({ "@friend:hs": [ROOM], "@other:hs": "not-an-array" });
    assert.equal(cache.directLoadedOnce, true);
    assert.equal(cache.isDirect(ROOM), true);
    assert.deepEqual([...cache.directRoomIds()], [ROOM]);
  });

  it("honours the is_direct invite hint", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(
      ROOM,
      state("m.room.member", { membership: "invite", is_direct: true }, "@bot:hs"),
    );
    assert.equal(cache.isDirect(ROOM), true);
  });

  it("treats a two-person room as direct", () => {
    const cache = new RoomCache();
    cache.setJoinedMembers(ROOM, ["@a:hs", "@b:hs"]);
    assert.equal(cache.isDirect(ROOM), true);
    cache.setJoinedMembers(ROOM, ["@a:hs", "@b:hs", "@c:hs"]);
    assert.equal(cache.isDirect(ROOM), false);
  });

  it("prefers the sync summary count when members are lazy-loaded", () => {
    const cache = new RoomCache();
    cache.applySummary(ROOM, { "m.joined_member_count": 7 });
    assert.equal(cache.isDirect(ROOM), false);
  });

  it("replaces the whole set on each account-data update", () => {
    const cache = new RoomCache();
    cache.applyDirectAccountData({ "@a:hs": [ROOM] });
    cache.applyDirectAccountData({ "@a:hs": ["!other:hs"] });
    assert.equal(cache.isDirect(ROOM), false);
  });
});

describe("RoomCache room state", () => {
  it("collects name, topic, alias, avatar, creator and version", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.name", { name: "General" }));
    cache.applyStateEvent(ROOM, state("m.room.topic", { topic: "Chat" }));
    cache.applyStateEvent(ROOM, state("m.room.canonical_alias", { alias: "#general:hs" }));
    cache.applyStateEvent(ROOM, state("m.room.avatar", { url: "mxc://hs/avatar" }));
    cache.applyStateEvent(ROOM, state("m.room.create", { room_version: "10" }));
    const room = cache.get(ROOM);
    assert.equal(room.name, "General");
    assert.equal(room.topic, "Chat");
    assert.equal(room.canonicalAlias, "#general:hs");
    assert.equal(room.avatarUrl, "mxc://hs/avatar");
    assert.equal(room.creator, "@admin:example.org");
    assert.equal(room.version, "10");
  });

  it("records a tombstone replacement", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, state("m.room.tombstone", { replacement_room: "!new:hs" }));
    assert.equal(cache.get(ROOM).replacedBy, "!new:hs");
  });

  it("tracks history visibility and defaults to shared", () => {
    const cache = new RoomCache();
    assert.equal(cache.historyVisibility(ROOM), "shared");
    cache.applyStateEvent(ROOM, state("m.room.history_visibility", { history_visibility: "invited" }));
    assert.equal(cache.historyVisibility(ROOM), "invited");
    cache.applyStateEvent(ROOM, state("m.room.history_visibility", { history_visibility: "bogus" }));
    assert.equal(cache.historyVisibility(ROOM), "shared");
  });

  it("ignores events with no type", () => {
    const cache = new RoomCache();
    cache.applyStateEvent(ROOM, { content: {} });
    assert.equal(cache.size, 0);
  });
});

describe("RoomCache bookkeeping", () => {
  it("evicts the least recently used room past capacity", () => {
    const cache = new RoomCache(2);
    cache.ensure("!a:hs");
    cache.ensure("!b:hs");
    cache.get("!a:hs");
    cache.ensure("!c:hs");
    assert.equal(cache.size, 2);
    assert.equal(cache.get("!b:hs"), undefined);
    assert.ok(cache.get("!a:hs"));
  });

  it("forgets a room entirely", () => {
    const cache = new RoomCache();
    cache.applyDirectAccountData({ "@a:hs": [ROOM] });
    cache.ensure(ROOM);
    cache.forget(ROOM);
    assert.equal(cache.get(ROOM), undefined);
    assert.equal(cache.isDirect(ROOM), false);
  });
});
