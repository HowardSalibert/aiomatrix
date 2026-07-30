import type { Context, FilterFn } from "./types.js";

export type Filter = FilterFn;

function parseCommandToken(body: string): { name: string; args: string } | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const withPrefix = trimmed.match(/^[!/](\S+)(?:\s+([\s\S]*))?$/);
  if (withPrefix) {
    const raw = withPrefix[1] ?? "";
    const name = raw.split(":")[0]?.toLowerCase() ?? "";
    return { name, args: (withPrefix[2] ?? "").trimStart() };
  }

  // bare first token (DM only — caller checks isDirect)
  const bare = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!bare) return null;
  const raw = bare[1] ?? "";
  if (raw.startsWith("!") || raw.startsWith("/")) return null;
  return { name: raw.toLowerCase(), args: (bare[2] ?? "").trimStart() };
}

/**
 * Match a bot command: `/name`, `!name`, and in DMs also bare `name` as first token.
 */
export function Command(name: string): FilterFn {
  const expected = name.toLowerCase().replace(/^[/!]/, "");
  return (ctx: Context) => {
    const body = ctx.body ?? ctx.text ?? "";
    const withPrefix = body.trim().match(/^[!/](\S+)(?:\s+([\s\S]*))?$/);
    if (withPrefix) {
      const cmd = (withPrefix[1] ?? "").split(":")[0]?.toLowerCase() ?? "";
      if (cmd === expected) {
        ctx.commandName = expected;
        ctx.commandArgs = (withPrefix[2] ?? "").trimStart();
        return true;
      }
      return false;
    }
    if (ctx.isDirect) {
      const parsed = parseCommandToken(body);
      if (parsed && parsed.name === expected && !body.trim().startsWith("!") && !body.trim().startsWith("/")) {
        // bare word only in DM
        const bareMatch = body.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
        if (bareMatch && !(bareMatch[1] ?? "").startsWith("!") && !(bareMatch[1] ?? "").startsWith("/")) {
          ctx.commandName = expected;
          ctx.commandArgs = parsed.args;
          return true;
        }
      }
    }
    return false;
  };
}

function truthyText(ctx: Context): boolean {
  return Boolean((ctx.text ?? "").trim());
}

function mentionMatches(ctx: Context, name: string): boolean {
  const needle = name.trim().toLowerCase();
  if (!needle) return false;
  const body = (ctx.body ?? ctx.text ?? "").toLowerCase();
  // display name substring or @localpart
  if (body.includes(needle)) return true;
  const local = needle.replace(/^@/, "").split(":")[0] ?? needle;
  if (body.includes(`@${local}`)) return true;
  // Matrix mention pill in formatted_body
  const formatted =
    typeof ctx.event.content?.formatted_body === "string"
      ? ctx.event.content.formatted_body.toLowerCase()
      : "";
  if (formatted.includes(needle) || formatted.includes(`@${local}`)) return true;
  return false;
}

export const F = {
  /** Truthy non-empty text body. */
  text: Object.assign(
    ((ctx: Context) => truthyText(ctx)) as FilterFn & {
      equals(s: string): FilterFn;
      regexp(re: RegExp): FilterFn;
    },
    {
      equals(s: string): FilterFn {
        return (ctx) => (ctx.text ?? "") === s;
      },
      regexp(re: RegExp): FilterFn {
        return (ctx) => re.test(ctx.text ?? "");
      },
    },
  ),
  room: {
    dm: ((ctx: Context) => ctx.isDirect) as FilterFn,
    group: ((ctx: Context) => !ctx.isDirect) as FilterFn,
  },
  /** Match display name or localpart mention in body / formatted_body. */
  mention(displayNameOrLocalpart: string): FilterFn {
    return (ctx) => mentionMatches(ctx, displayNameOrLocalpart);
  },
};

/** Standalone mention filter helper. */
export function mentioned(ctx: Context, displayNameOrLocalpart: string): boolean {
  return mentionMatches(ctx, displayNameOrLocalpart);
}
