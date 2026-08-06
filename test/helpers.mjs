import {
  CallbackRegistry,
  ContextFactory,
  MemoryStorage,
  RoomCache,
  createDefaultLogger,
  parseMiniAppDataContent,
  parseMiniAppJson,
} from "../dist/index.js";

/** Collects every send so tests can assert on the produced event content. */
export class FakeClient {
  constructor(options = {}) {
    this.selfId = options.selfId ?? "@bot:example.org";
    this.rooms = options.rooms ?? new RoomCache();
    this.sent = [];
    this.redactions = [];
    this.receipts = [];
    this.typing = [];
    this.edits = [];
    this.joined = [];
    this.left = [];
    this.directRoomIds = new Set(options.directRoomIds ?? []);
    this.nextEventId = 0;
    this.attachmentBytes = options.attachmentBytes ?? new Uint8Array([1, 2, 3]);
    this.eventsById = new Map(options.eventsById ?? []);
  }

  #eventId() {
    this.nextEventId += 1;
    return `$evt${this.nextEventId}`;
  }

  async sendEvent(roomId, type, content) {
    const eventId = this.#eventId();
    this.sent.push({ roomId, type, content, eventId });
    this.eventsById.set(eventId, {
      event_id: eventId,
      room_id: roomId,
      type,
      sender: this.selfId,
      content,
    });
    return eventId;
  }

  async sendMessage(roomId, content) {
    return this.sendEvent(roomId, "m.room.message", content);
  }

  async sendText(roomId, text) {
    return this.sendEvent(roomId, "m.room.message", { msgtype: "m.text", body: text });
  }

  async sendReaction(roomId, eventId, key) {
    return this.sendEvent(roomId, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key },
    });
  }

  async redactEvent(roomId, eventId, reason) {
    this.redactions.push({ roomId, eventId, reason });
    return this.#eventId();
  }

  async editMessage(roomId, eventId, content) {
    this.edits.push({ roomId, eventId, content });
    return this.#eventId();
  }

  async setTyping(roomId, on) {
    this.typing.push({ roomId, on });
  }

  async sendReadReceipt(roomId, eventId) {
    this.receipts.push({ roomId, eventId });
  }

  async sendStateEvent(roomId, type, stateKey, content) {
    const eventId = this.#eventId();
    this.sent.push({ roomId, type, stateKey, content, eventId, state: true });
    return eventId;
  }

  async getDirectRoomIds() {
    return new Set(this.directRoomIds);
  }

  async sendFile(roomId, data, options = {}) {
    return this.sendEvent(roomId, "m.room.message", {
      msgtype: options.msgtype ?? "m.file",
      body: options.caption ?? options.filename ?? "file",
      filename: options.filename,
      url: "mxc://example.org/fake",
      ...(options.extra ?? {}),
    });
  }

  async kickUser(roomId, userId, reason) {
    this.sent.push({ roomId, type: "kick", userId, reason });
  }

  async banUser(roomId, userId, reason) {
    this.sent.push({ roomId, type: "ban", userId, reason });
  }

  async inviteUser(roomId, userId, reason) {
    this.sent.push({ roomId, type: "invite", userId, reason });
  }

  async setPowerLevel(roomId, userId, level) {
    return this.sendStateEvent(roomId, "m.room.power_levels", "", {
      users: { [userId]: level },
    });
  }

  async getEvent(roomId, eventId) {
    const stored = this.eventsById.get(eventId);
    if (stored) return { ...stored, room_id: roomId };
    return {
      event_id: eventId,
      room_id: roomId,
      type: "m.room.message",
      sender: "@peer:example.org",
      content: { msgtype: "m.text", body: "quoted" },
    };
  }

  async uploadContent(data, options = {}) {
    return {
      upload: { contentUri: "mxc://example.org/uploaded" },
      file: options.encryptForRoom ? { url: "mxc://example.org/enc", key: {} } : null,
    };
  }

  async getOrCreateDirectRoom(userId) {
    return `!dm_${userId}:example.org`;
  }

  async getJoinedRoomMembers(roomId) {
    return this.rooms.joinedMembers(roomId);
  }

  async joinRoom(roomId) {
    this.joined.push(roomId);
    return roomId;
  }

  async leaveRoom(roomId, reason) {
    this.left.push({ roomId, reason });
  }

  async downloadContent() {
    return this.attachmentBytes;
  }

  async isRoomEncrypted(roomId) {
    return this.rooms.isEncrypted(roomId) === true;
  }
}

