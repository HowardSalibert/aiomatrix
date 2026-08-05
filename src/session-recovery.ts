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

/**
 * Build the MatrixHttp `onTokenExpired` hook that refreshes and persists the
 * session. Returns `null` when no refresh token is available.
 */
export function createSessionRefreshHandler(options: {
  storagePath: string;
  homeserverUrl: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  allowInsecure?: boolean;
}): (error: unknown) => Promise<string | null> {
  const root = resolveStoragePath(options.storagePath);
  const logger = options.logger ?? createDefaultLogger();
  return async () => {
    const session = loadSession(root);
    if (!session?.refreshToken) {
      logger.warn("access token expired and no refresh_token is stored");
      return null;
    }
    const anon = new MatrixHttp(options.homeserverUrl, {
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
      return null;
    }
  };
}
