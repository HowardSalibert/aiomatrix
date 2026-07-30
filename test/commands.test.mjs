import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defineCommands, matchCommand } from "../dist/commands.js";

const specs = defineCommands([
  { name: "echo", aliases: ["say"], description: "Repeat", args: "<text>" },
  { name: "help", description: "List commands" },
]);

describe("defineCommands", () => {
  it("returns the same typed list", () => {
    assert.equal(specs.length, 2);
    assert.equal(specs[0].name, "echo");
  });
});

describe("matchCommand", () => {
  it("matches /echo with args", () => {
    const hit = matchCommand("/echo hi there", specs);
    assert.ok(hit);
    assert.equal(hit.spec.name, "echo");
    assert.equal(hit.args, "hi there");
  });

  it("matches !help", () => {
    const hit = matchCommand("!help", specs);
    assert.ok(hit);
    assert.equal(hit.spec.name, "help");
    assert.equal(hit.args, "");
  });

  it("matches aliases", () => {
    const hit = matchCommand("/say ping", specs);
    assert.ok(hit);
    assert.equal(hit.spec.name, "echo");
    assert.equal(hit.args, "ping");
  });

  it("matches bare first token", () => {
    const hit = matchCommand("echo bare", specs);
    assert.ok(hit);
    assert.equal(hit.spec.name, "echo");
    assert.equal(hit.args, "bare");
  });

  it("returns null for unknown", () => {
    assert.equal(matchCommand("/nope", specs), null);
    assert.equal(matchCommand("", specs), null);
  });
});
