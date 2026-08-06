import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AIOMATRIX_SCHEMA,
  AIOMATRIX_SCHEMA_VERSION,
  AWARE_CONTRACT,
  COLD_START_DISPATCH,
  FileOutboxStore,
  StorageLock,
  buildAiomatrixEnvelope,
  checkSchemaVersion,
  definePlugin,
  flushOutbox,
  migrateStorage,
  pipelineAiomatrixContent,
  resolveCapabilityLevel,
  shouldDispatchOnColdStart,
} from "../dist/index.js";

describe("0.8 schema + pipeline", () => {
  it("exposes schema version and aware contract", () => {
    assert.equal(AIOMATRIX_SCHEMA_VERSION, 1);
    assert.equal(AIOMATRIX_SCHEMA.keyboard, 1);
    assert.ok(AWARE_CONTRACT.some((c) => c.id === "keyboard.render"));
    assert.equal(checkSchemaVersion("envelope", 1).supported, true);
  });

  it("resolveCapabilityLevel hybrid", () => {
    assert.equal(resolveCapabilityLevel("aware"), "aware");
    assert.equal(resolveCapabilityLevel("stock"), "stock");
    assert.equal(resolveCapabilityLevel("hybrid", true), "aware");
    assert.equal(resolveCapabilityLevel("hybrid", false), "stock");
  });

  it("pipelineAiomatrixContent for keyboard", () => {
    const content = {
      msgtype: "m.text",
      body: "hi",
      "dev.aiomatrix.keyboard": { version: 1, rows: [] },
    };
    const env = pipelineAiomatrixContent(content);
    assert.equal(env?.kind, "keyboard");
    assert.ok(env?.normalized);
    const built = buildAiomatrixEnvelope("raw", content);
    assert.equal(built.version, AIOMATRIX_SCHEMA.envelope);
  });
});

describe("0.8 cold start", () => {
  it("blocks messages on bootstrap", () => {
    assert.equal(COLD_START_DISPATCH.message, "after_bootstrap");
    assert.equal(shouldDispatchOnColdStart("message", true), false);
    assert.equal(shouldDispatchOnColdStart("message", false), true);
    assert.equal(shouldDispatchOnColdStart("host_capabilities_state", true), true);
  });
});

describe("0.8 storage lock + migrate + outbox", () => {
  it("StorageLock exclusive", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-lock-"));
    const a = new StorageLock(dir);
    a.acquire();
    const b = new StorageLock(dir);
    assert.throws(() => b.acquire(), /already locked in this process/);
    a.release();
    b.acquire();
    b.release();
  });

  it("migrateStorage is idempotent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-mig-"));
    const first = migrateStorage(dir);
    assert.ok(first.actions.length > 0);
    const second = migrateStorage(dir);
    assert.ok(fs.existsSync(path.join(dir, "storage-version.json")));
    assert.ok(second.actions.some((a) => a.includes("storage-version")));
  });

  it("FileOutboxStore flush", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-out-"));
    const store = new FileOutboxStore(dir);
    await store.enqueue({
      roomId: "!r:hs",
      eventType: "m.room.message",
      content: { msgtype: "m.text", body: "x" },
    });
    const sent = [];
    const result = await flushOutbox({
      store,
      send: async (roomId, type, content) => {
        sent.push({ roomId, type, content });
        return "$e";
      },
    });
    assert.equal(result.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal((await store.list()).length, 0);
  });
});

describe("0.8 plugin", () => {
  it("definePlugin requires name", () => {
    assert.throws(() => definePlugin({ name: "", install() {} }), /name/);
    const p = definePlugin({ name: "x", install() {} });
    assert.equal(p.name, "x");
  });
});
