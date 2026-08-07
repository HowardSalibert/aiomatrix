import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AWARE_MESSAGE_DEFAULTS,
  Bot,
  buildBotCapabilitiesContent,
  createFileSharedTokenStores,
  createDefaultLogger,
} from "../dist/index.js";

const silent = createDefaultLogger("silent");
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-pack-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("createFileSharedTokenStores", () => {
  it("persists used tokens across instances", () => {
    const a = createFileSharedTokenStores(dir);
    assert.equal(a.callbackUsedStore.tryAdd("k", 60_000), true);
    a.flush();
    const b = createFileSharedTokenStores(dir);
    assert.equal(b.callbackUsedStore.has("k"), true);
    assert.equal(b.callbackUsedStore.tryAdd("k", 60_000), false);
  });
});

describe("aware profile helpers", () => {
  it("exposes aware message defaults", () => {
    assert.equal(AWARE_MESSAGE_DEFAULTS.keyboardFallback, false);
    assert.equal(AWARE_MESSAGE_DEFAULTS.parseMode, "markdown");
  });

  it("builds bot capabilities state", () => {
    const caps = buildBotCapabilitiesContent({ clientProfile: "aware" });
    assert.equal(caps.client_profile, "aware");
    assert.equal(caps.keyboard_fallback, false);
    assert.ok(caps.features.includes("keyboard"));
  });
});

describe("BotHealth.ok", () => {
  it("reports not ok before start", async () => {
    const bot = await Bot.create({
      homeserverUrl: "https://hs.example.org",
      accessToken: "tok",
      userId: "@bot:example.org",
      deviceId: "DEV",
      storagePath: dir,
      crypto: false,
      logger: silent,
      storageLock: false,
      fetchImpl: async () =>
        new Response(JSON.stringify({ user_id: "@bot:example.org", device_id: "DEV" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const health = bot.getHealth();
    assert.equal(health.running, false);
    assert.equal(health.ok, false);
  });
});
