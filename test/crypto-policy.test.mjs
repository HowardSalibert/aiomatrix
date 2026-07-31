import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEncryptionSharePolicy,
  DEFAULT_ENCRYPTION_SHARE_POLICY,
  filterShareRecipients,
  parseToDeviceRecipients,
} from "../dist/crypto.js";
import { RoomKeyWithheldError } from "../dist/errors.js";

describe("resolveEncryptionSharePolicy", () => {
  it("shares with unverified devices and rotates per message by default", () => {
    const policy = resolveEncryptionSharePolicy();
    assert.deepEqual(policy, DEFAULT_ENCRYPTION_SHARE_POLICY);
    assert.equal(policy.onlyAllowTrustedDevices, false);
    assert.equal(policy.errorOnVerifiedUserProblem, false);
    // Default true: avoids "bot reply decrypts only after the user's next
    // message" when peers wipe crypto and the machine skips an already-shared
    // Megolm session. Large rooms may opt out explicitly.
    assert.equal(policy.rotateEveryMessage, true);
    assert.equal(policy.rotationPeriodMessages, 100);
    assert.equal(policy.rotationPeriodMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(policy.reshareOnDeviceChange, true);
    assert.deepEqual(resolveEncryptionSharePolicy(null), DEFAULT_ENCRYPTION_SHARE_POLICY);
  });

  it("merges partial overrides onto the defaults", () => {
    assert.deepEqual(resolveEncryptionSharePolicy({ onlyAllowTrustedDevices: true }), {
      ...DEFAULT_ENCRYPTION_SHARE_POLICY,
      onlyAllowTrustedDevices: true,
    });
    assert.deepEqual(
      resolveEncryptionSharePolicy({
        rotateEveryMessage: true,
        rotationPeriodMessages: 10,
      }),
      {
        ...DEFAULT_ENCRYPTION_SHARE_POLICY,
        rotateEveryMessage: true,
        rotationPeriodMessages: 10,
      },
    );
  });
});

describe("filterShareRecipients", () => {
  it("drops self and keeps peers", () => {
    assert.deepEqual(
      filterShareRecipients("@bot:hs", ["@bot:hs", "@admin:hs", "@other:hs"]),
      ["@admin:hs", "@other:hs"],
    );
  });

  it("returns copy when self absent or empty selfId", () => {
    assert.deepEqual(filterShareRecipients("@bot:hs", ["@admin:hs"]), [
      "@admin:hs",
    ]);
    assert.deepEqual(filterShareRecipients("", ["@a:hs", "@b:hs"]), [
      "@a:hs",
      "@b:hs",
    ]);
  });
});

describe("parseToDeviceRecipients", () => {
  it("parses messages map into userId/deviceId", () => {
    const body = {
      messages: {
        "@admin:hs": { WJHLDLREEK: { algorithm: "m.megolm.v1.aes-sha2" } },
        "@other:hs": { ABC: {}, DEF: {} },
      },
    };
    assert.deepEqual(parseToDeviceRecipients(body), [
      "@admin:hs/WJHLDLREEK",
      "@other:hs/ABC",
      "@other:hs/DEF",
    ]);
  });

  it("accepts JSON string and bare user→device map", () => {
    assert.deepEqual(
      parseToDeviceRecipients(
        JSON.stringify({
          messages: { "@u:hs": { DEV1: {} } },
        }),
      ),
      ["@u:hs/DEV1"],
    );
    assert.deepEqual(parseToDeviceRecipients({ "@u:hs": { D: { x: 1 } } }), [
      "@u:hs/D",
    ]);
  });

  it("returns empty on bad input", () => {
    assert.deepEqual(parseToDeviceRecipients(null), []);
    assert.deepEqual(parseToDeviceRecipients("not-json"), []);
  });
});

describe("RoomKeyWithheldError", () => {
  it("exposes roomId, withheld count, and policy snapshot", () => {
    const policy = {
      onlyAllowTrustedDevices: false,
      errorOnVerifiedUserProblem: false,
      rotateEveryMessage: true,
    };
    const err = new RoomKeyWithheldError("!room:hs", 3, policy);
    assert.equal(err.name, "RoomKeyWithheldError");
    assert.equal(err.roomId, "!room:hs");
    assert.equal(err.withheld, 3);
    assert.deepEqual(err.policy, policy);
    assert.match(err.message, /0 key shares/);
    assert.match(err.message, /3 withheld/);
    assert.match(err.message, /onlyAllowTrustedDevices=false/);
    assert.match(err.message, /errorOnVerifiedUserProblem=false/);
    assert.match(err.message, /rotateEveryMessage=true/);
  });
});
