import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DeviceMismatchError,
  clearSession,
  createDefaultLogger,
  diagnoseSession,
  loadPersistedDeviceId,
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
});
