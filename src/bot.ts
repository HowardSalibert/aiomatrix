import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  createMatrixClient,
  prepareCrypto,
  resolveDeviceId,
  type ClientEventMeta,
  type MatrixClient,
} from "./client.js";
import {
  CommandRegistry,
  COMMANDS_STATE_EVENT_TYPE,
  buildCommandsStateContent,
  buildHelpHtml,
  buildHelpText,
  type CommandSpec,
  type HelpTextOptions,
} from "./commands.js";
import { ContextFactory } from "./context.js";
import { assertDeviceIdMatch, assertOwnDeviceKeysReady } from "./crypto-guard.js";
import type { Dispatcher } from "./dispatcher.js";
import {
  ConfigurationError,
  DeviceMismatchError,
  MiniAppAuthError,
  RateLimitedError,
} from "./errors.js";
import {
  AWARE_MESSAGE_DEFAULTS,
  AWARE_MINI_APP_DEFAULTS,
  BOT_CAPABILITIES_STATE_EVENT_TYPE,
  buildBotCapabilitiesContent,
} from "./bot-capabilities.js";
import {
  createFileSharedTokenStores,
  type FileSharedTokenStores,
} from "./file-ttl-map.js";
import {
  CALLBACK_EVENT_TYPE,
  CALLBACK_FALLBACK_COMMAND,
  SignedCallbackRegistry,
  type CallbackTokenStore,
  InlineKeyboard,
} from "./keyboards.js";
import { createDefaultLogger, type Logger, type LogLevel } from "./logger.js";
import type { Middleware } from "./types.js";
import {
  buildMiniAppContent,
  parseMiniAppDataContent,
  parseMiniAppJson,
  type MiniAppCardOptions,
} from "./miniapp/events.js";
import {
  buildMiniAppLaunchUrl,
  createInitData,
  isMiniAppUrlAllowed,
  type MiniAppRoom,
  type MiniAppUser,
  type SignedInitData,
} from "./miniapp/initdata.js";
import { SignedMiniAppQueryRegistry, type MiniAppQueryStore } from "./miniapp/query.js";
import { MiniAppServer, type MiniAppServerOptions, type MiniAppSession } from "./miniapp/server.js";
import {
  WIDGET_STATE_EVENT_TYPE,
  buildWidgetLayoutContent,
  buildWidgetRemovalContent,
  buildWidgetStateContent,
  type WidgetOptions,
} from "./miniapp/widget.js";
import { Scheduler } from "./scheduler.js";
import { sendMessageWithOptions } from "./send.js";
import type {
  AnyContext,
  BotCreateOptions,
  MatrixEvent,
  MessageDefaults,
  MiniAppDataContext,
  SendOptions,
} from "./types.js";
import { isPlainObject, readJsonSafe, readString, writeJsonAtomic } from "./util.js";

export interface BotHealth {
  running: boolean;
  /** `running && !stopping && sync fresh && (crypto ok when enabled)`. */
  ok: boolean;
  cryptoEnabled: boolean;
  cryptoReady: boolean;
  userId: string;
  deviceId: string | null;
  /** Epoch ms of the last successful `/sync`. */
  lastSyncAtMs: number;
  /** Ms since the last successful `/sync` (`Infinity` before the first one). */
  syncAgeMs: number;
  /** True when syncAgeMs exceeds the configured stale threshold. */
  syncStale: boolean;
  roomsCached: number;
  pendingCallbacks: number;
  pendingMiniAppQueries: number;
  scheduledJobs: number;
}

export interface RunOptions {
  /** Signals that trigger graceful shutdown. Default `SIGINT` + `SIGTERM`. */
  signals?: NodeJS.Signals[];
  /** Called once syncing has started. */
  onReady?: (bot: Bot) => void | Promise<void>;
  /** Called before shutdown completes. */
  onShutdown?: (bot: Bot) => void | Promise<void>;
}

export interface MiniAppLaunchOptions {
  /** Mini app URL. Falls back to `miniApp.defaultUrl`. */
  url?: string;
  userId: string;
  roomId?: string;
  /** Deep-link parameter handed to the mini app. */
  startParam?: string;
  /** Event id the mini app is launched from. */
  messageId?: string;
  /** Stable mini app id, used to route `mini_app_data` updates. */
  appId?: string;
  /** Extra profile fields exposed to the mini app. */
  user?: Partial<Omit<MiniAppUser, "id">>;
  /** Skip issuing a query id (no `sendData` round trip expected). */
  withoutQuery?: boolean;
}

export interface MiniAppLaunch {
  url: string;
  signed: SignedInitData;
  queryId: string | null;
}

