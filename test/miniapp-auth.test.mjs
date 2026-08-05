import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MiniAppAuthError,
  MiniAppServer,
  assertMiniAppJoined,
  assertMiniAppPower,
  createInitData,
  createSessionToken,
  miniAppHasPower,
  verifySessionToken,
} from "../dist/index.js";

const SECRET = "server-secret-with-entropy-32ch!";
const ORIGIN = "https://app.example.org";

describe("MiniApp room auth helpers", () => {
  it("round-trips membership and powerLevel in session tokens", () => {
    const token = createSessionToken(
      {
        userId: "@alice:example.org",
        roomId: "!room:example.org",
        queryId: null,
        appId: null,
        membership: "join",
        powerLevel: 50,
      },
      SECRET,
    );
    const session = verifySessionToken(token, SECRET);
    assert.equal(session.membership, "join");
    assert.equal(session.powerLevel, 50);
    assertMiniAppJoined(session);
    assertMiniAppPower(session, 50);
    assert.equal(miniAppHasPower(session, 100), false);
  });

  it("fail-closed when powerLevel is missing", () => {
    const session = verifySessionToken(
      createSessionToken(
        {
          userId: "@alice:example.org",
          roomId: "!room:example.org",
          queryId: null,
          appId: null,
        },
        SECRET,
      ),
      SECRET,
    );
    assert.equal(session.powerLevel, null);
    assert.throws(() => assertMiniAppPower(session, 50), MiniAppAuthError);
    assert.throws(() => assertMiniAppJoined(session), MiniAppAuthError);
  });

  it("copies room snapshot into the session on /auth", async () => {
    const app = new MiniAppServer({
      secret: SECRET,
      allowedOrigins: [ORIGIN],
      singleUseLaunch: false,
    });
    const launch = createInitData(
      {
        user: { id: "@alice:example.org" },
        room: {
          id: "!room:example.org",
          type: "group",
          membership: "join",
          power_level: 50,
        },
      },
      SECRET,
    );
    const res = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: { initData: launch.initData },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    const session = verifySessionToken(payload.token, SECRET);
    assert.equal(session.membership, "join");
    assert.equal(session.powerLevel, 50);
    assert.equal(payload.room.power_level, 50);
  });

  it("rejects /auth when minPowerLevel is not met", async () => {
    const app = new MiniAppServer({
      secret: SECRET,
      allowedOrigins: [ORIGIN],
      singleUseLaunch: false,
      minPowerLevel: 50,
    });
    const launch = createInitData(
      {
        user: { id: "@alice:example.org" },
        room: {
          id: "!room:example.org",
          type: "group",
          membership: "join",
          power_level: 0,
        },
      },
      SECRET,
    );
    const res = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN },
      body: { initData: launch.initData },
    });
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error, "forbidden");
  });

  it("serves live /room-auth via resolveRoomAuth", async () => {
    const app = new MiniAppServer({
      secret: SECRET,
      allowedOrigins: [ORIGIN],
      singleUseLaunch: false,
      resolveRoomAuth: async () => ({ membership: "join", powerLevel: 100 }),
    });
    const token = createSessionToken(
      {
        userId: "@alice:example.org",
        roomId: "!room:example.org",
        queryId: null,
        appId: null,
        membership: "join",
        powerLevel: 0,
      },
      SECRET,
    );
    const res = await app.handle({
      method: "GET",
      url: "/room-auth",
      headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.source, "live");
    assert.equal(body.power_level, 100);
  });
});
