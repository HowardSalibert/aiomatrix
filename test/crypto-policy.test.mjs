import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEncryptionSharePolicy,
  DEFAULT_ENCRYPTION_SHARE_POLICY,
} from "../dist/crypto.js";
import { RoomKeyWithheldError } from "../dist/errors.js";

describe("resolveEncryptionSharePolicy", () => {
  it("defaults to bot-friendly unverified sharing", () => {
    assert.deepEqual(resolveEncryptionSharePolicy(), {
      onlyAllowTrustedDevices: false,
      errorOnVerifiedUserProblem: false,
    });
    assert.deepEqual(
      resolveEncryptionSharePolicy(null),
      DEFAULT_ENCRYPTION_SHARE_POLICY,
    );
  });

  it("merges partial overrides", () => {
    assert.deepEqual(
      resolveEncryptionSharePolicy({ onlyAllowTrustedDevices: true }),
      {
        onlyAllowTrustedDevices: true,
        errorOnVerifiedUserProblem: false,
      },
    );
    assert.deepEqual(
      resolveEncryptionSharePolicy({
        onlyAllowTrustedDevices: true,
        errorOnVerifiedUserProblem: true,
      }),
      {
        onlyAllowTrustedDevices: true,
        errorOnVerifiedUserProblem: true,
      },
    );
  });
});

describe("RoomKeyWithheldError", () => {
  it("exposes roomId, withheld count, and policy snapshot", () => {
    const policy = {
      onlyAllowTrustedDevices: false,
      errorOnVerifiedUserProblem: false,
    };
    const err = new RoomKeyWithheldError("!room:hs", 3, policy);
    assert.equal(err.name, "RoomKeyWithheldError");
    assert.equal(err.roomId, "!room:hs");
    assert.equal(err.withheld, 3);
    assert.deepEqual(err.policy, policy);
    assert.match(err.message, /0 key shares/);
    assert.match(err.message, /3 withheld/);
    assert.match(err.message, /onlyAllowTrustedDevices=false/);
  });
});
