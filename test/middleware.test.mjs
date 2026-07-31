import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Dispatcher,
  Scheduler,
  accessControl,
  compose,
  createDefaultLogger,
  errorReply,
  getTranslator,
  i18n,
  logging,
  skipSelf,
  throttle,
  typingIndicator,
} from "../dist/index.js";
import { messageContext } from "./helpers.mjs";

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

describe("compose", () => {
  it("runs middleware outside-in around the final handler", async () => {
    const order = [];
    const run = compose([
      async (_ctx, next) => {
        order.push("a:in");
        await next();
        order.push("a:out");
      },
      async (_ctx, next) => {
        order.push("b:in");
        await next();
        order.push("b:out");
      },
    ]);
    const { ctx } = await messageContext("hi");
    await run(ctx, async () => void order.push("final"));
    assert.deepEqual(order, ["a:in", "b:in", "final", "b:out", "a:out"]);
  });

  it("lets a middleware skip the handler entirely", async () => {
    let called = false;
    const run = compose([async () => {}]);
    const { ctx } = await messageContext("hi");
    await run(ctx, async () => {
      called = true;
    });
    assert.equal(called, false);
  });
});

describe("throttle", () => {
  it("allows the limit and drops the rest of the window", async () => {
    const mw = throttle({ limit: 2, windowMs: 1_000 });
    const harness = await messageContext("hi");
    let handled = 0;
    const call = async () => {
      const { ctx } = await messageContext("hi", { harness });
      await mw(ctx, async () => {
        handled += 1;
      });
    };
    await call();
    await call();
    await call();
    assert.equal(handled, 2);
  });

  it("starts a fresh window after it elapses", async () => {
    const mw = throttle({ limit: 1, windowMs: 20 });
    const harness = await messageContext("hi");
    let handled = 0;
    const call = async () => {
      const { ctx } = await messageContext("hi", { harness });
      await mw(ctx, async () => {
        handled += 1;
      });
    };
    await call();
    await call();
    await tick(40);
    await call();
    assert.equal(handled, 2);
  });

  it("notifies once per window", async () => {
    const notices = [];
    const mw = throttle({
      limit: 1,
      windowMs: 500,
      onThrottled: (_ctx, retryAfterMs) => notices.push(retryAfterMs),
    });
    const harness = await messageContext("hi");
    for (let i = 0; i < 4; i++) {
      const { ctx } = await messageContext("hi", { harness });
      await mw(ctx, async () => {});
    }
    assert.equal(notices.length, 1);
    assert.ok(notices[0] > 0 && notices[0] <= 500);
  });

  it("throttles per sender+room by default", async () => {
    const mw = throttle({ limit: 1, windowMs: 500 });
    let handled = 0;
    const call = async (options) => {
      const { ctx } = await messageContext("hi", options);
      await mw(ctx, async () => {
        handled += 1;
      });
    };
    await call({ sender: "@a:hs" });
    await call({ sender: "@b:hs" });
    assert.equal(handled, 2, "different senders have separate budgets");
  });

  it("accepts a custom key", async () => {
    const mw = throttle({ limit: 1, windowMs: 500, key: () => "global" });
    let handled = 0;
    const call = async (sender) => {
      const { ctx } = await messageContext("hi", { sender });
      await mw(ctx, async () => {
        handled += 1;
      });
    };
    await call("@a:hs");
    await call("@b:hs");
    assert.equal(handled, 1);
  });
});

describe("skipSelf", () => {
  it("drops the bot's own messages and passes others", async () => {
    const mw = skipSelf();
    let handled = 0;
    const own = await messageContext("echo", { sender: "@bot:example.org" });
    await mw(own.ctx, async () => {
      handled += 1;
    });
    assert.equal(handled, 0);

    const other = await messageContext("hi", { sender: "@alice:example.org" });
    await mw(other.ctx, async () => {
      handled += 1;
    });
    assert.equal(handled, 1);
  });
});

