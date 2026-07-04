// party search — server-side retained-history search with sender/time filters.
import type { SearchHit } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { handleRestError, searchMessages } from "../rest";
import { isName, isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const SEARCH_FLAGS = ["channel", "from", "since", "limit", "json"];
const HELP = `usage: party search <query> [--channel C] [--from agent] [--since seq] [--limit n] [--json]

Search retained server history for messages whose body/note or sender contains <query> (case-insensitive).

Options:
  --channel C   search channel C instead of the bound channel
  --from name   only return hits from sender name
  --since seq   only search messages after seq
  --limit n     max hits to return (default 100, max 1000)
  --json        emit search_hit agentparty.v1 NDJSON frames`;

function formatHit(hit: SearchHit): string {
  const prefix = hit.kind === "status" ? `#${hit.seq} ${hit.sender.name} status` : `#${hit.seq} ${hit.sender.name}`;
  return `${prefix} [${hit.match_field}] ${hit.snippet}`;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, SEARCH_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "from", "since", "limit"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }

  const query = positionals.join(" ").trim();
  if (!query) {
    console.error("need a query: party search <query> [--channel C]");
    return 1;
  }

  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 1000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const since = parseNonNegativeIntFlag(str(flags.since), "since");
  if (typeof since === "string") {
    console.error(since);
    return 1;
  }
  const from = str(flags.from);
  if (from !== undefined && !isName(from)) {
    console.error("--from must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }

  const channel = resolveChannel(str(flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  try {
    const hits = await searchMessages(cfg.server, cfg.token, channel, {
      query,
      since: since ?? 0,
      limit: limit ?? 100,
      ...(from !== undefined ? { from } : {}),
    });
    for (const hit of hits) {
      console.log(
        flags.json === true
          ? JSON.stringify(jsonFrame(hit as unknown as Record<string, unknown>))
          : formatHit(hit),
      );
    }
    if (flags.json !== true && hits.length === 0) {
      console.error(`no matches for "${query}" in #${channel}`);
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
