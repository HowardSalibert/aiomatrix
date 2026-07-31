import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DispatchQueue, EventDeduper } from "../dist/index.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("DispatchQueue", () => {
  it("serialises tasks within a room", async () => {
    const queue = new DispatchQueue();
    const order = [];
    const first = deferred();

    const a = queue.run("!r:hs", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = queue.run("!r:hs", async () => {
      order.push("b:start");
    });

    await tick();
    assert.deepEqual(order, ["a:start"], "b must wait for a");
    first.resolve();
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a:start", "a:end", "b:start"]);
  });

  it("runs different rooms in parallel", async () => {
    const queue = new DispatchQueue();
    const gate = deferred();
    const started = [];

    const tasks = [
      queue.run("!a:hs", async () => {
        started.push("a");
        await gate.promise;
      }),
      queue.run("!b:hs", async () => {
        started.push("b");
        await gate.promise;
      }),
    ];
    await tick();
    assert.deepEqual(started.sort(), ["a", "b"]);
    gate.resolve();
    await Promise.all(tasks);
  });

  it("caps concurrency at the global limit", async () => {
    const queue = new DispatchQueue(2);
    const gate = deferred();
    let running = 0;
    let peak = 0;

    const tasks = ["!a:hs", "!b:hs", "!c:hs", "!d:hs"].map((room) =>
      queue.run(room, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );
    await tick();
    assert.equal(queue.activeCount, 2);
    assert.equal(queue.pendingCount, 2);
    gate.resolve();
    await Promise.all(tasks);
    assert.equal(peak, 2);
    assert.equal(queue.activeCount, 0);
  });

  it("releases the slot when a task throws", async () => {
    const queue = new DispatchQueue(1);
    await assert.rejects(
      queue.run("!r:hs", async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(queue.activeCount, 0);
    await queue.run("!r:hs", async () => {});
  });

  it("returns the task result", async () => {
    const queue = new DispatchQueue();
    assert.equal(await queue.run("!r:hs", async () => 42), 42);
  });

  it("wakes waiters in FIFO order", async () => {
    const queue = new DispatchQueue(1);
    const gate = deferred();
    const order = [];
    const tasks = [
      queue.run("!a:hs", async () => {
        order.push("a");
        await gate.promise;
      }),
      queue.run("!b:hs", async () => void order.push("b")),
      queue.run("!c:hs", async () => void order.push("c")),
    ];
    await tick();
    gate.resolve();
    await Promise.all(tasks);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  it("drains once every task settles", async () => {
    const queue = new DispatchQueue(1);
    const gate = deferred();
    const task = queue.run("!a:hs", async () => {
      await gate.promise;
    });
    assert.equal(await queue.drain(30), false, "still busy");
    gate.resolve();
    await task;
    assert.equal(await queue.drain(200), true);
  });

  it("treats a non-positive limit as 1", async () => {
    const queue = new DispatchQueue(0);
    const gate = deferred();
    const tasks = [
      queue.run("!a:hs", async () => {
        await gate.promise;
      }),
      queue.run("!b:hs", async () => {}),
    ];
    await tick();
    assert.equal(queue.activeCount, 1);
    gate.resolve();
    await Promise.all(tasks);
  });
});

describe("EventDeduper", () => {
  it("reports the second sighting of an event", () => {
    const deduper = new EventDeduper();
    assert.equal(deduper.seen("!r:hs", "$e1"), false);
    assert.equal(deduper.seen("!r:hs", "$e1"), true);
  });

  it("keys on the room as well as the event", () => {
    const deduper = new EventDeduper();
    deduper.seen("!a:hs", "$e1");
    assert.equal(deduper.seen("!b:hs", "$e1"), false);
  });

  it("does not confuse a room/event boundary", () => {
    const deduper = new EventDeduper();
    deduper.seen("!a:hs", "x$e1");
    assert.equal(deduper.seen("!a:hsx", "$e1"), false);
  });

  it("forgets an entry on request", () => {
    const deduper = new EventDeduper();
    deduper.seen("!r:hs", "$e1");
    deduper.forget("!r:hs", "$e1");
    assert.equal(deduper.seen("!r:hs", "$e1"), false);
  });

  it("evicts the oldest entries past capacity", () => {
    const deduper = new EventDeduper(3);
    for (const id of ["$1", "$2", "$3", "$4"]) deduper.seen("!r:hs", id);
    assert.ok(deduper.size <= 3);
    assert.equal(deduper.seen("!r:hs", "$1"), false, "oldest was evicted");
    assert.equal(deduper.seen("!r:hs", "$4"), true, "newest is still remembered");
  });

  it("keeps memory bounded over many events", () => {
    const deduper = new EventDeduper(64);
    for (let i = 0; i < 10_000; i++) deduper.seen("!r:hs", `$e${i}`);
    assert.ok(deduper.size <= 65, `size stayed bounded (${deduper.size})`);
  });
});
