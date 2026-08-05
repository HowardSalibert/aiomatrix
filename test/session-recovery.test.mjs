import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DeviceMismatchError,
  MatrixHttp,
  clearSession,
  createDefaultLogger,
  createSessionRefreshHandler,
  diagnoseSession,
  loadPersistedDeviceId,
  resolveCryptoStorePassphrase,
  savePersistedDeviceId,
  saveSession,
  wipeCryptoStore,
} from "../dist/index.js";

const silent = createDefaultLogger("silent");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-session-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("session recovery helpers", () => {
  it("diagnoses an empty storage path", () => {
    const d = diagnoseSession(dir);
    assert.equal(d.hasSession, false);
    assert.equal(d.hasCryptoStore, false);
    assert.equal(d.deviceId, null);
    assert.equal(d.suggestedAction, "password_relogin");
  });

  it("persists and loads device id", () => {
    savePersistedDeviceId(dir, "DEVICEA");
    assert.equal(loadPersistedDeviceId(dir), "DEVICEA");
  });

  it("wipes only the crypto store", () => {
    fs.mkdirSync(path.join(dir, "crypto"), { recursive: true });
    fs.writeFileSync(path.join(dir, "crypto", "x"), "1");
    saveSession(dir, {
      userId: "@bot:example.org",
      deviceId: "DEVICEA",
      accessToken: "syt_token",
      homeserverUrl: "https://example.org",
    });
    wipeCryptoStore(dir);
    assert.equal(fs.existsSync(path.join(dir, "crypto")), false);
    assert.equal(fs.existsSync(path.join(dir, "session.json")), true);
  });

  it("suggests wipe when crypto exists without a session", () => {
    fs.mkdirSync(path.join(dir, "crypto"), { recursive: true });
    const d = diagnoseSession(dir);
    assert.equal(d.suggestedAction, "wipe_crypto_and_relogin");
  });

  it("DeviceMismatchError exposes recovery metadata", () => {
    const err = new DeviceMismatchError("A", "B", { storagePath: dir, keepDeviceId: "B" });
    assert.equal(err.recovery.suggested, "wipe_crypto_and_new_device");
    assert.deepEqual(err.recovery.wipePaths, ["crypto"]);
    assert.equal(err.recovery.keepDeviceId, "B");
    assert.ok(err.recovery.steps.length >= 3);
    assert.match(err.message, /Suggested:/);
    void silent;
    clearSession(dir);
  });

  it("generates and persists a crypto store passphrase", () => {
    const a = resolveCryptoStorePassphrase(dir, undefined, { logger: silent });
    const b = resolveCryptoStorePassphrase(dir, undefined, { logger: silent });
    assert.ok(a && a.length >= 16);
    assert.equal(a, b);
    assert.equal(resolveCryptoStorePassphrase(dir, "explicit-secret", { logger: silent }), "explicit-secret");
    assert.equal(
      resolveCryptoStorePassphrase(dir, undefined, { allowUnencrypted: true, logger: silent }),
      null,
    );
  });

  it("refreshes access tokens via createSessionRefreshHandler", async () => {
    saveSession(dir, {
      userId: "@bot:example.org",
      deviceId: "DEVICEA",
      accessToken: "old",
      refreshToken: "refresh-1",
      homeserverUrl: "https://example.org",
    });
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url: String(url), body: init?.body };
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "refresh-2",
          expires_in_ms: 60_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const handler = createSessionRefreshHandler({
      storagePath: dir,
      homeserverUrl: "https://example.org",
      logger: silent,
      fetchImpl,
    });
    const token = await handler(new Error("401"));
    assert.equal(token, "new-access");
    assert.match(seen.url, /\/refresh$/);
    const session = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
    assert.equal(session.accessToken, "new-access");
    assert.equal(session.refreshToken, "refresh-2");
  });

  it("password-relogins when refresh is unavailable", async () => {
    saveSession(dir, {
      userId: "@bot:example.org",
      deviceId: "DEVICEA",
      accessToken: "old",
      homeserverUrl: "https://hs.example.org",
    });
    savePersistedDeviceId(dir, "DEVICEA");
    let homeserverMovedTo = null;
    const fetchImpl = async (url, init) => {
      const pathName = String(url);
      if (pathName.includes("/login")) {
        return new Response(
          JSON.stringify({
            user_id: "@bot:example.org",
            device_id: "DEVICEA",
            access_token: "password-access",
            refresh_token: "refresh-new",
            well_known: { "m.homeserver": { base_url: "https://delegated.example.org" } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const handler = createSessionRefreshHandler({
      storagePath: dir,
      homeserverUrl: () => "https://hs.example.org",
      onHomeserverUrl: (url) => {
        homeserverMovedTo = url;
      },
      logger: silent,
      fetchImpl,
      password: "secret",
      userId: "@bot:example.org",
      autoRelogin: true,
      allowInsecure: true,
    });
    const token = await handler(new Error("401"));
    assert.equal(token, "password-access");
    assert.equal(homeserverMovedTo, "https://delegated.example.org");
    void MatrixHttp;
  });
});
