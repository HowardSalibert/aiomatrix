import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  FSMContext,
  JsonFileStorage,
  MemoryStorage,
  createStates,
  inStateGroup,
  storageKey,
} from "../dist/index.js";

const ROOM = "!room:example.org";
const USER = "@alice:example.org";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbfsm-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("storageKey", () => {
  it("scopes per strategy", () => {
    assert.equal(storageKey(ROOM, USER), `${ROOM}:${USER}`);
    assert.equal(storageKey(ROOM, USER, { strategy: "room" }), ROOM);
    assert.equal(storageKey(ROOM, USER, { strategy: "user" }), USER);
    assert.equal(storageKey(ROOM, USER, { strategy: "global" }), "global");
  });

  it("prefixes a namespace so bots can share a storage", () => {
    assert.equal(storageKey(ROOM, USER, { strategy: "user", namespace: "bot1" }), `bot1|${USER}`);
  });
});

describe("MemoryStorage", () => {
  it("stores and deletes records", async () => {
    const storage = new MemoryStorage();
    await storage.set("k", { state: "s", data: { a: 1 } });
    assert.deepEqual(await storage.get("k"), { state: "s", data: { a: 1 } });
    await storage.delete("k");
    assert.equal(await storage.get("k"), undefined);
  });

  it("returns copies so callers cannot mutate the store", async () => {
    const storage = new MemoryStorage();
    const original = { state: "s", data: { list: 1 } };
    await storage.set("k", original);
    original.data.list = 2;
    const read = await storage.get("k");
    read.data.list = 3;
    assert.equal((await storage.get("k")).data.list, 1);
  });

  it("drops expired records on read and via prune", async () => {
    const storage = new MemoryStorage();
    await storage.set("k", { state: "s", data: {}, expiresAtMs: Date.now() - 1 });
    assert.equal(await storage.get("k"), undefined);

    await storage.set("a", { state: "s", data: {}, expiresAtMs: Date.now() - 1 });
    await storage.set("b", { state: "s", data: {} });
    assert.equal(storage.prune(), 1);
    assert.equal(storage.size, 1);
  });

  it("evicts the oldest entry at capacity", async () => {
    const storage = new MemoryStorage(2);
    await storage.set("a", { state: null, data: {} });
    await storage.set("b", { state: null, data: {} });
    await storage.set("c", { state: null, data: {} });
    assert.equal(storage.size, 2);
    assert.equal(await storage.get("a"), undefined);
  });
});