function miniAppSecretPath(storagePath: string): string {
  return path.join(storagePath, "miniapp.json");
}

/**
 * Resolve the MiniApp signing secret.
 *
 * A persisted secret keeps `initData` verifiable across restarts, which is what
 * makes the zero-config path safe instead of merely convenient.
 */
function resolveMiniAppSecret(
  storagePath: string,
  provided: string | undefined,
  logger: Logger,
): string {
  if (provided) {
    if (provided.length < 16) {
      throw new ConfigurationError(
        "miniApp.secret must be at least 16 characters of high-entropy data",
      );
    }
    return provided;
  }
  const file = miniAppSecretPath(storagePath);
  const existing = readJsonSafe<{ secret?: string }>(file);
  if (existing?.secret && existing.secret.length >= 16) return existing.secret;
  const secret = crypto.randomBytes(32).toString("base64url");
  writeJsonAtomic(file, { secret });
  logger.info(
    `generated a MiniApp signing secret in ${file} — share it with your mini app backend, or set miniApp.secret explicitly`,
  );
  return secret;
}

/**
 * High-level Matrix bot.
 *
 * Owns the client, the E2EE contract, the interactive registries (inline
 * keyboards and MiniApp queries) and the scheduler, and feeds typed updates into
 * a {@link Dispatcher}.
 */
export class Bot {
  readonly client: MatrixClient;
  readonly storagePath: string;
  readonly cryptoEnabled: boolean;
  readonly logger: Logger;
  /** Inline keyboard callback tokens. */
  readonly callbacks: CallbackTokenStore;
  /** In-flight MiniApp launches awaiting a `sendData` round trip. */
  readonly miniAppQueries: MiniAppQueryStore;
  /** Commands advertised by `/help` and to clients. */
  readonly commands = new CommandRegistry();
  readonly scheduler: Scheduler;

  private readonly options: BotCreateOptions;
  private readonly configuredDeviceId?: string;
  private readonly miniAppSecret: string;
  private readonly miniAppAllowedOrigins: string[];
  private dispatcher: Dispatcher | null = null;
  private factory: ContextFactory | null = null;
  private _cryptoReady = false;
  private started = false;
  private stopping = false;
  private readonly durableStores: FileSharedTokenStores | null;
  private syncWatchTimer: ReturnType<typeof setInterval> | null = null;
  private syncStaleNotified = false;

  private constructor(params: {
    client: MatrixClient;
    storagePath: string;
    cryptoEnabled: boolean;
    logger: Logger;
    options: BotCreateOptions;
    configuredDeviceId?: string;
  }) {
    this.client = params.client;
    this.storagePath = params.storagePath;
    this.cryptoEnabled = params.cryptoEnabled;
    this.logger = params.logger.child("bot");
    this.options = params.options;
    if (params.configuredDeviceId !== undefined) {
      this.configuredDeviceId = params.configuredDeviceId;
    }
    this.scheduler = new Scheduler({ logger: params.logger });
    this.miniAppSecret = resolveMiniAppSecret(
      params.storagePath,
      params.options.miniApp?.secret,
      this.logger,
    );
    const callbackSecret = params.options.callbackSecret ?? this.miniAppSecret;
    const pack =
      params.options.callbackAliasStore &&
      params.options.callbackBindStore &&
      params.options.callbackUsedStore &&
      params.options.miniApp?.queryUsedStore
        ? null
        : createFileSharedTokenStores(params.storagePath);
    this.durableStores = pack;
    this.callbacks =
      params.options.callbacks ??
      new SignedCallbackRegistry({
        secret: callbackSecret,
        aliasStore: params.options.callbackAliasStore ?? pack!.callbackAliasStore,
        bindStore: params.options.callbackBindStore ?? pack!.callbackBindStore,
        used: params.options.callbackUsedStore ?? pack!.callbackUsedStore,
        ...(params.options.callbackAsyncUsedStore
          ? { asyncUsed: params.options.callbackAsyncUsedStore }
          : {}),
      });
    this.miniAppQueries =
      params.options.miniApp?.queries ??
      new SignedMiniAppQueryRegistry({
        secret: this.miniAppSecret,
        ...(params.options.miniApp?.queryUsedStore || pack
          ? { used: params.options.miniApp?.queryUsedStore ?? pack!.miniAppQueryUsedStore }
          : {}),
        ...(params.options.miniApp?.asyncQueryUsedStore
          ? { asyncUsed: params.options.miniApp.asyncQueryUsedStore }
          : {}),
      });
    this.miniAppAllowedOrigins = [...(params.options.miniApp?.allowedOrigins ?? [])];
    if (params.options.miniApp?.defaultUrl && this.miniAppAllowedOrigins.length === 0) {
      try {
        this.miniAppAllowedOrigins.push(new URL(params.options.miniApp.defaultUrl).origin);
      } catch {
        throw new ConfigurationError(
          `miniApp.defaultUrl is not a valid URL: ${params.options.miniApp.defaultUrl}`,
        );
      }
    }
    const warnStore = (message: string): void => {
      this.logger.warn(message);
      this.options.onStoreWarn?.(message);
    };
    if (
      this.callbacks instanceof SignedCallbackRegistry &&
      !params.options.callbackAsyncUsedStore
    ) {
      warnStore(
        "callback used-tokens persist under storagePath (single host); multi-instance bots must inject callbackAsyncUsedStore (see examples/redis-stores)",
      );
    }
    if (
      this.callbacks instanceof SignedCallbackRegistry &&
      !params.options.callbackAliasStore
    ) {
      warnStore(
        "short !cb aliases persist under storagePath (single host); multi-instance bots must inject callbackAliasStore",
      );
    }
    if (
      this.miniAppQueries instanceof SignedMiniAppQueryRegistry &&
      !params.options.miniApp?.asyncQueryUsedStore
    ) {
      warnStore(
        "MiniApp query used-tokens persist under storagePath (single host); multi-instance bots must inject miniApp.asyncQueryUsedStore",
      );
    }
    if (
      params.options.miniApp?.asyncNonceStore == null &&
      params.options.miniApp?.nonceStore == null &&
      params.options.miniApp?.secret
    ) {
      warnStore(
        "MiniApp launch nonces default to process-local memory; multi-instance HTTP must inject miniApp.asyncNonceStore",
      );
    }
  }

