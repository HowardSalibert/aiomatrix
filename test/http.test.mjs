import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AuthenticationError,
  MatrixApiError,
  MatrixHttp,
  RateLimitedError,
  RequestTimeoutError,
  normalizeHomeserverUrl,
} from "../dist/index.js";
import { mockFetch } from "./helpers.mjs";

function http(responses, options = {}) {
  const fetchImpl = mockFetch(responses);
  const client = new MatrixHttp("https://hs.example.org", {
    accessToken: "tok",
    fetchImpl,
    retryBaseMs: 1,
    maxRetryDelayMs: 5,
    logLevel: "silent",
    ...options,
  });
  return { client, fetchImpl };
}

describe("normalizeHomeserverUrl", () => {
  it("adds https and strips trailing slashes", () => {
    assert.equal(normalizeHomeserverUrl("hs.example.org"), "https://hs.example.org");
    assert.equal(normalizeHomeserverUrl("https://hs.example.org///"), "https://hs.example.org");
  });

  it("keeps an explicit port and path prefix", () => {
    assert.equal(
      normalizeHomeserverUrl("https://hs.example.org:8448/_matrix_proxy"),
      "https://hs.example.org:8448/_matrix_proxy",
    );
  });

  it("rejects empty and non-http schemes", () => {
    assert.throws(() => normalizeHomeserverUrl("   "), /must not be empty/);
    assert.throws(() => normalizeHomeserverUrl("ftp://hs.example.org"), /http\(s\)/);
  });
});

