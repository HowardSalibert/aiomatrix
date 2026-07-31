import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EncryptedRoomWithoutCryptoError,
  EncryptionStateUnknownError,
  MatrixClient,
  MatrixHttp,
  RoomCache,
  createDefaultLogger,
  htmlToPlainBody,
} from "../dist/index.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mbclient-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const ROOM = "!room:example.org";

function makeClient(handler, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    // Yield so a tight /sync loop cannot starve timers in the test.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const parsed = new URL(String(url));
    calls.push({
      method: init.method,
      path: decodeURIComponent(parsed.pathname),
      query: parsed.searchParams,
      body: init.body ? JSON.parse(init.body) : null,
    });
    const spec = (await handler(parsed, init, calls)) ?? { body: {} };
    return new Response(JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const http = new MatrixHttp("https://hs.example.org", {
    accessToken: "tok",
    fetchImpl,
    retryBaseMs: 1,
    maxRetryDelayMs: 2,
    maxRetries: 0,
    logger: createDefaultLogger("silent"),
  });
  const client = new MatrixClient({
    http,
    storagePath: dir,
    userId: "@bot:example.org",
    deviceId: "DEVICE",
    crypto: null,
    rooms: options.rooms ?? new RoomCache(),
    logger: createDefaultLogger("silent"),
    ...options,
  });
  return { client, calls };
}

describe("htmlToPlainBody", () => {
  it("keeps text and turns block tags into newlines", () => {
    assert.equal(htmlToPlainBody("<p>one</p><p>two</p>"), "one\ntwo");
    assert.equal(htmlToPlainBody("a<br>b"), "a\nb");
    assert.equal(htmlToPlainBody("<ul><li>x</li><li>y</li></ul>"), "• x\n• y");
  });

  it("strips tags without leaving markup", () => {
    assert.equal(htmlToPlainBody('<a href="https://e.org">link</a>'), "link");
    assert.equal(htmlToPlainBody("<strong>bold</strong>"), "bold");
  });

  it("decodes entities", () => {
    assert.equal(htmlToPlainBody("&lt;tag&gt; &amp; &quot;q&quot; &#65; &#x42;"), '<tag> & "q" A B');
  });

  it("leaves unknown entities alone and survives bogus code points", () => {
    assert.equal(htmlToPlainBody("&nope;"), "&nope;");
    assert.equal(htmlToPlainBody("&#999999999;"), "");
  });

  it("collapses excess blank lines", () => {
    assert.equal(htmlToPlainBody("<p>a</p><p></p><p></p><p>b</p>"), "a\n\nb");
  });
});

describe("isRoomEncrypted", () => {
  it("answers from the cache without any request", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, "m.megolm.v1.aes-sha2");
    const { client, calls } = makeClient(() => ({ body: {} }), { rooms });
    assert.equal(await client.isRoomEncrypted(ROOM), true);
    assert.equal(calls.length, 0);
  });

  it("reads m.room.encryption when the cache is cold", async () => {
    const { client, calls } = makeClient(() => ({ body: { algorithm: "m.megolm.v1.aes-sha2" } }));
    assert.equal(await client.isRoomEncrypted(ROOM), true);
    assert.equal(calls.length, 1);
    // Second call is served from the cache.
    assert.equal(await client.isRoomEncrypted(ROOM), true);
    assert.equal(calls.length, 1);
  });

  it("treats a 404 as an unencrypted room", async () => {
    const { client } = makeClient(() => ({ status: 404, body: { errcode: "M_NOT_FOUND" } }));
    assert.equal(await client.isRoomEncrypted(ROOM), false);
  });

  it("refuses to guess when the state read fails transiently", async () => {
    const { client } = makeClient(() => ({ status: 429, body: { errcode: "M_LIMIT_EXCEEDED" } }));
    // The pre-0.3 bug: a throttled read cached `false` and leaked plaintext.
    await assert.rejects(client.isRoomEncrypted(ROOM), EncryptionStateUnknownError);
  });

  it("propagates the failure to sendEvent instead of sending plaintext", async () => {
    const { client, calls } = makeClient((url) =>
      url.pathname.includes("/state/")
        ? { status: 500, body: { error: "boom" } }
        : { body: { event_id: "$sent" } },
    );
    await assert.rejects(
      client.sendText(ROOM, "secret"),
      EncryptionStateUnknownError,
    );
    assert.ok(!calls.some((c) => c.path.includes("/send/")), "nothing was sent");
  });
});

