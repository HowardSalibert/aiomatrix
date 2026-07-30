import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "../dist/filters.js";

function ctx(body, isDirect = false) {
  return {
    body,
    text: body,
    isDirect,
    commandArgs: "",
    commandName: null,
    event: { content: { body, msgtype: "m.text" } },
  };
}

describe("Command filter", () => {
  it("matches /echo hi", () => {
    const f = Command("echo");
    const c = ctx("/echo hi");
    assert.equal(f(c), true);
    assert.equal(c.commandName, "echo");
    assert.equal(c.commandArgs, "hi");
  });

  it("matches !echo", () => {
    const f = Command("echo");
    const c = ctx("!echo");
    assert.equal(f(c), true);
    assert.equal(c.commandName, "echo");
    assert.equal(c.commandArgs, "");
  });

  it("matches bare echo in DM", () => {
    const f = Command("echo");
    const c = ctx("echo hello", true);
    assert.equal(f(c), true);
    assert.equal(c.commandName, "echo");
    assert.equal(c.commandArgs, "hello");
  });

  it("does not match bare echo in group", () => {
    const f = Command("echo");
    const c = ctx("echo hello", false);
    assert.equal(f(c), false);
  });
});
