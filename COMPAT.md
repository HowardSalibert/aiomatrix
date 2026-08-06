# Compatibility matrix

Homeservers and clients against aiomatrix **0.8**.

## Homeservers (bot client API)

| Server | Sync / send | E2EE (native crypto) | Appservice AS API |
|---|---|---|---|
| Synapse | yes | yes | yes |
| Dendrite | yes | yes | yes |
| Conduit | yes | best-effort | yes |
| Grapevine / others with Client-Server + AS | yes | depends on crypto store | if AS implemented |

Crypto uses `@matrix-org/matrix-sdk-crypto-nodejs` (optional). Without it, set `crypto: false`.

## Host / client profiles

| Profile | Keyboard fallback | MiniApp lean | Toasts |
|---|---|---|---|
| `stock` | on (Element-safe) | off | notice fallback |
| `aware` | off | on | `dev.aiomatrix.*` events |
| `hybrid` | per-room via `dev.aiomatrix.host` | per-room | per-room |

## Schema

`AIOMATRIX_SCHEMA_VERSION` / `AIOMATRIX_SCHEMA` — see `AWARE_HOST.md` and `AWARE_CONTRACT`.

## Application Service (universal)

Not Synapse-only. TypeScript AS under `packages/appservice` (extract target:
FakeHoward/aiomatrix-appservice). Works with any HS that implements the Matrix
Application Service API. TDD via Node tests in CI (`npm run test:appservice`).
