// party webhook add|remove|list — 频道级 webhook 管理
import { parseArgs, str } from "../args";
import { readConfig, resolveChannel } from "../config";
import {
  addWebhook,
  handleRestError,
  listWebhooks,
  removeWebhook,
  type WebhookFilter,
} from "../rest";

const FILTERS: WebhookFilter[] = ["mentions", "all"];

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const cfg = readConfig();
  if (!cfg) {
    console.error("no config, run: party init --server URL --token T");
    return 1;
  }
  const sub = positionals[0];
  const channel = resolveChannel(positionals[1]);
  if (sub && !channel) {
    console.error("usage: party webhook add|remove|list <channel>");
    return 1;
  }
  try {
    switch (sub) {
      case "add": {
        const name = str(flags.name);
        const url = str(flags.url);
        const secret = str(flags.secret);
        const filter = str(flags.filter) ?? "mentions";
        if (!name || !url || !secret || !FILTERS.includes(filter as WebhookFilter)) {
          console.error(
            "usage: party webhook add <channel> --name n --url URL --secret S [--filter mentions|all]",
          );
          return 1;
        }
        await addWebhook(cfg.server, cfg.token, channel!, {
          name,
          url,
          secret,
          filter: filter as WebhookFilter,
        });
        console.log(`webhook ${name} added to ${channel} (filter: ${filter})`);
        return 0;
      }
      case "remove": {
        const name = str(flags.name);
        if (!name) {
          console.error("usage: party webhook remove <channel> --name n");
          return 1;
        }
        await removeWebhook(cfg.server, cfg.token, channel!, name);
        console.log(`webhook ${name} removed from ${channel}`);
        return 0;
      }
      case "list": {
        const webhooks = await listWebhooks(cfg.server, cfg.token, channel!);
        for (const w of webhooks) {
          console.log(`${w.name}\t${w.filter}\t${w.url}`);
        }
        return 0;
      }
      default:
        console.error("usage: party webhook add|remove|list <channel>");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
