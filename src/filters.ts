import {
  DEFAULT_COMMAND_PREFIXES,
  normalizeCommandName,
  parseCommand,
  type CommandSpec,
} from "./commands.js";
import type {
  BaseContext,
  CallbackContext,
  Filter,
  MembershipContext,
  MessageContext,
  MiniAppDataContext,
  ReactionContext,
} from "./types.js";
import { isPlainObject, readString } from "./util.js";

/** A command filter also carries its spec so `/help` can be generated. */
export interface CommandFilter extends Filter<MessageContext> {
  readonly spec: CommandSpec;
}

export interface CommandOptions extends Omit<CommandSpec, "name" | "aliases"> {
  /** Accepted prefixes. Default `["/", "!"]`. */
  prefixes?: readonly string[];
  /**
   * Accept the command without a prefix. Default: allowed in direct chats only,
   * which is what users expect from a DM with a bot.
   */
  allowBare?: boolean | "direct";
  /** Require the command to be addressed at this bot in group rooms. */
  requireMention?: boolean;
}

/**
 * Match a bot command.
 *
 * Recognises `/name`, `!name`, `name@bot`, `bot: name`, and — in direct chats —
 * a bare `name`. Names are NFC-normalised and case-folded, so Cyrillic and other
 * scripts are first-class rather than ASCII-only.
 */
export function Command(
  name: string | string[],
  options: CommandOptions = {},
): CommandFilter {
  const names = (Array.isArray(name) ? name : [name]).map((n) => normalizeCommandName(n));
  const primary = names[0] ?? "";
  const aliases = names.slice(1);
  const prefixes = options.prefixes ?? DEFAULT_COMMAND_PREFIXES;

  const filter = ((ctx: MessageContext): boolean => {
    if (!ctx.text) return false;
    const selfLocalpart = localpartOf(ctx.client.selfId);
    const botNames = [ctx.client.selfId, selfLocalpart].filter((n): n is string => Boolean(n));
    const allowBare =
      options.allowBare === true ||
      (options.allowBare !== false && ctx.isDirect);
    const parsed = parseCommand(ctx.text, { prefixes, allowBare, botNames });
    if (!parsed) return false;
    if (!names.includes(parsed.command)) return false;
    // `/cmd@otherbot` in a shared room is addressed at somebody else.
    if (parsed.mention && selfLocalpart && normalizeAddress(parsed.mention) !== selfLocalpart) {
      return false;
    }
    if (options.requireMention && !ctx.isDirect && !parsed.mention) {
      const mentioned = ctx.mentions.userIds.includes(ctx.client.selfId);
      if (!mentioned) return false;
    }
    if (options.scope === "direct" && !ctx.isDirect) return false;
    if (options.scope === "group" && ctx.isDirect) return false;
    if (options.minPowerLevel !== undefined && ctx.powerLevelOf() < options.minPowerLevel) {
      return false;
    }
    ctx.command = parsed;
    ctx.commandName = parsed.command;
    ctx.commandArgs = parsed.args;
    return true;
  }) as CommandFilter;

  const spec: CommandSpec = {
    name: primary,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.args ? { args: options.args } : {}),
    ...(options.hidden ? { hidden: true } : {}),
    ...(options.minPowerLevel !== undefined ? { minPowerLevel: options.minPowerLevel } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.category ? { category: options.category } : {}),
  };
  Object.defineProperty(filter, "spec", { value: spec, enumerable: true });
  return filter;
}

/** `/start`, the conventional entry point (also matches a bare `start` in DMs). */
export function CommandStart(options?: CommandOptions): CommandFilter {
  return Command("start", { description: "Start the bot", ...options });
}

/** `/help`, rendered from the registered command specs by default. */
export function CommandHelp(options?: CommandOptions): CommandFilter {
  return Command("help", { description: "Show available commands", ...options });
}

function localpartOf(userId: string): string {
  return userId.replace(/^@/, "").split(":")[0]?.toLowerCase() ?? "";
}

