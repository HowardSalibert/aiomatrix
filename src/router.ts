import type { CommandSpec } from "./commands.js";
import type {
  AnyContext,
  BaseContext,
  CallbackContext,
  ErrorHandler,
  Filter,
  Handler,
  MembershipContext,
  MessageContext,
  Middleware,
  MiniAppDataContext,
  EphemeralContext,
  PollResponseContext,
  RawEventContext,
  ReactionContext,
  RedactionContext,
  ToDeviceContext,
  UpdateType,
} from "./types.js";

interface Route {
  types: ReadonlySet<UpdateType> | null;
  filters: Array<Filter<never>>;
  handler: Handler<never>;
  name?: string;
}

interface ResolvedRoute {
  handler: Handler<never>;
  middlewares: Array<Middleware<never>>;
  router: Router;
  routeName?: string;
}

/**
 * Registration helper: the last argument is the handler, everything before it is
 * a filter (including state refs from `createStates`).
 */
function splitArgs<C extends BaseContext>(
  args: Array<Filter<C> | Handler<C>>,
): { filters: Array<Filter<C>>; handler: Handler<C> } {
  if (args.length === 0) {
    throw new TypeError("a handler function is required");
  }
  const handler = args[args.length - 1] as Handler<C>;
  if (typeof handler !== "function") {
    throw new TypeError("the last argument must be the handler function");
  }
  return { filters: args.slice(0, -1) as Array<Filter<C>>, handler };
}

const MESSAGE_TYPES = new Set<UpdateType>(["message"]);
const EDITED_TYPES = new Set<UpdateType>(["edited_message"]);
const ANY_MESSAGE_TYPES = new Set<UpdateType>(["message", "edited_message"]);

/**
 * Aiogram-style router.
 *
 * Handlers are tried in registration order; the first route whose filters all
 * pass wins, and nested routers are consulted afterwards. Router middleware runs
 * only once a route in that router (or one of its children) matched, so a
 * throttle or i18n layer never pays for updates nobody handles.
 */
export class Router {
  readonly name: string;
  private readonly routes: Route[] = [];
  private readonly children: Router[] = [];
  private readonly middlewares: Array<Middleware<never>> = [];
  private readonly errorHandlers: ErrorHandler[] = [];
  private readonly specs: CommandSpec[] = [];
  private parent: Router | null = null;

  constructor(name = "router") {
    this.name = name;
  }

  // ----------------------------------------------------------- registration

  /** Handler for new text/media messages. */
  message(...args: Array<Filter<MessageContext> | Handler<MessageContext>>): this {
    return this.register(MESSAGE_TYPES, args);
  }

  /** Handler for edits (`m.replace`). */
  editedMessage(...args: Array<Filter<MessageContext> | Handler<MessageContext>>): this {
    return this.register(EDITED_TYPES, args);
  }

  /** Handler for both new messages and edits. */
  anyMessage(...args: Array<Filter<MessageContext> | Handler<MessageContext>>): this {
    return this.register(ANY_MESSAGE_TYPES, args);
  }

  reaction(...args: Array<Filter<ReactionContext> | Handler<ReactionContext>>): this {
    return this.register(new Set<UpdateType>(["reaction"]), args);
  }

  redaction(...args: Array<Filter<RedactionContext> | Handler<RedactionContext>>): this {
    return this.register(new Set<UpdateType>(["redaction"]), args);
  }

  /** Membership changes (join/leave/kick/ban). */
  membership(...args: Array<Filter<MembershipContext> | Handler<MembershipContext>>): this {
    return this.register(new Set<UpdateType>(["membership"]), args);
  }

  /** Room invites addressed to the bot or to anyone else. */
  invite(...args: Array<Filter<MembershipContext> | Handler<MembershipContext>>): this {
    return this.register(new Set<UpdateType>(["invite"]), args);
  }

  /** Inline keyboard button presses. */
  callbackQuery(...args: Array<Filter<CallbackContext> | Handler<CallbackContext>>): this {
    return this.register(new Set<UpdateType>(["callback_query"]), args);
  }

  /** Data sent by a MiniApp (`WebApp.sendData`). */
  miniAppData(...args: Array<Filter<MiniAppDataContext> | Handler<MiniAppDataContext>>): this {
    return this.register(new Set<UpdateType>(["mini_app_data"]), args);
  }

  pollResponse(...args: Array<Filter<PollResponseContext> | Handler<PollResponseContext>>): this {
    return this.register(new Set<UpdateType>(["poll_response"]), args);
  }

  /** Typing / receipt / other ephemeral events (`receiveEphemeral: true`). */
  ephemeral(...args: Array<Filter<EphemeralContext> | Handler<EphemeralContext>>): this {
    return this.register(new Set<UpdateType>(["ephemeral"]), args);
  }

  /** Convenience: only `m.typing` ephemeral events. */
  typing(...args: Array<Filter<EphemeralContext> | Handler<EphemeralContext>>): this {
    return this.ephemeral((ctx) => ctx.isTyping, ...args);
  }

  /** Convenience: only `m.receipt` ephemeral events. */
  receipt(...args: Array<Filter<EphemeralContext> | Handler<EphemeralContext>>): this {
    return this.ephemeral((ctx) => ctx.isReceipt, ...args);
  }

  toDevice(...args: Array<Filter<ToDeviceContext> | Handler<ToDeviceContext>>): this {
    return this.register(new Set<UpdateType>(["to_device"]), args);
  }

  /** Any room event that no specific update type covers. */
  rawEvent(...args: Array<Filter<RawEventContext> | Handler<RawEventContext>>): this {
    return this.register(new Set<UpdateType>(["raw_event"]), args);
  }

