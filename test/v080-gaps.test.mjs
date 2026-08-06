import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CALLBACK_ANSWER_EVENT_TYPE,
  Conversation,
  FileOutboxStore,
  InlineKeyboard,
  MemoryStorage,
  RateLimitedError,
  SignedCallbackRegistry,
  shouldDispatchOnColdStart,
  COLD_START_DISPATCH,
  editMessageWithOptions,
  finalizeAiomatrixContent,
  parseKeyboardContent,
  sendEventWithOutbox,
  sendMessageWithOptions,
} from "../dist/index.js";
import { ContextFactory } from "../dist/index.js";
import { FakeBot, FakeClient, makeFactory } from "./helpers.mjs";
import { RoomCache } from "../dist/index.js";

describe("0.8 gap fixes", () => {
  it("COLD_START_DISPATCH.invite is after_bootstrap", () => {
    assert.equal(COLD_START_DISPATCH.invite, "after_bootstrap");
    assert.equal(shouldDispatchOnColdStart("invite", true), false);
    assert.equal(shouldDispatchOnColdStart("invite", false), true);
  });

  it("editMessageWithOptions preserves keyboard when omitted", async () => {
    const { client, callbacks } = makeFactory();
    client.eventsById.set("$old", {
      event_id: "$old",
      type: "m.room.message",
      content: {
        msgtype: "m.text",
        body: "hi",
        "dev.aiomatrix.keyboard": {
          version: 1,
          inline: [[{ kind: "callback", text: "A", data: "a", token: "tok" }]],
        },
      },
    });
    await editMessageWithOptions(
      { client, roomId: "!r:ex", callbacks },
      "$old",
      { text: "edited" },
      { keyboardFallback: false },
    );
    const edit = client.sent.find((e) => e.content?.["m.relates_to"]?.rel_type === "m.replace");
    assert.ok(edit);
    assert.ok(edit.content["m.new_content"]["dev.aiomatrix.keyboard"]);
    assert.equal(edit.content["m.new_content"]["dev.aiomatrix.keyboard"].inline[0][0].text, "A");
  });

  it("answerCallback applies keyboard (with or without editText)", async () => {
    const rooms = new RoomCache();
    const client = new FakeClient({ rooms });
    client.eventsById.set("$kb", {
      event_id: "$kb",
      type: "m.room.message",
      content: { msgtype: "m.text", body: "pick" },
    });
    const callbacks = new SignedCallbackRegistry({ secret: "x".repeat(16) });
    const token = callbacks.issue({
      data: "press",
      roomId: "!r:ex",
      messageEventId: "$kb",
    });
    const bot = new FakeBot(client, callbacks, { clientProfile: "aware" });
    const factory = new ContextFactory({
      bot,
      client,
      logger: bot.logger,
      storage: new MemoryStorage(),
      callbacks,
    });
    const ctx = await factory.fromRoomEvent("!r:ex", {
      event_id: "$cb1",
      sender: "@u:ex",
      type: "dev.aiomatrix.callback",
      content: { token },
    });
    const kb = new InlineKeyboard().text("Next", "next");
    await ctx.answerCallback({ keyboard: kb });
    const edit = client.sent.find((e) => e.content?.["m.relates_to"]?.rel_type === "m.replace");
    assert.ok(edit, "keyboard-only answerCallback must edit");
    assert.ok(edit.content["m.new_content"]["dev.aiomatrix.keyboard"]);
  });

  it("toast/callback_answer stamp version and validate", async () => {
    const toast = finalizeAiomatrixContent(
      { version: 1, text: "hi", alert: false },
      { eventType: "dev.aiomatrix.toast" },
    );
    assert.equal(toast.ok, true);
    const newer = finalizeAiomatrixContent(
      { version: 99, text: "hi" },
      { eventType: "dev.aiomatrix.toast" },
    );
    assert.equal(newer.ok, false);
    assert.ok(newer.warnings.some((w) => w.includes("toast")));
  });

  it("parseKeyboardContent surfaces version warnings", () => {
    const warnings = [];
    parseKeyboardContent(
      {
        "dev.aiomatrix.keyboard": {
          version: 99,
          inline: [[{ kind: "callback", text: "A", data: "a" }]],
        },
      },
      { onWarn: (w) => warnings.push(...w) },
    );
    assert.ok(warnings.some((w) => w.includes("keyboard")));
  });

  it("sendEventWithOutbox enqueues toast on rate limit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-toast-out-"));
    const store = new FileOutboxStore(dir);
    const client = {
      sendEvent: async () => {
        throw new RateLimitedError(100, "PUT", "/send");
      },
    };
    await assert.rejects(
      () =>
        sendEventWithOutbox(
          { client, roomId: "!r:hs", outbox: store },
          CALLBACK_ANSWER_EVENT_TYPE,
          { version: 1, text: "ok" },
        ),
      RateLimitedError,
    );
    const pending = await store.list();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].eventType, CALLBACK_ANSWER_EVENT_TYPE);
  });

  it("Conversation resumes step from storage", async () => {
    const storage = new MemoryStorage();
    await storage.set("wiz", { state: "conversation", data: { __step: 1, name: "Ada" } });
    const steps = [
      {
        handle: async () => {
          throw new Error("step0 should be skipped");
        },
      },
      {
        handle: async (_ctx, data) => {
          data.done = true;
        },
      },
    ];
    const start = {
      waitFor: async () => ({ updateType: "message", text: "ok" }),
    };
    const conv = new Conversation({ storage, storageKey: "wiz", timeoutMs: 1000 });
    const result = await conv.run(start, steps);
    assert.equal(result.completed, true);
    assert.equal(result.data.name, "Ada");
    assert.equal(result.data.done, true);
  });

  it("sendMessageWithOptions still works with outbox helper", async () => {
    const { client } = makeFactory();
    const id = await sendMessageWithOptions({ client, roomId: "!r:ex" }, { text: "x" });
    assert.ok(id);
  });
});
