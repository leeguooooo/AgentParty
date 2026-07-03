// party channel create|list|archive|reset-guard
import { parseArgs, str } from "../args";
import { readConfig, resolveChannel } from "../config";
import {
  archiveChannel,
  createChannel,
  handleRestError,
  listChannels,
  resetGuard,
} from "../rest";

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party"] });
  const cfg = readConfig();
  if (!cfg) {
    console.error("no config, run: party init --server URL --token T");
    return 1;
  }
  const sub = positionals[0];
  try {
    switch (sub) {
      case "create": {
        const slug = positionals[1];
        if (!slug) {
          console.error("usage: party channel create <slug> [--title t] [--temp] [--party]");
          return 1;
        }
        await createChannel(cfg.server, cfg.token, {
          slug,
          title: str(flags.title),
          kind: flags.temp === true ? "temp" : "standing",
          mode: flags.party === true ? "party" : "normal",
        });
        console.log(`created ${slug}`);
        return 0;
      }
      case "list": {
        const channels = await listChannels(cfg.server, cfg.token);
        for (const c of channels) {
          const state = c.archived_at ? "archived" : "active";
          console.log(`${c.slug}\t${c.kind}\t${c.mode ?? "normal"}\t${state}\t${c.title ?? ""}`);
        }
        return 0;
      }
      case "archive": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel archive [slug]");
          return 1;
        }
        await archiveChannel(cfg.server, cfg.token, slug);
        console.log(`archived ${slug}`);
        return 0;
      }
      case "reset-guard": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel reset-guard [slug]");
          return 1;
        }
        await resetGuard(cfg.server, cfg.token, slug);
        console.log(`guard reset ${slug}`);
        return 0;
      }
      default:
        console.error("usage: party channel create|list|archive|reset-guard");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
