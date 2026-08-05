import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ConfigurationError } from "./errors.js";
import { MatrixHttp } from "./http.js";
import {
  clearSession,
  loadSession,
  loginWithPassword,
  refreshAccessToken,
  saveSession,
  type MatrixSession,
  type PasswordLoginOptions,
} from "./login.js";
import { createDefaultLogger, type Logger } from "./logger.js";
import { readJsonSafe, resolveStoragePath, writeJsonAtomic } from "./util.js";

export type SessionSuggestedAction =
  | "ok"
  | "refresh"
  | "password_relogin"
  | "wipe_crypto_and_relogin";

export interface SessionDiagnosis {
  hasSession: boolean;
  hasCryptoStore: boolean;
  deviceId: string | null;
  hasRefreshToken: boolean;
  expiresAtMs?: number;
  suggestedAction: SessionSuggestedAction;
}

function deviceJsonPath(storagePath: string): string {
  return path.join(storagePath, "device.json");
}

function cryptoDir(storagePath: string): string {
  return path.join(storagePath, "crypto");
}

/** Load the persisted device id from `storagePath/device.json`, if any. */
export function loadPersistedDeviceId(storagePath: string): string | null {
  const raw = readJsonSafe<{ device_id?: string }>(deviceJsonPath(storagePath));
  return typeof raw?.device_id === "string" && raw.device_id ? raw.device_id : null;
}

/** Persist device id for the next restart (E2EE identity). */
export function savePersistedDeviceId(storagePath: string, deviceId: string): void {
  const root = resolveStoragePath(storagePath);
  if (loadPersistedDeviceId(root) === deviceId) return;
  writeJsonAtomic(deviceJsonPath(root), { device_id: deviceId });
}

/** Inspect local session/crypto files and suggest the next recovery step. */
export function diagnoseSession(storagePath: string): SessionDiagnosis {
  const root = resolveStoragePath(storagePath);
  const session = loadSession(root);
  const deviceId = session?.deviceId ?? loadPersistedDeviceId(root);
  const hasCryptoStore = fs.existsSync(cryptoDir(root));
  const hasRefreshToken = Boolean(session?.refreshToken);
  const expiresAtMs = session?.expiresAtMs;

  let suggestedAction: SessionSuggestedAction = "ok";
  if (!session) {
    suggestedAction = hasCryptoStore ? "wipe_crypto_and_relogin" : "password_relogin";
  } else if (expiresAtMs !== undefined && expiresAtMs <= Date.now()) {
    suggestedAction = hasRefreshToken ? "refresh" : "password_relogin";
  } else if (!hasRefreshToken && hasCryptoStore) {
    // Access token present but no refresh — mid-run expiry needs password relogin.
    suggestedAction = "ok";
  }

  const diagnosis: SessionDiagnosis = {
    hasSession: Boolean(session),
    hasCryptoStore,
    deviceId,
    hasRefreshToken,
    suggestedAction,
  };
  if (expiresAtMs !== undefined) diagnosis.expiresAtMs = expiresAtMs;
  return diagnosis;
}

/**
 * Delete `storagePath/crypto` so the next password login can rebuild Olm/Megolm
 * state. Does not touch `session.json`, `device.json`, or app data.
 */
