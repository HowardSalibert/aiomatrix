import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MiniAppServer,
  createInitData,
  createSessionToken,
  verifySessionToken,
} from "../dist/index.js";

const SECRET = "server-secret-with-entropy-32ch!";
const ORIGIN = "https://app.example.org";

function server(options = {}) {
  return new MiniAppServer({ secret: SECRET, allowedOrigins: [ORIGIN], ...options });
}

function launch(overrides = {}) {
  return createInitData(
    {
      user: { id: "@alice:example.org" },
      room: { id: "!room:example.org", type: "direct" },
      query_id: "q-42",
      ...overrides,
    },
    SECRET,
  );
}

describe("MiniAppServer", () => {
  it("exchanges signed initData for a session token", async () => {
    const app = server();
    const res = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: { initData: launch().initData },
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.user.id, "@alice:example.org");
    assert.equal(payload.query_id, "q-42");
    const session = verifySessionToken(payload.token, SECRET);
    assert.equal(session.userId, "@alice:example.org");
    assert.equal(session.roomId, "!room:example.org");
  });

  it("rejects a bad signature with 401", async () => {
    const app = server();
    const res = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN },
      body: { initData: "user=%7B%22id%22%3A%22%40a%3Ab%22%7D&auth_date=1&hash=deadbeef" },
    });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).error, "bad_signature");
  });

  it("rejects a replayed launch by default", async () => {
    const app = server();
    const initData = launch().initData;
    const first = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN },
      body: { initData },
    });
    assert.equal(first.status, 200);
    const second = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN },
      body: { initData },
    });
    assert.equal(second.status, 401);
    assert.equal(JSON.parse(second.body).error, "replayed");
  });

  it("blocks requests from origins outside the allowlist", async () => {
    const app = server();
    const res = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: "https://evil.example" },
      body: { initData: launch().initData },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });

  it("echoes CORS headers only for allowed origins", async () => {
    const app = server();
    const allowed = await app.handle({ method: "OPTIONS", url: "/auth", headers: { origin: ORIGIN } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN);

    const denied = await app.handle({
      method: "OPTIONS",
      url: "/auth",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  });

  it("routes sendData to onData with the verified session", async () => {
    const received = [];
    const app = server({
      onData: (session, data) => {
        received.push({ session, data });
        return { ack: true };
      },
    });
    const auth = JSON.parse(
      (
        await app.handle({
          method: "POST",
          url: "/auth",
          headers: { origin: ORIGIN },
          body: { initData: launch().initData },
        })
      ).body,
    );
    const res = await app.handle({
      method: "POST",
      url: "/data",
      headers: { origin: ORIGIN, authorization: `Bearer ${auth.token}` },
      body: { data: '{"action":"submit"}' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).result, { ack: true });
    assert.equal(received.length, 1);
    assert.equal(received[0].session.userId, "@alice:example.org");
    assert.equal(received[0].data, '{"action":"submit"}');
  });

  it("refuses sendData without a valid token", async () => {
    const app = server({ onData: () => ({}) });
    const missing = await app.handle({
      method: "POST",
      url: "/data",
      headers: { origin: ORIGIN },
      body: { data: "x" },
    });
    assert.equal(missing.status, 401);

    const forged = await app.handle({
      method: "POST",
      url: "/data",
      headers: { origin: ORIGIN, authorization: "Bearer eyJhIjoxfQ.notavalidmac" },
      body: { data: "x" },
    });
    assert.equal(forged.status, 401);
  });

  it("serves the browser bridge without requiring an origin", async () => {
    const app = server();
    const res = await app.handle({ method: "GET", url: "/bridge.js", headers: {} });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /javascript/);
    assert.match(res.body, /MatrixMiniApp/);
    assert.match(res.body, /Telegram/);
    assert.ok(res.headers.etag);
  });

  it("honours basePath when mounted under a prefix", async () => {
    const app = server({ basePath: "/api/miniapp" });
    const res = await app.handle({ method: "GET", url: "/api/miniapp/bridge.js", headers: {} });
    assert.equal(res.status, 200);
  });

  it("parses a raw string body", async () => {
    const app = server();
    const res = await app.handle({
      method: "POST",
      url: "/auth",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ initData: launch().initData }),
    });
    assert.equal(res.status, 200);
  });
});

describe("session tokens", () => {
  it("rejects an expired token", () => {
    const token = createSessionToken(
      { userId: "@a:b", roomId: null, queryId: null, appId: null, exp: 1 },
      SECRET,
    );
    assert.throws(() => verifySessionToken(token, SECRET), (err) => err.reason === "expired");
  });

  it("rejects a token signed with another secret", () => {
    const token = createSessionToken({ userId: "@a:b", roomId: null, queryId: null, appId: null }, SECRET);
    assert.throws(
      () => verifySessionToken(token, "different-secret-value!!"),
      (err) => err.reason === "bad_signature",
    );
  });
});
