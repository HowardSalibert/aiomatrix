import { ConfigurationError } from "./errors.js";
import { escapeHtml } from "./util.js";

/** Prefixes recognised by default for command tokens. */
export const DEFAULT_COMMAND_PREFIXES = ["/", "!"] as const;

export interface CommandSpec {
  name: string;
  aliases?: string[];
  description?: string;
  /** Usage hint, e.g. `<room> [date]`. */
  args?: string;
  /** Hide from generated help / autocomplete. */
  hidden?: boolean;
  /** Minimum power level required (used by `F.hasPower` and help rendering). */
  minPowerLevel?: number;
  /** Restrict to direct chats or group rooms. */
  scope?: "all" | "direct" | "group";
  /** Free-form category used to group generated help. */
  category?: string;
}

/** Parsed command, mirroring aiogram's `CommandObject`. */
export interface CommandObject {
  /** Prefix that introduced the command (`/`, `!`, or `""` for a bare token). */
  prefix: string;
  /** Normalised command name (NFC + lower-case, no prefix). */
  command: string;
  /** Command name exactly as typed. */
  raw: string;
  /** Everything after the command token, trimmed at the start. */
  args: string;
  /** Whitespace-split arguments. */
  argsList: string[];
  /** Bot mention suffix from `/cmd@bot`, when present. */
  mention: string | null;
}

/** Identity helper — keeps a typed list of command specs for hosts / help text. */
export function defineCommands(specs: CommandSpec[]): CommandSpec[] {
  return specs;
}

/**
 * Fold a command token for matching: NFC + lower-case, strip a leading prefix,
 * and take the part before `:` or `@`. Unicode-safe — Cyrillic and other
 * scripts are first-class, with no ASCII allowlists.
 */
export function normalizeCommandName(name: string): string {
  const folded = name.normalize("NFC").toLowerCase().replace(/^[/!.]/, "");
  const beforeSeparator = folded.split(/[:@]/)[0] ?? "";
  return beforeSeparator;
}

export interface ParseCommandOptions {
  /** Accepted prefixes. Default `["/", "!"]`. */
  prefixes?: readonly string[];
  /**
   * Accept a bare first token with no prefix (typical in direct chats).
   * Default false.
   */
  allowBare?: boolean;
  /**
   * Strip a leading bot mention such as `mybot: help` or `@bot:hs help`
   * before parsing. Pass the bot's localpart and/or display name.
   */
  botNames?: string[];
}

/**
 * Parse a message body into a {@link CommandObject}, or `null` when the body is
 * not a command.
 */
export function parseCommand(
  body: string,
  options: ParseCommandOptions = {},
): CommandObject | null {
  const prefixes = options.prefixes ?? DEFAULT_COMMAND_PREFIXES;
  let trimmed = body.trim();
  if (!trimmed) return null;

  // Strip an addressing prefix: "mybot: /help", "@mybot:hs help", "mybot, help".
  for (const name of options.botNames ?? []) {
    const stripped = stripAddressPrefix(trimmed, name);
    if (stripped !== null) {
      trimmed = stripped.trim();
      break;
    }
  }
  if (!trimmed) return null;

  const [firstToken = "", ...restTokens] = splitFirstToken(trimmed);
  const args = restTokens.join("");
  const matchedPrefix = prefixes.find((p) => p.length > 0 && firstToken.startsWith(p));

  if (!matchedPrefix) {
    if (!options.allowBare) return null;
    const command = normalizeCommandName(firstToken);
    if (!command) return null;
    return buildCommandObject("", firstToken, command, args);
  }

  const rawName = firstToken.slice(matchedPrefix.length);
  if (!rawName) return null;
  const command = normalizeCommandName(rawName);
  if (!command) return null;
  return buildCommandObject(matchedPrefix, rawName, command, args);
}

function buildCommandObject(
  prefix: string,
  raw: string,
  command: string,
  args: string,
): CommandObject {
  const mentionMatch = /@([^\s]+)$/.exec(raw);
  const trimmedArgs = args.trimStart();
  return {
    prefix,
    command,
    raw,
    args: trimmedArgs,
    argsList: trimmedArgs.length > 0 ? trimmedArgs.split(/\s+/) : [],
    mention: mentionMatch?.[1] ?? null,
  };
}

