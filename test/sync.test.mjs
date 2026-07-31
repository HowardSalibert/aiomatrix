import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MatrixHttp,
  SyncLoop,
  buildBootstrapFilter,
  buildRuntimeFilter,
  createDefaultLogger,
  loadSyncState,
  saveSyncState,
} from "../dist/index.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbsync-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sync filters", () => {
  it("bootstrap asks for state but no timeline", () => {
    const filter = buildBootstrapFilter();
    assert.equal(filter.room.timeline.limit, 0);
    assert.equal(filter.room.state.lazy_load_members, true);
    assert.deepEqual(filter.presence, { limit: 0, types: [] });
  });

  it("runtime asks for a bounded timeline and trims noise by default", () => {
    const filter = buildRuntimeFilter();
    assert.equal(filter.room.timeline.limit, 50);
    assert.deepEqual(filter.room.ephemeral, { limit: 0, types: [] });
    assert.deepEqual(filter.presence, { limit: 0, types: [] });
    assert.equal(filter.room.include_leave, false);
  });

  it("honours explicit filter options and clamps the timeline limit", () => {
    const filter = buildRuntimeFilter({
      timelineLimit: 5000,
      includeEphemeral: true,
      includePresence: true,
      includeLeave: true,
      timelineTypes: ["m.room.message"],
      stateTypes: ["m.room.member"],
    });
    assert.equal(filter.room.timeline.limit, 1000);
    assert.deepEqual(filter.room.timeline.types, ["m.room.message"]);
    assert.equal(filter.room.ephemeral, undefined);
    assert.deepEqual(filter.presence, { limit: 10 });
    assert.equal(filter.room.include_leave, true);
    assert.deepEqual(filter.room.state.types, ["m.room.member"]);
  });
});

describe("sync state persistence", () => {
  it("round-trips through the storage directory", () => {
    saveSyncState(dir, { next_batch: "s1", filter_id: "f1", filter_kind: "runtime", bootstrap_done: true, user_id: "@bot:hs" });
    const state = loadSyncState(dir, "@bot:hs");
    assert.equal(state.next_batch, "s1");
    assert.equal(state.filter_id, "f1");
    assert.equal(state.filter_kind, "runtime");
    assert.equal(state.bootstrap_done, true);
  });

  it("returns a cold state when nothing is stored", () => {
    assert.deepEqual(loadSyncState(dir), { next_batch: null });
  });

  it("never replays a token belonging to another account", () => {
    saveSyncState(dir, { next_batch: "s1", bootstrap_done: true, user_id: "@old:hs" });
    const state = loadSyncState(dir, "@new:hs");
    assert.equal(state.next_batch, null);
    assert.equal(state.user_id, "@new:hs");
  });

  it("survives a corrupt state file", () => {
    fs.writeFileSync(path.join(dir, "sync.json"), "{not json");
    assert.deepEqual(loadSyncState(dir), { next_batch: null });
  });

  it("writes atomically, leaving no temp files behind", () => {
    saveSyncState(dir, { next_batch: "s1" });
    assert.deepEqual(fs.readdirSync(dir), ["sync.json"]);
  });
});

