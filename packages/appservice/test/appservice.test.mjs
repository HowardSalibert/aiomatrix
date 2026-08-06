import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Appservice,
  buildRegistration,
  generateAppserviceToken,
  registrationToYaml,
} from "../dist/index.js";

async function request(port, method, path, { token, body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

describe("appservice", () => {
  it("buildRegistration + yaml", () => {
    const reg = buildRegistration({
      id: "aio",
      url: "http://127.0.0.1:8090",
      asToken: "as",
      hsToken: "hs",
      senderLocalpart: "bot",
    });
    assert.equal(reg.as_token, "as");
    const yaml = registrationToYaml(reg);
    assert.match(yaml, /as_token: "as"/);
    assert.match(yaml, /sender_localpart: "bot"/);
  });

  it("generateAppserviceToken is stable length", () => {
    assert.equal(generateAppserviceToken("seed").length, 64);
  });

  it("rejects bad hs_token", async () => {
    const as = new Appservice({
      hsToken: "good",
      asToken: "as",
      homeserverUrl: "http://example.org",
      port: 0,
    });
    const { port } = await as.listen();
    try {
      const bad = await request(port, "PUT", "/_matrix/app/v1/transactions/t1", {
        token: "bad",
        body: { events: [] },
      });
      assert.equal(bad.status, 401);
    } finally {
      await as.close();
    }
  });

  it("accepts transactions idempotently", async () => {
    const seen = [];
    const as = new Appservice({
      hsToken: "hs",
      asToken: "as",
      homeserverUrl: "http://example.org",
      port: 0,
      handlers: {
        onTransaction: async (txnId, events) => {
          seen.push({ txnId, n: events.length });
        },
      },
    });
    const { port } = await as.listen();
    try {
      const body = {
        events: [{ type: "m.room.message", room_id: "!r:hs", content: { body: "hi" } }],
      };
      const a = await request(port, "PUT", "/_matrix/app/v1/transactions/txn-1", {
        token: "hs",
        body,
      });
      const b = await request(port, "PUT", "/_matrix/app/v1/transactions/txn-1", {
        token: "hs",
        body,
      });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].n, 1);
    } finally {
      await as.close();
    }
  });

  it("query user namespace", async () => {
    const as = new Appservice({
      hsToken: "hs",
      asToken: "as",
      homeserverUrl: "http://example.org",
      port: 0,
      handlers: {
        onQueryUser: (id) => id === "@bot:example.org",
      },
    });
    const { port } = await as.listen();
    try {
      const ok = await request(port, "GET", "/_matrix/app/v1/users/%40bot%3Aexample.org", {
        token: "hs",
      });
      const miss = await request(
        port,
        "GET",
        "/_matrix/app/v1/users/%40other%3Aexample.org",
        { token: "hs" },
      );
      assert.equal(ok.status, 200);
      assert.equal(miss.status, 404);
    } finally {
      await as.close();
    }
  });
});
