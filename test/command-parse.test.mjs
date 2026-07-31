import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS_STATE_EVENT_TYPE,
  CommandRegistry,
  buildCommandsStateContent,
  buildHelpHtml,
  buildHelpText,
  parseCommand,
} from "../dist/index.js";

describe("parseCommand", () => {
  it("splits prefix, name and args", () => {
    const parsed = parseCommand("/remind me at 5pm");
    assert.equal(parsed.prefix, "/");
    assert.equal(parsed.command, "remind");
    assert.equal(parsed.args, "me at 5pm");
    assert.deepEqual(parsed.argsList, ["me", "at", "5pm"]);
    assert.equal(parsed.mention, null);
  });

  it("keeps the raw spelling while normalising the name", () => {
    const parsed = parseCommand("/HeLp");
    assert.equal(parsed.raw, "HeLp");
    assert.equal(parsed.command, "help");
  });

  it("returns null for non-commands", () => {
    assert.equal(parseCommand("hello there"), null);
    assert.equal(parseCommand(""), null);
    assert.equal(parseCommand("   "), null);
    assert.equal(parseCommand("/"), null);
  });

  it("accepts a bare token only when allowed", () => {
    assert.equal(parseCommand("help now"), null);
    const parsed = parseCommand("help now", { allowBare: true });
    assert.equal(parsed.prefix, "");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.args, "now");
  });

  it("honours custom prefixes", () => {
    assert.equal(parseCommand(".ping", { prefixes: ["."] }).command, "ping");
    assert.equal(parseCommand("/ping", { prefixes: ["."] }), null);
  });

  it("extracts the @bot mention from Telegram-style commands", () => {
    const parsed = parseCommand("/help@mybot arg");
    assert.equal(parsed.command, "help");
    assert.equal(parsed.mention, "mybot");
    assert.equal(parsed.args, "arg");
  });

  it("strips Matrix-style addressing", () => {
    const options = { botNames: ["mybot"] };
    assert.equal(parseCommand("mybot: /help", options).command, "help");
    assert.equal(parseCommand("mybot, /help", options).command, "help");
    assert.equal(parseCommand("@mybot:hs /help", { botNames: ["@mybot:hs"] }).command, "help");
    assert.equal(
      parseCommand("mybot help", { botNames: ["mybot"], allowBare: true }).command,
      "help",
    );
  });

  it("does not treat a longer name as the bot's name", () => {
    // Addressed at "mybots", so the trailing /help is not ours to run.
    assert.equal(parseCommand("mybots: /help", { botNames: ["mybot"] }), null);
    assert.equal(parseCommand("mybotsomething hello", { botNames: ["mybot"] }), null);
  });

  it("collapses runs of whitespace in argsList but keeps args verbatim", () => {
    const parsed = parseCommand("/echo   a   b  ");
    assert.deepEqual(parsed.argsList, ["a", "b"]);
    assert.equal(parsed.args, "a   b");
  });

  it("keeps newlines in args", () => {
    const parsed = parseCommand("/note first\nsecond");
    assert.equal(parsed.args, "first\nsecond");
  });

  it("normalises Cyrillic case and NFC", () => {
    assert.equal(parseCommand("!Сводка").command, "сводка");
    const nfd = parseCommand(`!св\u0435\u0308дка`).command;
    const nfc = parseCommand("!св\u0451дка").command;
    assert.equal(nfd, nfc);
  });
});