  static async create(options: BotCreateOptions): Promise<Bot> {
    const logger =
      typeof options.logger === "string" || options.logger === undefined
        ? createDefaultLogger(options.logger as LogLevel | undefined)
        : options.logger;
    const created = await createMatrixClient({ ...options, logger });
    return new Bot({
      client: created.client,
      storagePath: created.storagePath,
      cryptoEnabled: created.cryptoEnabled,
      logger,
      options,
      ...(created.configuredDeviceId !== undefined
        ? { configuredDeviceId: created.configuredDeviceId }
        : {}),
    });
  }

  /** True after crypto prepare and own-device-key verification succeeded. */
  get cryptoReady(): boolean {
    return this._cryptoReady;
  }

  get isRunning(): boolean {
    return this.started;
  }

  /** True after `stop()` began — contexts refuse further sends. */
  get isStopping(): boolean {
    return this.stopping;
  }

  /** The bot's own user id. */
  get selfId(): string {
    return this.client.selfId;
  }

  getDeviceId(): string | null {
    return this.client.crypto?.clientDeviceId ?? this.configuredDeviceId ?? null;
  }

  // ------------------------------------------------------------------ start

  /** Start syncing and dispatch updates through `dispatcher`. */
  async start(dispatcher: Dispatcher): Promise<void> {
    if (this.started) throw new ConfigurationError("Bot already started");
    this.stopping = false;
    this.dispatcher = dispatcher;

    if (this.options.handlerTimeoutMs) {
      dispatcher.setHandlerTimeout(this.options.handlerTimeoutMs);
    }
    this.commands.addAll(dispatcher.commandSpecs);

    if (this.cryptoEnabled) await this.verifyCryptoContract();
    else this._cryptoReady = false;

    this.factory = new ContextFactory({
      bot: this,
      client: this.client,
      logger: this.logger,
      storage: dispatcher.storage,
      callbacks: this.callbacks,
      ...(this.options.fsm ? { fsm: this.options.fsm } : {}),
      messageDefaults: this.effectiveMessageDefaults(),
    });

    if (this.options.onRateLimited) {
      const notify: Middleware = async (_ctx, next) => {
        try {
          await next();
        } catch (err) {
          if (err instanceof RateLimitedError) {
            this.options.onRateLimited?.({
              retryAfterMs: err.retryAfterMs,
              method: err.method,
              path: err.path,
            });
          }
          throw err;
        }
      };
      dispatcher.use(notify);
    }

    await this.client.start({
      onRoomEvent: (roomId, event, meta) => {
        void this.feedRoomEvent(roomId, event, meta);
      },
      onToDevice: (event) => {
        void this.feedToDevice(event);
      },
      onInvite: (roomId, events) => {
        void this.feedInvite(roomId, events);
      },
      onFatal: (err) => {
        this.logger.error("fatal sync error; the bot is no longer syncing", err);
        this.started = false;
        this.options.onFatal?.(err);
      },
    });

    this.started = true;
    this.syncStaleNotified = false;
    if (this.options.onSyncStale) {
      this.syncWatchTimer = setInterval(() => {
        const health = this.getHealth();
        if (!health.running) return;
        if (health.syncStale) {
          if (!this.syncStaleNotified) {
            this.syncStaleNotified = true;
            this.options.onSyncStale?.({
              syncAgeMs: health.syncAgeMs,
              lastSyncAtMs: health.lastSyncAtMs,
            });
          }
        } else {
          this.syncStaleNotified = false;
        }
      }, 15_000);
      this.syncWatchTimer.unref?.();
    }
    this.logger.info(
      `started as ${this.selfId} (device=${this.getDeviceId() ?? "none"}, crypto=${this.cryptoEnabled}, cryptoReady=${this._cryptoReady})`,
    );
  }

