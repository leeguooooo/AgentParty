import { spawnSync } from "node:child_process";
import { isHelpArg } from "../args";
import { isSlug } from "../validation";
import {
  inspectClaudePluginReadiness,
  type ClaudePluginDoctorBlocker,
  type ClaudePluginDoctorReport,
} from "./doctor";

export const CLAUDE_CHANNEL_PLUGIN = "plugin:agentparty@agentparty";
export const CLAUDE_CHANNEL_OPT_IN_ENV = "AGENTPARTY_CLAUDE_CHANNEL_OPT_IN";
/**
 * Authorizes the Marketplace lifecycle hooks to publish activity and guard a
 * delivered execution. Kept separate from the Channel opt-in because
 * `party bridge claude` supplies its own Channel MCP and must not wake the
 * plugin Channel MCP as a second listener.
 */
export const CLAUDE_LIFECYCLE_OPT_IN_ENV = "AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN";

const HELP = `usage: party claude [channel] [-- <claude args...>]

Start Claude Code with the AgentParty Marketplace Channel explicitly armed.
Before launch, require the enabled plugin, an agent token, channel access, and
no existing durable listener. Claude Cross-session uses party bridge claude
instead; do not stack the two launch paths.`;

export interface ClaudeLaunchResult {
  status: number | null;
  error?: Error;
}

export interface ClaudeLaunchDependencies {
  preflight(channel: string | undefined): Promise<{
    blockers: ClaudePluginDoctorBlocker[];
    listener: ClaudePluginDoctorReport["channel"]["listener"];
  }>;
  launch(args: string[], env: NodeJS.ProcessEnv): ClaudeLaunchResult;
}

const defaultDependencies: ClaudeLaunchDependencies = {
  preflight: async (channel) => {
    const report = await inspectClaudePluginReadiness(channel);
    return { blockers: report.blockers, listener: report.channel.listener };
  },
  launch: (args, env) => spawnSync("claude", args, { stdio: "inherit", env }),
};

export function claudeLaunchPlan(
  channel: string | undefined,
  claudeArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: ["--channels", CLAUDE_CHANNEL_PLUGIN, ...claudeArgs],
    env: {
      ...env,
      [CLAUDE_CHANNEL_OPT_IN_ENV]: "1",
      [CLAUDE_LIFECYCLE_OPT_IN_ENV]: "1",
      ...(channel === undefined ? {} : { AGENTPARTY_CHANNEL: channel }),
    },
  };
}

export async function run(
  argv: string[],
  deps: ClaudeLaunchDependencies = defaultDependencies,
): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const separator = argv.indexOf("--");
  const ownArgs = separator === -1 ? argv : argv.slice(0, separator);
  const claudeArgs = separator === -1 ? [] : argv.slice(separator + 1);
  if (ownArgs.length > 1 || ownArgs.some((arg) => arg.startsWith("-"))) {
    console.error("usage: party claude [channel] [-- <claude args...>]");
    return 1;
  }
  const channel = ownArgs[0];
  if (channel !== undefined && !isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  let readiness: Awaited<ReturnType<ClaudeLaunchDependencies["preflight"]>>;
  try {
    readiness = await deps.preflight(channel);
  } catch {
    console.error("AgentParty Channel preflight failed; run: party doctor claude-plugin --json");
    return 1;
  }
  // Before launch, no durable listener is the one expected doctor blocker.
  // Everything else means Claude would open without the promised Channel, or
  // another live listener already owns this identity/channel.
  const launchBlockers = readiness.blockers.filter((blocker) => blocker !== "listener_not_observed");
  if (launchBlockers.length > 0 || readiness.listener !== "not_observed") {
    const detail = launchBlockers.length > 0
      ? launchBlockers.join(", ")
      : `listener_${readiness.listener}`;
    console.error(`AgentParty Channel is not launch-ready (${detail}); run: party doctor claude-plugin --json`);
    return 1;
  }
  const plan = claudeLaunchPlan(channel, claudeArgs);
  const result = deps.launch(plan.args, plan.env);
  if (result.error !== undefined) {
    console.error(`could not start Claude Code: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