describe("MatrixHttp", () => {
  it("sends the bearer token and parses JSON", async () => {
    const { client, fetchImpl } = http([{ body: { user_id: "@bot:hs" } }]);
    const out = await client.request("GET", "/_matrix/client/v3/account/whoami");
    assert.deepEqual(out, { user_id: "@bot:hs" });
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer tok");
    assert.match(fetchImpl.calls[0].url, /^https:\/\/hs\.example\.org\/_matrix/);
  });

  it("omits the token for anonymous requests", async () => {
    const { client, fetchImpl } = http([{ body: {} }]);
    await client.request("GET", "/.well-known/matrix/client", null, undefined, {
      anonymous: true,
    });
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
  });

  it("appends query parameters and skips null/undefined", async () => {
    const { client, fetchImpl } = http([{ body: {} }]);
    await client.request("GET", "/x", { since: "s1", limit: 10, filter: null, extra: undefined });
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.searchParams.get("since"), "s1");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("filter"), null);
    assert.equal(url.searchParams.get("extra"), null);
  });

  it("keeps the access token out of enumerable state", async () => {
    const { client } = http([{ body: {} }]);
    assert.ok(!JSON.stringify(client).includes("tok"));
    assert.ok(!Object.keys(client).includes("accessToken"));
    assert.equal(client.hasAccessToken(), true);
  });

  it("raises MatrixApiError with errcode for 4xx", async () => {
    const { client } = http([
      { status: 403, body: { errcode: "M_FORBIDDEN", error: "not allowed" } },
    ]);
    await assert.rejects(client.request("GET", "/x"), (err) => {
      assert.ok(err instanceof MatrixApiError);
      assert.equal(err.status, 403);
      assert.equal(err.errcode, "M_FORBIDDEN");
      assert.match(err.message, /M_FORBIDDEN: not allowed/);
      return true;
    });
  });

  it("does not retry a 4xx", async () => {
    const { client, fetchImpl } = http([{ status: 400, body: { errcode: "M_BAD_JSON" } }]);
    await assert.rejects(client.request("GET", "/x"));
    assert.equal(fetchImpl.calls.length, 1);
  });

  it("honours retry_after_ms on 429 and then succeeds", async () => {
    let calls = 0;
    const { client } = http([
      () => {
        calls += 1;
        return calls === 1
          ? { status: 429, body: { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 5 } }
          : { body: { ok: true } };
      },
    ]);
    assert.deepEqual(await client.request("POST", "/x", null, {}), { ok: true });
    assert.equal(calls, 2);
  });

  it("retries a 429 even for non-idempotent methods", async () => {
    let calls = 0;
    const { client } = http([
      () => {
        calls += 1;
        return calls < 3 ? { status: 429, body: { retry_after_ms: 1 } } : { body: { ok: 1 } };
      },
    ]);
    await client.request("POST", "/send", null, {}, { idempotent: false });
    assert.equal(calls, 3);
  });

  it("reads Retry-After seconds from the header", () => {
    const err = new MatrixApiError(429, { errcode: "M_LIMIT_EXCEEDED" }, 2000);
    assert.equal(err.retryAfterMs, 2000);
    assert.equal(err.isRateLimit, true);
  });

  it("gives up on 429 after the retry budget with RateLimitedError", async () => {
    const { client, fetchImpl } = http([{ status: 429, body: { retry_after_ms: 1 } }], {
      maxRetries: 2,
    });
    await assert.rejects(client.request("GET", "/x"), RateLimitedError);
    assert.equal(fetchImpl.calls.length, 3);
  });

  it("retries 5xx for idempotent requests only", async () => {
    const retried = http([{ status: 502, body: "bad gateway" }], { maxRetries: 1 });
    await assert.rejects(retried.client.request("GET", "/x"));
    assert.equal(retried.fetchImpl.calls.length, 2);

    const notRetried = http([{ status: 502, body: "bad gateway" }], { maxRetries: 3 });
    await assert.rejects(
      notRetried.client.request("POST", "/x", null, {}, { idempotent: false }),
    );
    assert.equal(notRetried.fetchImpl.calls.length, 1);
  });

  it("retries a network failure for idempotent requests", async () => {
    let calls = 0;
    const { client } = http([
      () => {
        calls += 1;
        if (calls === 1) return Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" });
        return { body: { ok: 1 } };
      },
    ]);
    assert.deepEqual(await client.request("GET", "/x"), { ok: 1 });
    assert.equal(calls, 2);
  });

  it("times out a hung request", async () => {
    const { client } = http(
      [
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ],
      { timeoutMs: 20, maxRetries: 0 },
    );
    await assert.rejects(client.request("GET", "/x"), RequestTimeoutError);
  });

  it("respects an external AbortSignal", async () => {
    const controller = new AbortController();
    const { client } = http([
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    ]);
    const pending = client.request("GET", "/x", null, undefined, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
  });

  it("refreshes the token once on 401 and replays the request", async () => {
    let calls = 0;
    let refreshes = 0;
    const { client, fetchImpl } = http(
      [
        () => {
          calls += 1;
          return calls === 1
            ? { status: 401, body: { errcode: "M_UNKNOWN_TOKEN", soft_logout: true } }
            : { body: { ok: 1 } };
        },
      ],
      {
        onTokenExpired: async () => {
          refreshes += 1;
          return "fresh-token";
        },
      },
    );
    assert.deepEqual(await client.request("GET", "/x"), { ok: 1 });
    assert.equal(refreshes, 1);
    assert.equal(fetchImpl.calls[1].init.headers.Authorization, "Bearer fresh-token");
  });

  it("surfaces AuthenticationError when refresh is impossible", async () => {
    const { client } = http([{ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }]);
    await assert.rejects(client.request("GET", "/x"), (err) => {
      assert.ok(err instanceof AuthenticationError);
      return true;
    });
  });

  it("does not loop when the refreshed token is also rejected", async () => {
    const { client, fetchImpl } = http([{ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }], {
      onTokenExpired: async () => "still-bad",
    });
    await assert.rejects(client.request("GET", "/x"), AuthenticationError);
    assert.equal(fetchImpl.calls.length, 2);
  });

  it("returns raw bytes when asked", async () => {
    const { client } = http([
      { body: "binary-ish", headers: { "content-type": "application/octet-stream" } },
    ]);
    const bytes = await client.requestBytes("GET", "/media");
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(Buffer.from(bytes).toString(), "binary-ish");
  });

  it("sends a raw body with an explicit content type", async () => {
    const { client, fetchImpl } = http([{ body: { content_uri: "mxc://hs/a" } }]);
    await client.request("POST", "/upload", null, undefined, {
      rawBody: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });
    assert.equal(fetchImpl.calls[0].init.headers["Content-Type"], "image/png");
    assert.equal(fetchImpl.calls[0].init.body.length, 3);
  });

  it("mints unique transaction ids", () => {
    const { client } = http([{ body: {} }]);
    const ids = new Set([client.txnId(), client.txnId(), client.txnId()]);
    assert.equal(ids.size, 3);
    // A fresh process must not reuse ids from a previous run.
    const other = new MatrixHttp("https://hs.example.org", { fetchImpl: mockFetch([{ body: {} }]) });
    assert.notEqual(client.txnId().split(".")[0], other.txnId().split(".")[0]);
  });

  it("reports telemetry for each attempt", async () => {
    const seen = [];
    let calls = 0;
    const { client } = http(
      [
        () => {
          calls += 1;
          return calls === 1 ? { status: 500, body: "boom" } : { body: { ok: 1 } };
        },
      ],
      { onRequest: (info) => seen.push(info) },
    );
    await client.request("GET", "/x");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].status, 500);
    assert.equal(seen[1].retried, true);
  });
});
