// party channel create|list|archive|reset-guard
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import {
  archiveChannel,
  clearChannelRole,
  createChannel,
  handleRestError,
  kickParticipant,
  listChannelRoles,
  listChannels,
  resetGuard,
  setChannelRole,
} from "../rest";
import { isName, isSlug } from "../validation";

const CHANNEL_FLAGS = ["title", "temp", "party", "public"];
const COLLAB_ROLES = ["host", "worker", "reviewer", "observer"] as const;
const HELP = `usage: party channel create <slug> [--title t] [--temp] [--party] [--public]
       party channel list
       party channel archive [slug]
       party channel reset-guard [slug]
       party channel kick <name> [slug]
       party channel role list [slug]
       party channel role set <name> host|worker|reviewer|observer [slug]
       party channel role unset <name> [slug]

Manage channels.

Options:
  --title t   channel title when creating
  --temp      create a temporary channel
  --party     create a party-mode channel
  --public    create a public channel`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party", "public"] });
  const unknown = unknownFlagError(flags, CHANNEL_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["title"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const sub = positionals[0];
  try {
    switch (sub) {
      case "create": {
        const slug = positionals[1];
        if (!slug) {
          console.error(
            "usage: party channel create <slug> [--title t] [--temp] [--party] [--public]",
          );
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await createChannel(cfg.server, cfg.token, {
          slug,
          title: str(flags.title),
          kind: flags.temp === true ? "temp" : "standing",
          mode: flags.party === true ? "party" : "normal",
          visibility: flags.public === true ? "public" : "private",
        });
        console.log(`created ${slug}`);
        return 0;
      }
      case "list": {
        const channels = await listChannels(cfg.server, cfg.token);
        for (const c of channels) {
          const state = c.archived_at ? "archived" : "active";
          const vis = c.visibility ?? "private";
          console.log(
            `${c.slug}\t${c.kind}\t${c.mode ?? "normal"}\t${vis}\t${state}\t${c.title ?? ""}`,
          );
        }
        return 0;
      }
      case "archive": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel archive [slug]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
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
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await resetGuard(cfg.server, cfg.token, slug);
        console.log(`guard reset ${slug}`);
        return 0;
      }
      case "kick": {
        const name = positionals[1];
        const slug = resolveChannel(positionals[2]);
        if (!name || !slug) {
          console.error("usage: party channel kick <name> [slug]");
          return 1;
        }
        if (!isName(name)) {
          console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await kickParticipant(cfg.server, cfg.token, slug, name);
        console.log(`kicked ${name} from ${slug}`);
        return 0;
      }
      case "role": {
        const action = positionals[1];
        if (action === "list") {
          const slug = resolveChannel(positionals[2]);
          if (!slug) {
            console.error("usage: party channel role list [slug]");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          const roles = await listChannelRoles(cfg.server, cfg.token, slug);
          for (const r of roles) {
            console.log(`${r.name}\t${r.role}\t${r.assigned_by}\t${new Date(r.assigned_at).toISOString()}`);
          }
          return 0;
        }
        if (action === "set") {
          const name = positionals[2];
          const role = positionals[3];
          const slug = resolveChannel(positionals[4]);
          if (!name || !role || !slug) {
            console.error("usage: party channel role set <name> host|worker|reviewer|observer [slug]");
            return 1;
          }
          if (!isName(name)) {
            console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
            return 1;
          }
          if (!COLLAB_ROLES.includes(role as (typeof COLLAB_ROLES)[number])) {
            console.error("role must be host, worker, reviewer, or observer");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          await setChannelRole(cfg.server, cfg.token, slug, name, role as (typeof COLLAB_ROLES)[number]);
          console.log(`assigned ${name} as ${role} in ${slug}`);
          return 0;
        }
        if (action === "unset") {
          const name = positionals[2];
          const slug = resolveChannel(positionals[3]);
          if (!name || !slug) {
            console.error("usage: party channel role unset <name> [slug]");
            return 1;
          }
          if (!isName(name)) {
            console.error("name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          await clearChannelRole(cfg.server, cfg.token, slug, name);
          console.log(`cleared role for ${name} in ${slug}`);
          return 0;
        }
        console.error("usage: party channel role list|set|unset");
        return 1;
      }
      default:
        console.error("usage: party channel create|list|archive|reset-guard|kick|role");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
