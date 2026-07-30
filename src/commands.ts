/**
 * Thin helpers for command UX metadata.
 *
 * Interactive Tab / autocomplete UI is the **host client's** job (Element, StudNovSU
 * web, etc.). matrixbots only exports command specs so hosts can wire autocomplete.
 */

export type CommandSpec = {
  name: string;
  aliases?: string[];
  description?: string;
  args?: string;
};

/** Identity helper — keeps a typed list of command specs for hosts / help text. */
export function defineCommands(specs: CommandSpec[]): CommandSpec[] {
  return specs;
}

function normalizeCommandName(name: string): string {
  return name.toLowerCase().replace(/^[/!]/, "").split(":")[0] ?? "";
}

/**
 * Match a message body against command specs (`/name`, `!name`, or bare first token).
 * Returns the matched spec and remaining args string, or null.
 */
export function matchCommand(
  body: string,
  specs: CommandSpec[],
): { spec: CommandSpec; args: string } | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  let token: string;
  let args: string;

  const withPrefix = trimmed.match(/^[!/](\S+)(?:\s+([\s\S]*))?$/);
  if (withPrefix) {
    token = normalizeCommandName(withPrefix[1] ?? "");
    args = (withPrefix[2] ?? "").trimStart();
  } else {
    const bare = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    if (!bare) return null;
    token = normalizeCommandName(bare[1] ?? "");
    args = (bare[2] ?? "").trimStart();
  }

  if (!token) return null;

  for (const spec of specs) {
    const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeCommandName);
    if (names.includes(token)) {
      return { spec, args };
    }
  }
  return null;
}
