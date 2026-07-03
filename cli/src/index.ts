#!/usr/bin/env bun
// party — agentparty cli 入口，手写 argv 路由

const HELP = `party — agentparty cli

usage: party <command> [args]

commands:
  init      --server URL --token T [--channel C]   write config, bind channel (create if missing)
  send      [channel] <text|-> [--mention name]... [--reply-to seq]
  watch     [channel] [--timeout 240] [--mentions-only] [--follow]
  ask       [channel] <text|-> [--timeout 240] [--mention name]... [--mentions-only]
  status    [channel] working|waiting|blocked|done [-m note]
  history   [channel] [--since seq] [--limit n]
  channel   create <slug> [--title t] [--temp] [--party] | list | archive [slug] | reset-guard [slug]
  invite    "<title>" [--slug s] [--temp] [--party] [--guest-name bob]   (ADMIN_SECRET env)
  webhook   add <channel> --name n --url URL --secret S [--filter mentions|all] | remove <channel> --name n | list <channel>
  token     create --name n --role agent|human|readonly | revoke <name>   (ADMIN_SECRET env)

exit codes: 0 ok/new message · 2 watch timeout (prints TIMEOUT) · 3 bad token · 4 loop guard · 5 archived`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case "init":
      return (await import("./commands/init")).run(rest);
    case "send":
      return (await import("./commands/send")).run(rest);
    case "watch":
      return (await import("./commands/watch")).run(rest);
    case "ask":
      return (await import("./commands/ask")).run(rest);
    case "status":
      return (await import("./commands/status")).run(rest);
    case "history":
      return (await import("./commands/history")).run(rest);
    case "channel":
      return (await import("./commands/channel")).run(rest);
    case "invite":
      return (await import("./commands/invite")).run(rest);
    case "webhook":
      return (await import("./commands/webhook")).run(rest);
    case "token":
      return (await import("./commands/token")).run(rest);
    default:
      console.error(`unknown command: ${cmd}`);
      console.log(HELP);
      return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
