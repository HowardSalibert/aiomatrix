import type { CommandSpec } from "./commands.js";
import { HandlerTimeoutError } from "./errors.js";
import { MemoryStorage, type Storage } from "./fsm.js";
import { Router, runChain } from "./router.js";
import type {
  AnyContext,
  DispatcherOptions,
  ErrorHandler,
  Handler,
  Middleware,
  UpdateType,
} from "./types.js";

export interface DispatcherStats {
  /** Updates accepted for dispatch. */
  received: number;
  /** Updates a handler actually ran for. */
  handled: number;
  /** Updates no route matched. */
  unhandled: number;
  /** Handler errors, including those swallowed by error handlers. */
  errors: number;
  /** Handlers abandoned by `handlerTimeoutMs`. */
  timeouts: number;
}

/**
 * Root of the update pipeline.
 *
 * Outer middleware registered here runs for *every* update, matched or not,
 * which is what makes global logging, metrics and throttling possible. Routers
 * hold the handlers and their own (inner) middleware.
 */
export class Dispatcher {
  readonly storage: Storage;
  /** Implicit root router, so `dp.message(...)` works without a Router. */
  readonly router: Router;
  private readonly outerMiddlewares: Array<Middleware<never>> = [];
  private readonly routers: Router[] = [];
  private readonly errorHandlers: ErrorHandler[] = [];
  private readonly stats: DispatcherStats = {
    received: 0,
    handled: 0,
    unhandled: 0,
    errors: 0,
    timeouts: 0,
  };
  private unhandledHandler: ((ctx: AnyContext) => void | Promise<void>) | null = null;
  private handlerTimeoutMs = 0;
  private onTimeout: ((ctx: AnyContext, err: HandlerTimeoutError) => void) | null = null;

  constructor(options: DispatcherOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.router = new Router("root");
    this.routers.push(this.router);
  }

  /** Abandon handlers that run longer than `ms` (0 disables). */
  setHandlerTimeout(ms: number): this {
    this.handlerTimeoutMs = Math.max(0, ms);
    return this;
  }

  /** Called when a handler is abandoned by {@link setHandlerTimeout} (before error handlers). */
  setOnTimeout(handler: (ctx: AnyContext, err: HandlerTimeoutError) => void): this {
    this.onTimeout = handler;
    return this;
  }

  /** Outer middleware: runs for every update before routing. */
  use<C extends AnyContext = AnyContext>(middleware: Middleware<C>): this {
    this.outerMiddlewares.push(middleware as unknown as Middleware<never>);
    return this;
  }

  include(router: Router): this {
    this.routers.push(router);
    return this;
  }

  /** Global error handler. Return `true` to mark the error handled. */
  errors(handler: ErrorHandler): this {
    this.errorHandlers.push(handler);
    return this;
  }

  /** Called when no route matched — useful for a fallback reply. */
  fallback(handler: (ctx: AnyContext) => void | Promise<void>): this {
    this.unhandledHandler = handler;
    return this;
  }

  getStats(): DispatcherStats {
    return { ...this.stats };
  }

  /** Command specs declared by `Command(...)` filters across every router. */
  get commandSpecs(): CommandSpec[] {
    const seen = new Map<string, CommandSpec>();
    for (const router of this.routers) {
      for (const spec of router.commandSpecs) {
        if (!seen.has(spec.name)) seen.set(spec.name, spec);
      }
    }
    return [...seen.values()];
  }

  // Convenience proxies to the implicit root router. -------------------------

  message(...args: Parameters<Router["message"]>): this {
    this.router.message(...args);
    return this;
  }

  editedMessage(...args: Parameters<Router["editedMessage"]>): this {
    this.router.editedMessage(...args);
    return this;
  }

  callbackQuery(...args: Parameters<Router["callbackQuery"]>): this {
    this.router.callbackQuery(...args);
    return this;
  }

  miniAppData(...args: Parameters<Router["miniAppData"]>): this {
    this.router.miniAppData(...args);
    return this;
  }

  reaction(...args: Parameters<Router["reaction"]>): this {
    this.router.reaction(...args);
    return this;
  }

  membership(...args: Parameters<Router["membership"]>): this {
    this.router.membership(...args);
    return this;
  }

  invite(...args: Parameters<Router["invite"]>): this {
    this.router.invite(...args);
    return this;
  }

  ephemeral(...args: Parameters<Router["ephemeral"]>): this {
    this.router.ephemeral(...args);
    return this;
  }

  on(type: UpdateType | UpdateType[] | null, ...args: Array<Function>): this {
    (this.router.on as unknown as (t: unknown, ...rest: unknown[]) => void)(type, ...args);
    return this;
  }

  // ------------------------------------------------------------------ feed

  /** Push a context through outer middleware and the router tree. */
  async feed(ctx: AnyContext): Promise<boolean> {
    this.stats.received += 1;
    let handled = false;
    const abort = new AbortController();
    ctx.abortController = abort;

    const routeUpdate: Handler<never> = (async () => {
      for (const router of this.routers) {
        if (abort.signal.aborted) return;
        if (await router.feed(ctx)) {
          handled = true;
          return;
        }
      }
      if (this.unhandledHandler) await this.unhandledHandler(ctx);
    }) as unknown as Handler<never>;

    try {
      const run = (): Promise<void> => runChain(this.outerMiddlewares, ctx, routeUpdate);
      if (this.handlerTimeoutMs > 0) {
        await this.withTimeout(run(), ctx, abort);
      } else {
        await run();
      }
    } catch (err) {
      abort.abort(err);
      this.stats.errors += 1;
      if (err instanceof HandlerTimeoutError) {
        this.stats.timeouts += 1;
        try {
          this.onTimeout?.(ctx, err);
        } catch {
          // Metrics / hooks must not mask the original error.
        }
      }
      const wasHandled = await this.runErrorHandlers(err, ctx);
      if (!wasHandled) throw err;
    }

    if (handled) this.stats.handled += 1;
    else this.stats.unhandled += 1;
    return handled;
  }

  private async withTimeout(
    promise: Promise<void>,
    ctx: AnyContext,
    abort: AbortController,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new HandlerTimeoutError(
          this.handlerTimeoutMs,
          `${ctx.updateType} in ${ctx.roomId || "(no room)"}`,
        );
        abort.abort(err);
        reject(err);
      }, this.handlerTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runErrorHandlers(err: unknown, ctx: AnyContext | null): Promise<boolean> {
    for (const handler of this.errorHandlers) {
      try {
        if ((await handler(err, ctx)) === true) return true;
      } catch {
        // An error handler that throws must not mask the original error.
      }
    }
    return false;
  }

  /** Release resources held by the FSM storage. */
  async close(): Promise<void> {
    await this.storage.close?.();
  }
}
