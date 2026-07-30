import {
  createMatrixClient,
  prepareCrypto,
  resolveDeviceId,
  type MatrixClient,
} from "./client.js";
import { assertDeviceIdMatch, assertOwnDeviceKeysReady } from "./crypto-guard.js";
import { DeviceMismatchError } from "./errors.js";
import type { Dispatcher } from "./dispatcher.js";
import type { BotCreateOptions } from "./types.js";

/**
 * High-level Matrix bot with strict E2EE contract when crypto is enabled.
 */
export class Bot {
  readonly client: MatrixClient;
  readonly storagePath: string;
  readonly cryptoEnabled: boolean;
  private readonly configuredDeviceId?: string;
  private _cryptoReady = false;
  private started = false;

  private constructor(
    client: MatrixClient,
    storagePath: string,
    cryptoEnabled: boolean,
    configuredDeviceId?: string,
  ) {
    this.client = client;
    this.storagePath = storagePath;
    this.cryptoEnabled = cryptoEnabled;
    this.configuredDeviceId = configuredDeviceId;
  }

  /** True after successful crypto prepare + own device key verification. */
  get cryptoReady(): boolean {
    return this._cryptoReady;
  }

  static async create(options: BotCreateOptions): Promise<Bot> {
    const cryptoEnabled = options.crypto !== false;
    // deviceId may come from options or storagePath/device.json (resolved in createMatrixClient)
    const created = await createMatrixClient(options);

    if (cryptoEnabled && !created.client.getDeviceId() && !options.deviceId) {
      throw new Error(
        "deviceId is REQUIRED when crypto is enabled (set MATRIX_DEVICE_ID / BotCreateOptions.deviceId or storagePath/device.json)",
      );
    }

    return new Bot(
      created.client,
      created.storagePath,
      created.cryptoEnabled,
      options.deviceId ?? created.configuredDeviceId,
    );
  }

  /**
   * Start syncing and dispatch room messages through the given Dispatcher.
   * With crypto: prepareCrypto, verify deviceId, verify own keys — or throw and refuse start.
   */
  async start(dispatcher: Dispatcher): Promise<void> {
    if (this.started) {
      throw new Error("Bot already started");
    }

    if (this.cryptoEnabled) {
      const whoami = await this.client.getWhoAmI();
      const whoamiDevice = whoami.device_id ?? null;
      // Only enforce whoami match when HS returns device_id
      if (this.configuredDeviceId && whoamiDevice) {
        assertDeviceIdMatch(this.configuredDeviceId, whoamiDevice);
      }
    }

    if (this.cryptoEnabled) {
      await prepareCrypto(this.client);

      const deviceId = await resolveDeviceId(this.client);
      const cryptoDevice = this.client.crypto?.clientDeviceId ?? null;

      // After prepare: configured deviceId must equal crypto.clientDeviceId
      if (this.configuredDeviceId) {
        if (!cryptoDevice || cryptoDevice !== this.configuredDeviceId) {
          throw new DeviceMismatchError(this.configuredDeviceId, cryptoDevice);
        }
        if (deviceId) {
          assertDeviceIdMatch(this.configuredDeviceId, deviceId);
        }
      }

      const userId = await this.client.getUserId();
      const readyDevice = cryptoDevice ?? deviceId ?? this.configuredDeviceId;
      if (!readyDevice) {
        throw new Error("No deviceId available after prepareCrypto");
      }
      await assertOwnDeviceKeysReady(this.client, userId, readyDevice);
      this._cryptoReady = true;
    } else {
      this._cryptoReady = false;
    }

    await this.client.start(
      (roomId, event) => {
        void dispatcher.feed(this, roomId, event).catch((err: unknown) => {
          console.error("[matrixbots] handler error:", err);
        });
      },
      (err) => {
        console.error("[matrixbots] fatal sync error:", err);
        this.started = false;
      },
    );
    this.started = true;
    console.log(
      `[matrixbots] Bot started (crypto=${this.cryptoEnabled}, cryptoReady=${this._cryptoReady})`,
    );
  }

  async stop(): Promise<void> {
    await this.client.stop();
    this.started = false;
  }

  getDeviceId(): string | null {
    return this.client.crypto?.clientDeviceId ?? this.configuredDeviceId ?? null;
  }
}
