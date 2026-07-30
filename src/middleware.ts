import type { Context, Middleware } from "./types.js";

/**
 * Compose middleware stack (onion model). Final `next` runs the handler chain.
 */
export function compose(middlewares: Middleware[]): (
  ctx: Context,
  final: () => Promise<void>,
) => Promise<void> {
  return async (ctx, final) => {
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      const fn = i === middlewares.length ? final : middlewares[i];
      if (!fn) return;
      if (i === middlewares.length) {
        await final();
        return;
      }
      await middlewares[i]!(ctx, () => dispatch(i + 1));
    };
    await dispatch(0);
  };
}
