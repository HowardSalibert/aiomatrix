import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuthenticationError,
  ConfigurationError,
  DiscoveryError,
  MatrixHttp,
  clearSession,
  createDefaultLogger,
  discoverHomeserver,
  getServerVersions,
  isUserId,
  listDevices,
  loadSession,
  loginWithPassword,
  logout,
  pruneOtherDevices,
  normalizeHomeserverUrl,
  refreshAccessToken,
  saveSession,
  serverNameFromUserId,
} from "../dist/index.js";
import { mockFetch } from "./helpers.mjs";

const silent = createDefaultLogger("silent");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbsession-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("user id helpers", () => {
  it("recognises user ids", () => {
    assert.equal(isUserId("@bot:example.org"), true);
    assert.equal(isUserId("  @bot:example.org  "), true);
    assert.equal(isUserId("@bot:example.org:8448"), true);
    assert.equal(isUserId("example.org"), false);
    assert.equal(isUserId("https://example.org"), false);
    assert.equal(isUserId("@nocolon"), false);
  });

  it("extracts the server name", () => {
    assert.equal(serverNameFromUserId("@bot:example.org"), "example.org");
    assert.equal(serverNameFromUserId("@bot:example.org:8448"), "example.org:8448");
    assert.equal(serverNameFromUserId("bot"), null);
  });
});

describe("normalizeHomeserverUrl", () => {
  it("adds https and strips a trailing slash", () => {
    assert.equal(normalizeHomeserverUrl("example.org", { logger: silent }), "https://example.org");
    assert.equal(
      normalizeHomeserverUrl("https://example.org/", { logger: silent }),
      "https://example.org",
    );
  });

  it("keeps an explicit port and path", () => {
    assert.equal(
      normalizeHomeserverUrl("https://example.org:8448", { logger: silent }),
      "https://example.org:8448",
    );
  });

  it("rejects http unless explicitly allowed", () => {
    assert.throws(() => normalizeHomeserverUrl("http://example.org", { logger: silent }));
    assert.equal(
      normalizeHomeserverUrl("http://example.org", { allowInsecure: true, logger: silent }),
      "http://example.org",
    );
  });

  it("allows plain http on localhost for development", () => {
    assert.equal(
      normalizeHomeserverUrl("http://localhost:8008", { logger: silent }),
      "http://localhost:8008",
    );
  });
});

describe("discoverHomeserver", () => {
  it("passes an explicit URL through untouched", async () => {
    const fetchImpl = mockFetch([{ body: {} }]);
    const result = await discoverHomeserver("https://matrix.example.org", {
      logger: silent,
      fetchImpl,
    });
    assert.deepEqual(result, { homeserverUrl: "https://matrix.example.org", source: "explicit" });
    assert.equal(fetchImpl.calls.length, 0, "no discovery request for an explicit URL");
  });

  it("resolves a server name through .well-known", async () => {
    const fetchImpl = mockFetch([
      {
        body: {
          "m.homeserver": { base_url: "https://matrix.example.org" },
          "m.identity_server": { base_url: "https://vector.im" },
        },
      },
    ]);
    const result = await discoverHomeserver("example.org", { logger: silent, fetchImpl });
    assert.equal(result.homeserverUrl, "https://matrix.example.org");
    assert.equal(result.identityServerUrl, "https://vector.im");
    assert.equal(result.source, "well-known");
    assert.match(fetchImpl.calls[0].url, /^https:\/\/example\.org\/\.well-known\/matrix\/client$/);
  });

  it("resolves a user id through its server name", async () => {
    const fetchImpl = mockFetch([
      { body: { "m.homeserver": { base_url: "https://matrix.example.org" } } },
    ]);
    const result = await discoverHomeserver("@bot:example.org", { logger: silent, fetchImpl });
    assert.equal(result.homeserverUrl, "https://matrix.example.org");
    assert.match(fetchImpl.calls[0].url, /example\.org\/\.well-known/);
  });

  it("falls back to https://<serverName> when discovery 404s", async () => {
    const fetchImpl = mockFetch([{ status: 404, body: { errcode: "M_NOT_FOUND" } }]);
    const result = await discoverHomeserver("example.org", { logger: silent, fetchImpl });
    assert.deepEqual(result, { homeserverUrl: "https://example.org", source: "fallback" });
  });

  it("falls back when the network is down", async () => {
    const fetchImpl = mockFetch([new TypeError("fetch failed")]);
    const result = await discoverHomeserver("example.org", { logger: silent, fetchImpl });
    assert.equal(result.source, "fallback");
  });

  it("falls back when .well-known is malformed", async () => {
    const fetchImpl = mockFetch([{ body: { "m.homeserver": {} } }]);
    const result = await discoverHomeserver("example.org", { logger: silent, fetchImpl });
    assert.equal(result.source, "fallback");
  });

  it("rejects an empty identifier", async () => {
    await assert.rejects(discoverHomeserver("   ", { logger: silent }), DiscoveryError);
  });

  it("normalizes a well-known base_url without a scheme", async () => {
    const fetchImpl = mockFetch([{ body: { "m.homeserver": { base_url: "matrix.example.org" } } }]);
    const result = await discoverHomeserver("example.org", { logger: silent, fetchImpl });
    assert.equal(result.homeserverUrl, "https://matrix.example.org");
  });
});