function normalizeAddress(value: string): string {
  return localpartOf(value.normalize("NFC"));
}

// ------------------------------------------------------------------ text ---

interface TextFilter extends Filter<MessageContext> {
  equals(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext>;
  contains(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext>;
  startsWith(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext>;
  endsWith(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext>;
  in(values: string[], options?: { ignoreCase?: boolean }): Filter<MessageContext>;
  regexp(pattern: RegExp): Filter<MessageContext>;
  len(predicate: (length: number) => boolean): Filter<MessageContext>;
}

function fold(value: string, ignoreCase?: boolean): string {
  const normalized = value.normalize("NFC");
  return ignoreCase === false ? normalized : normalized.toLowerCase();
}

const textFilter = ((ctx: MessageContext) => Boolean(ctx.text.trim())) as TextFilter;
Object.assign(textFilter, {
  equals(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext> {
    return (ctx) => fold(ctx.text, options?.ignoreCase) === fold(value, options?.ignoreCase);
  },
  contains(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext> {
    return (ctx) => fold(ctx.text, options?.ignoreCase).includes(fold(value, options?.ignoreCase));
  },
  startsWith(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext> {
    return (ctx) =>
      fold(ctx.text, options?.ignoreCase).startsWith(fold(value, options?.ignoreCase));
  },
  endsWith(value: string, options?: { ignoreCase?: boolean }): Filter<MessageContext> {
    return (ctx) => fold(ctx.text, options?.ignoreCase).endsWith(fold(value, options?.ignoreCase));
  },
  in(values: string[], options?: { ignoreCase?: boolean }): Filter<MessageContext> {
    const set = new Set(values.map((value) => fold(value, options?.ignoreCase)));
    return (ctx) => set.has(fold(ctx.text, options?.ignoreCase));
  },
  regexp(pattern: RegExp): Filter<MessageContext> {
    return (ctx) => {
      // Reset `lastIndex` so a sticky/global pattern stays reusable.
      if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
      const match = pattern.exec(ctx.text);
      if (!match) return false;
      ctx.data.match = match;
      return true;
    };
  },
  len(predicate: (length: number) => boolean): Filter<MessageContext> {
    return (ctx) => predicate([...ctx.text].length);
  },
});

// ----------------------------------------------------------------- mentions -

function mentionMatches(ctx: MessageContext, name: string): boolean {
  const needle = name.trim().normalize("NFC").toLowerCase();
  if (!needle) return false;
  if (ctx.mentions.userIds.some((id) => id.toLowerCase() === needle)) return true;
  const local = localpartOf(needle) || needle;
  const body = ctx.text.normalize("NFC").toLowerCase();
  if (body.includes(needle) || body.includes(`@${local}`)) return true;
  const formatted = (ctx.html ?? "").normalize("NFC").toLowerCase();
  return formatted.includes(needle) || formatted.includes(`@${local}`);
}

/** Standalone mention check, kept for backwards compatibility. */
export function mentioned(ctx: MessageContext, displayNameOrLocalpart: string): boolean {
  return mentionMatches(ctx, displayNameOrLocalpart);
}

// ------------------------------------------------------------------- combinators

/** All filters must pass. */
export function and<C extends BaseContext>(...filters: Array<Filter<C>>): Filter<C> {
  return async (ctx) => {
    for (const filter of filters) {
      if (!(await filter(ctx))) return false;
    }
    return true;
  };
}

/** At least one filter must pass. */
export function or<C extends BaseContext>(...filters: Array<Filter<C>>): Filter<C> {
  return async (ctx) => {
    for (const filter of filters) {
      if (await filter(ctx)) return true;
    }
    return false;
  };
}

/** Invert a filter. */
export function not<C extends BaseContext>(filter: Filter<C>): Filter<C> {
  return async (ctx) => !(await filter(ctx));
}

// ------------------------------------------------------------------------- F

/**
 * Filter factory namespace, in the spirit of aiogram's magic filters.
 *
 * Filters that only need the shared context surface (`F.room.*`, `F.from.*`,
 * `F.hasPower`) work with every update type; text/media filters are typed for
 * message handlers.
 */
export const F = {
  /** Non-empty message text, plus text matchers. */
  text: textFilter,

  /** Message carries an HTML body. */
  html: ((ctx: MessageContext) => ctx.html !== null) as Filter<MessageContext>,

  /** Match specific `msgtype` values. */
  msgtype(...types: string[]): Filter<MessageContext> {
    const set = new Set(types);
    return (ctx) => set.has(ctx.msgtype);
  },
  image: ((ctx: MessageContext) => ctx.msgtype === "m.image") as Filter<MessageContext>,
  video: ((ctx: MessageContext) => ctx.msgtype === "m.video") as Filter<MessageContext>,
  audio: ((ctx: MessageContext) => ctx.msgtype === "m.audio") as Filter<MessageContext>,
  file: ((ctx: MessageContext) => ctx.msgtype === "m.file") as Filter<MessageContext>,
  location: ((ctx: MessageContext) => ctx.msgtype === "m.location") as Filter<MessageContext>,
  emote: ((ctx: MessageContext) => ctx.msgtype === "m.emote") as Filter<MessageContext>,
  notice: ((ctx: MessageContext) => ctx.msgtype === "m.notice") as Filter<MessageContext>,
  hasAttachment: ((ctx: MessageContext) => ctx.attachment !== null) as Filter<MessageContext>,

  /** Message is a rich reply. */
  reply: ((ctx: MessageContext) => ctx.replyToEventId !== null) as Filter<MessageContext>,
  /** Message belongs to a thread. */
  thread: ((ctx: MessageContext) => ctx.threadRootId !== null) as Filter<MessageContext>,
  /** Message is an edit. */
  edited: ((ctx: MessageContext) => ctx.isEdit) as Filter<MessageContext>,

  /** Match a display name / localpart mention anywhere in the message. */
  mention(displayNameOrLocalpart: string): Filter<MessageContext> {
    return (ctx) => mentionMatches(ctx, displayNameOrLocalpart);
  },
  /** The bot itself was mentioned (`m.mentions` or plain text). */
  mentionsMe: ((ctx: MessageContext) => {
    if (ctx.mentions.userIds.includes(ctx.client.selfId)) return true;
    if (ctx.mentions.room) return true;
    return mentionMatches(ctx, ctx.client.selfId);
  }) as Filter<MessageContext>,

  room: {
    /** Direct (1:1) chat. */
    dm: ((ctx: BaseContext) => ctx.isDirect) as Filter<BaseContext>,
    /** Any non-direct room. */
    group: ((ctx: BaseContext) => !ctx.isDirect) as Filter<BaseContext>,
    is(roomId: string): Filter<BaseContext> {
      return (ctx) => ctx.roomId === roomId;
    },
    in(roomIds: string[]): Filter<BaseContext> {
      const set = new Set(roomIds);
      return (ctx) => set.has(ctx.roomId);
    },
    /** The room is end-to-end encrypted (cache-only, never blocks on HTTP). */
    encrypted: ((ctx: BaseContext) =>
      ctx.client.rooms.isEncrypted(ctx.roomId) === true) as Filter<BaseContext>,
  },

  from: {
    user(userId: string): Filter<BaseContext> {
      return (ctx) => ctx.senderId === userId;
    },
    users(userIds: string[]): Filter<BaseContext> {
      const set = new Set(userIds);
      return (ctx) => set.has(ctx.senderId);
    },
    /** Sender's homeserver. */
    server(serverName: string): Filter<BaseContext> {
      const needle = serverName.toLowerCase().replace(/^:/, "");
      return (ctx) => (ctx.senderId.split(":")[1] ?? "").toLowerCase() === needle;
    },
    self: ((ctx: BaseContext) => ctx.senderId === ctx.client.selfId) as Filter<BaseContext>,
  },

  /** Sender power level is at least `level`. */
  hasPower(level: number): Filter<BaseContext> {
    return (ctx) => ctx.powerLevelOf() >= level;
  },
  /** Power level >= 50. */
  isModerator: ((ctx: BaseContext) => ctx.powerLevelOf() >= 50) as Filter<BaseContext>,
  /** Power level >= 100. */
  isAdmin: ((ctx: BaseContext) => ctx.powerLevelOf() >= 100) as Filter<BaseContext>,

  reaction: {
    key(...keys: string[]): Filter<ReactionContext> {
      const set = new Set(keys);
      return (ctx) => set.has(ctx.key);
    },
    /** Reaction annotates a specific event. */
    on(eventId: string): Filter<ReactionContext> {
      return (ctx) => ctx.targetEventId === eventId;
    },
  },

  callback: {
    data(...values: string[]): Filter<CallbackContext> {
      const set = new Set(values);
      return (ctx) => set.has(ctx.callbackData);
    },
    startsWith(prefix: string): Filter<CallbackContext> {
      return (ctx) => ctx.callbackData.startsWith(prefix);
    },
    regexp(pattern: RegExp): Filter<CallbackContext> {
      return (ctx) => {
        if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
        const match = pattern.exec(ctx.callbackData);
        if (!match) return false;
        ctx.data.match = match;
        return true;
      };
    },
  },

  miniApp: {
    app(appId: string): Filter<MiniAppDataContext> {
      return (ctx) => ctx.appId === appId;
    },
    /** Payload is JSON with `field` set to `value`. */
    field(field: string, value?: unknown): Filter<MiniAppDataContext> {
      return (ctx) => {
        if (!isPlainObject(ctx.payload)) return false;
        return value === undefined ? field in ctx.payload : ctx.payload[field] === value;
      };
    },
    /** JSON payload with `action` (or `type`) equal to one of `actions`. */
    action(...actions: string[]): Filter<MiniAppDataContext> {
      const set = new Set(actions);
      return (ctx) => {
        if (!isPlainObject(ctx.payload)) return false;
        const action = readString(ctx.payload, "action") ?? readString(ctx.payload, "type");
        return action !== undefined && set.has(action);
      };
    },
    /** Sender power level is at least `level` (uses RoomCache via context). */
    hasPower(level: number): Filter<MiniAppDataContext> {
      return (ctx) => ctx.powerLevelOf() >= level;
    },
    /** Sender is currently joined in the room (RoomCache). */
    joined(): Filter<MiniAppDataContext> {
      return (ctx) => ctx.client.rooms.membershipOf(ctx.roomId, ctx.senderId) === "join";
    },
  },

  membership: {
    is(...values: string[]): Filter<MembershipContext> {
      const set = new Set(values);
      return (ctx) => set.has(ctx.membership);
    },
    joined: ((ctx: MembershipContext) =>
      ctx.membership === "join" && ctx.previousMembership !== "join") as Filter<MembershipContext>,
    left: ((ctx: MembershipContext) => ctx.membership === "leave") as Filter<MembershipContext>,
    banned: ((ctx: MembershipContext) => ctx.membership === "ban") as Filter<MembershipContext>,
    invited: ((ctx: MembershipContext) =>
      ctx.membership === "invite") as Filter<MembershipContext>,
    /** The bot itself is the subject of the change. */
    isSelf: ((ctx: MembershipContext) => ctx.isSelf) as Filter<MembershipContext>,
  },

  /** Wrap an arbitrary predicate. */
  custom<C extends BaseContext>(predicate: Filter<C>): Filter<C> {
    return predicate;
  },

  and,
  or,
  not,
};

/** Alias so `import { Filter } from 'aiomatrix'` keeps working. */
export type { Filter } from "./types.js";
