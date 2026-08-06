/**
 * Unified Aiomatrix content pipeline: normalize → preview → envelope.
 * One path for messages, MiniApps, polls, toasts, and host/bot state blobs.
 */

import {
  classifyAiomatrixContent,
  formatMessagePreview,
  normalizeAiomatrixContent,
  type AiomatrixContentKind,
  type NormalizedAiomatrixContent,
} from "./miniapp/preview.js";
import { AIOMATRIX_SCHEMA } from "./schema-contract.js";
import { AIOMATRIX_CONTENT_KEYS } from "./schema.js";

export type { AiomatrixContentKind, NormalizedAiomatrixContent };

export interface AiomatrixEnvelope {
  version: number;
  kind: AiomatrixContentKind | "toast" | "progress" | "callback_answer" | "poll" | "raw";
  preview: string;
  content: Record<string, unknown>;
  normalized?: NormalizedAiomatrixContent;
}

/** Classify + normalize + preview in one shot (null = ordinary Matrix content). */
export function pipelineAiomatrixContent(content: unknown): AiomatrixEnvelope | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const record = content as Record<string, unknown>;
  const normalized = normalizeAiomatrixContent(record);
  if (normalized) {
    return {
      version: AIOMATRIX_SCHEMA.envelope,
      kind: normalized.kind,
      preview: normalized.preview,
      content: record,
      normalized,
    };
  }
  if (record[AIOMATRIX_CONTENT_KEYS.poll] != null) {
    return {
      version: AIOMATRIX_SCHEMA.envelope,
      kind: "poll",
      preview: formatMessagePreview(record) ?? "poll",
      content: record,
    };
  }
  return null;
}

/**
 * Build a versioned envelope for outbound structured fields (hosts may ignore).
 * Does not mutate Matrix msgtype / body — callers still use buildMessageContent.
 */
export function buildAiomatrixEnvelope(
  kind: AiomatrixEnvelope["kind"],
  content: Record<string, unknown>,
  preview?: string,
): AiomatrixEnvelope {
  const normalized = normalizeAiomatrixContent(content) ?? undefined;
  return {
    version: AIOMATRIX_SCHEMA.envelope,
    kind: normalized?.kind ?? kind,
    preview: preview ?? normalized?.preview ?? formatMessagePreview(content) ?? kind,
    content,
    ...(normalized ? { normalized } : {}),
  };
}

export {
  classifyAiomatrixContent,
  formatMessagePreview,
  normalizeAiomatrixContent,
};
