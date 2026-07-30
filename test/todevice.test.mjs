import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToDeviceBody } from "../dist/crypto.js";

describe("normalizeToDeviceBody", () => {
  it("passes through { messages }", () => {
    const messages = { "@u:hs": { DEVICE: { type: "m.room.encrypted" } } };
    assert.deepEqual(normalizeToDeviceBody({ messages }), { messages });
  });

  it("unwraps nested content.messages", () => {
    const messages = { "@u:hs": { D: {} } };
    assert.deepEqual(normalizeToDeviceBody({ content: { messages } }), {
      messages,
    });
  });

  it("wraps bare user→device map", () => {
    const map = { "@u:hs": { D: { hi: 1 } } };
    assert.deepEqual(normalizeToDeviceBody(map), { messages: map });
  });

  it("handles nullish", () => {
    assert.deepEqual(normalizeToDeviceBody(null), { messages: {} });
  });
});
