/**
 * Unit coverage for crypto.ts surfaces that do not require a live homeserver.
 * Native OlmMachine paths still run in live Megolm CI.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_ENCRYPTION_SHARE_POLICY,
  createDefaultLogger,
  resolveCryptoStorePassphrase,
  resolveEncryptionSharePolicy,
  shouldRotateEveryMessage,
} from "../dist/index.js";

const silent = createDefaultLogger("silent");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-crypto-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("crypto.ts support surfaces", () => {
  it("keeps default share policy stable for small rooms", () => {
    const policy = resolveEncryptionSharePolicy();
    assert.equal(policy.rotateEveryMessage, DEFAULT_ENCRYPTION_SHARE_POLICY.rotateEveryMessage);
    assert.equal(shouldRotateEveryMessage(policy, 2), true);
    assert.equal(shouldRotateEveryMessage(policy, 64), false);
  });

  it("persists crypto passphrase beside the store path root", () => {
    const pass = resolveCryptoStorePassphrase(dir, undefined, { logger: silent });
    assert.ok(fs.existsSync(path.join(dir, "crypto-passphrase.json")));
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, "crypto-passphrase.json"), "utf8")).passphrase,
      pass,
    );
  });
});
