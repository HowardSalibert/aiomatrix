import { StoreType } from "@matrix-org/matrix-sdk-crypto-nodejs";
import matrixBotSdk from "matrix-bot-sdk";
import type { MatrixClient } from "matrix-bot-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BotCreateOptions } from "./types.js";

const {
  MatrixClient: MatrixClientCtor,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} = matrixBotSdk;

export interface CreatedClient {
  client: MatrixClient;
  storagePath: string;
  cryptoEnabled: boolean;
  configuredDeviceId?: string;
}

/**
 * Build a MatrixClient with optional RustSdkCryptoStorageProvider under storagePath/crypto.
 */
export function createMatrixClient(options: BotCreateOptions): CreatedClient {
  const storagePath = path.resolve(options.storagePath ?? "./data");
  fs.mkdirSync(storagePath, { recursive: true });

  const cryptoEnabled = options.crypto !== false;
  const storePath = path.join(storagePath, "bot.json");
  const storage = new SimpleFsStorageProvider(storePath);

  let cryptoStore: InstanceType<typeof RustSdkCryptoStorageProvider> | undefined;
  if (cryptoEnabled) {
    const cryptoPath = path.join(storagePath, "crypto");
    fs.mkdirSync(cryptoPath, { recursive: true });
    // Sqlite is the supported durable store for matrix-sdk-crypto-nodejs.
    // Import StoreType from crypto-nodejs — matrix-bot-sdk does not re-export it at runtime.
    cryptoStore = new RustSdkCryptoStorageProvider(cryptoPath, StoreType.Sqlite);
  }

  const client = new MatrixClientCtor(
    options.homeserverUrl,
    options.accessToken,
    storage,
    cryptoStore,
  );

  return {
    client,
    storagePath,
    cryptoEnabled,
    configuredDeviceId: options.deviceId,
  };
}

/**
 * Resolve the active device id after crypto prepare (or from whoami).
 */
export async function resolveDeviceId(client: MatrixClient): Promise<string | null> {
  if (client.crypto?.clientDeviceId) {
    return client.crypto.clientDeviceId;
  }
  try {
    const whoami = await client.getWhoAmI();
    return whoami.device_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Explicit prepareCrypto step: join rooms + crypto.prepare (flush via engine.run inside).
 */
export async function prepareCrypto(client: MatrixClient): Promise<void> {
  if (!client.crypto) {
    throw new Error("prepareCrypto called but crypto is not enabled on MatrixClient");
  }
  const rooms = await client.getJoinedRooms();
  await client.crypto.prepare(rooms);
}
