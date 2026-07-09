// party spawn <worker> — front agent creates a short-lived channel-scoped worker identity
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveAuthDetailed } from "../oidc-cli";
import { handleRestError, RestError, spawnAgent } from "../rest";
import { isName, isSlug } from "../validation";

const SPAWN_FLAGS = ["channel-scope", "ttl", "team-id"];
const HELP = `usage: party spawn <worker> --channel-scope slug [--ttl 2h] [--team-id id]

Create a short-lived worker agent token from the current front/runtime identity.

Options:
  --channel-scope slug   required channel scope for the worker
  --ttl 2h               worker lifetime: seconds, 30m, 2h, 1d (default server TTL)
  --team-id id           lineage team id for grouping with the front agent (defaults to parent agent)`;

function parseTtl(input: string | undefined): number | string | undefined {
  if (input === undefined) return undefined;
  const m = /^([1-9]\d*)([smhd]?)$/.exec(input);
  if (!m) return "--ttl must be seconds or use suffix s|m|h|d";
  const n = Number(m[1]);
  const unit = m[2] || "s";
  const mult = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return n * mult;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv);
  const unknown = unknownFlagError(flags, SPAWN_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel-scope", "ttl", "team-id"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const name = positionals[0];
  if (!name || positionals.length !== 1 || !isName(name)) {
    console.error("usage: party spawn <worker> --channel-scope slug [--ttl 2h] [--team-id id]");
    return 1;
  }
  const channelScope = str(flags["channel-scope"]);
  if (!channelScope || !isSlug(channelScope)) {
    console.error("--channel-scope must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const ttl = parseTtl(str(flags.ttl));
  if (typeof ttl === "string") {
    console.error(ttl);
    return 1;
  }
  const teamId = str(flags["team-id"]);
  if (teamId !== undefined && !isName(teamId)) {
    console.error("--team-id must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  let auth;
  try {
    auth = await resolveAuthDetailed();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (!auth.server || !auth.token) {
    console.error("no config, run: party init --server URL --token T");
    return 1;
  }
  try {
    const res = await spawnAgent(auth.server, auth.token, name, channelScope, { ttlSec: ttl, teamId });
    console.log(JSON.stringify(res));
    console.error(`give it to the worker: party init --server ${auth.server} --token ${res.token} --channel ${res.channel_scope}`);
    return 0;
  } catch (e) {
    if (e instanceof RestError && (e.status === 401 || e.status === 403)) {
      console.error("spawn requires a channel-scoped parent agent token with spawn permission");
      return 1;
    }
    return handleRestError(e);
  }
}
