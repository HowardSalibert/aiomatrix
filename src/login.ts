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

export interface MatrixDeviceInfo {
  device_id: string;
  display_name?: string;
  last_seen_ts?: number;
  last_seen_ip?: string;
}

/** List the account's devices — useful for cleaning up stale bot devices. */
export async function listDevices(http: MatrixHttp): Promise<MatrixDeviceInfo[]> {
  const resp = await http.request<unknown>("GET", "/_matrix/client/v3/devices");
  const devices = isPlainObject(resp) ? resp.devices : null;
  if (!Array.isArray(devices)) return [];
  const out: MatrixDeviceInfo[] = [];
  for (const raw of devices) {
    if (!isPlainObject(raw)) continue;
    const device_id = readString(raw, "device_id");
    if (!device_id) continue;
    const info: MatrixDeviceInfo = { device_id };
    const display_name = readString(raw, "display_name");
    if (display_name) info.display_name = display_name;
    const last_seen_ts = readNumber(raw, "last_seen_ts");
    if (last_seen_ts !== undefined) info.last_seen_ts = last_seen_ts;
    const last_seen_ip = readString(raw, "last_seen_ip");
    if (last_seen_ip) info.last_seen_ip = last_seen_ip;
    out.push(info);
  }
  return out;
}

/**
 * Delete one device. Homeservers usually require UIA — pass `auth` (e.g.
 * `m.login.password`) or call {@link deleteDevices} which retries with session.
 */
export async function deleteDevice(
  http: MatrixHttp,
  deviceId: string,
  auth?: Record<string, unknown>,
): Promise<void> {
  await deleteDevices(http, [deviceId], auth);
}

/**
 * Delete devices via `POST /delete_devices`, completing UIA when the HS asks.
 */
export async function deleteDevices(
  http: MatrixHttp,
  deviceIds: string[],
  auth?: Record<string, unknown>,
): Promise<void> {
  if (deviceIds.length === 0) return;
  const body: Record<string, unknown> = { devices: deviceIds };
  if (auth) body.auth = auth;

  try {
    await http.request("POST", "/_matrix/client/v3/delete_devices", null, body, {
      maxRetries: 0,
    });
  } catch (err) {
    if (!(err instanceof MatrixApiError) || err.status !== 401 || !auth) throw err;
    const session = readString(err.body, "session");
    if (!session) throw err;
    await http.request(
      "POST",
      "/_matrix/client/v3/delete_devices",
      null,
      { devices: deviceIds, auth: { ...auth, session } },
      { maxRetries: 0 },
    );
  }
}

export interface PruneOtherDevicesOptions {
  /** Device id to keep (usually the current bot device). */
  keepDeviceId: string;
  /** Only delete devices with `last_seen_ts` older than this (ms ago). */
  olderThanMs?: number;
  /** Cap how many devices to delete in one call. Default 64. */
  limit?: number;
  /**
   * UIA auth dict for `/delete_devices` (typically password login).
   * Required on most homeservers.
   */
  auth?: Record<string, unknown>;
}

/**
 * Remove other devices on this account so Megolm fanout does not target ghost
 * bots left behind by `relocateSession({ wipeCrypto: true })` / redeploys.
 */
export async function pruneOtherDevices(
  http: MatrixHttp,
  options: PruneOtherDevicesOptions,
): Promise<{ deleted: string[]; kept: string }> {
  const devices = await listDevices(http);
  const cutoff =
    options.olderThanMs !== undefined ? Date.now() - options.olderThanMs : null;
  const limit = Math.max(1, options.limit ?? 64);
  const victims = devices
    .filter((d) => d.device_id && d.device_id !== options.keepDeviceId)
    .filter((d) => {
      if (cutoff == null) return true;
      return typeof d.last_seen_ts === "number" ? d.last_seen_ts <= cutoff : true;
    })
    .map((d) => d.device_id)
    .slice(0, limit);
  await deleteDevices(http, victims, options.auth);
  return { deleted: victims, kept: options.keepDeviceId };
}
