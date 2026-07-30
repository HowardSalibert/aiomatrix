import { createContext, detectDirectRoom } from "./context.js";
import { MemoryStorage, type Storage } from "./fsm.js";
import { compose } from "./middleware.js";
import type { Router } from "./router.js";
import type { Bot } from "./bot.js";
import type { DispatcherOptions, MatrixMessageEvent, Middleware } from "./types.js";

/**
 * Middleware stack + router includes. Wired from Bot room message listener.
 */
export class Dispatcher {
  readonly storage: Storage;
  private readonly middlewares: Middleware[] = [];
  private readonly routers: Router[] = [];

  constructor(options: DispatcherOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
  }

  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  include(router: Router): this {
    this.routers.push(router);
    return this;
  }

  async feed(bot: Bot, roomId: string, event: MatrixMessageEvent): Promise<void> {
    if (!event.content?.msgtype) return;

    const selfId = await bot.client.getUserId();
    // Ignore own messages (incl. m.notice echoes and unsigned.transaction_id echoes)
    if (event.sender === selfId) return;

    const isDirect = await detectDirectRoom(bot.client, roomId, event.sender ?? "");
    const ctx = createContext({
      bot,
      client: bot.client,
      storage: this.storage,
      roomId,
      event,
      isDirect,
    });

    const runRouters = async (): Promise<void> => {
      for (const router of this.routers) {
        // eslint-disable-next-line no-await-in-loop
        if (await router.feed(ctx)) return;
      }
    };

    const run = compose(this.middlewares);
    await run(ctx, runRouters);
  }
}
