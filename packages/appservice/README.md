# Application Service

Matrix Application Service (AS API) for any homeserver that supports it
(Synapse, Dendrite, Conduit, …).

Canonical package: [FakeHoward/aiomatrix-appservice](https://github.com/FakeHoward/aiomatrix-appservice).

```bash
npm install aiomatrix-appservice
npx aiomatrix-appservice register --id aio --url http://127.0.0.1:8090 --localpart bot
npx aiomatrix-appservice serve --hs-token … --as-token … --hs-url https://matrix.example.org
```

See that repo for architecture, homeserver setup, and wiring with aiomatrix.
