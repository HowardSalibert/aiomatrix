import { DiscoveryError } from "./errors.js";
import { MatrixHttp, normalizeHomeserverUrl } from "./http.js";
import { createDefaultLogger, type Logger } from "./logger.js";
import { isPlainObject, readString } from "./util.js";

export interface DiscoveryResult {
  /** Base URL to use for Client-Server API calls. */
  homeserverUrl: string;
  /** Optional identity server advertised by `.well-known`. */
  identityServerUrl?: string;
  /** How the URL was determined. */
  source: "explicit" | "well-known" | "fallback";
}

/** Extract the server name from `@user:example.org`, or `null`. */
export function serverNameFromUserId(userId: string): string | null {
  const match = /^@[^:]+:(.+)$/.exec(userId.trim());
  return match?.[1] ?? null;
}

/** `true` for strings shaped like a Matrix user id. */
export function isUserId(value: string): boolean {
  return /^@[^\s:]+:[^\s:]+(?::\d+)?$/.test(value.trim());
}

/**
 * Resolve a Client-Server base URL from anything a user is likely to paste:
 * a full URL (`https://matrix.example.org`), a server name (`example.org`), or
 * a Matrix user id (`@bot:example.org`).
 *
 * Server names and user ids go through `/.well-known/matrix/client`
 * ([spec](https://spec.matrix.org/latest/client-server-api/#getwell-knownmatrixclient)),
 * falling back to `https://<serverName>` when discovery is unavailable.
 */
export async function discoverHomeserver(
  input: string,
  options?: {
    logger?: Logger;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    allowInsecure?: boolean;
  },
): Promise<DiscoveryResult> {
  const logger = options?.logger ?? createDefaultLogger();
  const trimmed = input.trim();
  if (!trimmed) {
    throw new DiscoveryError("Cannot resolve an empty homeserver/user identifier");
  }

  if (isUserId(trimmed)) {
    const server = serverNameFromUserId(trimmed);
    if (!server) {
      throw new DiscoveryError(`Cannot extract a server name from ${trimmed}`);
    }
    return resolveServerName(server, logger, options);
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return {
      homeserverUrl: normalizeHomeserverUrl(trimmed, {
        allowInsecure: options?.allowInsecure,
        logger,
      }),
      source: "explicit",
    };
  }

  return resolveServerName(trimmed, logger, options);
}

async function resolveServerName(
  serverName: string,
  logger: Logger,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; allowInsecure?: boolean },
): Promise<DiscoveryResult> {
  const base = normalizeHomeserverUrl(serverName, {
    allowInsecure: options?.allowInsecure,
    logger,
  });
  try {
    const http = new MatrixHttp(base, {
      logger,
      fetchImpl: options?.fetchImpl,
      maxRetries: 1,
      timeoutMs: options?.timeoutMs ?? 10_000,
      allowInsecure: options?.allowInsecure,
    });
    const wellKnown = await http.request<unknown>(
      "GET",
      "/.well-known/matrix/client",
      null,
      undefined,
      { anonymous: true, timeoutMs: options?.timeoutMs ?? 10_000 },
    );
    const homeserver = isPlainObject(wellKnown) ? wellKnown["m.homeserver"] : null;
    const baseUrl = readString(homeserver, "base_url");
    if (baseUrl) {
      const identity = isPlainObject(wellKnown) ? wellKnown["m.identity_server"] : null;
      const identityUrl = readString(identity, "base_url");
      const result: DiscoveryResult = {
        homeserverUrl: normalizeHomeserverUrl(baseUrl, {
          allowInsecure: options?.allowInsecure,
          logger,
        }),
        source: "well-known",
      };
      if (identityUrl) result.identityServerUrl = identityUrl;
      logger.debug(`discovered homeserver for ${serverName}: ${result.homeserverUrl}`);
      return result;
    }
    logger.debug(`.well-known for ${serverName} has no m.homeserver.base_url`);
  } catch (err) {
    logger.debug(`.well-known discovery failed for ${serverName}`, err);
  }
  return { homeserverUrl: base, source: "fallback" };
}

/**
 * Fetch the homeserver's supported spec versions and unstable features.
 * Useful for capability gating (threads, polls, refresh tokens).
 */
export async function getServerVersions(
  http: MatrixHttp,
): Promise<{ versions: string[]; unstableFeatures: Record<string, boolean> }> {
  const resp = await http.request<{
    versions?: string[];
    unstable_features?: Record<string, boolean>;
  }>("GET", "/_matrix/client/versions", null, undefined, { anonymous: true });
  return {
    versions: Array.isArray(resp?.versions) ? resp.versions : [],
    unstableFeatures: isPlainObject(resp?.unstable_features)
      ? (resp.unstable_features as Record<string, boolean>)
      : {},
  };
}