describe("accessControl", () => {
  const run = async (mw, sender) => {
    const { ctx } = await messageContext("hi", { sender });
    let handled = false;
    await mw(ctx, async () => {
      handled = true;
    });
    return handled;
  };

  it("allows everyone when no allowlist is given", async () => {
    assert.equal(await run(accessControl({}), "@anyone:hs"), true);
  });

  it("enforces an allowlist", async () => {
    const mw = accessControl({ allow: ["@admin:hs"] });
    assert.equal(await run(mw, "@admin:hs"), true);
    assert.equal(await run(mw, "@rando:hs"), false);
  });

  it("applies deny after allow", async () => {
    const mw = accessControl({ allow: ["@a:hs", "@b:hs"], deny: ["@b:hs"] });
    assert.equal(await run(mw, "@a:hs"), true);
    assert.equal(await run(mw, "@b:hs"), false);
  });

  it("denies from an otherwise open bot", async () => {
    assert.equal(await run(accessControl({ deny: ["@spam:hs"] }), "@spam:hs"), false);
  });

  it("allows whole homeservers", async () => {
    const mw = accessControl({ allowServers: ["example.org"] });
    assert.equal(await run(mw, "@anyone:example.org"), true);
    assert.equal(await run(mw, "@anyone:elsewhere.org"), false);
  });

  it("reports rejections", async () => {
    const rejected = [];
    const mw = accessControl({ allow: ["@a:hs"], onRejected: (ctx) => rejected.push(ctx.senderId) });
    await run(mw, "@b:hs");
    assert.deepEqual(rejected, ["@b:hs"]);
  });
});

describe("i18n", () => {
  const catalogs = {
    en: { greet: "Hello {name}", bye: "Bye" },
    ru: { greet: "Привет, {name}" },
  };

  it("installs a translator for the default locale", async () => {
    const mw = i18n({ catalogs, defaultLocale: "en" });
    const { ctx } = await messageContext("hi");
    await mw(ctx, async () => {
      const t = getTranslator(ctx);
      assert.equal(t.locale, "en");
      assert.equal(t.t("greet", { name: "Alice" }), "Hello Alice");
    });
  });

  it("resolves the locale per update and falls back per key", async () => {
    const mw = i18n({ catalogs, defaultLocale: "en", resolveLocale: () => "ru" });
    const { ctx } = await messageContext("hi");
    await mw(ctx, async () => {
      const t = getTranslator(ctx);
      assert.equal(t.t("greet", { name: "Алиса" }), "Привет, Алиса");
      assert.equal(t.t("bye"), "Bye", "missing keys fall back to the default locale");
      assert.equal(t.t("unknown"), "unknown", "unknown keys return the key");
    });
  });

  it("falls back to the default catalog for an unknown locale", async () => {
    const mw = i18n({ catalogs, defaultLocale: "en", resolveLocale: () => "de" });
    const { ctx } = await messageContext("hi");
    await mw(ctx, async () => {
      assert.equal(getTranslator(ctx).t("bye"), "Bye");
    });
  });

  it("leaves unknown placeholders untouched", async () => {
    const mw = i18n({ catalogs, defaultLocale: "en" });
    const { ctx } = await messageContext("hi");
    await mw(ctx, async () => {
      assert.equal(getTranslator(ctx).t("greet", {}), "Hello {name}");
    });
  });

  it("returns null when no translator is installed", async () => {
    const { ctx } = await messageContext("hi");
    assert.equal(getTranslator(ctx), null);
  });
});

describe("typingIndicator", () => {
  it("brackets the handler with typing on/off", async () => {
    const { ctx, client } = await messageContext("hi");
    await typingIndicator()(ctx, async () => {});
    assert.deepEqual(
      client.typing.map((t) => t.on),
      [true, false],
    );
  });

  it("still clears typing when the handler throws", async () => {
    const { ctx, client } = await messageContext("hi");
    await assert.rejects(
      typingIndicator()(ctx, async () => {
        throw new Error("boom");
      }),
    );
    assert.deepEqual(
      client.typing.map((t) => t.on),
      [true, false],
    );
  });
});

describe("errorReply", () => {
  it("tells the room and rethrows by default", async () => {
    const { ctx, client } = await messageContext("hi");
    await assert.rejects(
      errorReply()(ctx, async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].content.msgtype, "m.notice");
  });

  it("can swallow the error and use custom text", async () => {
    const { ctx, client } = await messageContext("hi");
    await errorReply({ text: "Oops", swallow: true, notice: false })(ctx, async () => {
      throw new Error("boom");
    });
    assert.equal(client.sent[0].content.body, "Oops");
    assert.equal(client.sent[0].content.msgtype, "m.text");
  });

  it("stays quiet on success", async () => {
    const { ctx, client } = await messageContext("hi");
    await errorReply()(ctx, async () => {});
    assert.equal(client.sent.length, 0);
  });
});

