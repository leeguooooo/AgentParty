// party statusline — compact, prompt-safe identity segment for Codex/Claude/tmux/etc.
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig, resolveChannel, refreshConfigInPlace, type CachedIdentity } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, listTasks, type Identity } from "../rest";
import { cachedIdentity, readStatuslineCache, statuslineIdentity, writeStatuslineCache } from "../statusline-cache";
import { isSlug } from "../validation";

const STATUSLINE_FLAGS = ["channel", "refresh", "no-network"];
const HELP = `usage: party statusline [--channel C] [--refresh] [--no-network]

Print a compact AgentParty identity segment for prompt/status-line integrations.

Options:
  --channel C    show channel C instead of the bound channel
  --refresh      verify /api/me and update the local cached identity
  --no-network   only use the local identity cache`;

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

async function fetchMineTaskCountsWithTimeout(
  server: string,
  token: string,
  channel: string,
  name: string,
  ms = 900,
): Promise<{ mine_active: number; mine_total: number } | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const tasks = await Promise.race([
      listTasks(server, token, channel, { assignee: name, limit: 200 }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    if (tasks === null) return null;
    const activeStates = new Set(["assigned", "in_progress", "needs_review", "blocked"]);
    return {
      mine_active: tasks.filter((task) => activeStates.has(task.state)).length,
      mine_total: tasks.length,
    };
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
        // statusline 在后台定时跑，绝不能顺手换掉全局回落身份（#104）
        if (local?.token) refreshConfigInPlace({ ...local, identity: cachedIdentity(me) });
        writeStatuslineCache({
          ...(channel === null ? {} : { channel }),
          server: auth.server,
          identity: statuslineIdentity(me),
        });
      }
    }
  }

  if (identity === null) return 0;
  const statuslineCache = readStatuslineCache();
  let taskCounts = statuslineCache?.channel === channel ? statuslineCache.tasks ?? null : null;
  if (flags["no-network"] !== true && channel !== null) {
    const auth = await resolveAuthDetailed();
    if (auth.server && auth.token) {
      taskCounts = await fetchMineTaskCountsWithTimeout(auth.server, auth.token, channel, identity.name);
      if (taskCounts !== null) {
        writeStatuslineCache({
          channel,
          server: auth.server,
          identity: statuslineIdentity(identity),
          tasks: taskCounts,
        });
      }
    }
  }
  const parts = [`ap:${identityLabel(identity)}`];
  if (channel !== null) parts.push(`#${channel}`);
  if (taskCounts !== null && taskCounts.mine_active > 0) parts.push(`tasks:${taskCounts.mine_active}`);
  console.log(parts.join(" "));
  return 0;
}