/** Scripted homeserver: each /sync returns the next queued response. */
function scriptedHttp(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    // Yield a macrotask so the sync loop cannot starve timers: without real I/O
    // the loop would spin entirely in microtasks and never let the test observe it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, query: parsed.searchParams, init });
    const handler = script[parsed.pathname];
    const spec = handler ? await handler(parsed, init, calls) : { status: 404, body: {} };
    return new Response(typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const http = new MatrixHttp("https://hs.example.org", {
    accessToken: "tok",
    fetchImpl,
    retryBaseMs: 1,
    maxRetryDelayMs: 2,
    logger: createDefaultLogger("silent"),
  });
  return { http, calls };
}

function loop(http, onSync, extra = {}) {
  return new SyncLoop({
    http,
    storagePath: dir,
    userId: "@bot:hs",
    onSync,
    timeoutMs: 10,
    backoffMinMs: 5,
    backoffMaxMs: 20,
    logger: createDefaultLogger("silent"),
    ...extra,
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

describe("SyncLoop", () => {
  it("marks the first sync as bootstrap and keeps the runtime filter", async () => {
    const uploaded = [];
    let batch = 0;
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async (_u, init) => {
        uploaded.push(JSON.parse(init.body));
        return { body: { filter_id: `f${uploaded.length}` } };
      },
      "/_matrix/client/v3/sync": async () => {
        batch += 1;
        return { body: { next_batch: `s${batch}` } };
      },
    });

    const rounds = [];
    const sync = loop(http, async (_res, meta) => {
      rounds.push(meta.isBootstrap);
    });
    sync.start();
    await waitFor(() => rounds.length >= 2);
    sync.stop();
    await sync.waitUntilStopped();

    assert.deepEqual(rounds.slice(0, 2), [true, false], "first round is bootstrap");
    assert.equal(uploaded.length, 1, "one filter upload");
    assert.equal(uploaded[0].room.timeline.limit, 50);
  });

  it("persists next_batch and resumes from it", async () => {
    let seenSince = null;
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async (url) => {
        seenSince = url.searchParams.get("since");
        return { body: { next_batch: "s-final" } };
      },
    });
    let rounds = 0;
    const sync = loop(http, async () => {
      rounds += 1;
    });
    sync.start();
    await waitFor(() => rounds >= 2);
    sync.stop();
    await sync.waitUntilStopped();

    assert.equal(seenSince, "s-final");
    assert.equal(loadSyncState(dir, "@bot:hs").next_batch, "s-final");
  });

  it("re-uploads the filter when the persisted one is the wrong kind", async () => {
    saveSyncState(dir, {
      next_batch: "s1",
      bootstrap_done: true,
      filter_id: "stale",
      filter_kind: "bootstrap",
      user_id: "@bot:hs",
    });
    const uploaded = [];
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async (_u, init) => {
        uploaded.push(JSON.parse(init.body));
        return { body: { filter_id: "fresh" } };
      },
      "/_matrix/client/v3/sync": async () => ({ body: { next_batch: "s2" } }),
    });
    let rounds = 0;
    const sync = loop(http, async () => {
      rounds += 1;
    });
    sync.start();
    await waitFor(() => rounds >= 1);
    sync.stop();
    await sync.waitUntilStopped();

    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].room.timeline.limit, 50, "must install the runtime filter");
    assert.equal(loadSyncState(dir, "@bot:hs").filter_kind, "runtime");
  });

  it("syncs without a filter rather than with the wrong one", async () => {
    let filterAttempts = 0;
    let sawNoFilter = false;
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => {
        filterAttempts += 1;
        return { status: 500, body: { error: "nope" } };
      },
      "/_matrix/client/v3/sync": async (url) => {
        if (!url.searchParams.get("filter")) sawNoFilter = true;
        return { body: { next_batch: "s1" } };
      },
    });
    let rounds = 0;
    const sync = loop(http, async () => {
      rounds += 1;
    });
    sync.start();
    await waitFor(() => rounds >= 1);
    sync.stop();
    await sync.waitUntilStopped();

    assert.ok(filterAttempts > 0);
    assert.equal(sawNoFilter, true, "a deaf bot is worse than a chatty sync");
  });

  it("stops and reports a fatal auth failure", async () => {
    const fatal = [];
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async () => ({
        status: 401,
        body: { errcode: "M_UNKNOWN_TOKEN", soft_logout: false },
      }),
    });
    const sync = loop(http, async () => {}, { onFatal: (err) => fatal.push(err) });
    sync.start();
    await waitFor(() => fatal.length > 0);
    await sync.waitUntilStopped();

    assert.equal(fatal.length, 1);
    assert.equal(sync.isRunning, false);
    assert.ok(sync.getFatalError());
  });

  it("keeps running after a transient sync error", async () => {
    let calls = 0;
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async () => {
        calls += 1;
        if (calls === 1) return { status: 502, body: "bad gateway" };
        return { body: { next_batch: `s${calls}` } };
      },
    });
    let rounds = 0;
    const sync = loop(http, async () => {
      rounds += 1;
    });
    sync.start();
    await waitFor(() => rounds >= 1, 5000);
    sync.stop();
    await sync.waitUntilStopped();
    assert.ok(rounds >= 1);
    assert.equal(sync.getFatalError(), null);
  });

  it("skips a batch that keeps breaking the handler instead of stalling", async () => {
    let batch = 0;
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async () => {
        batch += 1;
        return { body: { next_batch: `s${batch}` } };
      },
    });
    let attempts = 0;
    const sync = loop(http, async () => {
      attempts += 1;
      throw new Error("poison");
    });
    sync.start();
    // Three retries of the same batch, then the loop advances past it.
    await waitFor(() => attempts >= 5, 5000);
    sync.stop();
    await sync.waitUntilStopped();
    assert.ok(attempts >= 5, `handler kept being called (${attempts})`);
    assert.ok(loadSyncState(dir, "@bot:hs").next_batch, "loop advanced past the poison batch");
  });

  it("reports health on each successful round", async () => {
    const beats = [];
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async () => ({ body: { next_batch: "s1" } }),
    });
    const sync = loop(http, async () => {}, { onHealthy: (info) => beats.push(info) });
    sync.start();
    await waitFor(() => beats.length >= 1);
    sync.stop();
    await sync.waitUntilStopped();
    assert.equal(beats[0].nextBatch, "s1");
    assert.ok(sync.getLastSyncAt() > 0);
  });

  it("stops promptly even while backing off", async () => {
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async () => ({ status: 500, body: "always down" }),
    });
    const sync = loop(http, async () => {}, { backoffMinMs: 5_000, backoffMaxMs: 5_000 });
    sync.start();
    await new Promise((r) => setTimeout(r, 100));
    const startedAt = Date.now();
    sync.stop();
    await sync.waitUntilStopped();
    assert.ok(Date.now() - startedAt < 2_000, "backoff must abort on stop()");
  });

  it("sends set_presence=offline by default", async () => {
    let presence = null;
    const { http } = scriptedHttp({
      "/_matrix/client/v3/user/%40bot%3Ahs/filter": async () => ({ body: { filter_id: "f1" } }),
      "/_matrix/client/v3/sync": async (url) => {
        presence = url.searchParams.get("set_presence");
        return { body: { next_batch: "s1" } };
      },
    });
    let rounds = 0;
    const sync = loop(http, async () => {
      rounds += 1;
    });
    sync.start();
    await waitFor(() => rounds >= 1);
    sync.stop();
    await sync.waitUntilStopped();
    assert.equal(presence, "offline");
  });
});
