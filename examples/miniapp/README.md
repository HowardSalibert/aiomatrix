# MiniApp example

A single process that runs the bot, the mini app page, and the MiniApp backend, so you can see the
whole round trip without any infrastructure.

```bash
cp .env.example .env   # fill in MATRIX_HS_URL, MATRIX_USER_ID, MATRIX_PASSWORD
npm install
npm start
```

Then say `/order` to the bot in any room. The bot posts a launch card; opening it runs
`src/page.ts` in the browser, which:

1. reads the signed `initData` from the URL fragment,
2. `POST /api/miniapp/auth` to have the backend verify it and mint a session token,
3. `POST /api/miniapp/data` with the order, which the bot receives as a `mini_app_data` update,
4. gets an acknowledgement message back in the room.

`/link` returns the raw signed URL, useful for inspecting the fragment.

## What runs where

| File | Role |
|---|---|
| `src/main.ts` | Bot, HTTP server, `MiniAppServer` wiring |
| `src/page.ts` | The mini app page (inlined HTML, no build step) |

## Notes for a real deployment

- Serve the page over **https**. Only `localhost` may use http; the launch URL is validated.
- Set `MINIAPP_SECRET` from your secret store and give the same value to every backend instance.
  Without it, each bot process generates its own into `data/miniapp.json`, which breaks as soon as you
  run more than one.
- Keep `allowedOrigins` tight: the bot refuses to sign a launch for an origin outside it.
- Put the mini app on its own origin, separate from anything holding user sessions. The fragment is
  visible to every script on the page.
- The example sends the payload over both HTTP and `postMessage`; pick whichever your client supports
  and drop the other.
- For clients that embed apps inline, pin a widget instead of posting a card:

```ts
await bot.pinMiniAppWidget(roomId, {
  widgetId: "order",
  url: `${publicUrl}/app`,
  name: "Order form",
});
```

See [../../MINIAPP.md](../../MINIAPP.md) for the protocol and security model.
