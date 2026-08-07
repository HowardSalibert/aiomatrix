import { checkSchemaVersion, readSchemaVersion } from "./schema-contract.js";
import { AIOMATRIX_CONTENT_KEYS, AIOMATRIX_EVENT_TYPES } from "./schema.js";
import {
  buildAiomatrixEnvelope,
  pipelineAiomatrixContent,
  type AiomatrixEnvelope,
} from "./content-pipeline.js";
import {
  CALLBACK_ANSWER_EVENT_TYPE,
  KEYBOARD_CONTENT_KEY,
  PROGRESS_EVENT_TYPE,
  TOAST_EVENT_TYPE,
} from "./keyboards.js";
import { MINI_APP_CONTENT_KEY, MINI_APP_DATA_KEY } from "./miniapp/events.js";
import { BOT_CAPABILITIES_STATE_EVENT_TYPE } from "./bot-capabilities.js";
import { HOST_CAPABILITIES_STATE_EVENT_TYPE } from "./host-capabilities.js";

export interface ContentValidation {
  ok: boolean;
  warnings: string[];
  envelope: AiomatrixEnvelope | null;
}

export interface FinalizeContentOptions {
  /** When set, treat `content` as the schema body for that event type. */
  eventType?: string;
}

/**
 * Validate nested `dev.aiomatrix.*` schema versions and attach a receive/send
 * envelope. Mutates nothing; returns warnings for unsupported newer versions.
 */
export function finalizeAiomatrixContent(
  content: Record<string, unknown>,
  options?: FinalizeContentOptions,
): ContentValidation {
  const warnings: string[] = [];
  const check = (key: Parameters<typeof checkSchemaVersion>[0], block: unknown): void => {
    if (block == null) return;
    const info = checkSchemaVersion(key, readSchemaVersion(block));
    if (!info.supported) {
      warnings.push(`${key} version ${info.version} newer than library support`);
    }
  };

  const et = options?.eventType;
  check("keyboard", content[KEYBOARD_CONTENT_KEY] ?? content[AIOMATRIX_CONTENT_KEYS.keyboard]);
  check("mini_app", content[MINI_APP_CONTENT_KEY] ?? content[AIOMATRIX_CONTENT_KEYS.miniApp]);
  check("mini_app_data", content[MINI_APP_DATA_KEY] ?? content[AIOMATRIX_CONTENT_KEYS.miniAppData]);
  check("poll", content[AIOMATRIX_CONTENT_KEYS.poll]);

  if (et === TOAST_EVENT_TYPE || et === AIOMATRIX_EVENT_TYPES.toast) {
    check("toast", content);
  } else {
    check("toast", content[TOAST_EVENT_TYPE] ?? content[AIOMATRIX_EVENT_TYPES.toast]);
  }
  if (et === PROGRESS_EVENT_TYPE || et === AIOMATRIX_EVENT_TYPES.progress) {
    check("progress", content);
  } else {
    check("progress", content[PROGRESS_EVENT_TYPE] ?? content[AIOMATRIX_EVENT_TYPES.progress]);
  }
  if (et === CALLBACK_ANSWER_EVENT_TYPE || et === AIOMATRIX_EVENT_TYPES.callbackAnswer) {
    check("callback_answer", content);
  } else {
    check(
      "callback_answer",
      content[CALLBACK_ANSWER_EVENT_TYPE] ?? content[AIOMATRIX_EVENT_TYPES.callbackAnswer],
    );
  }
  if (et === BOT_CAPABILITIES_STATE_EVENT_TYPE || et === AIOMATRIX_EVENT_TYPES.botCapabilities) {
    check("bot", content);
  } else {
    check("bot", content[BOT_CAPABILITIES_STATE_EVENT_TYPE] ?? content[AIOMATRIX_EVENT_TYPES.botCapabilities]);
  }
  if (et === HOST_CAPABILITIES_STATE_EVENT_TYPE || et === AIOMATRIX_EVENT_TYPES.hostCapabilities) {
    check("host", content);
  } else {
    check(
      "host",
      content[HOST_CAPABILITIES_STATE_EVENT_TYPE] ?? content[AIOMATRIX_EVENT_TYPES.hostCapabilities],
    );
  }

  const envelope =
    pipelineAiomatrixContent(content) ??
    (hasAiomatrixFields(content, et)
      ? buildAiomatrixEnvelope("raw", content)
      : null);

  return { ok: warnings.length === 0, warnings, envelope };
}

function hasAiomatrixFields(
  content: Record<string, unknown>,
  eventType?: string,
): boolean {
  if (
    eventType === TOAST_EVENT_TYPE ||
    eventType === PROGRESS_EVENT_TYPE ||
    eventType === CALLBACK_ANSWER_EVENT_TYPE ||
    eventType === BOT_CAPABILITIES_STATE_EVENT_TYPE ||
    eventType === HOST_CAPABILITIES_STATE_EVENT_TYPE
  ) {
    return true;
  }
  return (
    content[KEYBOARD_CONTENT_KEY] != null ||
    content[MINI_APP_CONTENT_KEY] != null ||
    content[MINI_APP_DATA_KEY] != null ||
    content[AIOMATRIX_CONTENT_KEYS.poll] != null ||
    content[AIOMATRIX_EVENT_TYPES.toast] != null ||
    content[TOAST_EVENT_TYPE] != null ||
    content[PROGRESS_EVENT_TYPE] != null ||
    content[CALLBACK_ANSWER_EVENT_TYPE] != null
  );
}
