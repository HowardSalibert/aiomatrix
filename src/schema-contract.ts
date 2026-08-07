/**
 * Normative schema versions for `dev.aiomatrix.*` fields.
 * Hosts and bots SHOULD reject or degrade gracefully when `version` is newer
 * than they understand; unknown older versions MUST still parse best-effort.
 *
 * See AWARE_HOST.md (normative) and COMPATIBILITY.md.
 */

export const AIOMATRIX_SCHEMA = {
  keyboard: 1,
  callback: 1,
  callback_answer: 1,
  toast: 1,
  progress: 1,
  mini_app: 1,
  mini_app_data: 1,
  bot: 1,
  host: 1,
  poll: 1,
  /** Unified envelope for {@link import("./content-pipeline.js").buildAiomatrixEnvelope}. */
  envelope: 1,
} as const;

export type AiomatrixSchemaKey = keyof typeof AIOMATRIX_SCHEMA;

export interface SchemaVersionInfo {
  key: AiomatrixSchemaKey;
  version: number;
  /** Supported by this library release. */
  supported: boolean;
  /** Host may render best-effort when false but version is lower. */
  deprecated: boolean;
}

/** Compare a wire `version` against the library's known schema. */
export function checkSchemaVersion(
  key: AiomatrixSchemaKey,
  version: unknown,
): SchemaVersionInfo {
  const expected = AIOMATRIX_SCHEMA[key];
  const v = typeof version === "number" && Number.isFinite(version) ? version : 1;
  return {
    key,
    version: v,
    supported: v <= expected,
    deprecated: v < expected,
  };
}

/**
 * Read `version` from a nested `dev.aiomatrix.*` object, defaulting to 1.
 */
export function readSchemaVersion(block: unknown): number {
  if (!block || typeof block !== "object" || Array.isArray(block)) return 1;
  const v = (block as Record<string, unknown>).version;
  return typeof v === "number" && Number.isFinite(v) ? v : 1;
}