  /**
   * Start, then block until a shutdown signal arrives, then stop cleanly.
   * The equivalent of aiogram's `dp.run_polling(bot)`.
   */
  async run(dispatcher: Dispatcher, options: RunOptions = {}): Promise<void> {
    await this.start(dispatcher);
    await options.onReady?.(this);

    const signals = options.signals ?? (["SIGINT", "SIGTERM"] as NodeJS.Signals[]);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (signal: NodeJS.Signals): void => {
        if (settled) return;
        settled = true;
        this.logger.info(`received ${signal}, shutting down`);
        for (const s of signals) process.off(s, handlers[s]!);
        resolve();
      };
      const handlers: Partial<Record<NodeJS.Signals, () => void>> = {};
      for (const signal of signals) {
        handlers[signal] = () => finish(signal);
        process.on(signal, handlers[signal]!);
      }
    });

    await options.onShutdown?.(this);
    await this.stop();
    await dispatcher.close();
  }

  /** Stop syncing, drain in-flight handlers and release resources. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.syncWatchTimer) {
      clearInterval(this.syncWatchTimer);
      this.syncWatchTimer = null;
    }
    this.scheduler.stop();
    await this.client.stop();
    await this.client.crypto?.close();
    this.durableStores?.flush();
    this.started = false;
    this.logger.info("stopped");
  }

  getHealth(): BotHealth {
    const lastSyncAtMs = this.client.lastSyncAt;
    const syncAgeMs = lastSyncAtMs > 0 ? Date.now() - lastSyncAtMs : Number.POSITIVE_INFINITY;
    const staleMs = this.options.healthSyncStaleMs ?? 120_000;
    const syncStale = syncAgeMs > staleMs;
    const cryptoOk = !this.cryptoEnabled || this._cryptoReady;
    const ok = this.started && !this.stopping && !syncStale && cryptoOk;
    return {
      running: this.started,
      ok,
      cryptoEnabled: this.cryptoEnabled,
      cryptoReady: this._cryptoReady,
      userId: this.selfId,
      deviceId: this.getDeviceId(),
      lastSyncAtMs,
      syncAgeMs,
      syncStale,
      roomsCached: this.client.rooms.size,
      pendingCallbacks: this.callbacks.size,
      pendingMiniAppQueries: this.miniAppQueries.size,
      scheduledJobs: this.scheduler.size,
    };
  }

  /**
   * Effective send defaults. `parseMode: "markdown"` is on unless overridden.
   * `clientProfile: "aware"` applies {@link AWARE_MESSAGE_DEFAULTS}.
   */
  effectiveMessageDefaults(): MessageDefaults {
    const aware =
      this.options.clientProfile === "aware" ? AWARE_MESSAGE_DEFAULTS : null;
    return {
      parseMode: "markdown",
      ...aware,
      ...this.options.messageDefaults,
    };
  }

  /** MiniApp card defaults after `clientProfile` / explicit `miniApp.*`. */
  effectiveMiniAppDefaults(): Partial<MiniAppCardOptions> {
    const aware =
      this.options.clientProfile === "aware" ? { ...AWARE_MINI_APP_DEFAULTS } : {};
    const configured = this.options.miniApp ?? {};
    return {
      ...aware,
      ...(configured.includePlainLink !== undefined
        ? { includePlainLink: configured.includePlainLink }
        : {}),
      ...(configured.includeLaunchKeyboard !== undefined
        ? { includeLaunchKeyboard: configured.includeLaunchKeyboard }
        : {}),
      ...(configured.includeKeyboardFallback !== undefined
        ? { includeKeyboardFallback: configured.includeKeyboardFallback }
        : {}),
      ...(configured.topLevelUrl !== undefined ? { topLevelUrl: configured.topLevelUrl } : {}),
    };
  }

  private async verifyCryptoContract(): Promise<void> {
    const whoami = await this.client.getWhoAmI();
    if (this.configuredDeviceId && whoami.device_id) {
      assertDeviceIdMatch(this.configuredDeviceId, whoami.device_id);
    }
    await prepareCrypto(this.client);

    const deviceId = await resolveDeviceId(this.client);
    const cryptoDevice = this.client.crypto?.clientDeviceId ?? null;
    if (this.configuredDeviceId) {
      if (!cryptoDevice || cryptoDevice !== this.configuredDeviceId) {
        throw new DeviceMismatchError(this.configuredDeviceId, cryptoDevice, {
          storagePath: this.storagePath,
          keepDeviceId: cryptoDevice,
        });
      }
      if (deviceId) assertDeviceIdMatch(this.configuredDeviceId, deviceId);
    }
    const readyDevice = cryptoDevice ?? deviceId ?? this.configuredDeviceId;
    if (!readyDevice) {
      throw new ConfigurationError("no device id is available after prepareCrypto");
    }
    await assertOwnDeviceKeysReady(this.client, this.selfId, readyDevice);
    if (this.options.bootstrapCrossSigning && this.client.crypto) {
      try {
        const auth =
          this.options.password != null
            ? {
                type: "m.login.password",
                identifier: { type: "m.id.user", user: this.selfId },
                password: this.options.password,
              }
            : undefined;
        await this.client.crypto.bootstrapCrossSigning(false, auth);
        this.logger.info("cross-signing keys bootstrapped");
      } catch (err) {
        this.logger.warn("bootstrapCrossSigning failed", err);
      }
    }
    this._cryptoReady = true;
  }

  // --------------------------------------------------------------- dispatch

  /**
   * Feed a timeline event as if it had arrived from `/sync`.
   *
   * Public so tests and alternative transports (bridges, replays, webhooks) can
   * drive the same pipeline the sync loop uses.
   */
  async feedRoomEvent(
    roomId: string,
    event: MatrixEvent,
    meta: Partial<ClientEventMeta> = {},
  ): Promise<void> {
    if (this.stopping || !this.dispatcher || !this.factory) return;
    // The bot's own echoes are never updates; handlers that need them can read
    // the timeline explicitly.
    if (event.sender === this.selfId) return;
    try {
      const ctx = await this.factory.fromRoomEvent(roomId, event, meta);
      if (!ctx || this.stopping) return;
      await this.dispatcher.feed(ctx);
    } catch (err) {
      if (this.stopping) return;
      this.logger.error(`unhandled dispatch error in ${roomId}`, err);
    }
  }

  /** Feed a to-device event through the dispatcher. */
  async feedToDevice(event: MatrixEvent): Promise<void> {
    if (this.stopping || !this.dispatcher || !this.factory) return;
    // Crypto plumbing is not an application-level update.
    const type = readString(event, "type") ?? "";
    if (type.startsWith("m.room_key") || type === "m.room.encrypted" || type === "m.dummy") return;
    try {
      await this.dispatcher.feed(this.factory.fromToDevice(event));
    } catch (err) {
      this.logger.error("unhandled to-device dispatch error", err);
    }
  }

  /** Feed an invite's stripped state through the dispatcher. */
  async feedInvite(roomId: string, events: MatrixEvent[]): Promise<void> {
    if (this.stopping || !this.dispatcher || !this.factory) return;
    const own = events.find(
      (event) => event.type === "m.room.member" && event.state_key === this.selfId,
    );
    if (!own) return;
    try {
      await this.dispatcher.feed(await this.factory.fromInvite(roomId, own));
    } catch (err) {
      this.logger.error(`unhandled invite dispatch error in ${roomId}`, err);
    }
  }

  // ------------------------------------------------------------- callbacks

  /**
   * Resolve an inline-keyboard press from either the dedicated callback event or
   * the `!cb <token>` text fallback. Used by the context factory.
   */
  async readCallbackEvent(
    roomId: string,
    event: MatrixEvent,
  ): Promise<{ callbackData: string; messageEventId: string; queryId: string } | null> {
    const type = readString(event, "type");
    const content = isPlainObject(event.content) ? event.content : {};

    if (type === CALLBACK_EVENT_TYPE) {
      const token = readString(content, "token");
      const record = token ? await this.resolveCallbackToken(token, roomId, event.sender) : null;
      if (record) {
        if (record.answered) return null;
        return {
          callbackData: record.data,
          messageEventId: record.messageEventId,
          queryId: token as string,
        };
      }
      // Unsigned `content.data` bypasses room-bound HMAC — off by default.
      if (!this.options.allowUnsignedCallbacks) {
        if (readString(content, "data") || token) {
          this.logger.warn(
            `ignoring unsigned/invalid ${CALLBACK_EVENT_TYPE} in ${roomId} (set allowUnsignedCallbacks to opt in)`,
          );
        }
        return null;
      }
      const data = readString(content, "data");
      if (!data) return null;
      return {
        callbackData: data,
        messageEventId: readString(content, "message_id") ?? "",
        queryId: "",
      };
    }

    if (type !== "m.room.message") return null;
    const body = (readString(content, "body") ?? "").trim();
    if (!body) return null;
    const match = new RegExp(`^[!/]${CALLBACK_FALLBACK_COMMAND}\\s+(\\S+)$`).exec(body);
    if (!match?.[1]) return null;
    const record = await this.resolveCallbackToken(match[1], roomId, event.sender);
    if (!record || record.answered) return null;
    return {
      callbackData: record.data,
      messageEventId: record.messageEventId,
      queryId: match[1],
    };
  }

  /**
   * Resolve a callback token, refusing tokens minted for a different room.
   * Without the room check a token leaked from one room would work in another.
   */
  private async resolveCallbackToken(
    token: string,
    roomId: string,
    senderId: string | undefined,
  ): Promise<ReturnType<CallbackTokenStore["resolve"]>> {
    const record = this.callbacks.resolveAsync
      ? await this.callbacks.resolveAsync(token, senderId)
      : this.callbacks.resolve(token, senderId);
    if (!record) return null;
    if (record.roomId !== roomId) {
      this.logger.warn(`callback token used in ${roomId} but was issued for ${record.roomId}`);
      return null;
    }
    return record;
  }

  /** Extract MiniApp `sendData` payloads from message content. */
  readMiniAppData(
    event: MatrixEvent,
  ): { raw: string; payload: unknown; queryId: string | null; appId: string | null } | null {
    const parsed = parseMiniAppDataContent(event.content);
    if (!parsed) return null;
    return {
      raw: parsed.data,
      payload: parseMiniAppJson(parsed.data),
      queryId: parsed.queryId,
      appId: parsed.appId,
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Send a plain-text message with the full {@link SendOptions} surface. */
  sendMessage(roomId: string, text: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(
      { client: this.client, roomId, callbacks: this.callbacks },
      { text },
      { ...this.effectiveMessageDefaults(), ...options },
    );
  }

  /** Send an HTML message (plain-text fallback derived automatically). */
  sendHtml(roomId: string, html: string, options?: SendOptions): Promise<string> {
    return sendMessageWithOptions(
      { client: this.client, roomId, callbacks: this.callbacks },
      { html },
      { ...this.effectiveMessageDefaults(), ...options },
    );
  }

  /** Render `/help` text from the registered command specs. */
  helpText(options?: HelpTextOptions): string {
    return buildHelpText(this.commands.list(), options);
  }

  helpHtml(options?: HelpTextOptions): string {
    return buildHelpHtml(this.commands.list(), options);
  }

  /** Register extra command specs (for commands not declared via `Command(...)`). */
  addCommands(specs: CommandSpec[]): this {
    this.commands.addAll(specs);
    return this;
  }

  /**
   * Advertise the command list as room state so clients can offer
   * slash-autocomplete without hard-coding anything.
   */
  async advertiseCommands(roomId: string): Promise<string> {
    const eventId = await this.client.sendStateEvent(
      roomId,
      COMMANDS_STATE_EVENT_TYPE,
      this.selfId,
      buildCommandsStateContent(this.commands.list()),
    );
    if (this.options.advertiseCapabilities === true) {
      await this.advertiseCapabilities(roomId).catch((err) => {
        this.logger.warn(`advertiseCapabilities failed in ${roomId}`, err);
      });
    }
    return eventId;
  }

  /** Publish `dev.aiomatrix.bot` so aware hosts can detect keyboard/MiniApp contract. */
  async advertiseCapabilities(roomId: string): Promise<string> {
    const defaults = this.effectiveMessageDefaults();
    const mini = this.effectiveMiniAppDefaults();
    return this.client.sendStateEvent(
      roomId,
      BOT_CAPABILITIES_STATE_EVENT_TYPE,
      this.selfId,
      buildBotCapabilitiesContent({
        clientProfile: this.options.clientProfile ?? "stock",
        keyboardFallback: defaults.keyboardFallback,
        parseMode: defaults.parseMode,
        topLevelUrl: mini.topLevelUrl,
        includePlainLink: mini.includePlainLink,
        includeLaunchKeyboard: mini.includeLaunchKeyboard,
        includeKeyboardFallback: mini.includeKeyboardFallback,
      }) as unknown as Record<string, unknown>,
    );
  }

  // ---------------------------------------------------------------- MiniApp

  /** The MiniApp signing secret (persisted under `storagePath`). */
  get miniAppSigningSecret(): string {
    return this.miniAppSecret;
  }

  /**
   * Build a signed, per-user launch URL for a mini app.
   *
   * The signature is what makes a Matrix mini app trustworthy: the mini app's
   * backend can verify who opened it without trusting the browser.
   */
  createMiniAppLaunch(options: MiniAppLaunchOptions): MiniAppLaunch {
    const url = options.url ?? this.options.miniApp?.defaultUrl;
    if (!url) {
      throw new ConfigurationError(
        "no mini app url: pass `url` or configure `miniApp.defaultUrl`",
      );
    }
    if (
      this.miniAppAllowedOrigins.length > 0 &&
      !isMiniAppUrlAllowed(url, this.miniAppAllowedOrigins)
    ) {
      throw new MiniAppAuthError(
        `mini app url ${url} is not in miniApp.allowedOrigins`,
        "malformed",
      );
    }

    const query =
      options.withoutQuery === true || !options.roomId
        ? null
        : this.miniAppQueries.issue({
            roomId: options.roomId,
            userId: options.userId,
            messageId: options.messageId ?? null,
            appId: options.appId ?? null,
          });

    const room: MiniAppRoom | undefined = options.roomId
      ? {
          id: options.roomId,
          type: this.client.rooms.isDirect(options.roomId) ? "direct" : "group",
          ...(this.client.rooms.get(options.roomId)?.name
            ? { title: this.client.rooms.get(options.roomId)!.name as string }
            : {}),
          ...(this.client.rooms.membershipOf(options.roomId, options.userId)
            ? {
                membership: this.client.rooms.membershipOf(
                  options.roomId,
                  options.userId,
                ) as MiniAppRoom["membership"],
              }
            : {}),
          power_level: this.client.rooms.powerLevelOf(options.roomId, options.userId),
        }
      : undefined;

    const localpart = options.userId.replace(/^@/, "").split(":")[0] ?? options.userId;
    const signed = createInitData(
      {
        user: { id: options.userId, username: localpart, ...options.user },
        ...(room ? { room } : {}),
        ...(query ? { query_id: query.queryId } : {}),
        ...(options.startParam ? { start_param: options.startParam } : {}),
        ...(options.messageId ? { message_id: options.messageId } : {}),
        bot_id: this.selfId,
      },
      this.miniAppSecret,
      { ttlSeconds: this.options.miniApp?.initDataTtlSeconds ?? 3600 },
    );

    return {
      url: buildMiniAppLaunchUrl(url, signed),
      signed,
      queryId: query?.queryId ?? null,
    };
  }

  /**
   * Post a mini app launch card.
   *
   * When `userId` is given the card links to a signed, single-user launch URL;
   * otherwise it links to the plain mini app URL and the client is expected to
   * request signed launch data itself.
   */
  async sendMiniApp(
    roomId: string,
    options: Omit<MiniAppCardOptions, "url"> & { url?: string; userId?: string } = {},
  ): Promise<string> {
    const url = options.url ?? this.options.miniApp?.defaultUrl;
    if (!url) {
      throw new ConfigurationError(
        "no mini app url: pass `url` or configure `miniApp.defaultUrl`",
      );
    }
    let launchUrl = url;
    if (options.userId) {
      launchUrl = this.createMiniAppLaunch({
        url,
        userId: options.userId,
        roomId,
        ...(options.startParam ? { startParam: options.startParam } : {}),
        ...(options.appId ? { appId: options.appId } : {}),
      }).url;
    }
    const content = buildMiniAppContent({
      ...this.effectiveMiniAppDefaults(),
      ...options,
      url: launchUrl,
      botId: options.botId ?? this.selfId,
    });
    return this.client.sendMessage(roomId, content);
  }

  /**
   * Reply to a MiniApp `sendData` round trip.
   * Returns `null` when the query is unknown, expired, or already answered.
   */
  async answerMiniAppQuery(
    queryId: string,
    text: string,
    options?: SendOptions & { html?: string },
  ): Promise<string | null> {
    const record = this.miniAppQueries.claimAsync
      ? await this.miniAppQueries.claimAsync(queryId)
      : this.miniAppQueries.claim(queryId);
    if (!record) {
      this.logger.debug(`mini app query ${queryId} is unknown, expired, or already answered`);
      return null;
    }
    try {
      return await sendMessageWithOptions(
        {
          client: this.client,
          roomId: record.roomId,
          callbacks: this.callbacks,
          triggerEventId: record.messageId,
          callbackUserId: record.userId,
        },
        options?.html ? { html: options.html } : { text },
        { ...this.effectiveMessageDefaults(), ...options },
      );
    } catch (err) {
      // Let the mini app retry rather than burning the query on a transient error.
      this.miniAppQueries.release(queryId);
      throw err;
    }
  }

  /**
   * Build the HTTP backend for a mini app: launch validation, session tokens and
   * the `sendData` bridge into the dispatcher.
   */
  createMiniAppServer(
    options: Partial<Omit<MiniAppServerOptions, "secret">> = {},
  ): MiniAppServer {
    const defaultResolveRoomAuth = (
      userId: string,
      roomId: string,
    ): { membership: string | null; powerLevel: number | null } => ({
      membership: this.client.rooms.membershipOf(roomId, userId) ?? null,
      powerLevel: this.client.rooms.powerLevelOf(roomId, userId),
    });
    return new MiniAppServer({
      secret: this.miniAppSecret,
      allowedOrigins: options.allowedOrigins ?? this.miniAppAllowedOrigins,
      ...(this.options.miniApp?.initDataTtlSeconds !== undefined
        ? { initDataTtlSeconds: this.options.miniApp.initDataTtlSeconds }
        : {}),
      ...(this.options.miniApp?.nonceStore
        ? { nonceStore: this.options.miniApp.nonceStore }
        : {}),
      ...(this.options.miniApp?.asyncNonceStore
        ? { asyncNonceStore: this.options.miniApp.asyncNonceStore }
        : {}),
      ...options,
      resolveRoomAuth: options.resolveRoomAuth ?? defaultResolveRoomAuth,
      onData:
        options.onData ??
        (async (session, data) => {
          await this.feedMiniAppData(session, data);
          return { delivered: true };
        }),
    });
  }

  /** Turn a `sendData` payload from the HTTP bridge into a dispatcher update. */
  async feedMiniAppData(session: MiniAppSession, data: string): Promise<MiniAppDataContext | null> {
    if (!this.dispatcher || !this.factory) {
      throw new ConfigurationError("Bot is not started; cannot dispatch mini app data");
    }
    const roomId = session.roomId ?? this.miniAppQueries.peek(session.queryId ?? "")?.roomId ?? "";
    if (!roomId) {
      this.logger.warn("mini app data has no room context; dropping it");
      return null;
    }
    const record = session.queryId ? this.miniAppQueries.peek(session.queryId) : null;
    const ctx = this.factory.buildMiniAppData({
      roomId,
      userId: session.userId,
      raw: data,
      payload: parseMiniAppJson(data),
      queryId: session.queryId,
      appId: session.appId ?? record?.appId ?? null,
      messageId: record?.messageId ?? null,
    });
    await this.dispatcher.feed(ctx as AnyContext);
    return ctx;
  }

  /** Pin a mini app as a room widget so stock clients can open it inline. */
  async pinMiniAppWidget(
    roomId: string,
    options: Omit<WidgetOptions, "creatorUserId"> & { layout?: boolean },
  ): Promise<string> {
    const eventId = await this.client.sendStateEvent(
      roomId,
      WIDGET_STATE_EVENT_TYPE,
      options.widgetId,
      buildWidgetStateContent({ ...options, creatorUserId: this.selfId }),
    );
    if (options.layout !== false) {
      await this.client
        .sendStateEvent(
          roomId,
          "io.element.widgets.layout",
          "",
          buildWidgetLayoutContent(options.widgetId),
        )
        .catch((err: unknown) => {
          this.logger.debug("could not set the widget layout", err);
        });
    }
    return eventId;
  }

  /** Remove a previously pinned widget. */
  async removeWidget(roomId: string, widgetId: string): Promise<string> {
    return this.client.sendStateEvent(
      roomId,
      WIDGET_STATE_EVENT_TYPE,
      widgetId,
      buildWidgetRemovalContent(),
    );
  }

  /** Convenience re-export so `new bot.Keyboard()` is not needed. */
  static keyboard(): InlineKeyboard {
    return new InlineKeyboard();
  }
}
