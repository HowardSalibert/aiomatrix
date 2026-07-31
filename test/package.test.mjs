// Publish-safety checks: a broken exports map or a missing file only shows up
// after `npm publish`, which is too late.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

describe("package metadata", () => {
  it("declares ESM and a matching main/types pair", () => {
    assert.equal(pkg.type, "module");
    assert.ok(fs.existsSync(path.join(root, pkg.main)), `${pkg.main} is missing`);
    assert.ok(fs.existsSync(path.join(root, pkg.types)), `${pkg.types} is missing`);
  });

  it("resolves every subpath export to a file on disk", () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const entries = typeof target === "string" ? { default: target } : target;
      for (const [condition, file] of Object.entries(entries)) {
        assert.ok(
          fs.existsSync(path.join(root, file)),
          `exports["${subpath}"].${condition} → ${file} does not exist`,
        );
      }
    }
  });

  it("ships the documentation it links to", () => {
    for (const entry of pkg.files) {
      assert.ok(fs.existsSync(path.join(root, entry)), `files entry "${entry}" does not exist`);
    }
  });

  it("keeps the native crypto bindings optional", () => {
    assert.ok(
      pkg.optionalDependencies?.["@matrix-org/matrix-sdk-crypto-nodejs"],
      "crypto bindings must stay optional so install works on every platform",
    );
    assert.equal(
      pkg.dependencies,
      undefined,
      "runtime dependencies would defeat the point of a zero-dependency SDK",
    );
  });

  it("declares a Node floor the code actually needs", () => {
    assert.match(pkg.engines.node, /^>=\s*20/);
  });

  it("marks itself side-effect free for tree shaking", () => {
    assert.equal(pkg.sideEffects, false);
  });
});

describe("root entry", () => {
  it("does not statically import the native crypto bindings", () => {
    // A static import would break `require`/`import` resolution on platforms
    // with no prebuilt binary, even for bots running with `crypto: false`.
    const entry = fs.readFileSync(path.join(root, "dist/index.js"), "utf8");
    assert.ok(
      !entry.includes("@matrix-org/matrix-sdk-crypto-nodejs"),
      "dist/index.js must not reference the native package directly",
    );
    assert.ok(!entry.includes('from "./crypto.js"'), "dist/index.js must not import crypto.js");
  });

  it("exports the documented surface", async () => {
    const mod = await import("../dist/index.js");
    for (const name of [
      "Bot",
      "Dispatcher",
      "Router",
      "Command",
      "F",
      "InlineKeyboard",
      "FSMContext",
      "MemoryStorage",
      "JsonFileStorage",
      "createStates",
      "Scheduler",
      "MatrixClient",
      "MiniAppServer",
      "loadCryptoEngine",
      "sanitizeMatrixHtml",
      "serveMiniAppBridge",
      "validateInitData",
      "ConfigurationError",
    ]) {
      assert.ok(name in mod, `missing export: ${name}`);
    }
  });
});