/** Minimal stand-in for `Bot` covering only what contexts need. */
export class FakeBot {
  constructor(client, callbacks, options = {}) {
    this.client = client;
    this.callbacks = callbacks;
    this.selfId = options.selfId ?? client.selfId ?? "@bot:example.org";
    this.clientProfile = options.clientProfile ?? "stock";
    this.isStopping = false;
    this.logger = createDefaultLogger("silent");
    this._hostCaps = new Map();
    this._outbox = options.outbox ?? null;
    this._metrics = [];
  }

  get outboxStore() {
    return this._outbox;
  }

  noteMetric(metric) {
    this._metrics.push(metric);
  }

  capabilityForRoom(roomId) {
    const host = this.getHostCapabilities(roomId);
    const hostAware =
      host.profile === "aware" ||
      host.keyboardNative ||
      host.toast ||
      host.progress ||
      host.pollUi ||
      host.miniApp;
    if (this.clientProfile === "aware") return "aware";
    if (this.clientProfile === "hybrid") return hostAware ? "aware" : "stock";
    return "stock";
  }

  effectiveMessageDefaults(roomId) {
    const level = roomId !== undefined ? this.capabilityForRoom(roomId) : this.clientProfile;
    return {
      parseMode: "markdown",
      ...(level === "aware" ? { keyboardFallback: false } : {}),
    };
  }

  getHostCapabilities(roomId) {
    return (
      this._hostCaps.get(roomId) ?? {
        profile: this.clientProfile === "hybrid" ? "stock" : this.clientProfile,
        features: new Set(),
        keyboardNative: this.clientProfile === "aware",
        toast: this.clientProfile === "aware",
        progress: this.clientProfile === "aware",
        pollUi: this.clientProfile === "aware",
        miniApp: this.clientProfile === "aware",
      }
    );
  }

  readMiniAppData(event) {
    const parsed = parseMiniAppDataContent(event.content);
    if (!parsed) return null;
    return {
      raw: parsed.data,
      payload: parseMiniAppJson(parsed.data),
      queryId: parsed.queryId,
      appId: parsed.appId,
    };
  }

  async readCallbackEvent(roomId, event) {
    if (event.type !== "dev.aiomatrix.callback") return null;
    const token = event.content?.token;
    const record = token
      ? this.callbacks.resolveAsync
        ? await this.callbacks.resolveAsync(token, event.sender)
        : this.callbacks.resolve(token, event.sender)
      : null;
    if (!record || record.roomId !== roomId) return null;
    return {
      callbackData: record.data,
      messageEventId: record.messageEventId,
      queryId: token,
    };
  }

  waitFor(filter, options = {}) {
    const timeoutMs = options.timeoutMs ?? 60_000;
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new (globalThis.WaitForTimeoutError ?? Error)(`waitFor timed out after ${timeoutMs}ms`));
      }, timeoutMs).unref?.();
    });
  }
}

/**
 * Build a real `ContextFactory` on top of the fakes, so tests exercise the same
 * classification and send paths the bot uses at runtime.
 */
export function makeFactory(options = {}) {
  const client = options.client ?? new FakeClient(options);
  const callbacks = options.callbacks ?? new CallbackRegistry();
  const storage = options.storage ?? new MemoryStorage();
  const bot = options.bot ?? new FakeBot(client, callbacks, options);
  const factory = new ContextFactory({
    bot,
    client,
    logger: createDefaultLogger("silent"),
    storage,
    callbacks,
  });
  return { factory, client, callbacks, storage, bot };
}

/** Build a message context for `text` in `roomId`. */
export async function messageContext(text, options = {}) {
  const harness = options.harness ?? makeFactory(options);
  const roomId = options.roomId ?? "!room:example.org";
  if (options.isDirect) harness.client.directRoomIds.add(roomId);
  if (options.members) harness.client.rooms.setJoinedMembers(roomId, options.members);
  if (options.powerLevels) {
    harness.client.rooms.applyStateEvent(roomId, {
      type: "m.room.power_levels",
      state_key: "",
      content: options.powerLevels,
    });
  }
  const event = {
    type: "m.room.message",
    event_id: options.eventId ?? "$trigger",
    sender: options.sender ?? "@alice:example.org",
    room_id: roomId,
    content: {
      msgtype: options.msgtype ?? "m.text",
      body: text,
      ...(options.content ?? {}),
    },
  };
  const ctx = await harness.factory.fromRoomEvent(roomId, event);
  return { ctx, ...harness };
}

/** Queue-based fetch mock: each entry is a response or a function. */
export function mockFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const spec = typeof next === "function" ? await next(String(url), init) : next;
    if (spec instanceof Error) throw spec;
    const body = spec.body === undefined ? "" : typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body);
    return new Response(body, {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
    });
  };
  impl.calls = calls;
  return impl;
}