describe("getServerVersions", () => {
  it("reads versions and unstable features", async () => {
    const http = new MatrixHttp("https://hs.example.org", {
      logger: silent,
      fetchImpl: mockFetch([
        { body: { versions: ["v1.11"], unstable_features: { "org.matrix.msc3440": true } } },
      ]),
    });
    const info = await getServerVersions(http);
    assert.deepEqual(info.versions, ["v1.11"]);
    assert.equal(info.unstableFeatures["org.matrix.msc3440"], true);
  });

  it("tolerates a homeserver that omits both fields", async () => {
    const http = new MatrixHttp("https://hs.example.org", {
      logger: silent,
      fetchImpl: mockFetch([{ body: {} }]),
    });
    const info = await getServerVersions(http);
    assert.deepEqual(info, { versions: [], unstableFeatures: {} });
  });
});

describe("session persistence", () => {
  const session = {
    userId: "@bot:example.org",
    deviceId: "DEV",
    accessToken: "secret",
    homeserverUrl: "https://hs.example.org",
  };

  it("round-trips a session", () => {
    assert.equal(loadSession(dir), null);
    saveSession(dir, session);
    assert.deepEqual(loadSession(dir), session);
  });

  it("keeps refresh metadata", () => {
    saveSession(dir, { ...session, refreshToken: "r", expiresAtMs: 1234 });
    const loaded = loadSession(dir);
    assert.equal(loaded.refreshToken, "r");
    assert.equal(loaded.expiresAtMs, 1234);
  });

  it("rejects an incomplete session file", () => {
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ userId: "@a:hs" }));
    assert.equal(loadSession(dir), null);
  });

  it("survives a corrupt session file", () => {
    fs.writeFileSync(path.join(dir, "session.json"), "{not json");
    assert.equal(loadSession(dir), null);
  });

  it("clears the session", () => {
    saveSession(dir, session);
    clearSession(dir);
    assert.equal(loadSession(dir), null);
    clearSession(dir);
  });

  it("writes the file with owner-only permissions on posix", () => {
    saveSession(dir, session);
    if (process.platform === "win32") return;
    const mode = fs.statSync(path.join(dir, "session.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

describe("loginWithPassword", () => {
  const ok = {
    body: {
      user_id: "@bot:example.org",
      device_id: "DEV1",
      access_token: "tok",
      refresh_token: "ref",
      expires_in_ms: 60_000,
    },
  };

  it("logs in and returns a matching device id", async () => {
    const fetchImpl = mockFetch([ok]);
    const session = await loginWithPassword({
      homeserverUrl: "https://hs.example.org",
      user: "@bot:example.org",
      password: "pw",
      logger: silent,
      fetchImpl,
    });
    assert.equal(session.userId, "@bot:example.org");
    assert.equal(session.deviceId, "DEV1");
    assert.equal(session.accessToken, "tok");
    assert.equal(session.refreshToken, "ref");
    assert.ok(session.expiresAtMs > Date.now());

    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.type, "m.login.password");
    assert.deepEqual(body.identifier, { type: "m.id.user", user: "@bot:example.org" });
    assert.equal(body.refresh_token, true);
  });

  it("accepts a bare localpart", async () => {
    const fetchImpl = mockFetch([ok]);
    await loginWithPassword({
      homeserverUrl: "https://hs.example.org",
      user: "bot",
      password: "pw",
      logger: silent,
      fetchImpl,
    });
    assert.equal(JSON.parse(fetchImpl.calls[0].init.body).identifier.user, "bot");
  });

  it("forwards the device name and a reused device id", async () => {
    const fetchImpl = mockFetch([ok]);
    await loginWithPassword({
      homeserverUrl: "https://hs.example.org",
      user: "bot",
      password: "pw",
      deviceId: "OLD",
      initialDeviceDisplayName: "My bot",
      logger: silent,
      fetchImpl,
    });
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.equal(body.device_id, "OLD");
    assert.equal(body.initial_device_display_name, "My bot");
  });

  it("prefers the homeserver advertised in the login response", async () => {
    const fetchImpl = mockFetch([
      {
        body: {
          ...ok.body,
          well_known: { "m.homeserver": { base_url: "https://real.example.org" } },
        },
      },
    ]);
    const session = await loginWithPassword({
      homeserverUrl: "https://hs.example.org",
      user: "bot",
      password: "pw",
      logger: silent,
      fetchImpl,
    });
    assert.equal(session.homeserverUrl, "https://real.example.org");
  });

  it("requires a password", async () => {
    await assert.rejects(
      loginWithPassword({
        homeserverUrl: "https://hs.example.org",
        user: "bot",
        password: "",
        logger: silent,
      }),
      ConfigurationError,
    );
  });

  it("reports bad credentials as an authentication error", async () => {
    const fetchImpl = mockFetch([{ status: 403, body: { errcode: "M_FORBIDDEN" } }]);
    await assert.rejects(
      loginWithPassword({
        homeserverUrl: "https://hs.example.org",
        user: "bot",
        password: "wrong",
        logger: silent,
        fetchImpl,
      }),
      AuthenticationError,
    );
  });

  it("rejects a truncated login response", async () => {
    const fetchImpl = mockFetch([{ body: { user_id: "@bot:example.org", access_token: "tok" } }]);
    await assert.rejects(
      loginWithPassword({
        homeserverUrl: "https://hs.example.org",
        user: "bot",
        password: "pw",
        logger: silent,
        fetchImpl,
      }),
      /device_id/,
    );
  });
});

describe("token lifecycle", () => {
  it("refreshes an access token", async () => {
    const fetchImpl = mockFetch([
      { body: { access_token: "new", refresh_token: "newref", expires_in_ms: 1_000 } },
    ]);
    const http = new MatrixHttp("https://hs.example.org", { logger: silent, fetchImpl });
    const next = await refreshAccessToken(http, "old");
    assert.equal(next.accessToken, "new");
    assert.equal(next.refreshToken, "newref");
    assert.ok(next.expiresAtMs > Date.now());
    assert.equal(JSON.parse(fetchImpl.calls[0].init.body).refresh_token, "old");
  });

  it("fails loudly when the refresh response has no token", async () => {
    const http = new MatrixHttp("https://hs.example.org", {
      logger: silent,
      fetchImpl: mockFetch([{ body: {} }]),
    });
    await assert.rejects(refreshAccessToken(http, "old"), AuthenticationError);
  });

  it("logs out", async () => {
    const fetchImpl = mockFetch([{ body: {} }]);
    const http = new MatrixHttp("https://hs.example.org", {
      accessToken: "tok",
      logger: silent,
      fetchImpl,
    });
    await logout(http);
    assert.match(fetchImpl.calls[0].url, /\/logout$/);
  });

  it("lists devices and tolerates a malformed response", async () => {
    const http = new MatrixHttp("https://hs.example.org", {
      accessToken: "tok",
      logger: silent,
      fetchImpl: mockFetch([
        { body: { devices: [{ device_id: "A" }, "junk"] } },
        { body: { nope: true } },
      ]),
    });
    assert.deepEqual(await listDevices(http), [{ device_id: "A" }]);
    assert.deepEqual(await listDevices(http), []);
  });

  it("prunes other devices while keeping the current one", async () => {
    const fetchImpl = mockFetch([
      {
        body: {
          devices: [
            { device_id: "KEEP", last_seen_ts: Date.now() },
            { device_id: "OLD", last_seen_ts: 1 },
            { device_id: "GHOST" },
          ],
        },
      },
      { body: {} },
    ]);
    const http = new MatrixHttp("https://hs.example.org", {
      accessToken: "tok",
      logger: silent,
      fetchImpl,
    });
    const result = await pruneOtherDevices(http, {
      keepDeviceId: "KEEP",
      auth: { type: "m.login.password", password: "pw" },
    });
    assert.deepEqual(result.deleted.sort(), ["GHOST", "OLD"]);
    assert.equal(result.kept, "KEEP");
    assert.match(fetchImpl.calls[1].url, /\/delete_devices$/);
    assert.deepEqual(JSON.parse(fetchImpl.calls[1].init.body).devices.sort(), [
      "GHOST",
      "OLD",
    ]);
  });
});
