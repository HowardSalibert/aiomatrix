# Live homeserver tests

Megolm round-trip, cold start, revoked-token → `onFatal`, refresh_token exchange, and mid-run
password re-login against a real Synapse.

## CI

The `live` job in `.github/workflows/ci.yml` runs `npm run test:live:ci` on Ubuntu
(Docker Synapse + Node 24). Suites share one bot/peer session storage and Synapse
login rate limits are relaxed for the ephemeral homeserver.

## Local

```bash
npm run build
npm run test:live:ci
```

Or point at an existing HS:

```bash
export MATRIX_HS_URL=http://127.0.0.1:8008
export MATRIX_BOT_USER='@livebot:localhost'
export MATRIX_BOT_PASSWORD='…'
export MATRIX_PEER_USER='@livepeer:localhost'
export MATRIX_PEER_PASSWORD='…'
npm run test:live
```

Unit tests (`npm test`) do not start Docker. Live files under `test/live/` are
skipped unless the env vars above are set.