describe("buildHelpText", () => {
  const specs = [
    { name: "start", description: "Begin" },
    { name: "echo", description: "Repeat", args: "<text>" },
    { name: "secret", description: "Hidden", hidden: true },
    { name: "ban", description: "Ban a user", minPowerLevel: 50 },
    { name: "dmonly", description: "Direct only", scope: "direct" },
  ];

  it("lists visible commands with usage and description", () => {
    const text = buildHelpText(specs);
    assert.match(text, /\/start — Begin/);
    assert.match(text, /\/echo <text> — Repeat/);
    assert.ok(!text.includes("secret"), "hidden commands stay hidden");
  });

  it("hides commands above the caller's power level", () => {
    assert.ok(!buildHelpText(specs, { powerLevel: 0 }).includes("/ban"));
    assert.ok(buildHelpText(specs, { powerLevel: 50 }).includes("/ban"));
  });

  it("filters by scope", () => {
    assert.ok(!buildHelpText(specs, { scope: "group" }).includes("/dmonly"));
    assert.ok(buildHelpText(specs, { scope: "direct" }).includes("/dmonly"));
  });

  it("honours a custom prefix and title", () => {
    const text = buildHelpText([{ name: "ping" }], { prefix: "!", title: "Commands" });
    assert.match(text, /^Commands/);
    assert.match(text, /!ping/);
  });

  it("groups by category when categories are present", () => {
    const text = buildHelpText([
      { name: "a", category: "Admin" },
      { name: "b", category: "Fun" },
    ]);
    assert.match(text, /Admin:/);
    assert.match(text, /Fun:/);
  });

  it("says so when nothing is visible", () => {
    assert.match(buildHelpText([{ name: "x", hidden: true }]), /No commands available/);
  });
});

describe("buildHelpHtml", () => {
  it("escapes descriptions", () => {
    const html = buildHelpHtml([{ name: "x", description: '<img src=x onerror="a()">' }]);
    assert.ok(!html.includes("<img"));
    assert.match(html, /&lt;img/);
  });

  it("renders usage inside code tags", () => {
    assert.match(buildHelpHtml([{ name: "echo", args: "<text>" }]), /<code>\/echo &lt;text&gt;<\/code>/);
  });
});

describe("CommandRegistry", () => {
  it("adds, finds and removes specs", () => {
    const registry = new CommandRegistry();
    registry.add({ name: "Ping", description: "pong" });
    assert.equal(registry.has("ping"), true, "lookup is case-insensitive");
    assert.equal(registry.get("PING").description, "pong");
    assert.equal(registry.size, 1);
    assert.equal(registry.remove("ping"), true);
    assert.equal(registry.size, 0);
  });

  it("deduplicates by normalised name", () => {
    const registry = new CommandRegistry();
    registry.addAll([
      { name: "ping", description: "first" },
      { name: "PING", description: "second" },
    ]);
    assert.equal(registry.size, 1);
    assert.equal(registry.get("ping").description, "second");
  });

  it("matches bodies and suggests completions", () => {
    const registry = new CommandRegistry().addAll([
      { name: "echo", aliases: ["say"] },
      { name: "status" },
    ]);
    assert.equal(registry.match("/say hi").spec.name, "echo");
    assert.equal(registry.match("/nope"), null);
    assert.deepEqual(
      registry.suggest("s").map((spec) => spec.name),
      ["echo", "status"],
    );
  });

  it("renders help from its own contents", () => {
    const registry = new CommandRegistry().add({ name: "ping", description: "pong" });
    assert.match(registry.helpText(), /\/ping — pong/);
    assert.match(registry.helpHtml(), /<code>\/ping<\/code>/);
  });
});

describe("command advertisement", () => {
  it("builds a state event clients can read for autocomplete", () => {
    const content = buildCommandsStateContent([
      { name: "echo", aliases: ["say"], description: "Repeat", args: "<text>", category: "Fun" },
      { name: "secret", hidden: true },
      { name: "dm", scope: "direct" },
      { name: "any", scope: "all" },
    ]);
    assert.equal(COMMANDS_STATE_EVENT_TYPE, "m.matrixbots.commands");
    assert.deepEqual(content.prefixes, ["/", "!"]);
    assert.deepEqual(
      content.commands.map((c) => c.name),
      ["echo", "dm", "any"],
    );
    assert.deepEqual(content.commands[0], {
      name: "echo",
      aliases: ["say"],
      description: "Repeat",
      args: "<text>",
      category: "Fun",
    });
    assert.equal(content.commands[1].scope, "direct");
    assert.equal(content.commands[2].scope, undefined, "`all` is the default and stays implicit");
  });

  it("carries custom prefixes", () => {
    const content = buildCommandsStateContent([{ name: "x" }], { prefixes: ["."] });
    assert.deepEqual(content.prefixes, ["."]);
  });
});
