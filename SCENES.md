# Scenes / FSM cookbook

Patterns for multi-step dialogs on top of aiomatrix.

## 1. `waitFor` (lightest)

```ts
dp.message(Command("name"), async (ctx) => {
  await ctx.answer("What is your name?");
  const reply = await ctx.waitFor(
    (u) => u.updateType === "message" && Boolean(u.text),
    { timeoutMs: 60_000 },
  );
  await ctx.answer(`Hi, ${reply.text}`);
});
```

## 2. `Conversation` helper

```ts
import { createConversation, F } from "aiomatrix";

const onboard = createConversation({ timeoutMs: 60_000 });

dp.message(Command("start"), async (ctx) => {
  await onboard.run(ctx, [
    {
      prompt: (c) => c.answer("Name?"),
      filter: F.text,
      handle: async (c, data) => {
        data.name = c.text;
      },
    },
  ]);
});
```

## 3. FSM states

```ts
import { createStates, inStateGroup } from "aiomatrix";

const Form = createStates("Form", ["name", "age"]);

dp.message(Command("form"), async (ctx) => {
  await ctx.state.setState(Form.name);
  await ctx.answer("Name?");
});

dp.message(and(F.text, inStateGroup(Form)), async (ctx) => {
  if (ctx.state.current === Form.name) {
    await ctx.state.setData({ name: ctx.text });
    await ctx.state.setState(Form.age);
    await ctx.answer("Age?");
    return;
  }
  await ctx.state.clear();
  await ctx.answer("Done");
});
```

## Typed `ctx.data`

```ts
type Scratch = { attempts: number };
// middleware:
(ctx, next) => {
  (ctx.data as Scratch).attempts = 0;
  return next();
};
```

Prefer `BaseContext<"message", Scratch>` in your own handler typings.

## Cold start

Bootstrap sync never delivers history as `message` / `callback_query` updates.
See `COLD_START_DISPATCH` / `shouldDispatchOnColdStart` and `AWARE_HOST.md`.
