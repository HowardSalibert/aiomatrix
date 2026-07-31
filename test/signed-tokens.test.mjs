import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryUsedTokenStore,
  SignedCallbackRegistry,
  SignedMiniAppQueryRegistry,
} from "../dist/index.js";

const SECRET = "signed-token-secret-32chars!!";

describe("SignedCallbackRegistry", () => {
  const base = { roomId: "!r:example.org", data: "vote:yes" };

  it("resolves on a second registry with the same secret", () => {
    const a = new SignedCallbackRegistry({ secret: SECRET });
    const b = new SignedCallbackRegistry({ secret: SECRET });
    const token = a.issue(base);
    assert.equal(b.peek(token).data, "vote:yes");
    assert.equal(b.resolve(token).roomId, "!r:example.org");
  });

  it("rejects a forged mac", () => {
    const reg = new SignedCallbackRegistry({ secret: SECRET });
    const token = reg.issue(base);
    const [payload] = token.split(".");
    assert.equal(reg.peek(`${payload}.deadbeef`), null);
  });

  it("expires tokens", () => {
    const reg = new SignedCallbackRegistry({ secret: SECRET, ttlMs: 1 });
    const token = reg.issue(base);
    assert.equal(reg.resolve(token, undefined, Date.now() + 50), null);
  });

  it("consumes single-use tokens via a shared used store", () => {
    const used = new MemoryUsedTokenStore();
    const a = new SignedCallbackRegistry({ secret: SECRET, used });
    const b = new SignedCallbackRegistry({ secret: SECRET, used });
    const token = a.issue({ ...base, singleUse: true });
    assert.ok(a.resolve(token));
    assert.equal(b.resolve(token), null);
  });

  it("enforces the owner", () => {
    const reg = new SignedCallbackRegistry({ secret: SECRET });
    const token = reg.issue({ ...base, userId: "@alice:example.org" });
    assert.equal(reg.resolve(token, "@mallory:example.org"), null);
    assert.ok(reg.resolve(token, "@alice:example.org"));
  });

  it("binds message ids locally", () => {
    const reg = new SignedCallbackRegistry({ secret: SECRET });
    const token = reg.issue(base);
    reg.bind([token], "$sent");
    assert.equal(reg.peek(token).messageEventId, "$sent");
  });

  it("revokes for a message", () => {
    const reg = new SignedCallbackRegistry({ secret: SECRET });
    const token = reg.issue({ ...base, messageEventId: "$m1" });
    reg.revokeForMessage("$m1");
    assert.equal(reg.peek(token), null);
  });
});

describe("SignedMiniAppQueryRegistry", () => {
  it("peeks across registries with the same secret", () => {
    const a = new SignedMiniAppQueryRegistry({ secret: SECRET });
    const b = new SignedMiniAppQueryRegistry({ secret: SECRET });
    const issued = a.issue({
      roomId: "!r:example.org",
      userId: "@alice:example.org",
      appId: "shop",
    });
    const peeked = b.peek(issued.queryId);
    assert.equal(peeked.userId, "@alice:example.org");
    assert.equal(peeked.appId, "shop");
  });

  it("claims once across a shared used store", () => {
    const used = new MemoryUsedTokenStore();
    const a = new SignedMiniAppQueryRegistry({ secret: SECRET, used });
    const b = new SignedMiniAppQueryRegistry({ secret: SECRET, used });
    const issued = a.issue({ roomId: "!r:example.org", userId: "@alice:example.org" });
    assert.ok(a.claim(issued.queryId));
    assert.equal(b.claim(issued.queryId), null);
  });

  it("releases a failed claim", () => {
    const used = new MemoryUsedTokenStore();
    const reg = new SignedMiniAppQueryRegistry({ secret: SECRET, used });
    const issued = reg.issue({ roomId: "!r:example.org", userId: "@alice:example.org" });
    assert.ok(reg.claim(issued.queryId));
    reg.release(issued.queryId);
    assert.ok(reg.claim(issued.queryId));
  });

  it("rejects a bad signature", () => {
    const reg = new SignedMiniAppQueryRegistry({ secret: SECRET });
    assert.equal(reg.peek("not.a.token"), null);
  });
});