describe("JsonFileStorage", () => {
  it("persists across instances", async () => {
    const first = new JsonFileStorage(dir, { flushIntervalMs: 1 });
    await first.set("k", { state: "Form:name", data: { step: 1 } });
    await first.close();

    const second = new JsonFileStorage(dir);
    assert.deepEqual(await second.get("k"), { state: "Form:name", data: { step: 1 } });
  });

  it("writes to the configured file name", async () => {
    const storage = new JsonFileStorage(dir, { fileName: "states.json" });
    await storage.set("k", { state: null, data: {} });
    await storage.close();
    assert.ok(fs.existsSync(path.join(dir, "states.json")));
  });

  it("accepts an explicit .json path", async () => {
    const file = path.join(dir, "nested", "fsm.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const storage = new JsonFileStorage(file);
    await storage.set("k", { state: "x", data: {} });
    await storage.close();
    assert.ok(fs.existsSync(file));
  });

  it("starts clean when the file is corrupt", async () => {
    fs.writeFileSync(path.join(dir, "fsm.json"), "}} not json");
    const storage = new JsonFileStorage(dir);
    assert.equal(await storage.get("k"), undefined);
  });

  it("skips malformed and expired entries on load", async () => {
    fs.writeFileSync(
      path.join(dir, "fsm.json"),
      JSON.stringify({
        good: { state: "s", data: { a: 1 } },
        expired: { state: "s", data: {}, expiresAtMs: Date.now() - 1000 },
        broken: "nope",
      }),
    );
    const storage = new JsonFileStorage(dir);
    assert.ok(await storage.get("good"));
    assert.equal(await storage.get("expired"), undefined);
    assert.equal(await storage.get("broken"), undefined);
  });

  it("leaves no temp files behind", async () => {
    const storage = new JsonFileStorage(dir);
    await storage.set("k", { state: null, data: {} });
    await storage.close();
    assert.deepEqual(fs.readdirSync(dir), ["fsm.json"]);
  });
});

describe("FSMContext", () => {
  const ctxFor = (storage, options) => new FSMContext(storage, ROOM, USER, options);

  it("starts empty", async () => {
    const state = ctxFor(new MemoryStorage());
    assert.equal(await state.getState(), null);
    assert.deepEqual(await state.getData(), {});
  });

  it("sets and clears state", async () => {
    const state = ctxFor(new MemoryStorage());
    await state.setState("Form:name");
    assert.equal(await state.getState(), "Form:name");
    await state.setState(null);
    assert.equal(await state.getState(), null);
  });

  it("accepts a StateRef", async () => {
    const Form = createStates("Form", ["name", "age"]);
    const state = ctxFor(new MemoryStorage());
    await state.setState(Form.age);
    assert.equal(await state.getState(), "Form:age");
  });

  it("merges data with updateData and replaces with setData", async () => {
    const state = ctxFor(new MemoryStorage());
    await state.updateData({ a: 1 });
    await state.updateData({ b: 2 });
    assert.deepEqual(await state.getData(), { a: 1, b: 2 });
    await state.setData({ c: 3 });
    assert.deepEqual(await state.getData(), { c: 3 });
  });

  it("reads a single field with a fallback", async () => {
    const state = ctxFor(new MemoryStorage());
    await state.updateData({ name: "Alice" });
    assert.equal(await state.get("name"), "Alice");
    assert.equal(await state.get("missing", "default"), "default");
  });

  it("keeps data when only the state changes", async () => {
    const state = ctxFor(new MemoryStorage());
    await state.updateData({ keep: true });
    await state.setState("Form:next");
    assert.deepEqual(await state.getData(), { keep: true });
  });

  it("writes state and data in one call", async () => {
    const state = ctxFor(new MemoryStorage());
    await state.set("Form:name", { step: 1 });
    assert.equal(await state.getState(), "Form:name");
    assert.deepEqual(await state.getData(), { step: 1 });
  });

  it("clear() wipes both state and data", async () => {
    const state = ctxFor(new MemoryStorage());
    await state.set("Form:name", { step: 1 });
    await state.clear();
    assert.equal(await state.getState(), null);
    assert.deepEqual(await state.getData(), {});
  });

  it("isolates users under the default strategy", async () => {
    const storage = new MemoryStorage();
    const alice = new FSMContext(storage, ROOM, "@alice:hs");
    const bob = new FSMContext(storage, ROOM, "@bob:hs");
    await alice.setState("Form:name");
    assert.equal(await bob.getState(), null);
  });

  it("shares state across a room with the room strategy", async () => {
    const storage = new MemoryStorage();
    const alice = new FSMContext(storage, ROOM, "@alice:hs", { strategy: "room" });
    const bob = new FSMContext(storage, ROOM, "@bob:hs", { strategy: "room" });
    await alice.setState("Poll:open");
    assert.equal(await bob.getState(), "Poll:open");
  });

  it("follows a user across rooms with the user strategy", async () => {
    const storage = new MemoryStorage();
    const inRoomA = new FSMContext(storage, "!a:hs", USER, { strategy: "user" });
    const inRoomB = new FSMContext(storage, "!b:hs", USER, { strategy: "user" });
    await inRoomA.updateData({ lang: "ru" });
    assert.deepEqual(await inRoomB.getData(), { lang: "ru" });
  });

  it("expires state after the configured ttl", async () => {
    const storage = new MemoryStorage();
    const state = new FSMContext(storage, ROOM, USER, { ttlMs: 5 });
    await state.setState("Form:name");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await state.getState(), null);
  });

  it("refreshes the ttl on every write", async () => {
    const storage = new MemoryStorage();
    const state = new FSMContext(storage, ROOM, USER, { ttlMs: 60 });
    await state.setState("Form:name");
    await new Promise((r) => setTimeout(r, 40));
    await state.updateData({ a: 1 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(await state.getState(), "Form:name");
  });

  it("exposes the storage key it uses", () => {
    const state = new FSMContext(new MemoryStorage(), ROOM, USER, { namespace: "bot" });
    assert.equal(state.storageKeyValue, `bot|${ROOM}:${USER}`);
  });
});

describe("createStates", () => {
  it("names states group-qualified", () => {
    const Form = createStates("Form", ["name", "age"]);
    assert.equal(Form.name.name, "Form:name");
    assert.equal(Form.age.group, "Form");
    assert.equal(Form.group, "Form");
  });

  it("acts as a filter on the current state", async () => {
    const Form = createStates("Form", ["name", "age"]);
    const storage = new MemoryStorage();
    const ctx = { state: new FSMContext(storage, ROOM, USER) };
    assert.equal(await Form.name(ctx), false);
    await ctx.state.setState(Form.name);
    assert.equal(await Form.name(ctx), true);
    assert.equal(await Form.age(ctx), false);
  });

  it("inStateGroup matches any member of the group", async () => {
    const Form = createStates("Form", ["name", "age"]);
    const Other = createStates("Other", ["x"]);
    const anyForm = inStateGroup(Form);
    const ctx = { state: new FSMContext(new MemoryStorage(), ROOM, USER) };
    assert.equal(await anyForm(ctx), false);
    await ctx.state.setState(Form.age);
    assert.equal(await anyForm(ctx), true);
    await ctx.state.setState(Other.x);
    assert.equal(await anyForm(ctx), false);
  });
});
