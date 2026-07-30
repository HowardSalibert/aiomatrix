import type { MatrixClient } from "./client.js";
import type { Bot } from "./bot.js";
import type { FSMContext, Storage } from "./fsm.js";

/** Raw Matrix room message event (subset used by handlers). */
export interface MatrixMessageEvent {
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  type?: string;
  content?: {
    msgtype?: string;
    body?: string;
    formatted_body?: string;
    format?: string;
    "m.relates_to"?: unknown;
    [key: string]: unknown;
  };
  unsigned?: {
    age?: number;
    transaction_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type FilterFn = (ctx: Context) => boolean | Promise<boolean>;

export type Handler = (ctx: Context) => void | Promise<void>;

export type Middleware = (
  ctx: Context,
  next: () => Promise<void>,
) => void | Promise<void>;

export interface Context {
  roomId: string;
  senderId: string;
  eventId: string;
  /** Plain body text (may be empty). */
  text: string;
  /** Alias for text / event content body. */
  body: string;
  isDirect: boolean;
  /** Arguments after the matched command token (trimmed by handlers as needed). */
  commandArgs: string;
  /** Matched command name without prefix, if any. */
  commandName: string | null;
  event: MatrixMessageEvent;
  client: MatrixClient;
  bot: Bot;
  state: FSMContext;
  reply(text: string): Promise<string>;
  replyHtml(html: string): Promise<string>;
  react(key: string): Promise<string>;
}

/**
 * Bot-side OlmMachine EncryptionSettings for megolm key sharing.
 * These are NOT Synapse server settings — they control how this bot's
 * CryptoEngine calls `shareRoomKey`.
 */
export type EncryptionSharePolicy = {
  /** Default false for bots — share megolm with unverified devices. */
  onlyAllowTrustedDevices?: boolean;
  /** Default false — don't fail share on verified-user/unverified-device problems. */
  errorOnVerifiedUserProblem?: boolean;
};

/** Structured crypto lifecycle events for bot authors (withheld keys, peers, encrypt). */
export type CryptoLogEvent =
  | {
      type: "share_room_key";
      roomId: string;
      keyShares: number;
      withheld: number;
      peers: string[];
      policy: Required<EncryptionSharePolicy>;
    }
  | { type: "withheld_detail"; roomId: string; eventType: string; bodyPreview: string }
  | { type: "peer_keys_missing"; roomId: string; peers: string[] }
  | { type: "encrypt_send"; roomId: string; eventType: string }
  | { type: "warn"; message: string; detail?: unknown }
  | { type: "error"; message: string; detail?: unknown };

export interface BotCreateOptions {
  homeserverUrl: string;
  accessToken: string;
  /** Required when crypto is enabled (or loaded from storagePath/device.json). */
  deviceId?: string;
  storagePath?: string;
  /** Default true. When true, Rust crypto (OlmMachine) is initialized and E2EE contract enforced. */
  crypto?: boolean;
  /**
   * Megolm share policy for OlmMachine EncryptionSettings (bot client, not Synapse).
   * Defaults: onlyAllowTrustedDevices=false, errorOnVerifiedUserProblem=false.
   */
  encryption?: EncryptionSharePolicy;
  /** Optional hook for rich crypto diagnostics (withheld keys, peer gaps, encrypt). */
  onCryptoLog?: (event: CryptoLogEvent) => void;
  /** Auto-join invited rooms. Default true. */
  autojoin?: boolean;
  /** Passphrase for OlmMachine SQLite store. Empty → warn once (unencrypted store). */
  cryptoStorePassphrase?: string;
}

export interface DispatcherOptions {
  storage?: Storage;
}

export interface StateRef {
  readonly group: string;
  readonly name: string;
  /** Filter: current FSM state equals this state. */
  (ctx: Context): boolean | Promise<boolean>;
}
