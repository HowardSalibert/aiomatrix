import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defineCommands,
  matchCommand,
  suggestCommands,
  normalizeCommandName,
} from "../dist/commands.js";

const specs = defineCommands([
  { name: "echo", aliases: ["say"], description: "Repeat", args: "<text>" },
  { name: "help", description: "List commands" },
  { name: "status", aliases: ["st"], description: "Status" },
]);

const ruSpecs = defineCommands([
  { name: "сводка", aliases: ["summary"], description: "Дайджест" },
  { name: "помощь", aliases: ["help"], description: "Справка" },
]);

describe("defineCommands", () => {
  it("returns the same typed list", () => {
    assert.equal(specs.length, 3);
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

describe("suggestCommands", () => {
  it("empty input returns first limit specs in stable order", () => {
    const hit = suggestCommands("", specs, 2);
    assert.deepEqual(
      hit.map((s) => s.name),
      ["echo", "help"],
    );
  });

  it("prefix-matches /name case-insensitively", () => {
    const hit = suggestCommands("/Ec", specs);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].name, "echo");
  });

  it("prefix-matches !name and bare token", () => {
    assert.equal(suggestCommands("!he", specs)[0]?.name, "help");
    assert.equal(suggestCommands("st", specs)[0]?.name, "status");
  });

  it("matches aliases by prefix", () => {
    const hit = suggestCommands("/sa", specs);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].name, "echo");
  });

  it("respects limit and stable order", () => {
    const many = defineCommands([
      { name: "aa" },
      { name: "ab" },
      { name: "ac" },
    ]);
    const hit = suggestCommands("a", many, 2);
    assert.deepEqual(
      hit.map((s) => s.name),
      ["aa", "ab"],
    );
  });

  it("returns empty when nothing matches", () => {
    assert.deepEqual(suggestCommands("/zzz", specs), []);
  });
});

describe("Cyrillic commands (first-class)", () => {
  it("matchCommand matches !сводка / !СВОДКА / /помощь", () => {
    assert.equal(matchCommand("!сводка", ruSpecs)?.spec.name, "сводка");
    assert.equal(matchCommand("!СВОДКА", ruSpecs)?.spec.name, "сводка");
    assert.equal(matchCommand("/помощь", ruSpecs)?.spec.name, "помощь");
  });

  it("matchCommand matches Cyrillic aliases and Latin aliases on RU names", () => {
    assert.equal(matchCommand("/summary", ruSpecs)?.spec.name, "сводка");
    assert.equal(matchCommand("!help", ruSpecs)?.spec.name, "помощь");
  });

  it("suggestCommands prefix-matches Cyrillic", () => {
    assert.equal(suggestCommands("/св", ruSpecs)[0]?.name, "сводка");
    assert.equal(suggestCommands("/пом", ruSpecs)[0]?.name, "помощь");
  });

  it("normalizeCommandName applies NFC (ё NFD ≡ NFC)", () => {
    // Cyrillic ё: NFD = е + combining diaeresis; NFC folds before match.
    const nfdYo = "\u0435\u0308"; // ё
    const nfcYo = "\u0451"; // ё
    const nfdName = `св${nfdYo}дка`;
    const nfcName = `св${nfcYo}дка`;
    assert.equal(normalizeCommandName(nfdName), normalizeCommandName(nfcName));
    const yoSpecs = defineCommands([{ name: nfcName, description: "NFC" }]);
    assert.equal(matchCommand(`!${nfdName}`, yoSpecs)?.spec.name, nfcName);
  });
});