function splitFirstToken(input: string): [string, string] | [string] {
  const match = /^(\S+)([\s\S]*)$/.exec(input);
  if (!match) return [input];
  return [match[1] ?? "", match[2] ?? ""];
}

function stripAddressPrefix(body: string, botName: string): string | null {
  const name = botName.trim();
  if (!name) return null;
  const candidates = new Set<string>([name]);
  const localpart = name.replace(/^@/, "").split(":")[0];
  if (localpart) {
    candidates.add(localpart);
    candidates.add(`@${localpart}`);
  }
  const lowered = body.toLowerCase();
  for (const candidate of candidates) {
    const needle = candidate.toLowerCase();
    if (!lowered.startsWith(needle)) continue;
    const rest = body.slice(candidate.length);
    // Require an addressing separator so "mybots" does not match "mybot".
    const separator = /^\s*[:,\-—]?\s+/.exec(rest) ?? /^\s*[:,]\s*/.exec(rest);
    if (separator) return rest.slice(separator[0].length);
  }
  return null;
}

/**
 * Match a message body against command specs (`/name`, `!name`, or a bare
 * first token). Returns the matched spec and the remaining args, or `null`.
 */
export function matchCommand(
  body: string,
  specs: CommandSpec[],
  options: ParseCommandOptions = {},
): { spec: CommandSpec; args: string; command: CommandObject } | null {
  const parsed = parseCommand(body, { allowBare: true, ...options });
  if (!parsed) return null;
  for (const spec of specs) {
    const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeCommandName);
    if (names.includes(parsed.command)) {
      return { spec, args: parsed.args, command: parsed };
    }
  }
  return null;
}

/**
 * Suggest command specs for host Tab / slash autocomplete.
 *
 * Prefix-matches the first token of `input` (with an optional prefix) against
 * each spec's `name` and `aliases`. Stable order = the input `specs` order.
 * Empty input returns the first `limit` specs.
 */
export function suggestCommands(
  input: string,
  specs: CommandSpec[],
  limit = 8,
): CommandSpec[] {
  const capped = Math.max(0, limit);
  if (capped === 0) return [];
  const visible = specs.filter((spec) => !spec.hidden);

  const trimmed = input.trim();
  if (!trimmed) return visible.slice(0, capped);

  const first = trimmed.split(/\s+/)[0] ?? "";
  const token = normalizeCommandName(first);
  if (!token) return visible.slice(0, capped);

  const out: CommandSpec[] = [];
  for (const spec of visible) {
    const names = [spec.name, ...(spec.aliases ?? [])].map(normalizeCommandName);
    if (names.some((n) => n.startsWith(token))) {
      out.push(spec);
      if (out.length >= capped) break;
    }
  }
  return out;
}

export interface HelpTextOptions {
  /** Prefix rendered before each command. Default `/`. */
  prefix?: string;
  /** Heading placed above the list. */
  title?: string;
  /** Only include commands available in this scope. */
  scope?: "direct" | "group";
  /** Caller's power level; higher-privilege commands are hidden below it. */
  powerLevel?: number;
  /** Group by `category`. Default true when any spec has a category. */
  groupByCategory?: boolean;
}

function visibleForHelp(spec: CommandSpec, options: HelpTextOptions): boolean {
  if (spec.hidden) return false;
  if (options.scope && spec.scope && spec.scope !== "all" && spec.scope !== options.scope) {
    return false;
  }
  if (
    options.powerLevel !== undefined &&
    spec.minPowerLevel !== undefined &&
    options.powerLevel < spec.minPowerLevel
  ) {
    return false;
  }
  return true;
}

/** Render a plain-text help listing from command specs. */
export function buildHelpText(specs: CommandSpec[], options: HelpTextOptions = {}): string {
  const prefix = options.prefix ?? "/";
  const visible = specs.filter((spec) => visibleForHelp(spec, options));
  if (visible.length === 0) return options.title ?? "No commands available.";

  const groupBy = options.groupByCategory ?? visible.some((spec) => spec.category);
  const lines: string[] = [];
  if (options.title) lines.push(options.title, "");

  const render = (spec: CommandSpec): string => {
    const usage = spec.args ? `${prefix}${spec.name} ${spec.args}` : `${prefix}${spec.name}`;
    return spec.description ? `${usage} — ${spec.description}` : usage;
  };

  if (!groupBy) {
    for (const spec of visible) lines.push(render(spec));
    return lines.join("\n").trim();
  }

  const groups = new Map<string, CommandSpec[]>();
  for (const spec of visible) {
    const key = spec.category ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(spec);
    else groups.set(key, [spec]);
  }
  for (const [category, group] of groups) {
    if (category) lines.push(`${category}:`);
    for (const spec of group) lines.push(category ? `  ${render(spec)}` : render(spec));
    lines.push("");
  }
  return lines.join("\n").trim();
}

