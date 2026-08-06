import { checkSchemaVersion, readSchemaVersion } from "./schema-contract.js";
import { AIOMATRIX_CONTENT_KEYS, AIOMATRIX_EVENT_TYPES } from "./schema.js";
import {
  buildAiomatrixEnvelope,
  pipelineAiomatrixContent,
  type AiomatrixEnvelope,
} from "./content-pipeline.js";
import { KEYBOARD_CONTENT_KEY } from "./keyboards.js";
import { MINI_APP_CONTENT_KEY, MINI_APP_DATA_KEY } from "./miniapp/events.js";

export interface ContentValidation {
  ok: boolean;
  warnings: string[];
  envelope: AiomatrixEnvelope | null;
}

/**
 * Validate nested `dev.aiomatrix.*` schema versions and attach a receive/send
 * envelope. Mutates nothing; returns warnings for unsupported newer versions.
 */
export function finalizeAiomatrixContent(
  content: Record<string, unknown>,
): ContentValidation {
  const warnings: string[] = [];
  const check = (key: Parameters<typeof checkSchemaVersion>[0], block: unknown): void => {
    if (block == null) return;
    const info = checkSchemaVersion(key, readSchemaVersion(block));
    if (!info.supported) {
      warnings.push(`${key} version ${info.version} newer than library support`);
    }
  };

  check("keyboard", content[KEYBOARD_CONTENT_KEY] ?? content[AIOMATRIX_CONTENT_KEYS.keyboard]);
  check("mini_app", content[MINI_APP_CONTENT_KEY] ?? content[AIOMATRIX_CONTENT_KEYS.miniApp]);
  check("mini_app_data", content[MINI_APP_DATA_KEY] ?? content[AIOMATRIX_CONTENT_KEYS.miniAppData]);
  check("poll", content[AIOMATRIX_CONTENT_KEYS.poll]);

  const envelope =
    pipelineAiomatrixContent(content) ??
    (hasAiomatrixFields(content)
      ? buildAiomatrixEnvelope("raw", content)
      : null);

  return { ok: warnings.length === 0, warnings, envelope };
}

function hasAiomatrixFields(content: Record<string, unknown>): boolean {
  return (
    content[KEYBOARD_CONTENT_KEY] != null ||
    content[MINI_APP_CONTENT_KEY] != null ||
    content[MINI_APP_DATA_KEY] != null ||
    content[AIOMATRIX_CONTENT_KEYS.poll] != null ||
    content[AIOMATRIX_EVENT_TYPES.toast] != null
  );
}