describe("logging", () => {
  it("does not swallow handler errors", async () => {
    const { ctx } = await messageContext("hi");
    await assert.rejects(
      logging()(ctx, async () => {
        throw new Error("boom");
      }),
    );
  });

  it("omits the payload unless asked", async () => {
    const lines = [];
    const logger = {
      trace: () => {},
      debug: (msg, detail) => lines.push(detail),
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const { ctx } = await messageContext("secret text");
    Object.defineProperty(ctx, "logger", { get: () => logger });
    await logging()(ctx, async () => {});
    assert.equal(lines[0].text, undefined);
    await logging({ includePayload: true })(ctx, async () => {});
    assert.equal(lines[1].text, "secret text");
  });
});

describe("middleware inside a dispatcher", () => {
  it("stacks global middleware around handlers", async () => {
    const dp = new Dispatcher();
    const seen = [];
    dp.use(skipSelf());
    dp.use(async (ctx, next) => {
      seen.push(`before:${ctx.senderId}`);
      await next();
    });
    dp.message(() => void seen.push("handled"));

    const own = await messageContext("x", { sender: "@bot:example.org" });
    await dp.feed(own.ctx);
    const other = await messageContext("x", { sender: "@alice:example.org" });
    await dp.feed(other.ctx);

    assert.deepEqual(seen, ["before:@alice:example.org", "handled"]);
  });
});

describe("Scheduler", () => {
  it("runs a delayed job once", async () => {
    const scheduler = new Scheduler({ tickMs: 50, logger: createDefaultLogger("silent") });
    let runs = 0;
    const job = scheduler.after(10, () => {
      runs += 1;
    });
    await tick(200);
    assert.equal(runs, 1);
    assert.equal(job.runCount, 1);
    assert.equal(job.nextRunAtMs, null);
    assert.equal(scheduler.size, 0, "one-shot jobs clean themselves up");
    scheduler.stop();
  });

  it("repeats an interval job and honours maxRuns", async () => {
    const scheduler = new Scheduler({ tickMs: 50, logger: createDefaultLogger("silent") });
    let runs = 0;
    scheduler.every(
      10,
      () => {
        runs += 1;
      },
      { immediate: true, maxRuns: 2 },
    );
    await tick(300);
    assert.equal(runs, 2);
    assert.equal(scheduler.size, 0);
    scheduler.stop();
  });

  it("does not overlap a slow job with itself", async () => {
    const scheduler = new Scheduler({ tickMs: 50, logger: createDefaultLogger("silent") });
    let concurrent = 0;
    let peak = 0;
    scheduler.every(
      10,
      async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await tick(150);
        concurrent -= 1;
      },
      { immediate: true },
    );
    await tick(400);
    scheduler.stop();
    assert.equal(peak, 1);
  });

  it("keeps running after a job throws and records the error", async () => {
    const errors = [];
    const scheduler = new Scheduler({
      tickMs: 50,
      logger: createDefaultLogger("silent"),
      onError: (err, job) => errors.push([err.message, job.name]),
    });
    let runs = 0;
    const job = scheduler.every(
      10,
      () => {
        runs += 1;
        throw new Error("boom");
      },
      { immediate: true, name: "flaky" },
    );
    await tick(250);
    scheduler.stop();
    assert.ok(runs >= 2, "the loop survived the failure");
    assert.equal(errors[0][1], "flaky");
    assert.match(String(job.lastError?.message ?? ""), /boom/);
  });

  it("cancels a job", async () => {
    const scheduler = new Scheduler({ tickMs: 50, logger: createDefaultLogger("silent") });
    let runs = 0;
    const job = scheduler.every(10, () => {
      runs += 1;
    });
    job.cancel();
    await tick(150);
    assert.equal(runs, 0);
    assert.equal(scheduler.size, 0);
    scheduler.stop();
  });

  it("stop() clears every job", async () => {
    const scheduler = new Scheduler({ tickMs: 50, logger: createDefaultLogger("silent") });
    scheduler.every(10, () => {});
    scheduler.after(10, () => {});
    assert.equal(scheduler.size, 2);
    scheduler.stop();
    assert.equal(scheduler.size, 0);
  });

  it("schedules at a wall-clock time", async () => {
    const scheduler = new Scheduler({ tickMs: 50, logger: createDefaultLogger("silent") });
    let ran = false;
    scheduler.at(Date.now() + 10, () => {
      ran = true;
    });
    await tick(200);
    assert.equal(ran, true);
    scheduler.stop();
  });

  it("validates dailyAt input and schedules in the future", () => {
    const scheduler = new Scheduler({ tickMs: 1000, logger: createDefaultLogger("silent") });
    assert.throws(() => scheduler.dailyAt("nope", () => {}), /HH:MM/);
    assert.throws(() => scheduler.dailyAt("25:00", () => {}), /out of range/);
    const job = scheduler.dailyAt("03:30", () => {});
    assert.ok(job.nextRunAtMs > Date.now());
    const next = new Date(job.nextRunAtMs);
    assert.equal(next.getHours(), 3);
    assert.equal(next.getMinutes(), 30);
    scheduler.stop();
  });
});
