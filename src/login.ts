import * as fs from "node:fs";
import * as path from "node:path";
import { AuthenticationError, ConfigurationError } from "./errors.js";
import { MatrixApiError, MatrixHttp } from "./http.js";
import { createDefaultLogger, type Logger } from "./logger.js";
import { isPlainObject, readJsonSafe, readNumber, readString, writeJsonAtomic } from "./util.js";

/** Persisted login session. Stored at `storagePath/session.json` (mode 0600). */
export interface MatrixSession {
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, when the HS provides it. */
  expiresAtMs?: number;
  homeserverUrl: string;
}

export interface PasswordLoginOptions {
  homeserverUrl: string;
  /** `@bot:example.org` or a bare localpart. */
  user: string;
  password: string;
  /** Human-readable device name shown in the user's device list. */
  initialDeviceDisplayName?: string;
  /** Reuse an existing device id (keeps the E2EE identity). */
  deviceId?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  allowInsecure?: boolean;
}

interface LoginResponseBody {
  user_id?: string;
  device_id?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in_ms?: number;
  well_known?: { "m.homeserver"?: { base_url?: string } };
}

function sessionFile(storagePath: string): string {
  return path.join(storagePath, "session.json");
}

/** Load a previously persisted session, or `null`. */
export function loadSession(storagePath: string): MatrixSession | null {
  const raw = readJsonSafe<Partial<MatrixSession>>(sessionFile(storagePath));
  if (!raw?.userId || !raw.accessToken || !raw.deviceId || !raw.homeserverUrl) {
    return null;
  }
  const session: MatrixSession = {
    userId: raw.userId,
    deviceId: raw.deviceId,
    accessToken: raw.accessToken,
    homeserverUrl: raw.homeserverUrl,
  };
  if (raw.refreshToken) session.refreshToken = raw.refreshToken;
  if (typeof raw.expiresAtMs === "number") session.expiresAtMs = raw.expiresAtMs;
  return session;
}

/** Persist a session atomically with restrictive file permissions. */
export function saveSession(storagePath: string, session: MatrixSession): void {
  writeJsonAtomic(sessionFile(storagePath), session);
}

/** Remove the persisted session file. */
export function clearSession(storagePath: string): void {
  try {
    fs.rmSync(sessionFile(storagePath), { force: true });
  } catch {
    // best effort
  }
}

/**
 * Password login via `POST /login` with `m.login.password`.
 *
 * Prefer this over hand-managed access tokens: the returned `device_id` is
 * guaranteed to match the token, which removes the single largest E2EE footgun
 * (a stale `deviceId` paired with a fresh token).
 */
export async function loginWithPassword(
  options: PasswordLoginOptions,
): Promise<MatrixSession> {
  const logger = options.logger ?? createDefaultLogger();
  if (!options.password) {
    throw new ConfigurationError("loginWithPassword requires a password");
  }
  const http = new MatrixHttp(options.homeserverUrl, {
    logger,
    fetchImpl: options.fetchImpl,
    allowInsecure: options.allowInsecure,
  });

  const body: Record<string, unknown> = {
    type: "m.login.password",
    // `m.id.user` accepts both a full user id and a bare localpart.
    identifier: { type: "m.id.user", user: options.user },
    password: options.password,
    refresh_token: true,
  };
  if (options.initialDeviceDisplayName) {
    body.initial_device_display_name = options.initialDeviceDisplayName;
  }
  if (options.deviceId) body.device_id = options.deviceId;

  let resp: LoginResponseBody;
  try {
    resp = await http.request<LoginResponseBody>("POST", "/_matrix/client/v3/login", null, body);
  } catch (err) {
    if (err instanceof MatrixApiError && err.status === 403) {
      throw new AuthenticationError("Login rejected: invalid user or password.", false, {
        cause: err,
      });
    }
    throw err;
  }

  if (!resp.user_id || !resp.access_token || !resp.device_id) {
    throw new AuthenticationError(
      "Homeserver login response is missing user_id / access_token / device_id",
    );
  }

  const discovered = resp.well_known?.["m.homeserver"]?.base_url;
  const session: MatrixSession = {
    userId: resp.user_id,
    deviceId: resp.device_id,
    accessToken: resp.access_token,
    homeserverUrl: discovered ?? http.baseUrl,
  };
  if (resp.refresh_token) session.refreshToken = resp.refresh_token;
  if (typeof resp.expires_in_ms === "number") {
    session.expiresAtMs = Date.now() + resp.expires_in_ms;
  }
  logger.info(`logged in as ${session.userId} (device ${session.deviceId})`);
  return session;
}

/**
 * Exchange a refresh token for a new access token
 * ([`POST /refresh`](https://spec.matrix.org/latest/client-server-api/#post_matrixclientv3refresh)).
 */
export async function refreshAccessToken(
  http: MatrixHttp,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAtMs?: number }> {
  const resp = await http.request<unknown>(
    "POST",
    "/_matrix/client/v3/refresh",
    null,
    { refresh_token: refreshToken },
    { anonymous: true, maxRetries: 1 },
  );
  const accessToken = readString(resp, "access_token");
  if (!accessToken) {
    throw new AuthenticationError("Refresh response did not include an access_token");
  }
  const next: { accessToken: string; refreshToken?: string; expiresAtMs?: number } = {
    accessToken,
  };
  const nextRefresh = readString(resp, "refresh_token");
  if (nextRefresh) next.refreshToken = nextRefresh;
  const expiresIn = readNumber(resp, "expires_in_ms");
  if (expiresIn !== undefined) next.expiresAtMs = Date.now() + expiresIn;
  return next;
}

/** Invalidate the current access token server-side. */
export async function logout(http: MatrixHttp): Promise<void> {
  await http.request("POST", "/_matrix/client/v3/logout", null, {}, { maxRetries: 1 });
}

/** List the account's devices — useful for cleaning up stale bot devices. */
export async function listDevices(
  http: MatrixHttp,
): Promise<Array<{ device_id: string; display_name?: string; last_seen_ts?: number }>> {
  const resp = await http.request<unknown>("GET", "/_matrix/client/v3/devices");
  const devices = isPlainObject(resp) ? resp.devices : null;
  if (!Array.isArray(devices)) return [];
  return devices.filter(isPlainObject) as Array<{
    device_id: string;
    display_name?: string;
    last_seen_ts?: number;
  }>;
}
