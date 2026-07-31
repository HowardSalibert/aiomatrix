import { runChain } from "./router.js";
import type { AnyContext, Handler, Middleware } from "./types.js";
import { LruCache } from "./util.js";

/**
 * Compose a middleware stack (onion model); `final` runs at the centre.
 * Kept as a standalone export because it is useful for testing handlers.
 */
export function compose(
  middlewares: Array<Middleware<never>>,
): (ctx: AnyContext, final: () => Promise<void>) => Promise<void> {
  return async (ctx, final) => {
    await runChain(middlewares, ctx, final as unknown as Handler<never>);
  };
}

export interface ThrottleOptions {
  /** Allowed updates per window. Default 5. */
  limit?: number;
  /** Window length in ms. Default 5000. */
  windowMs?: number;
  /** Key derivation. Default: sender + room. */
  key?: (ctx: AnyContext) => string;
  /** Called the first time a key is throttled inside a window. */
  onThrottled?: (ctx: AnyContext, retryAfterMs: number) => void | Promise<void>;
  /** Max distinct keys tracked. Default 10000. */
  capacity?: number;
}

interface ThrottleRecord {
  windowStart: number;
  count: number;
  notified: boolean;
}

/**
 * Sliding-window throttle. Updates over the limit are dropped, so a flood in one
 * room cannot starve handlers in others.
 */
export function throttle(options: ThrottleOptions = {}): Middleware<AnyContext> {
  const limit = Math.max(1, options.limit ?? 5);
  const windowMs = Math.max(1, options.windowMs ?? 5_000);
  const keyOf = options.key ?? ((ctx) => `${ctx.senderId}|${ctx.roomId}`);
  const records = new LruCache<string, ThrottleRecord>(options.capacity ?? 10_000);

  return async (ctx, next) => {
    const key = keyOf(ctx);
    const now = Date.now();
    const record = records.get(key);
    if (!record || now - record.windowStart >= windowMs) {
      records.set(key, { windowStart: now, count: 1, notified: false });
      await next();
      return;
    }
    record.count += 1;
    if (record.count > limit) {
      if (!record.notified) {
        record.notified = true;
        const retryAfterMs = record.windowStart + windowMs - now;
        await options.onThrottled?.(ctx, retryAfterMs);
      }
      return;
    }
    await next();
  };
}

export interface LoggingOptions {
  /** Log level used for the per-update line. Default `debug`. */
  level?: "trace" | "debug" | "info";
  /** Include the message body / callback data. Default false (privacy). */
  includePayload?: boolean;
}

/** Log every update with its duration and outcome. */
export function logging(options: LoggingOptions = {}): Middleware<AnyContext> {
  const level = options.level ?? "debug";
  return async (ctx, next) => {
    const started = Date.now();
    const describe = (): Record<string, unknown> => ({
      update: ctx.updateType,
      room: ctx.roomId,
      sender: ctx.senderId,
      ...(options.includePayload && "text" in ctx
        ? { text: (ctx as { text?: string }).text }
        : {}),
    });
    try {
      await next();
      ctx.logger[level](`update handled in ${Date.now() - started}ms`, describe());
    } catch (err) {
      ctx.logger.error(`update failed after ${Date.now() - started}ms`, {
        ...describe(),
        error: err,
      });
      throw err;
    }
  };
}

/** Drop updates the bot itself produced (own echoes). */
export function skipSelf(): Middleware<AnyContext> {
  return async (ctx, next) => {
    if (ctx.senderId && ctx.senderId === ctx.client.selfId) return;
    await next();
  };
}

export interface UserFilterOptions {
  /** Only these users may reach handlers. */
  allow?: string[];
  /** These users never reach handlers (applied after `allow`). */
  deny?: string[];
  /** Allow entire homeservers by server name. */
  allowServers?: string[];
  onRejected?: (ctx: AnyContext) => void | Promise<void>;
}

/** Coarse access control in front of every handler. */
export function accessControl(options: UserFilterOptions): Middleware<AnyContext> {
  const allow = options.allow ? new Set(options.allow) : null;
  const deny = options.deny ? new Set(options.deny) : null;
  const servers = options.allowServers
    ? new Set(options.allowServers.map((s) => s.replace(/^:/, "").toLowerCase()))
    : null;

  return async (ctx, next) => {
    const sender = ctx.senderId;
    const server = (sender.split(":")[1] ?? "").toLowerCase();
    const allowed =
      (allow === null && servers === null) ||
      (allow?.has(sender) ?? false) ||
      (servers?.has(server) ?? false);
    if (!allowed || deny?.has(sender)) {
      await options.onRejected?.(ctx);
      return;
    }
    await next();
  };
}

export interface I18nOptions<T extends Record<string, Record<string, string>>> {
  /** `{ en: { greet: 'Hi' }, ru: { greet: 'Привет' } }`. */
  catalogs: T;
  defaultLocale: keyof T & string;
  /** Resolve the locale for an update (e.g. from FSM data or a database). */
  resolveLocale?: (ctx: AnyContext) => string | Promise<string>;
}

export interface Translator {
  locale: string;
  /** Translate a key, substituting `{name}` placeholders. */
  t(key: string, params?: Record<string, string | number>): string;
}

/**
 * Minimal i18n middleware: puts a {@link Translator} on `ctx.data.i18n`.
 *
 * Deliberately dependency-free — swap in `intl-messageformat` or similar by
 * writing your own middleware with the same shape.
 */
export function i18n<T extends Record<string, Record<string, string>>>(
  options: I18nOptions<T>,
): Middleware<AnyContext> {
  const catalogs = options.catalogs as Record<string, Record<string, string>>;
  const fallback: Record<string, string> = catalogs[options.defaultLocale] ?? {};
  return async (ctx, next) => {
    const locale = (await options.resolveLocale?.(ctx)) ?? options.defaultLocale;
    const catalog: Record<string, string> = catalogs[locale] ?? fallback;
    const translator: Translator = {
      locale,
      t(key, params) {
        const template = catalog[key] ?? fallback[key] ?? key;
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
          name in params ? String(params[name]) : match,
        );
      },
    };
    ctx.data.i18n = translator;
    await next();
  };
}

/** Read the translator installed by {@link i18n}. */
export function getTranslator(ctx: AnyContext): Translator | null {
  const value = ctx.data.i18n;
  return value && typeof (value as Translator).t === "function" ? (value as Translator) : null;
}

/** Show the typing indicator while a handler runs. */
export function typingIndicator(): Middleware<AnyContext> {
  return async (ctx, next) => {
    await ctx.withTyping(async () => {
      await next();
    });
  };
}

export interface ErrorReplyOptions {
  /** Message sent to the room when a handler throws. */
  text?: string;
  /** Send as a notice. Default true. */
  notice?: boolean;
  /** Swallow the error after replying. Default false, so it still reaches logs. */
  swallow?: boolean;
}

/**
 * Tell the user something went wrong instead of failing silently.
 *
 * The error still propagates by default so dispatcher-level error handlers and
 * metrics keep seeing it.
 */
export function errorReply(options: ErrorReplyOptions = {}): Middleware<AnyContext> {
  const text = options.text ?? "Something went wrong handling that. Please try again.";
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      await ctx.answer(text, { notice: options.notice !== false }).catch(() => undefined);
      if (options.swallow !== true) throw err;
    }
  };
}