describe("sendEvent", () => {
  it("sends plaintext in an unencrypted room", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, null);
    const { client, calls } = makeClient(() => ({ body: { event_id: "$sent" } }), { rooms });
    const eventId = await client.sendText(ROOM, "hello");
    assert.equal(eventId, "$sent");
    const send = calls.find((c) => c.path.includes("/send/"));
    assert.match(send.path, /\/send\/m\.room\.message\//);
    assert.equal(send.body.body, "hello");
    assert.equal(send.method, "PUT");
  });

  it("refuses to send into an encrypted room with no crypto", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, "m.megolm.v1.aes-sha2");
    const { client } = makeClient(() => ({ body: { event_id: "$sent" } }), { rooms });
    await assert.rejects(client.sendText(ROOM, "hi"), EncryptedRoomWithoutCryptoError);
  });

  it("uses a fresh transaction id per send but reuses a supplied one", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, null);
    const { client, calls } = makeClient(() => ({ body: { event_id: "$sent" } }), { rooms });
    await client.sendText(ROOM, "a");
    await client.sendText(ROOM, "b");
    const txns = calls.filter((c) => c.path.includes("/send/")).map((c) => c.path.split("/").pop());
    assert.notEqual(txns[0], txns[1]);

    await client.sendEvent(ROOM, "m.room.message", { msgtype: "m.text", body: "c" }, { txnId: "fixed" });
    assert.equal(calls.at(-1).path.split("/").pop(), "fixed");
  });

  it("sends reactions unencrypted so clients can aggregate them", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, "m.megolm.v1.aes-sha2");
    const { client, calls } = makeClient(() => ({ body: { event_id: "$sent" } }), { rooms });
    await client.sendReaction(ROOM, "$target", "👍");
    const send = calls.find((c) => c.path.includes("/send/"));
    assert.match(send.path, /\/send\/m\.reaction\//);
    assert.equal(send.body["m.relates_to"].key, "👍");
  });

  it("sends HTML with a derived plain-text body", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, null);
    const { client, calls } = makeClient(() => ({ body: { event_id: "$sent" } }), { rooms });
    await client.sendHtmlText(ROOM, "<p>Hi <b>there</b></p>");
    const body = calls.find((c) => c.path.includes("/send/")).body;
    assert.equal(body.format, "org.matrix.custom.html");
    assert.equal(body.body, "Hi there");
  });
});

describe("room operations", () => {
  it("redacts with a transaction id", async () => {
    const { client, calls } = makeClient(() => ({ body: { event_id: "$redaction" } }));
    assert.equal(await client.redactEvent(ROOM, "$bad", "spam"), "$redaction");
    assert.match(calls[0].path, /\/redact\/\$bad\//);
    assert.deepEqual(calls[0].body, { reason: "spam" });
  });

  it("edits a message with m.replace and a fallback body", async () => {
    const rooms = new RoomCache();
    rooms.setEncrypted(ROOM, null);
    const { client, calls } = makeClient(() => ({ body: { event_id: "$edit" } }), { rooms });
    await client.editMessage(ROOM, "$orig", { body: "fixed" });
    const body = calls.find((c) => c.path.includes("/send/")).body;
    assert.equal(body["m.relates_to"].rel_type, "m.replace");
    assert.equal(body["m.relates_to"].event_id, "$orig");
    assert.equal(body["m.new_content"].body, "fixed");
    assert.match(body.body, /fixed/);
  });

  it("caches joined members and refreshes on demand", async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return { body: { joined: { "@a:hs": {}, "@b:hs": {} } } };
    });
    assert.deepEqual((await client.getJoinedRoomMembers(ROOM)).sort(), ["@a:hs", "@b:hs"]);
    await client.getJoinedRoomMembers(ROOM);
    assert.equal(calls, 1, "second read comes from the cache");
    await client.getJoinedRoomMembers(ROOM, true);
    assert.equal(calls, 2);
  });

  it("exposes whoami and persists the device id", async () => {
    const { client } = makeClient(() => ({
      body: { user_id: "@bot:example.org", device_id: "FRESH" },
    }));
    const whoami = await client.getWhoAmI();
    assert.equal(whoami.device_id, "FRESH");
    assert.equal(client.getDeviceId(), "FRESH");
    assert.ok(fs.existsSync(path.join(dir, "device.json")));
  });

  it("url-encodes room ids and user ids", async () => {
    const { client, calls } = makeClient(() => ({ body: {} }));
    await client.getProfile("@user with space:hs").catch(() => {});
    assert.ok(!String(calls[0].query).includes(" "));
  });

  it("after cold-start bootstrap, drops replayed timeline older than start", async () => {
    const beforeStart = Date.now() - 60_000;
    let syncCount = 0;
    const seen = [];
    let resolveFresh;
    const gotFresh = new Promise((resolve) => {
      resolveFresh = resolve;
    });
    const { client } = makeClient(async (url) => {
      const pathName = decodeURIComponent(url.pathname);
      if (pathName.includes("/filter")) return { body: { filter_id: "f1" } };
      if (pathName.endsWith("/sync")) {
        syncCount += 1;
        if (syncCount === 1) {
          return {
            body: {
              next_batch: "s1",
              rooms: {
                join: {
                  [ROOM]: {
                    timeline: {
                      events: [
                        {
                          type: "m.room.message",
                          event_id: "$old",
                          sender: "@peer:hs",
                          origin_server_ts: beforeStart,
                          content: { msgtype: "m.text", body: "old" },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        if (syncCount === 2) {
          return {
            body: {
              next_batch: "s2",
              rooms: {
                join: {
                  [ROOM]: {
                    timeline: {
                      limited: true,
                      events: [
                        {
                          type: "m.room.message",
                          event_id: "$old-replay",
                          sender: "@peer:hs",
                          origin_server_ts: beforeStart,
                          content: { msgtype: "m.text", body: "old-replay" },
                        },
                        {
                          type: "m.room.message",
                          event_id: "$fresh",
                          sender: "@peer:hs",
                          origin_server_ts: Date.now() + 1_000,
                          content: { msgtype: "m.text", body: "fresh" },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        return { body: { next_batch: `s${syncCount}` } };
      }
      return { body: {} };
    }, { syncTimeoutMs: 20, backoffMinMs: 5, backoffMaxMs: 10 });

    await client.start({
      onRoomEvent: (_roomId, event) => {
        const body =
          event.content && typeof event.content.body === "string" ? event.content.body : null;
        if (!body) return;
        seen.push(body);
        if (body === "fresh") resolveFresh();
      },
    });

    await Promise.race([
      gotFresh,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timed out; seen=${JSON.stringify(seen)}`)), 2_000),
      ),
    ]);
    await client.stop();

    assert.deepEqual(seen, ["fresh"]);
  });
});
