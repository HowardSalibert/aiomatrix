import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLikelyBotUserId } from "../dist/crypto-guard.js";

describe("isLikelyBotUserId", () => {
  it("matches bot_ prefix", () => {
    assert.equal(isLikelyBotUserId("@bot_echo:example.org"), true);
  });

  it("matches _bot infix", () => {
    assert.equal(isLikelyBotUserId("@helper_bot:example.org"), true);
  });

  it("matches -bot infix", () => {
    assert.equal(isLikelyBotUserId("@helper-bot:example.org"), true);
  });

  it("matches ending bot", () => {
    assert.equal(isLikelyBotUserId("@echobot:example.org"), true);
  });

  it("rejects humans", () => {
    assert.equal(isLikelyBotUserId("@alice:example.org"), false);
    assert.equal(isLikelyBotUserId("@howard:studnovsu.ru"), false);
  });
});
