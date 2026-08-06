#!/usr/bin/env node
import {
  Appservice,
  buildRegistration,
  generateAppserviceToken,
  registrationToYaml,
} from "./index.js";

function usage(): never {
  console.log(`Usage:
  aiomatrix-appservice register --id <id> --url <url> --localpart <bot>
  aiomatrix-appservice serve --hs-token <t> --as-token <t> --hs-url <url> [--port 8090]

Universal Application Service for any Matrix homeserver (AS API).
Not Synapse-specific. See packages/appservice/README.md.
`);
  process.exit(2);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  const pref = `${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  return hit?.slice(pref.length);
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help") usage();

  if (cmd === "register") {
    const id = arg(argv, "--id") ?? "aiomatrix";
    const url = arg(argv, "--url") ?? "http://127.0.0.1:8090";
    const localpart = arg(argv, "--localpart") ?? "bot";
    const asToken = arg(argv, "--as-token") ?? generateAppserviceToken(`as:${id}`);
    const hsToken = arg(argv, "--hs-token") ?? generateAppserviceToken(`hs:${id}`);
    const reg = buildRegistration({
      id,
      url,
      asToken,
      hsToken,
      senderLocalpart: localpart,
    });
    process.stdout.write(registrationToYaml(reg));
    return;
  }

  if (cmd === "serve") {
    const hsToken = arg(argv, "--hs-token");
    const asToken = arg(argv, "--as-token");
    const homeserverUrl = arg(argv, "--hs-url");
    if (!hsToken || !asToken || !homeserverUrl) usage();
    const port = Number(arg(argv, "--port") ?? "8090");
    const as = new Appservice({
      hsToken: hsToken!,
      asToken: asToken!,
      homeserverUrl: homeserverUrl!,
      port,
      logger: console,
      handlers: {
        onTransaction: async (txnId, events) => {
          console.log(`txn ${txnId}: ${events.length} event(s)`);
        },
      },
    });
    await as.listen();
    return;
  }

  usage();
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
