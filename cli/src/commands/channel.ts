// party channel create|list|archive|reset-guard
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import {
  createJoinLink,
  archiveChannel,
  clearChannelRole,
  createChannel,
  handleRestError,
  kickParticipant,
  listChannelMembers,
  listChannelRoles,
  listChannels,
  removeChannelMember,
  resetGuard,
  revokeJoinLink,
  setChannelRole,
  setChannelVisibility,
  setCompletionGate,
} from "../rest";
import { isName, isSlug } from "../validation";

const CHANNEL_FLAGS = ["title", "temp", "party", "public", "policy", "confirm", "expires", "max-uses", "remove"];
const COLLAB_ROLES = ["host", "worker", "reviewer", "observer"] as const;
const COMPLETION_GATES = ["reviewer", "off"] as const;
const COMPLETION_REVIEW_POLICIES = ["sender", "owner"] as const;
const VISIBILITIES = ["public", "private"] as const;
const HELP = `usage: party channel create <slug> [--title t] [--temp] [--party] [--public]
       party channel list
       party channel archive [slug]
       party channel reset-guard [slug]
       party channel kick <name> [slug] [--remove]
       party channel gate reviewer|off [slug] [--policy sender|owner]
       party channel visibility <slug> public|private [--confirm]
       party channel members <slug>
       party channel join-link <slug> [--expires 7d] [--max-uses N]
       party channel join-link revoke <slug> <code>
       party channel leave <slug>
       party channel role list [slug]
       party channel role set <name> host|worker|reviewer|observer [slug]
       party channel role unset <name> [slug]

Manage channels.

Options:
  --title t   channel title when creating
  --temp      create a temporary channel
  --party     create a party-mode channel
  --public    create a public channel
  --policy p  completion review policy: sender or owner
  --confirm   confirm private-to-public visibility switch
  --remove    revoke the channel-scoped token and remove membership when kicking
  --expires d join-link expiry like 7d, 12h, 30m, 60s
  --max-uses n join-link redemption limit`;

function parseDurationSec(input: string | undefined): number | null | undefined {
  if (input === undefined) return undefined;
  const m = input.match(/^([1-9]\d*)([smhd])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

function parsePositiveIntFlag(input: string | undefined): number | null | undefined {
  if (input === undefined) return undefined;
  const n = Number(input);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party", "public", "confirm", "remove"] });
  const unknown = unknownFlagError(flags, CHANNEL_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["title", "policy", "expires", "max-uses"]);
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
          console.error("usage: party channel kick <name> [slug] [--remove]");
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
        const mode = flags.remove === true ? "remove" : "disconnect";
        await kickParticipant(cfg.server, cfg.token, slug, name, mode);
        console.log(mode === "remove" ? `removed ${name} from ${slug}` : `kicked ${name} from ${slug}`);
        return 0;
      }
      case "gate": {
        const gate = positionals[1];
        const slug = resolveChannel(positionals[2]);
        const policy = str(flags.policy);
        if (!gate || !slug) {
          console.error("usage: party channel gate reviewer|off [slug] [--policy sender|owner]");
          return 1;
        }
        if (!COMPLETION_GATES.includes(gate as (typeof COMPLETION_GATES)[number])) {
          console.error("gate must be reviewer or off");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        if (policy !== undefined && !COMPLETION_REVIEW_POLICIES.includes(policy as (typeof COMPLETION_REVIEW_POLICIES)[number])) {
          console.error("policy must be sender or owner");
          return 1;
        }
        const result = await setCompletionGate(cfg.server, cfg.token, slug, {
          gate: gate as (typeof COMPLETION_GATES)[number],
          ...(policy === undefined ? {} : { policy: policy as (typeof COMPLETION_REVIEW_POLICIES)[number] }),
        });
        console.log(`completion gate ${slug}: ${result.gate} policy=${result.policy}`);
        return 0;
      }
      case "visibility": {
        const first = positionals[1];
        const second = positionals[2];
        const slug = second === undefined ? resolveChannel(undefined) : first;
        const visibility = second === undefined ? first : second;
        if (!slug || !visibility) {
          console.error("usage: party channel visibility <slug> public|private [--confirm]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        if (!VISIBILITIES.includes(visibility as (typeof VISIBILITIES)[number])) {
          console.error("visibility must be public or private");
          return 1;
        }
        const result = await setChannelVisibility(cfg.server, cfg.token, slug, {
          visibility: visibility as (typeof VISIBILITIES)[number],
          ...(flags.confirm === true ? { confirm: true as const } : {}),
        });
        console.log(`visibility ${slug}: ${result.visibility}`);
        return 0;
      }
      case "members": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel members <slug>");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const members = await listChannelMembers(cfg.server, cfg.token, slug);
        for (const m of members) {
          console.log(`${m.account}\t${m.added_by}\t${new Date(m.added_at).toISOString()}`);
        }
        return 0;
      }
      case "join-link": {
        const actionOrSlug = positionals[1];
        if (actionOrSlug === "revoke") {
          const slug = positionals[2];
          const code = positionals[3];
          if (!slug || !code) {
            console.error("usage: party channel join-link revoke <slug> <code>");
            return 1;
          }
          if (!isSlug(slug)) {
            console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
            return 1;
          }
          await revokeJoinLink(cfg.server, cfg.token, slug, code);
          console.log(`revoked join link ${code} for ${slug}`);
          return 0;
        }
        const slug = actionOrSlug;
        if (!slug) {
          console.error("usage: party channel join-link <slug> [--expires 7d] [--max-uses N]");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        const expires = parseDurationSec(str(flags.expires));
        if (expires === null) {
          console.error("--expires must look like 7d, 12h, 30m, or 60s");
          return 1;
        }
        const maxUses = parsePositiveIntFlag(str(flags["max-uses"]));
        if (maxUses === null) {
          console.error("--max-uses must be a positive integer");
          return 1;
        }
        const link = await createJoinLink(cfg.server, cfg.token, slug, {
          ...(expires === undefined ? {} : { expires_in_sec: expires }),
          ...(maxUses === undefined ? {} : { max_uses: maxUses }),
        });
        console.log(link.url ?? `${cfg.server.replace(/\/+$/, "")}/join/${link.code}`);
        return 0;
      }
      case "leave": {
        const slug = resolveChannel(positionals[1]);
        if (!slug) {
          console.error("usage: party channel leave <slug>");
          return 1;
        }
        if (!isSlug(slug)) {
          console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
          return 1;
        }
        await removeChannelMember(cfg.server, cfg.token, slug, "me");
        console.log(`left ${slug}`);
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
        console.error("usage: party channel create|list|archive|reset-guard|kick|gate|visibility|members|join-link|leave|role");
        return 1;
    }
  } catch (e) {
    return handleRestError(e);
  }
}
