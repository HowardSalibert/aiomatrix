import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command, Dispatcher, F, Router } from "../dist/index.js";
import { messageContext } from "./helpers.mjs";

async function ctxFor(text, options) {
  return (await messageContext(text, options)).ctx;
}

describe("Router", () => {
  it("runs the first matching route only", async () => {
    const seen = [];
    const router = new Router("t");
    router.message(Command("a"), () => void seen.push("a"));
    router.message(F.text, () => void seen.push("any"));

    assert.equal(await router.feed(await ctxFor("/a")), true);
    assert.deepEqual(seen, ["a"]);

    assert.equal(await router.feed(await ctxFor("hello")), true);
    assert.deepEqual(seen, ["a", "any"]);
  });

  it("returns false when nothing matches", async () => {
    const router = new Router();
    router.message(Command("nope"), () => {});
    assert.equal(await router.feed(await ctxFor("hello")), false);
  });

  it("only feeds handlers of the matching update type", async () => {
    const seen = [];
    const router = new Router();
    router.callbackQuery(() => void seen.push("cb"));
    router.message(() => void seen.push("msg"));
    await router.feed(await ctxFor("hi"));
    assert.deepEqual(seen, ["msg"]);
  });

  it("consults child routers after its own routes", async () => {
    const order = [];
    const parent = new Router("parent");
    const child = new Router("child");
    child.message(Command("child"), () => void order.push("child"));
    parent.message(Command("parent"), () => void order.push("parent"));
    parent.include(child);

    await parent.feed(await ctxFor("/child"));
    await parent.feed(await ctxFor("/parent"));
    assert.deepEqual(order, ["child", "parent"]);
  });

  it("refuses cycles and double attachment", () => {
    const a = new Router("a");
    const b = new Router("b");
    a.include(b);
    assert.throws(() => b.include(a), /cycle/);
    assert.throws(() => new Router("c").include(b), /already attached/);
    assert.throws(() => a.include(a), /cannot include itself/);
  });

  it("runs inherited middleware outside-in, only when a route matches", async () => {
    const order = [];
    const parent = new Router("parent");
    const child = new Router("child");
    parent.use(async (_ctx, next) => {
      order.push("parent:before");
      await next();
      order.push("parent:after");
    });
    child.use(async (_ctx, next) => {
      order.push("child:before");
      await next();
      order.push("child:after");
    });
    child.message(Command("go"), () => void order.push("handler"));
    parent.include(child);

    await parent.feed(await ctxFor("/nomatch"));
    assert.deepEqual(order, [], "middleware must not run when nothing matches");

    await parent.feed(await ctxFor("/go"));
    assert.deepEqual(order, [
      "parent:before",
      "child:before",
      "handler",
      "child:after",
      "parent:after",
    ]);
  });

  it("collects command specs from the whole subtree", () => {
    const parent = new Router();
    const child = new Router();
    parent.message(Command("one", { description: "1" }), () => {});
    child.message(Command("two", { description: "2" }), () => {});
    parent.include(child);
    assert.deepEqual(
      parent.commandSpecs.map((spec) => spec.name),
      ["one", "two"],
    );
  });

  it("lets an error handler swallow a failure", async () => {
    const router = new Router();
    const caught = [];
    router.errors((err) => {
      caught.push(err.message);
      return true;
    });
    router.message(() => {
      throw new Error("boom");
    });
    await router.feed(await ctxFor("hi"));
    assert.deepEqual(caught, ["boom"]);
  });

  it("bubbles unhandled errors to the parent router", async () => {
    const parent = new Router();
    const child = new Router();
    const caught = [];
    parent.errors((err) => {
      caught.push(err.message);
      return true;
    });
    child.errors(() => false);
    child.message(() => {
      throw new Error("nested");
    });
    parent.include(child);
    await parent.feed(await ctxFor("hi"));
    assert.deepEqual(caught, ["nested"]);
  });

  it("rejects registration without a handler function", () => {
    const router = new Router();
    assert.throws(() => router.message(), TypeError);
    assert.throws(() => router.message(F.text, "not a function"), TypeError);
  });
});

describe("Dispatcher", () => {
  it("runs outer middleware for every update, matched or not", async () => {
    const dp = new Dispatcher();
    const seen = [];
    dp.use(async (ctx, next) => {
      seen.push(ctx.updateType);
      await next();
    });
    dp.message(Command("known"), () => {});

    assert.equal(await dp.feed(await ctxFor("/known")), true);
    assert.equal(await dp.feed(await ctxFor("random text")), false);
    assert.deepEqual(seen, ["message", "message"]);
    const stats = dp.getStats();
    assert.equal(stats.received, 2);
    assert.equal(stats.handled, 1);
    assert.equal(stats.unhandled, 1);
  });

  it("invokes the fallback when nothing matched", async () => {
    const dp = new Dispatcher();
    let fell = 0;
    dp.fallback(() => {
      fell += 1;
    });
    dp.message(Command("x"), () => {});
    await dp.feed(await ctxFor("nothing"));
    assert.equal(fell, 1);
  });

  it("surfaces handler errors to dispatcher error handlers", async () => {
    const dp = new Dispatcher();
    const caught = [];
    dp.errors((err) => {
      caught.push(err.message);
      return true;
    });
    dp.message(() => {
      throw new Error("nope");
    });
    await dp.feed(await ctxFor("hi"));
    assert.deepEqual(caught, ["nope"]);
    assert.equal(dp.getStats().errors, 1);
  });

  it("abandons handlers past the configured timeout", async () => {
    const dp = new Dispatcher();
    dp.setHandlerTimeout(20);
    const caught = [];
    dp.errors((err) => {
      caught.push(err.name);
      return true;
    });
    dp.message(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    await dp.feed(await ctxFor("slow"));
    assert.deepEqual(caught, ["HandlerTimeoutError"]);
    assert.equal(dp.getStats().timeouts, 1);
  });

  it("deduplicates command specs across routers", () => {
    const dp = new Dispatcher();
    const extra = new Router();
    dp.message(Command("dup", { description: "first" }), () => {});
    extra.message(Command("dup", { description: "second" }), () => {});
    dp.include(extra);
    const specs = dp.commandSpecs;
    assert.equal(specs.length, 1);
    assert.equal(specs[0].description, "first");
  });

  it("rejects a middleware that calls next twice", async () => {
    const dp = new Dispatcher();
    const caught = [];
    dp.errors((err) => {
      caught.push(err.message);
      return true;
    });
    dp.use(async (_ctx, next) => {
      await next();
      await next();
    });
    dp.message(() => {});
    await dp.feed(await ctxFor("hi"));
    assert.equal(caught.length, 1);
    assert.match(caught[0], /more than once/);
  });
});