export function wipeCryptoStore(storagePath: string): void {
  const root = resolveStoragePath(storagePath);
  const dir = cryptoDir(root);
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface RelocateSessionOptions {
  storagePath: string;
  homeserverUrl: string;
  user: string;
  password: string;
  /** Prefer this device id (defaults to session / device.json). */
  deviceId?: string;
  /** Wipe the crypto store before login. Default true on explicit relocate. */
  wipeCrypto?: boolean;
  /** Also clear session.json before login. Default true. */
  clearExistingSession?: boolean;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  allowInsecure?: boolean;
  deviceDisplayName?: string;
}

/**
 * Password-login again, preferably reusing the same device id so peers keep
 * decrypting the bot. Universal ops helper — bots should call this from
 * `onFatal` / deploy recover hooks rather than hand-rolling wipes.
 */
export async function relocateSession(options: RelocateSessionOptions): Promise<MatrixSession> {
  if (!options.password) {
    throw new ConfigurationError("relocateSession requires a password");
  }
  const root = resolveStoragePath(options.storagePath);
  fs.mkdirSync(root, { recursive: true });
  const logger = options.logger ?? createDefaultLogger();

  const existing = loadSession(root);
  const deviceId =
    options.deviceId ?? existing?.deviceId ?? loadPersistedDeviceId(root) ?? undefined;

  if (options.wipeCrypto !== false) wipeCryptoStore(root);
  if (options.clearExistingSession !== false) clearSession(root);

  const loginOpts: PasswordLoginOptions = {
    homeserverUrl: options.homeserverUrl,
    user: options.user,
    password: options.password,
    logger,
    ...(deviceId ? { deviceId } : {}),
    ...(options.deviceDisplayName
      ? { initialDeviceDisplayName: options.deviceDisplayName }
      : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.allowInsecure ? { allowInsecure: true } : {}),
  };
  const session = await loginWithPassword(loginOpts);
  saveSession(root, session);
  savePersistedDeviceId(root, session.deviceId);
  logger.info(
    `relocated session for ${session.userId} (device ${session.deviceId}` +
      `${options.wipeCrypto !== false ? ", crypto wiped" : ""})`,
  );
  return session;
}

function cryptoPassphrasePath(storagePath: string): string {
  return path.join(storagePath, "crypto-passphrase.json");
}

/**
 * Resolve the Olm SQLite passphrase: explicit option, persisted file, or a
 * newly generated secret written under `storagePath`. Returns `null` only when
 * `allowUnencrypted` is set.
 */
export function resolveCryptoStorePassphrase(
  storagePath: string,
  provided: string | null | undefined,
  options: { allowUnencrypted?: boolean; logger?: Logger } = {},
): string | null {
  if (provided != null && provided.length > 0) return provided;
  if (options.allowUnencrypted) return null;

  const root = resolveStoragePath(storagePath);
  const file = cryptoPassphrasePath(root);
  const existing = readJsonSafe<{ passphrase?: string }>(file);
  if (existing?.passphrase && existing.passphrase.length >= 16) {
    return existing.passphrase;
  }
  const passphrase = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(root, { recursive: true });
  writeJsonAtomic(file, { passphrase });
  (options.logger ?? createDefaultLogger()).info(
    `generated a crypto store passphrase in ${file} — back it up with the crypto directory`,
  );
  return passphrase;
}

export interface SessionRefreshHandlerOptions {
  storagePath: string;
  /**
   * Current homeserver URL. Prefer a getter so password re-login can follow
   * `well_known` / delegated HS changes.
   */
  homeserverUrl: string | (() => string);
  /** Called when password re-login discovers a different homeserver URL. */
  onHomeserverUrl?: (url: string) => void;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  allowInsecure?: boolean;
  /** When refresh fails, password-login again (mid-run recovery). */
  password?: string;
  userId?: string;
  autoRelogin?: boolean;
  deviceDisplayName?: string;
}

/**
 * Build the MatrixHttp `onTokenExpired` hook that refreshes and persists the
 * session. Falls back to password re-login when configured. Returns `null`
 * when recovery is impossible.
 */
export function createSessionRefreshHandler(
  options: SessionRefreshHandlerOptions,
): (error: unknown) => Promise<string | null> {
  const root = resolveStoragePath(options.storagePath);
  const logger = options.logger ?? createDefaultLogger();
  const getHomeserverUrl = (): string =>
    typeof options.homeserverUrl === "function"
      ? options.homeserverUrl()
      : options.homeserverUrl;

  return async () => {
    const session = loadSession(root);
    if (session?.refreshToken) {
      const anon = new MatrixHttp(getHomeserverUrl(), {
        logger,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.allowInsecure ? { allowInsecure: true } : {}),
      });
      try {
        const next = await refreshAccessToken(anon, session.refreshToken);
        const updated: MatrixSession = {
          ...session,
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? session.refreshToken,
        };
        if (next.expiresAtMs !== undefined) updated.expiresAtMs = next.expiresAtMs;
        else delete updated.expiresAtMs;
        saveSession(root, updated);
        logger.info("refreshed Matrix access token");
        return next.accessToken;
      } catch (err) {
        logger.warn("refresh_token exchange failed", err);
      }
    } else {
      logger.warn("access token expired and no refresh_token is stored");
    }

    if (!options.autoRelogin || !options.password || !options.userId) {
      return null;
    }

    const deviceId =
      session?.deviceId ?? loadPersistedDeviceId(root) ?? undefined;
    try {
      logger.warn("password re-login after auth failure");
      const loginOpts: PasswordLoginOptions = {
        homeserverUrl: getHomeserverUrl(),
        user: options.userId,
        password: options.password,
        logger,
        ...(deviceId ? { deviceId } : {}),
        ...(options.deviceDisplayName
          ? { initialDeviceDisplayName: options.deviceDisplayName }
          : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.allowInsecure ? { allowInsecure: true } : {}),
      };
      const next = await loginWithPassword(loginOpts);
      saveSession(root, next);
      savePersistedDeviceId(root, next.deviceId);
      if (next.homeserverUrl !== getHomeserverUrl()) {
        options.onHomeserverUrl?.(next.homeserverUrl);
      }
      logger.info(
        `password re-login succeeded for ${next.userId} (device ${next.deviceId})`,
      );
      return next.accessToken;
    } catch (err) {
      logger.warn("password re-login after auth failure failed", err);
      return null;
    }
  };
}
