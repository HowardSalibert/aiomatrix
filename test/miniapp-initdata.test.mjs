import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryNonceStore,
  MiniAppAuthError,
  buildDataCheckString,
  buildMiniAppLaunchUrl,
  createInitData,
  isMiniAppUrlAllowed,
  validateInitData,
} from "../dist/index.js";

const SECRET = "test-secret-with-enough-entropy";

function sign(overrides = {}) {
  return createInitData(
    {
      user: { id: "@alice:example.org", username: "alice" },
      room: { id: "!room:example.org", type: "group" },
      query_id: "q-1",
      bot_id: "@bot:example.org",
      ...overrides,
    },
    SECRET,
  );
}

describe("MiniApp initData", () => {
  it("round-trips a signed payload", () => {
    const signed = sign();
    const validated = validateInitData(signed.initData, SECRET);
    assert.equal(validated.user.id, "@alice:example.org");
    assert.equal(validated.room.id, "!room:example.org");
    assert.equal(validated.queryId, "q-1");
    assert.equal(validated.botId, "@bot:example.org");
    assert.ok(validated.nonce.length > 0);
  });

  it("rejects a tampered field", () => {
    const signed = sign();
    const params = new URLSearchParams(signed.initData);
    params.set("user", JSON.stringify({ id: "@attacker:example.org" }));
    assert.throws(
      () => validateInitData(params.toString(), SECRET),
      (err) => err instanceof MiniAppAuthError && err.reason === "bad_signature",
    );
  });

  it("rejects a different secret", () => {
    const signed = sign();
    assert.throws(
      () => validateInitData(signed.initData, "another-secret-entirely!!"),
      (err) => err.reason === "bad_signature",
    );
  });

  it("rejects a missing hash", () => {
    const signed = sign();
    const params = new URLSearchParams(signed.initData);
    params.delete("hash");
    assert.throws(
      () => validateInitData(params.toString(), SECRET),
      (err) => err.reason === "missing_hash",
    );
  });

  it("rejects an expired auth_date", () => {
    const old = Math.floor(Date.now() / 1000) - 7200;
    const signed = sign({ auth_date: old });
    assert.throws(
      () => validateInitData(signed.initData, SECRET, { ttlSeconds: 3600 }),
      (err) => err.reason === "expired",
    );
    // Still valid with a longer window.
    assert.ok(validateInitData(signed.initData, SECRET, { ttlSeconds: 10800 }));
  });

  it("rejects an auth_date far in the future", () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const signed = sign({ auth_date: future });
    assert.throws(
      () => validateInitData(signed.initData, SECRET),
      (err) => err.reason === "malformed",
    );
  });

  it("rejects a replayed nonce when a store is supplied", () => {
    const signed = sign();
    const nonceStore = new MemoryNonceStore();
    assert.ok(validateInitData(signed.initData, SECRET, { nonceStore }));
    assert.throws(
      () => validateInitData(signed.initData, SECRET, { nonceStore }),
      (err) => err.reason === "replayed",
    );
  });

  it("refuses to sign with a weak secret", () => {
    assert.throws(() => createInitData({ user: { id: "@a:b" } }, "short"), MiniAppAuthError);
  });

  it("excludes hash from the data-check string and sorts keys", () => {
    const checked = buildDataCheckString({ b: "2", a: "1", hash: "zzz" });
    assert.equal(checked, "a=1\nb=2");
  });

  it("puts launch data in the URL fragment, never the query string", () => {
    const signed = sign();
    const url = buildMiniAppLaunchUrl("https://app.example.org/start?x=1", signed);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("matrixWebAppData"), null);
    assert.equal(parsed.searchParams.get("x"), "1");
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    assert.equal(fragment.get("matrixWebAppData"), signed.initData);
  });
});

describe("isMiniAppUrlAllowed", () => {
  it("allows an allowlisted https origin", () => {
    assert.equal(
      isMiniAppUrlAllowed("https://app.example.org/x", ["https://app.example.org"]),
      true,
    );
  });

  it("rejects other origins, plain http and javascript URLs", () => {
    assert.equal(isMiniAppUrlAllowed("https://evil.example/x", ["https://app.example.org"]), false);
    assert.equal(isMiniAppUrlAllowed("http://app.example.org/x", ["http://app.example.org"]), false);
    assert.equal(isMiniAppUrlAllowed("javascript:alert(1)", ["*"]), false);
  });

  it("allows http on localhost for development", () => {
    assert.equal(isMiniAppUrlAllowed("http://localhost:3000/", ["http://localhost:3000"]), true);
  });

  it("rejects everything when the allowlist is empty", () => {
    assert.equal(isMiniAppUrlAllowed("https://app.example.org", []), false);
  });
});
