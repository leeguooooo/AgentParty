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
  claudePluginDoctorFixLines,
  inspectClaudePluginReadiness,
  type ClaudePluginDoctorBlocker,
  type ClaudePluginDoctorReport,
} from "./doctor";

export const CLAUDE_CHANNEL_PLUGIN = "plugin:agentparty@agentparty";
/**
 * Claude 加载频道服务器的唯一入口（#984）。
 *
 * `--channels <entry>` 受 Claude 的 `allowedChannelPlugins` 门控：那是 managed-only 设置
 * （与 allowedMcpServers / availableModels 同组，"highest source owns it whole"），个人账号在
 * 自己的 settings.json 里改不了；默认名单来自 Anthropic 远端的 `tengu_harbor_ledger`，只有
 * telegram/discord/imessage 那几个官方插件。所以插件频道在个人账号上永远 "not on the approved
 * channels allowlist"，只能走 `--dangerously-load-development-channels <entry>`（启动时弹一次
 * "Loading development channels" 确认框）。
 *
 * 用真二进制（claude 2.1.250）核过的两个事实，决定了这里**只**传 dev flag、**不**同时传
 * `--channels`：
 * 1. 两个 flag 的值同一个解析器，形态一样：`plugin:<name>@<marketplace>` 或 `server:<name>`，
 *    不带标签直接报 "entries must be tagged"。
 * 2. `--channels` 的条目先进 allowedChannels，dev 条目在确认框之后**追加**在后面；注册门
 *    `findChannelEntry` 用 Array.find 取**第一个**同名条目——同时传两者时命中的是 `--channels`
 *    那个非 dev 条目，照样走 allowlist 判定、照样被拒（实测："Channel notifications skipped:
 *    … not on the approved channels allowlist"）；只传 dev flag 才 "Channel notifications
 *    registered"。`party bridge claude` 一直只传 dev flag，所以起得来。
 *
 * `party claude` 与 `party bridge claude` 都必须经这个函数拼参数，测试钉住两处不再漂移。
 */
export const CLAUDE_DEV_CHANNELS_FLAG = "--dangerously-load-development-channels";
export function claudeChannelLoadArgs(entry: string): string[] {
  return [CLAUDE_DEV_CHANNELS_FLAG, entry];
}
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

The plugin channel is loaded with ${CLAUDE_DEV_CHANNELS_FLAG} ${CLAUDE_CHANNEL_PLUGIN}
(Claude's allowedChannelPlugins allowlist is managed-only and cannot be edited on a
personal account), so Claude shows one "Loading development channels" confirmation
at startup; pick "I am using this for local development". Do not add
--channels ${CLAUDE_CHANNEL_PLUGIN} yourself: that entry shadows the development
one and the channel is refused again.

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
    /** doctor 的逐项修法（#984：拒绝启动时直接印出来，不再只丢一句「去跑 doctor」）。 */
    fix_lines?: string[];
  }>;
  launch(args: string[], env: NodeJS.ProcessEnv): ClaudeLaunchResult;
  /** 本机偏好根（默认 `agentpartyHome(env)`）；测试用临时目录注入。 */
  home?: string;
  env?: NodeJS.ProcessEnv;
}

const defaultDependencies: ClaudeLaunchDependencies = {
  preflight: async (channel) => {
    const report = await inspectClaudePluginReadiness(channel);
    return {
      blockers: report.blockers,
      listener: report.channel.listener,
      fix_lines: claudePluginDoctorFixLines(report),
    };
  },
  launch: (args, env) => spawnSync("claude", args, { stdio: "inherit", env }),
};

export function claudeLaunchPlan(
  channel: string | undefined,
  claudeArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultArgs: string[] = [],
): { args: string[]; env: NodeJS.ProcessEnv } {
  // 频道加载参数是启动必需项，不是用户偏好：永远由启动器拼，不走 #978 的默认参数机制。
  // 但沿用 mergeClaudeArgs 的同名判定——用户在默认参数或显式 `--` 里自己写了
  // --dangerously-load-development-channels，就以用户的为准、不重复拼（run() 会提醒必须自带插件条目）。
  const userArgs = mergeClaudeArgs(defaultArgs, claudeArgs);
  return {
    args: mergeClaudeArgs(claudeChannelLoadArgs(CLAUDE_CHANNEL_PLUGIN), userArgs),
    env: {
      ...env,
      [CLAUDE_CHANNEL_OPT_IN_ENV]: "1",
      [CLAUDE_LIFECYCLE_OPT_IN_ENV]: "1",
      ...(channel === undefined ? {} : { AGENTPARTY_CHANNEL: channel }),
    },
  };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

/**
 * 启动前关于频道加载方式的提示（纯函数，可测）。`userArgs` 是默认参数与显式 `--` 合并后的用户参数。
 * 第一条永远打印：让人知道为什么会弹确认框、该选哪个；后两条只在用户自己碰了这两个 flag 时出现。
 */
export function claudeChannelLaunchNotices(userArgs: string[]): string[] {
  const lines = [
    `频道加载：${CLAUDE_DEV_CHANNELS_FLAG} ${CLAUDE_CHANNEL_PLUGIN}` +
      "（Claude 的 allowedChannelPlugins 名单是 managed-only，个人账号改不了，插件频道只能按 development channel 加载）；" +
      "Claude 启动会弹一次「Loading development channels」确认框，选「I am using this for local development」即可。",
  ];
  if (hasFlag(userArgs, CLAUDE_DEV_CHANNELS_FLAG)) {
    lines.push(
      `注意：你自己给了 ${CLAUDE_DEV_CHANNELS_FLAG}，启动器不再替你补；它的值里必须包含 ${CLAUDE_CHANNEL_PLUGIN}，否则频道不会武装。`,
    );
  }
  if (hasFlag(userArgs, "--channels")) {
    lines.push(
      `注意：--channels 的条目会遮住同名的 development 条目（Claude 取第一个匹配），` +
        `带上 --channels ${CLAUDE_CHANNEL_PLUGIN} 会让频道再次被 allowlist 拒掉；请去掉它。`,
    );
  }
  return lines;
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
    console.error(`AgentParty Channel is not launch-ready (${detail})`);
    for (const line of readiness.fix_lines ?? []) console.error(line);
    if (launchBlockers.includes("plugin_state_unavailable")) {
      // 读不到插件状态 ≠ 插件坏了：`claude plugin list --json` 没在 10s 内返回（Claude 慢、正在自更新、
      // 登录过期都会这样）。别让人去改插件，先重试。
      console.error(
        "  hint: `claude plugin list --json` did not answer within 10s (Claude slow, self-updating, or logged out); retry, then: party doctor claude-plugin --json",
      );
    } else {
      console.error("  details: party doctor claude-plugin --json");
    }
    return 1;
  }
  const defaults = resolveClaudeDefaultArgs(env, home);
  if (defaults.args.length > 0) {
    // 让人一眼知道这个会话带了什么默认（尤其是跳权限），以及它是从哪来的。
    console.log(`默认参数：${defaults.args.join(" ")}（来自 ${defaults.origin}）`);
    const notice = dangerousFlagNotice(defaults.args);
    if (notice !== null) console.log(notice);
  }
  for (const line of claudeChannelLaunchNotices(mergeClaudeArgs(defaults.args, claudeArgs))) console.log(line);
  const plan = claudeLaunchPlan(channel, claudeArgs, env, defaults.args);
  const result = deps.launch(plan.args, plan.env);
  if (result.error !== undefined) {
    console.error(`could not start Claude Code: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