  /** Register for explicit update types, or for every update when omitted. */
  on<C extends BaseContext = AnyContext>(
    types: UpdateType | UpdateType[] | null,
    ...args: Array<Filter<C> | Handler<C>>
  ): this {
    const set =
      types === null
        ? null
        : new Set<UpdateType>(Array.isArray(types) ? types : [types]);
    return this.register(set, args);
  }

  private register<C extends BaseContext>(
    types: ReadonlySet<UpdateType> | null,
    args: Array<Filter<C> | Handler<C>>,
  ): this {
    const { filters, handler } = splitArgs<C>(args);
    for (const filter of filters) {
      // `Command(...)` carries its spec, so `/help` and client-side command
      // advertising stay in sync with the handlers that actually exist.
      const spec = (filter as { spec?: CommandSpec }).spec;
      if (spec && typeof spec.name === "string") this.specs.push(spec);
    }
    this.routes.push({
      types,
      filters: filters as unknown as Array<Filter<never>>,
      handler: handler as unknown as Handler<never>,
    });
    return this;
  }

  /** Command specs declared by `Command(...)` filters in this subtree. */
  get commandSpecs(): CommandSpec[] {
    const out = [...this.specs];
    for (const child of this.children) out.push(...child.commandSpecs);
    return out;
  }

  /** Middleware applied to updates this router (or a descendant) handles. */
  use<C extends BaseContext = AnyContext>(middleware: Middleware<C>): this {
    this.middlewares.push(middleware as unknown as Middleware<never>);
    return this;
  }

  /**
   * Error handler for this subtree. Return `true` to mark the error handled;
   * anything else re-raises it to the parent router / dispatcher.
   */
  errors(handler: ErrorHandler): this {
    this.errorHandlers.push(handler);
    return this;
  }

  include(
    router: Router,
    options?: {
      /** Only enter this subtree when the filter passes. */
      filter?: Filter<AnyContext>;
    },
  ): this {
    if (router === this) throw new Error("a router cannot include itself");
    if (router.parent) {
      throw new Error(`router "${router.name}" is already attached to "${router.parent.name}"`);
    }
    let ancestor: Router | null = this;
    while (ancestor) {
      if (ancestor === router) throw new Error("router include would create a cycle");
      ancestor = ancestor.parent;
    }
    router.parent = this;
    if (options?.filter) {
      (router as Router & { includeFilter?: Filter<AnyContext> }).includeFilter = options.filter;
    }
    this.children.push(router);
    return this;
  }

  /** Routers directly attached to this one. */
  get includedRouters(): readonly Router[] {
    return this.children;
  }

  /** Number of handlers registered on this router (excluding children). */
  get handlerCount(): number {
    return this.routes.length;
  }

  // -------------------------------------------------------------- dispatch

  /**
   * Try to handle `ctx`. Returns `true` when a handler ran (even if it threw and
   * the error was swallowed by an error handler).
   */
  async feed(ctx: AnyContext): Promise<boolean> {
    const resolved = await this.resolve(ctx, []);
    if (!resolved) return false;
    try {
      await runChain(resolved.middlewares, ctx, resolved.handler);
    } catch (err) {
      const handled = await resolved.router.handleError(err, ctx);
      if (!handled) throw err;
    }
    return true;
  }

  /** Find the first matching route, accumulating middleware from the ancestors. */
  private async resolve(
    ctx: AnyContext,
    inherited: Array<Middleware<never>>,
  ): Promise<ResolvedRoute | null> {
    const chain = this.middlewares.length > 0 ? [...inherited, ...this.middlewares] : inherited;
    for (const route of this.routes) {
      if (route.types && !route.types.has(ctx.updateType)) continue;
      if (!(await passesFilters(route.filters, ctx))) continue;
      return {
        handler: route.handler,
        middlewares: chain,
        router: this,
        ...(route.name ? { routeName: route.name } : {}),
      };
    }
    for (const child of this.children) {
      const includeFilter = (child as Router & { includeFilter?: Filter<AnyContext> })
        .includeFilter;
      if (includeFilter && !(await includeFilter(ctx))) continue;
      const found = await child.resolve(ctx, chain);
      if (found) return found;
    }
    return null;
  }

  /** Run this router's error handlers, then bubble up to the parent. */
  private async handleError(err: unknown, ctx: AnyContext): Promise<boolean> {
    for (const handler of this.errorHandlers) {
      const result = await handler(err, ctx);
      if (result === true) return true;
    }
    if (this.parent) return this.parent.handleError(err, ctx);
    return false;
  }
}

async function passesFilters(
  filters: Array<Filter<never>>,
  ctx: AnyContext,
): Promise<boolean> {
  for (const filter of filters) {
    const result = await (filter as unknown as (c: AnyContext) => boolean | Promise<boolean>)(ctx);
    if (!result) return false;
  }
  return true;
}

/** Run middleware onion-style with `handler` at the centre. */
export async function runChain(
  middlewares: Array<Middleware<never>>,
  ctx: AnyContext,
  handler: Handler<never>,
): Promise<void> {
  let index = -1;
  const dispatch = async (i: number): Promise<void> => {
    if (i <= index) throw new Error("next() was called more than once");
    index = i;
    if (i === middlewares.length) {
      await (handler as unknown as (c: AnyContext) => void | Promise<void>)(ctx);
      return;
    }
    const middleware = middlewares[i] as unknown as (
      c: AnyContext,
      next: () => Promise<void>,
    ) => void | Promise<void>;
    await middleware(ctx, () => dispatch(i + 1));
  };
  await dispatch(0);
}