/** Render the same help listing as HTML. */
export function buildHelpHtml(specs: CommandSpec[], options: HelpTextOptions = {}): string {
  const prefix = options.prefix ?? "/";
  const visible = specs.filter((spec) => visibleForHelp(spec, options));
  if (visible.length === 0) {
    return `<p>${escapeHtml(options.title ?? "No commands available.")}</p>`;
  }
  const parts: string[] = [];
  if (options.title) parts.push(`<p><strong>${escapeHtml(options.title)}</strong></p>`);
  const groupBy = options.groupByCategory ?? visible.some((spec) => spec.category);

  const item = (spec: CommandSpec): string => {
    const usage = spec.args ? `${prefix}${spec.name} ${spec.args}` : `${prefix}${spec.name}`;
    const desc = spec.description ? ` — ${escapeHtml(spec.description)}` : "";
    return `<li><code>${escapeHtml(usage)}</code>${desc}</li>`;
  };

  if (!groupBy) {
    parts.push(`<ul>${visible.map(item).join("")}</ul>`);
    return parts.join("");
  }

  const groups = new Map<string, CommandSpec[]>();
  for (const spec of visible) {
    const key = spec.category ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(spec);
    else groups.set(key, [spec]);
  }
  for (const [category, group] of groups) {
    if (category) parts.push(`<p><em>${escapeHtml(category)}</em></p>`);
    parts.push(`<ul>${group.map(item).join("")}</ul>`);
  }
  return parts.join("");
}

/**
 * Mutable command registry. Routers register specs here so `/help` and host
 * autocomplete stay in sync with the handlers that actually exist.
 */
export class CommandRegistry {
  private readonly specs = new Map<string, CommandSpec>();

  add(spec: CommandSpec): this {
    const name = normalizeCommandName(spec?.name ?? "");
    if (!name) {
      throw new ConfigurationError(
        `command spec needs a non-empty \`name\`, got ${JSON.stringify(spec)}`,
      );
    }
    this.specs.set(name, spec);
    return this;
  }

  addAll(specs: CommandSpec[]): this {
    for (const spec of specs) this.add(spec);
    return this;
  }

  remove(name: string): boolean {
    return this.specs.delete(normalizeCommandName(name));
  }

  has(name: string): boolean {
    return this.specs.has(normalizeCommandName(name));
  }

  get(name: string): CommandSpec | undefined {
    return this.specs.get(normalizeCommandName(name));
  }

  list(): CommandSpec[] {
    return [...this.specs.values()];
  }

  get size(): number {
    return this.specs.size;
  }

  suggest(input: string, limit = 8): CommandSpec[] {
    return suggestCommands(input, this.list(), limit);
  }

  match(
    body: string,
    options?: ParseCommandOptions,
  ): { spec: CommandSpec; args: string; command: CommandObject } | null {
    return matchCommand(body, this.list(), options);
  }

  helpText(options?: HelpTextOptions): string {
    return buildHelpText(this.list(), options);
  }

  helpHtml(options?: HelpTextOptions): string {
    return buildHelpHtml(this.list(), options);
  }
}

/**
 * State event type bots use to advertise their commands to clients so hosts can
 * build slash-autocomplete without hard-coding anything.
 */
export const COMMANDS_STATE_EVENT_TYPE = "dev.aiomatrix.commands";

export function buildCommandsStateContent(
  specs: CommandSpec[],
  options?: { prefixes?: readonly string[] },
): Record<string, unknown> {
  return {
    version: 1,
    prefixes: [...(options?.prefixes ?? DEFAULT_COMMAND_PREFIXES)],
    commands: specs
      .filter((spec) => !spec.hidden)
      .map((spec) => ({
        name: spec.name,
        ...(spec.aliases?.length ? { aliases: spec.aliases } : {}),
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.category ? { category: spec.category } : {}),
        ...(spec.scope && spec.scope !== "all" ? { scope: spec.scope } : {}),
      })),
  };
}
