import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AsyncLock,
  LruCache,
  clamp,
  escapeHtml,
  fingerprintSet,
  isPlainObject,
  jitter,
  randomId,
  readJsonSafe,
  readNumber,
  readString,
  resolveStoragePath,
  sleep,
  timingSafeEqualStrings,
  writeJsonAtomic,
} from "../dist/index.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbutil-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("atomic JSON files", () => {
  it("round-trips a value", () => {
    const file = path.join(dir, "a.json");
    writeJsonAtomic(file, { a: 1, nested: { b: [1, 2] } });
    assert.deepEqual(readJsonSafe(file), { a: 1, nested: { b: [1, 2] } });
  });

  it("creates missing parent directories", () => {
    const file = path.join(dir, "deep", "nested", "a.json");
    writeJsonAtomic(file, { ok: true });
    assert.deepEqual(readJsonSafe(file), { ok: true });
  });

  it("leaves no temp file behind", () => {
    const file = path.join(dir, "a.json");
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(fs.readdirSync(dir), ["a.json"]);
  });

  it("replaces the previous content wholesale", () => {
    const file = path.join(dir, "a.json");
    writeJsonAtomic(file, { long: "x".repeat(500) });
    writeJsonAtomic(file, { short: 1 });
    assert.deepEqual(readJsonSafe(file), { short: 1 });
  });

  it("writes credentials with owner-only permissions on POSIX", () => {
    if (process.platform === "win32") return;
    const file = path.join(dir, "device.json");
    writeJsonAtomic(file, { deviceId: "ABC" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("reads null for missing, empty and corrupt files", () => {
    assert.equal(readJsonSafe(path.join(dir, "nope.json")), null);
    const empty = path.join(dir, "empty.json");
    fs.writeFileSync(empty, "   ");
    assert.equal(readJsonSafe(empty), null);
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{oops");
    assert.equal(readJsonSafe(broken), null);
  });
});

describe("resolveStoragePath", () => {
  it("resolves a relative path against the cwd", () => {
    assert.equal(resolveStoragePath("./data"), path.resolve("data"));
  });

  it("rejects empty input and relative traversal", () => {
    assert.throws(() => resolveStoragePath("  "), /must not be empty/);
    assert.throws(() => resolveStoragePath("../etc"), /parent directories/);
    assert.throws(() => resolveStoragePath("data/../../etc"), /parent directories/);
  });

  it("allows dots inside a segment name", () => {
    assert.equal(resolveStoragePath("my..data"), path.resolve("my..data"));
  });

  it("allows absolute paths", () => {
    const absolute = path.resolve(dir, "store");
    assert.equal(resolveStoragePath(absolute), absolute);
  });
});

describe("randomId", () => {
  it("is url-safe and unique", () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomId(16)));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/);
  });

  it("scales with the requested byte count", () => {
    assert.ok(randomId(32).length > randomId(8).length);
  });
});

describe("timingSafeEqualStrings", () => {
  it("compares by value", () => {
    assert.equal(timingSafeEqualStrings("secret", "secret"), true);
    assert.equal(timingSafeEqualStrings("secret", "secreT"), false);
    assert.equal(timingSafeEqualStrings("secret", "secret-longer"), false);
    assert.equal(timingSafeEqualStrings("", ""), true);
  });

  it("handles multi-byte input", () => {
    assert.equal(timingSafeEqualStrings("пароль", "пароль"), true);
    assert.equal(timingSafeEqualStrings("пароль", "паролъ"), false);
  });
});

describe("sleep", () => {
  it("waits roughly the requested time", async () => {
    const start = Date.now();
    await sleep(30);
    assert.ok(Date.now() - start >= 20);
  });

  it("returns immediately for non-positive delays", async () => {
    const start = Date.now();
    await sleep(0);
    await sleep(-5);
    assert.ok(Date.now() - start < 500);
  });

  it("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const pending = sleep(5_000, controller.signal);
    controller.abort();
    await pending;
    assert.ok(Date.now() - start < 500);
  });

  it("returns immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await sleep(5_000, controller.signal);
  });
});

describe("numeric helpers", () => {
  it("clamps into range", () => {
    assert.equal(clamp(5, 1, 10), 5);
    assert.equal(clamp(-1, 1, 10), 1);
    assert.equal(clamp(99, 1, 10), 10);
  });

  it("jitters within [base, 2*base)", () => {
    for (let i = 0; i < 200; i++) {
      const value = jitter(100);
      assert.ok(value >= 100 && value < 200, `jitter out of range: ${value}`);
    }
  });
});

describe("unknown-value readers", () => {
  it("recognises plain objects only", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("x"), false);
  });

  it("reads typed fields defensively", () => {
    assert.equal(readString({ a: "x" }, "a"), "x");
    assert.equal(readString({ a: 1 }, "a"), undefined);
    assert.equal(readString(null, "a"), undefined);
    assert.equal(readNumber({ a: 1 }, "a"), 1);
    assert.equal(readNumber({ a: Number.NaN }, "a"), undefined);
    assert.equal(readNumber({ a: "1" }, "a"), undefined);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 1);
    assert.equal(cache.size, 2);
  });

  it("overwrites without growing", () => {
    const cache = new LruCache(2);
    cache.set("a", 1);
    cache.set("a", 2);
    assert.equal(cache.size, 1);
    assert.equal(cache.get("a"), 2);
  });

  it("supports has/delete/clear/keys", () => {
    const cache = new LruCache(4);
    cache.set("a", 1);
    cache.set("b", 2);
    assert.equal(cache.has("a"), true);
    assert.equal(cache.delete("a"), true);
    assert.equal(cache.delete("a"), false);
    assert.deepEqual([...cache.keys()], ["b"]);
    cache.clear();
    assert.equal(cache.size, 0);
  });

  it("refuses a capacity below 1", () => {
    assert.throws(() => new LruCache(0), /capacity/);
  });
});

describe("AsyncLock", () => {
  it("serialises tasks", async () => {
    const lock = new AsyncLock();
    const order = [];
    await Promise.all([
      lock.run(async () => {
        await sleep(20);
        order.push("first");
      }),
      lock.run(async () => {
        order.push("second");
      }),
    ]);
    assert.deepEqual(order, ["first", "second"]);
  });

  it("keeps running after a rejection", async () => {
    const lock = new AsyncLock();
    await assert.rejects(
      lock.run(async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(await lock.run(async () => "ok"), "ok");
  });

  it("returns each task's own result", async () => {
    const lock = new AsyncLock();
    const [a, b] = await Promise.all([lock.run(async () => 1), lock.run(async () => 2)]);
    assert.deepEqual([a, b], [1, 2]);
  });
});

describe("escapeHtml", () => {
  it("escapes every dangerous character", () => {
    assert.equal(
      escapeHtml(`<a href="x" onclick='y'>&</a>`),
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("escapes ampersands before the rest, so entities are not doubled oddly", () => {
    assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  });
});

describe("fingerprintSet", () => {
  it("is order- and duplicate-insensitive", () => {
    assert.equal(fingerprintSet(["a", "b"]), fingerprintSet(["b", "a", "a"]));
  });

  it("changes when membership changes", () => {
    assert.notEqual(fingerprintSet(["a"]), fingerprintSet(["a", "b"]));
  });

  it("does not collide on separator tricks", () => {
    assert.notEqual(fingerprintSet(["a\u0000b"]), fingerprintSet(["a", "b"]));
  });
});
