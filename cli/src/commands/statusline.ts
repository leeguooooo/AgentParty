// party statusline — compact, prompt-safe identity segment for Codex/Claude/tmux/etc.
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig, resolveChannel, writeConfig, type CachedIdentity } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, type Identity } from "../rest";
import { isSlug } from "../validation";

const STATUSLINE_FLAGS = ["channel", "refresh", "no-network"];
const HELP = `usage: party statusline [--channel C] [--refresh] [--no-network]

Print a compact AgentParty identity segment for prompt/status-line integrations.

Options:
  --channel C    show channel C instead of the bound channel
  --refresh      verify /api/me and update the local cached identity
  --no-network   only use the local identity cache`;

function cacheIdentity(me: Identity): CachedIdentity {
  return {
    name: me.name,
    email: me.email,
    kind: me.kind,
    role: me.role,
    owner: me.owner,
    channel_scope: me.channel_scope ?? null,
    verified_at: Date.now(),
  };
}

function identityLabel(id: CachedIdentity | Identity): string {
  return id.kind === "agent" ? id.name : id.email ?? id.name;
}

async function fetchMeWithTimeout(server: string, token: string, ms = 900): Promise<Identity | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fetchMe(server, token),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { flags } = parseArgs(argv, { booleans: ["refresh", "no-network"] });
  const unknown = unknownFlagError(flags, STATUSLINE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel));
  if (channel !== null && !isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  const local = readConfig();
  let identity: CachedIdentity | Identity | null = local?.identity ?? null;
  const shouldRefresh = flags.refresh === true || (identity === null && flags["no-network"] !== true);
  if (shouldRefresh) {
    const auth = await resolveAuthDetailed();
    if (auth.server && auth.token) {
      const me = await fetchMeWithTimeout(auth.server, auth.token);
      if (me !== null) {
        identity = me;
        if (local?.token) writeConfig({ ...local, identity: cacheIdentity(me) });
      }
    }
  }

  if (identity === null) return 0;
  const parts = [`ap:${identityLabel(identity)}`];
  if (channel !== null) parts.push(`#${channel}`);
  console.log(parts.join(" "));
  return 0;
}
