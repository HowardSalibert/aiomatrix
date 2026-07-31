import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command, CommandStart } from "../dist/index.js";
import { messageContext } from "./helpers.mjs";

describe("Command filter", () => {
  it("matches /echo hi and exposes the parsed command", async () => {
    const { ctx } = await messageContext("/echo hi there");
    assert.equal(await Command("echo")(ctx), true);
    assert.equal(ctx.commandName, "echo");
    assert.equal(ctx.commandArgs, "hi there");
    assert.deepEqual(ctx.command.argsList, ["hi", "there"]);
    assert.equal(ctx.command.prefix, "/");
  });

  it("matches the ! prefix", async () => {
    const { ctx } = await messageContext("!echo");
    assert.equal(await Command("echo")(ctx), true);
    assert.equal(ctx.commandArgs, "");
  });

  it("matches a bare command in a direct chat", async () => {
    const { ctx } = await messageContext("echo hello", { isDirect: true });
    assert.equal(await Command("echo")(ctx), true);
    assert.equal(ctx.commandArgs, "hello");
  });

  it("does not match a bare command in a group room", async () => {
    const { ctx } = await messageContext("echo hello");
    assert.equal(await Command("echo")(ctx), false);
  });

  it("matches aliases", async () => {
    const { ctx } = await messageContext("/e hi");
    assert.equal(await Command(["echo", "e"])(ctx), true);
    assert.equal(ctx.commandName, "e");
  });

  it("treats Cyrillic as first-class (NFC + case fold)", async () => {
    const upper = await messageContext("!Сводка");
    assert.equal(await Command("сводка")(upper.ctx), true);

    const help = await messageContext("/помощь список");
    assert.equal(await Command("помощь")(help.ctx), true);
    assert.equal(help.ctx.commandArgs, "список");
  });

  it("accepts /cmd@self but rejects /cmd@otherbot", async () => {
    const mine = await messageContext("/echo@bot arg");
    assert.equal(await Command("echo")(mine.ctx), true);

    const theirs = await messageContext("/echo@otherbot arg");
    assert.equal(await Command("echo")(theirs.ctx), false);
  });

  it("accepts Matrix-style addressing (`bot: cmd`)", async () => {
    const { ctx } = await messageContext("bot: /echo hi");
    assert.equal(await Command("echo")(ctx), true);
    assert.equal(ctx.commandArgs, "hi");
  });

  it("honours scope and minPowerLevel", async () => {
    const group = await messageContext("/mod", {
      powerLevels: { users: { "@alice:example.org": 0 }, users_default: 0 },
    });
    assert.equal(await Command("mod", { minPowerLevel: 50 })(group.ctx), false);

    const admin = await messageContext("/mod", {
      powerLevels: { users: { "@alice:example.org": 100 } },
    });
    assert.equal(await Command("mod", { minPowerLevel: 50 })(admin.ctx), true);

    const dmOnly = await messageContext("/secret");
    assert.equal(await Command("secret", { scope: "direct" })(dmOnly.ctx), false);
  });

  it("carries a spec for help generation", () => {
    const filter = Command("ping", { description: "Check liveness", category: "Utility" });
    assert.equal(filter.spec.name, "ping");
    assert.equal(filter.spec.description, "Check liveness");
    assert.equal(CommandStart().spec.name, "start");
  });
});
