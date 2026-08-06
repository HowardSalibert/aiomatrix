/** Stable Matrix poll event types (MSC3381 + stable `m.poll.*`). */
export const POLL_START_EVENT_TYPES = [
  "m.poll.start",
  "org.matrix.msc3381.poll.start",
] as const;

export const POLL_END_EVENT_TYPES = [
  "m.poll.end",
  "org.matrix.msc3381.poll.end",
] as const;

export interface PollAnswer {
  id: string;
  text: string;
}

export interface SendPollOptions {
  question: string;
  answers: Array<string | PollAnswer>;
  /** Max selections a voter may pick. Default 1. */
  maxSelections?: number;
  /**
   * Prefer unstable MSC3381 type for broader homeserver support.
   * Default true (`org.matrix.msc3381.poll.start`).
   */
  useUnstableType?: boolean;
  /**
   * Lean body for aware hosts (short question only; answers live in structured
   * poll fields). Default false.
   */
  leanBody?: boolean;
  extra?: Record<string, unknown>;
}

/** Build `m.poll.start` / MSC3381 poll start content. */
export function buildPollStartContent(options: SendPollOptions): Record<string, unknown> {
  if (!options.question.trim()) {
    throw new TypeError("poll question must be non-empty");
  }
  if (!options.answers.length) {
    throw new TypeError("poll requires at least one answer");
  }
  const answers = options.answers.map((answer, index) => {
    if (typeof answer === "string") {
      return {
        id: `answer${index}`,
        "org.matrix.msc1767.text": answer,
      };
    }
    return {
      id: answer.id || `answer${index}`,
      "org.matrix.msc1767.text": answer.text,
    };
  });
  const maxSelections = Math.max(1, options.maxSelections ?? 1);
  const start = {
    question: { "org.matrix.msc1767.text": options.question },
    kind: "org.matrix.msc3381.poll.disclosed",
    max_selections: maxSelections,
    answers,
  };
  const body = options.leanBody
    ? options.question
    : `${options.question}\n${answers
        .map((a, i) => `${i + 1}. ${a["org.matrix.msc1767.text"]}`)
        .join("\n")}`;
  return {
    "org.matrix.msc3381.poll.start": start,
    "m.poll.start": start,
    body,
    msgtype: "m.text",
    ...(options.leanBody
      ? { "dev.aiomatrix.poll": { version: 1, lean: true, question: options.question } }
      : {}),
    ...(options.extra ?? {}),
  };
}

/** Build poll end content relating to `pollEventId`. */
export function buildPollEndContent(pollEventId: string): Record<string, unknown> {
  const end = {};
  return {
    "m.relates_to": {
      rel_type: "m.reference",
      event_id: pollEventId,
    },
    "org.matrix.msc3381.poll.end": end,
    "m.poll.end": end,
    body: "Poll ended",
    msgtype: "m.text",
  };
}

export function pollStartEventType(useUnstable = true): string {
  return useUnstable ? "org.matrix.msc3381.poll.start" : "m.poll.start";
}

export function pollEndEventType(useUnstable = true): string {
  return useUnstable ? "org.matrix.msc3381.poll.end" : "m.poll.end";
}
