import { ConfigurationError } from "./errors.js";

/** Primitive arg kinds accepted by {@link parseCommandArgs}. */
export type CommandArgKind =
  | "string"
  | "int"
  | "float"
  | "userId"
  | "roomId"
  | "bool"
  | "rest";

export type CommandArgSpec =
  | CommandArgKind
  | {
      kind: CommandArgKind;
      /** When true, missing values become `undefined` instead of throwing. */
      optional?: boolean;
      /** Default when the token is absent (implies optional). */
      default?: unknown;
      /** Inclusive lower bound for int/float. */
      min?: number;
      /** Inclusive upper bound for int/float. */
      max?: number;
    };

export type CommandArgsSchema = Record<string, CommandArgSpec>;

export type ParsedCommandArgs<S extends CommandArgsSchema = CommandArgsSchema> = {
  [K in keyof S]: unknown;
};

/**
 * Parse a command argument string against a typed schema.
 *
 * @example
 * ```ts
 * const args = parseCommandArgs(ctx.commandArgs, {
 *   user: "userId",
 *   days: { kind: "int", optional: true, default: 7, min: 1, max: 365 },
 *   reason: { kind: "rest", optional: true },
 * });
 * ```
 */
export function parseCommandArgs<S extends CommandArgsSchema>(
  raw: string,
  schema: S,
): ParsedCommandArgs<S> {
  const tokens = tokenizeArgs(raw);
  const keys = Object.keys(schema);
  const out: Record<string, unknown> = {};
  let index = 0;

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    const spec = normalizeSpec(schema[key]!);
    if (spec.kind === "rest") {
      const rest = tokens.slice(index).join(" ").trim();
      index = tokens.length;
      if (!rest) {
        if (spec.optional || spec.default !== undefined) {
          out[key] = spec.default;
          continue;
        }
        throw new ConfigurationError(`command arg "${key}" (rest) is required`);
      }
      out[key] = rest;
      continue;
    }

    const token = tokens[index];
    if (token === undefined) {
      if (spec.optional || spec.default !== undefined) {
        out[key] = spec.default;
        continue;
      }
      throw new ConfigurationError(`command arg "${key}" is required`);
    }
    index += 1;
    out[key] = coerceToken(token, spec, key);
  }

  return out as ParsedCommandArgs<S>;
}

/** Convenience: split args with quotes (`"a b"` / `'c'`). */
export function tokenizeArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const token = match[0];
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      out.push(token.slice(1, -1).replace(/\\(["'\\])/g, "$1"));
    } else {
      out.push(token);
    }
  }
  return out;
}

function normalizeSpec(spec: CommandArgSpec): {
  kind: CommandArgKind;
  optional?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
} {
  if (typeof spec === "string") return { kind: spec };
  return spec;
}

function coerceToken(
  token: string,
  spec: { kind: CommandArgKind; min?: number; max?: number },
  key: string,
): unknown {
  switch (spec.kind) {
    case "string":
      return token;
    case "rest":
      return token;
    case "int": {
      if (!/^-?\d+$/.test(token)) {
        throw new ConfigurationError(`command arg "${key}" must be an integer`);
      }
      const n = Number(token);
      return clampNumber(n, spec, key);
    }
    case "float": {
      const n = Number(token);
      if (!Number.isFinite(n)) {
        throw new ConfigurationError(`command arg "${key}" must be a number`);
      }
      return clampNumber(n, spec, key);
    }
    case "userId": {
      if (!/^@[^\s:]+:[^\s]+$/.test(token)) {
        throw new ConfigurationError(`command arg "${key}" must be a Matrix user id`);
      }
      return token;
    }
    case "roomId": {
      if (!/^![^\s:]+:[^\s]+$/.test(token) && !/^#[^\s:]+:[^\s]+$/.test(token)) {
        throw new ConfigurationError(`command arg "${key}" must be a room id or alias`);
      }
      return token;
    }
    case "bool": {
      const folded = token.toLowerCase();
      if (["1", "true", "yes", "on"].includes(folded)) return true;
      if (["0", "false", "no", "off"].includes(folded)) return false;
      throw new ConfigurationError(`command arg "${key}" must be a boolean`);
    }
    default:
      throw new ConfigurationError(`unknown command arg kind for "${key}"`);
  }
}

function clampNumber(
  n: number,
  spec: { min?: number; max?: number },
  key: string,
): number {
  if (spec.min !== undefined && n < spec.min) {
    throw new ConfigurationError(`command arg "${key}" must be >= ${spec.min}`);
  }
  if (spec.max !== undefined && n > spec.max) {
    throw new ConfigurationError(`command arg "${key}" must be <= ${spec.max}`);
  }
  return n;
}
