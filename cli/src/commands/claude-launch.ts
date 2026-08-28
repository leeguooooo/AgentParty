import { spawnSync } from "node:child_process";
import { isHelpArg } from "../args";
import {
  CLAUDE_DEFAULT_ARGS_ENV,
  claudeDefaultArgsPath,
  clearClaudeDefaultArgs,
  hasDangerousClaudeFlag,
  mergeClaudeArgs,
  resolveClaudeDefaultArgs,
  writeClaudeDefaultArgs,
} from "../claude-default-args";
import { agentpartyHome } from "../config";
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

const USAGE = "usage: party claude [channel] [-- <claude args...>] | --default-args -- [<claude args...>] | --show-default-args";

const HELP = `usage: party claude [channel] [-- <claude args...>]
       party claude --default-args -- <claude args...>   # 设为本机默认启动参数（配一次）
       party claude --default-args --                    # 清空本机默认
       party claude --show-default-args                  # 查看本机默认及其来源

Start Claude Code with the AgentParty Marketplace Channel explicitly armed.
Before launch, require the enabled plugin, an agent token, channel access, and
no existing durable listener. Claude Cross-session uses party bridge claude
instead; do not stack the two launch paths.

Default launch args are opt-in per machine and never hard-coded: only what you
wrote with --default-args (file: $AGENTPARTY_HOME/claude-default-args.json;
fallback env ${CLAUDE_DEFAULT_ARGS_ENV}, lower priority) is prepended before your
explicit -- args. The launcher prints the defaults and their source every time.`;

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
  /** 本机偏好根（默认 `agentpartyHome(env)`）；测试用临时目录注入。 */
  home?: string;
  env?: NodeJS.ProcessEnv;
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
  defaultArgs: string[] = [],
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: ["--channels", CLAUDE_CHANNEL_PLUGIN, ...mergeClaudeArgs(defaultArgs, claudeArgs)],
    env: {
      ...env,
      [CLAUDE_CHANNEL_OPT_IN_ENV]: "1",
      [CLAUDE_LIFECYCLE_OPT_IN_ENV]: "1",
      ...(channel === undefined ? {} : { AGENTPARTY_CHANNEL: channel }),
    },
  };
}

function dangerousFlagNotice(args: string[]): string | null {
  if (!hasDangerousClaudeFlag(args)) return null;
  return "注意：--dangerously-skip-permissions 会让 Claude 跳过所有权限确认。这是你在本机显式配置的默认，AgentParty 从不替你打开它；不想要了就 `party claude --default-args --` 清空。";
}

function runSetDefaultArgs(home: string, args: string[]): number {
  const path = claudeDefaultArgsPath(home);
  if (args.length === 0) {
    clearClaudeDefaultArgs(home);
    console.log(`已清空本机 \`party claude\` 的默认启动参数（删除 ${path}）；之后只带你显式写在 -- 后面的参数。`);
    return 0;
  }
  writeClaudeDefaultArgs(home, args);
  console.log(
    `已把以下参数设为本机 \`party claude\` 的默认启动参数（由你显式配置，写在 ${path}）：\n` +
      `  ${args.join(" ")}\n` +
      "之后每次 `party claude <channel>` 都会自动带上；显式 `-- <args>` 追加在默认之后（同名 flag 以显式为准）。\n" +
      "清空：`party claude --default-args --`；查看：`party claude --show-default-args`。",
  );
  const notice = dangerousFlagNotice(args);
  if (notice !== null) console.log(notice);
  return 0;
}

function runShowDefaultArgs(env: NodeJS.ProcessEnv, home: string): number {
  const resolution = resolveClaudeDefaultArgs(env, home);
  if (resolution.source === "none") {
    console.log(`未配置本机默认启动参数（文件 ${resolution.origin} 不存在，环境变量 ${CLAUDE_DEFAULT_ARGS_ENV} 未设）。`);
    console.log("设置：`party claude --default-args -- <claude args...>`");
    return 0;
  }
  console.log(`默认参数：${resolution.args.join(" ")}（来自 ${resolution.origin}）`);
  console.log(
    resolution.source === "config"
      ? "这是本机显式配置的默认；清空：`party claude --default-args --`"
      : `这是环境变量兜底；写配置文件会覆盖它：\`party claude --default-args -- <claude args...>\``,
  );
  const notice = dangerousFlagNotice(resolution.args);
  if (notice !== null) console.log(notice);
  return 0;
}

export async function run(
  argv: string[],
  deps: ClaudeLaunchDependencies = defaultDependencies,
): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const env = deps.env ?? process.env;
  const home = deps.home ?? agentpartyHome(env);
  const separator = argv.indexOf("--");
  const ownArgs = separator === -1 ? argv : argv.slice(0, separator);
  const claudeArgs = separator === -1 ? [] : argv.slice(separator + 1);
  if (ownArgs.length === 1 && ownArgs[0] === "--default-args") {
    if (separator === -1) {
      console.error("party claude --default-args 需要 `--`：`--default-args -- <claude args...>` 设置，`--default-args --` 清空");
      return 1;
    }
    return runSetDefaultArgs(home, claudeArgs);
  }
  if (ownArgs.length === 1 && ownArgs[0] === "--show-default-args" && separator === -1) {
    return runShowDefaultArgs(env, home);
  }
  if (ownArgs.length > 1 || ownArgs.some((arg) => arg.startsWith("-"))) {
    console.error(USAGE);
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
  const defaults = resolveClaudeDefaultArgs(env, home);
  if (defaults.args.length > 0) {
    // 让人一眼知道这个会话带了什么默认（尤其是跳权限），以及它是从哪来的。
    console.log(`默认参数：${defaults.args.join(" ")}（来自 ${defaults.origin}）`);
    const notice = dangerousFlagNotice(defaults.args);
    if (notice !== null) console.log(notice);
  }
  const plan = claudeLaunchPlan(channel, claudeArgs, env, defaults.args);
  const result = deps.launch(plan.args, plan.env);
  if (result.error !== undefined) {
    console.error(`could not start Claude Code: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
