# Security

## Report a vulnerability

Use [GitHub Private Vulnerability Reporting](https://github.com/HowardSalibert/aiomatrix/security/advisories/new)
on this repository. Do not open a public issue for an exploitable bug.

Include: affected version, reproduction steps, impact (what an attacker gains).
Patches or PoCs help; keep PoCs minimal.

We aim to acknowledge within a few days and ship a fix or mitigation before any
advisory is published.

## Scope

In scope for this library:

- E2EE send/receive path (`CryptoEngine`, share policy, plaintext refusal)
- MiniApp `initData` HMAC, session tokens, launch replay
- Inline callback token minting / room binding
- HTML sanitization helpers and documented trust boundaries
- Credential handling in `storagePath` and HTTP auth errors

Out of scope:

- Homeserver bugs (Synapse, Dendrite, …)
- Matrix clients embedding MiniApps
- Deployments that share one crypto store across processes
- Issues that require disabling documented safeguards (`allowInsecureHomeserver`, empty `cryptoStorePassphrase`, `singleUseLaunch: false` without a shared nonce store)

## Hardening history

Internal review notes: [AUDIT.md](./AUDIT.md).

## Dependency advisories

CI runs `npm audit --omit=dev --audit-level=high`. Optional native crypto
bindings (`@matrix-org/matrix-sdk-crypto-nodejs`) are included when present.
