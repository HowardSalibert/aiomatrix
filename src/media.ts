import { MediaTooLargeError, MatrixBotsError } from "./errors.js";
import { MatrixApiError, type MatrixHttp } from "./http.js";
import { isPlainObject, readNumber, readString } from "./util.js";

/** Default guard against accidentally buffering huge media in memory. */
export const DEFAULT_MEDIA_LIMIT_BYTES = 100 * 1024 * 1024;

export interface MxcUri {
  serverName: string;
  mediaId: string;
}

/** Parse `mxc://server/mediaId`, or `null` when the URI is not an mxc URI. */
export function parseMxcUri(uri: string): MxcUri | null {
  const match = /^mxc:\/\/([^/?#]+)\/([^/?#]+)$/.exec(uri.trim());
  if (!match?.[1] || !match[2]) return null;
  return { serverName: match[1], mediaId: match[2] };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Best-effort content type from a filename extension. */
export function guessMimeType(filename: string, fallback = "application/octet-stream"): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return fallback;
  return MIME_BY_EXTENSION[filename.slice(dot).toLowerCase()] ?? fallback;
}

/** Pick the Matrix msgtype that matches a content type. */
export function msgtypeForMime(mimetype: string): "m.image" | "m.audio" | "m.video" | "m.file" {
  if (mimetype.startsWith("image/")) return "m.image";
  if (mimetype.startsWith("audio/")) return "m.audio";
  if (mimetype.startsWith("video/")) return "m.video";
  return "m.file";
}

export interface UploadResult {
  /** `mxc://…` URI of the uploaded content. */
  contentUri: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadOptions {
  filename?: string;
  contentType?: string;
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Upload bytes to the homeserver's media repository. */
export async function uploadMedia(
  http: MatrixHttp,
  data: Uint8Array,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const limit = options.maxBytes ?? DEFAULT_MEDIA_LIMIT_BYTES;
  if (data.byteLength > limit) {
    throw new MediaTooLargeError(data.byteLength, limit);
  }
  const contentType =
    options.contentType ??
    (options.filename ? guessMimeType(options.filename) : "application/octet-stream");

  const resp = await http.request<{ content_uri?: string }>(
    "POST",
    "/_matrix/media/v3/upload",
    options.filename ? { filename: options.filename } : null,
    undefined,
    {
      rawBody: data,
      contentType,
      // Uploads are not idempotent, but the media repo dedupes by content and a
      // duplicate upload is harmless compared to losing the attachment.
      idempotent: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : { timeoutMs: 120_000 }),
    },
  );
  if (!resp?.content_uri) {
    throw new MatrixBotsError("Media upload response did not include content_uri");
  }
  return { contentUri: resp.content_uri, contentType, sizeBytes: data.byteLength };
}

export interface DownloadOptions {
  maxBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Allow falling back to the deprecated unauthenticated media endpoint. */
  allowLegacyEndpoint?: boolean;
}

/**
 * Download media by `mxc://` URI.
 *
 * Prefers the authenticated endpoint added in Matrix 1.11
 * (`/_matrix/client/v1/media/download`) and falls back to the legacy
 * `/_matrix/media/v3/download` route on older homeservers.
 */
export async function downloadMedia(
  http: MatrixHttp,
  mxcUri: string,
  options: DownloadOptions = {},
): Promise<Uint8Array> {
  const parsed = parseMxcUri(mxcUri);
  if (!parsed) {
    throw new MatrixBotsError(`Not an mxc:// URI: ${mxcUri}`);
  }
  const requestOptions = {
    idempotent: true,
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: options.timeoutMs ?? 120_000,
  };
  const authenticatedPath = `/_matrix/client/v1/media/download/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`;

  let bytes: Uint8Array;
  try {
    bytes = await http.requestBytes("GET", authenticatedPath, null, requestOptions);
  } catch (err) {
    const canFallback =
      options.allowLegacyEndpoint !== false &&
      err instanceof MatrixApiError &&
      (err.isNotFound || err.errcode === "M_UNRECOGNIZED");
    if (!canFallback) throw err;
    bytes = await http.requestBytes(
      "GET",
      `/_matrix/media/v3/download/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`,
      { allow_redirect: true },
      requestOptions,
    );
  }

  const limit = options.maxBytes ?? DEFAULT_MEDIA_LIMIT_BYTES;
  if (bytes.byteLength > limit) {
    throw new MediaTooLargeError(bytes.byteLength, limit);
  }
  return bytes;
}

/** Fetch a server-side thumbnail for an image/video. */
export async function downloadThumbnail(
  http: MatrixHttp,
  mxcUri: string,
  params: { width: number; height: number; method?: "crop" | "scale" } & DownloadOptions,
): Promise<Uint8Array> {
  const parsed = parseMxcUri(mxcUri);
  if (!parsed) {
    throw new MatrixBotsError(`Not an mxc:// URI: ${mxcUri}`);
  }
  const query = {
    width: params.width,
    height: params.height,
    method: params.method ?? "scale",
  };
  const requestOptions = {
    idempotent: true,
    ...(params.signal ? { signal: params.signal } : {}),
    timeoutMs: params.timeoutMs ?? 60_000,
  };
  try {
    return await http.requestBytes(
      "GET",
      `/_matrix/client/v1/media/thumbnail/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`,
      query,
      requestOptions,
    );
  } catch (err) {
    if (
      params.allowLegacyEndpoint === false ||
      !(err instanceof MatrixApiError) ||
      (!err.isNotFound && err.errcode !== "M_UNRECOGNIZED")
    ) {
      throw err;
    }
    return http.requestBytes(
      "GET",
      `/_matrix/media/v3/thumbnail/${encodeURIComponent(parsed.serverName)}/${encodeURIComponent(parsed.mediaId)}`,
      { ...query, allow_redirect: true },
      requestOptions,
    );
  }
}

/**
 * The `EncryptedFile` block of an E2EE attachment: the Rust media encryption
 * info plus the `mxc://` URL of the ciphertext.
 */
export function buildEncryptedFileBlock(
  encryptionInfo: Record<string, unknown>,
  contentUri: string,
): Record<string, unknown> {
  return { ...encryptionInfo, url: contentUri };
}

/** Split an `EncryptedFile` block back into `{ url, encryptionInfo }`. */
export function splitEncryptedFileBlock(
  file: Record<string, unknown>,
): { url: string; encryptionInfo: Record<string, unknown> } | null {
  const url = readString(file, "url");
  if (!url) return null;
  const encryptionInfo: Record<string, unknown> = { ...file };
  delete encryptionInfo.url;
  return { url, encryptionInfo };
}

export interface MediaInfo {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
  duration?: number;
  thumbnail_url?: string;
  thumbnail_file?: Record<string, unknown>;
  thumbnail_info?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Build the `info` block for a media message. */
export function buildMediaInfo(params: {
  mimetype: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
}): MediaInfo {
  const info: MediaInfo = { mimetype: params.mimetype, size: params.sizeBytes };
  if (params.width !== undefined) info.w = params.width;
  if (params.height !== undefined) info.h = params.height;
  if (params.durationMs !== undefined) info.duration = params.durationMs;
  return info;
}

/** Extract a normalised attachment descriptor from message content. */
export function readAttachmentFromContent(content: unknown): {
  msgtype: string;
  body: string;
  url: string | null;
  file: Record<string, unknown> | null;
  mimetype: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
} | null {
  if (!isPlainObject(content)) return null;
  const msgtype = readString(content, "msgtype");
  if (!msgtype) return null;
  if (!["m.image", "m.file", "m.audio", "m.video", "m.sticker"].includes(msgtype)) {
    return null;
  }
  const info = isPlainObject(content.info) ? content.info : {};
  return {
    msgtype,
    body: readString(content, "body") ?? "",
    url: readString(content, "url") ?? null,
    file: isPlainObject(content.file) ? content.file : null,
    mimetype: readString(info, "mimetype") ?? null,
    sizeBytes: readNumber(info, "size") ?? null,
    width: readNumber(info, "w") ?? null,
    height: readNumber(info, "h") ?? null,
    durationMs: readNumber(info, "duration") ?? null,
  };
}
