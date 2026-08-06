# @aiomatrix/appservice

Universal **Matrix Application Service** in TypeScript for any homeserver that
implements the [Application Service API](https://spec.matrix.org/latest/application-service-api/)
(Synapse, Dendrite, Conduit, Grapevine, …).

This is **not** a Synapse Python module — Node/HTTP only, so it stays fast and
homeserver-agnostic.

Intended extract target: `FakeHoward/aiomatrix-appservice`. Lived here under
`packages/appservice` so CI can TDD without a second remote.

## Quick start

```bash
cd packages/appservice
npm install
npm test
npx aiomatrix-appservice register --id aio --url http://127.0.0.1:8090 --localpart bot
```

Point the homeserver at the generated registration (`as_token` / `hs_token`),
then:

```bash
npx aiomatrix-appservice serve --hs-token … --as-token … --hs-url https://matrix.example.org
```

## API

- `PUT /_matrix/app/v1/transactions/{txnId}` — HS push (idempotent)
- `GET /_matrix/app/v1/users/{userId}` — namespace claim
- `GET /_matrix/app/v1/rooms/{alias}` — alias claim
- `GET /health` — liveness
