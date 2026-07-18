// party squad — channel-scoped mention groups.
import type { ChannelSquad } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { stripTerminalControls } from "../format";
import { resolveAuth } from "../oidc-cli";
import { createSquad, deleteSquad, handleRestError, listSquads, updateSquad } from "../rest";
import { isName, isSlug } from "../validation";

const FLAGS = ["channel", "member", "leader", "title", "desc", "description", "json"];
const HELP = `usage: party squad list [--channel C] [--json]
  party squad create <name> --member @agent... [--leader @agent] [--channel C] [--title t] [--desc text] [--json]
  party squad update <name> [--member @agent...] [--leader @agent|none] [--title t] [--desc text] [--channel C] [--json]
  party squad delete <name> [--channel C] [--json]

Create channel-scoped @squad mention groups. A squad can later be used as a
task assignee with --assignee-kind squad and appears in web @ suggestions.`;

function cleanName(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const name = raw.replace(/^@/, "");
  return isName(name) && name !== "system" ? name : null;
}

function membersFrom(value: string | boolean | Array<string | boolean> | undefined): string[] | null | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const members: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const name = cleanName(item);
    if (name === null) return null;
    if (!members.includes(name)) members.push(name);
  }
  return members;
}

function leaderFrom(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "none" || raw === "null" || raw === "") return null;
  return cleanName(raw);
}

export function formatSquad(squad: ChannelSquad): string {
  const leader = squad.leader === null ? "" : ` leader:@${squad.leader}`;
  const title = squad.title === null ? "" : ` ${squad.title}`;
  // #629：name/leader/members/title 都是服务端存的参与者可控自由文本，整行剥离终端控制序列后再打印。
  return stripTerminalControls(`@${squad.name}\t${squad.members.length} members${leader}\t${squad.members.map((m) => `@${m}`).join(",")}${title}`);
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"], repeatable: ["member"] });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "leader", "title", "desc", "description"], ["member"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const slug = resolveChannel(str(flags.channel));
  if (!slug) {
    console.error("channel required: pass --channel C or run party init --channel C");
    return 1;
  }
  if (!isSlug(slug)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  const sub = positionals[0] ?? "list";
  try {
    if (sub === "list") {
      const squads = await listSquads(cfg.server, cfg.token, slug);
      for (const squad of squads) {
        console.log(flags.json === true ? JSON.stringify(squad) : formatSquad(squad));
      }
      return 0;
    }

    const name = cleanName(positionals[1]);
    if (name === null) {
      console.error("squad name required");
      return 1;
    }

    if (sub === "create") {
      const members = membersFrom(flags.member);
      if (members === undefined || members === null || members.length === 0) {
        console.error("party squad create requires --member @name at least once");
        return 1;
      }
      const leader = leaderFrom(str(flags.leader));
      if (leader === null && flags.leader !== undefined) {
        console.error("--leader must be @name");
        return 1;
      }
      const squad = await createSquad(cfg.server, cfg.token, slug, {
        name,
        members,
        ...(leader !== undefined ? { leader } : {}),
        ...(str(flags.title) !== undefined ? { title: str(flags.title) } : {}),
        ...(str(flags.desc) ?? str(flags.description) ? { description: str(flags.desc) ?? str(flags.description) } : {}),
      });
      console.log(flags.json === true ? JSON.stringify(squad) : `created ${formatSquad(squad)}`);
      return 0;
    }

    if (sub === "update") {
      const members = membersFrom(flags.member);
      if (members === null) {
        console.error("--member must be a valid @name");
        return 1;
      }
      const leader = leaderFrom(str(flags.leader));
      if (leader === null && flags.leader !== undefined && str(flags.leader) !== "none" && str(flags.leader) !== "null" && str(flags.leader) !== "") {
        console.error("--leader must be @name or none");
        return 1;
      }
      const body: {
        title?: string | null;
        description?: string | null;
        leader?: string | null;
        members?: string[];
      } = {};
      if (members !== undefined) body.members = members;
      if (leader !== undefined) body.leader = leader;
      if (str(flags.title) !== undefined) body.title = str(flags.title) === "" ? null : str(flags.title);
      const desc = str(flags.desc) ?? str(flags.description);
      if (desc !== undefined) body.description = desc === "" ? null : desc;
      if (Object.keys(body).length === 0) {
        console.error("party squad update needs at least one field");
        return 1;
      }
      const squad = await updateSquad(cfg.server, cfg.token, slug, name, body);
      console.log(flags.json === true ? JSON.stringify(squad) : `updated ${formatSquad(squad)}`);
      return 0;
    }

    if (sub === "delete" || sub === "remove") {
      const deleted = await deleteSquad(cfg.server, cfg.token, slug, name);
      console.log(flags.json === true ? JSON.stringify(deleted) : `deleted @${deleted.squad.name}`);
      return 0;
    }

    console.error("usage: party squad list|create|update|delete");
    return 1;
  } catch (e) {
    return handleRestError(e);
  }
}
