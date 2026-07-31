import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CryptoNotReadyError,
  assertOwnDeviceKeysReady,
  hasOwnDeviceKeys,
  countDevicesForUser,
} from "../dist/index.js";

describe("crypto-guard helpers", () => {
  it("hasOwnDeviceKeys requires a non-empty keys map", () => {
    assert.equal(
      hasOwnDeviceKeys(
        { device_keys: { "@u:x": { DEV: { keys: { "ed25519:DEV": "abc" } } } } },
        "@u:x",
        "DEV",
      ),
      true,
    );
    assert.equal(
      hasOwnDeviceKeys({ device_keys: { "@u:x": { DEV: { keys: {} } } } }, "@u:x", "DEV"),
      false,
    );
  });

  it("countDevicesForUser counts published devices", () => {
    assert.equal(
      countDevicesForUser(
        { device_keys: { "@u:x": { A: {}, B: {} } } },
        "@u:x",
      ),
      2,
    );
    assert.equal(countDevicesForUser({}, "@u:x"), 0);
  });

  it("assertOwnDeviceKeysReady retries then succeeds", async () => {
    let calls = 0;
    const client = {
      async doRequest() {
        calls += 1;
        if (calls < 3) return { device_keys: {} };
        return {
          device_keys: {
            "@bot:example.org": {
              DEVICE: { keys: { "curve25519:DEVICE": "x", "ed25519:DEVICE": "y" } },
            },
          },
        };
      },
    };
    await assertOwnDeviceKeysReady(client, "@bot:example.org", "DEVICE");
    assert.equal(calls, 3);
  });

  it("assertOwnDeviceKeysReady throws after exhausting retries", async () => {
    const client = {
      async doRequest() {
        return { device_keys: {} };
      },
    };
    await assert.rejects(
      assertOwnDeviceKeysReady(client, "@bot:example.org", "DEVICE"),
      CryptoNotReadyError,
    );
  });
});
