# Compatibility matrix

Homeservers and clients against aiomatrix **0.8**.

## Homeservers (bot client API)

| Server | Sync / send | E2EE (native crypto) | Appservice AS API |
|---|---|---|---|
| Synapse | yes | yes | yes |
| Dendrite | yes | yes | yes |
| Conduit | yes | best-effort | yes |
| Others with Client-Server + AS | yes | depends on crypto store | if AS implemented |

Crypto: `@matrix-org/matrix-sdk-crypto-nodejs` (optional). Without it, `crypto: false`.

## Host / client profiles

| Profile | Keyboard fallback | MiniApp lean | Toasts |
|---|---|---|---|
| `stock` | on | off | notice fallback |
| `aware` | off | on | `dev.aiomatrix.*` events |
| `hybrid` | per-room via `dev.aiomatrix.host` | per-room | per-room |

## Schema

`AIOMATRIX_SCHEMA_VERSION` / `AIOMATRIX_SCHEMA` — see `AWARE_HOST.md` and `AWARE_CONTRACT`.

## Application Service

Separate package: [aiomatrix-appservice](https://github.com/FakeHoward/aiomatrix-appservice).
Any homeserver with the Matrix Application Service API.
