import type { Context, FilterFn, Handler } from "./types.js";

interface Route {
  filters: FilterFn[];
  handler: Handler;
}

/**
 * Aiogram-like router: first matching route wins within this router.
 * Nested routers via include().
 */
export class Router {
  readonly name: string;
  private readonly routes: Route[] = [];
  private readonly children: Router[] = [];

  constructor(name = "main") {
    this.name = name;
  }

  /**
   * Register a message handler. Last argument is the handler; preceding are filters
   * (including StateRef from createStates).
   */
  message(...args: [...FilterFn[], Handler]): this {
    if (args.length < 1) {
      throw new Error("Router.message requires a handler");
    }
    const handler = args[args.length - 1] as Handler;
    const filters = args.slice(0, -1) as FilterFn[];
    this.routes.push({ filters, handler });
    return this;
  }

  include(router: Router): this {
    this.children.push(router);
    return this;
  }

  /**
   * Try to handle ctx. Returns true if a route matched and ran.
   */
  async feed(ctx: Context): Promise<boolean> {
    for (const route of this.routes) {
      let ok = true;
      for (const filter of route.filters) {
        // eslint-disable-next-line no-await-in-loop
        const result = await filter(ctx);
        if (!result) {
          ok = false;
          break;
        }
      }
      if (ok) {
        await route.handler(ctx);
        return true;
      }
    }

    for (const child of this.children) {
      // eslint-disable-next-line no-await-in-loop
      if (await child.feed(ctx)) return true;
    }
    return false;
  }
}
