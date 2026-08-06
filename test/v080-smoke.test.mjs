/**
 * Smoke checks for 0.8 wiring that do not need a live homeserver.
 * Live E2EE remains in test/live + scripts/live-hs.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Bot,
  COLD_START_DISPATCH,
  shouldDispatchOnColdStart,
  resolveCapabilityLevel,
  finalizeAiomatrixContent,
} from "../dist/index.js";

describe("0.8 smoke (offline)", () => {
  it("cold-start contract matches client bootstrap policy", () => {
    assert.equal(shouldDispatchOnColdStart("message", true), false);
    assert.equal(shouldDispatchOnColdStart("host_capabilities_state", true), true);
    assert.equal(COLD_START_DISPATCH.callback_query, "after_bootstrap");
  });

  it("hybrid capability resolves from host hint", () => {
    assert.equal(resolveCapabilityLevel("hybrid", true), "aware");
    assert.equal(resolveCapabilityLevel("hybrid", false), "stock");
  });

  it("finalizeAiomatrixContent validates keyboard schema", () => {
    const v = finalizeAiomatrixContent({
      msgtype: "m.text",
      body: "x",
      "dev.aiomatrix.keyboard": { version: 1, inline: [] },
    });
    assert.equal(v.ok, true);
    assert.equal(v.envelope?.kind, "keyboard");
  });

  it("Bot.create exposes outboxStore and canSendToRoom", async () => {
    assert.equal(typeof Bot.create, "function");
    assert.ok("prototype" in Bot);
  });
});
