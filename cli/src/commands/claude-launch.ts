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
import { agentpartyHome, readConfig, refreshConfigInPlace } from "../config";
import { normalizeWakeLang } from "../wake-note-i18n";
import { MCP_OPT_IN_ENV } from "../mcp-session-binding";
import {
  CLAUDE_PLUGIN_UPDATE_COMMAND,
  syncClaudePluginToCli,
  type ClaudePluginSyncResult,
} from "../claude-plugin-sync";
import { RUNNING_VERSION, compareVersions } from "../upgrade";
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

const USAGE = "usage: party claude [channel] [--lang zh|en] [--no-auto-plugin-update] [-- <claude args...>] | --default-args -- [<claude args...>] | --show-default-args";

const HELP = `usage: party claude [channel] [--lang zh|en] [--no-auto-plugin-update] [-- <claude args...>]
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

--lang zh|en stores the language of the wake notes injected into this session in the
agent config (#1003) and then launches as usual; omit it to auto-detect from the agent's
own recent channel messages (fallback: the mentioning message, then LANG, then en).

If the installed Marketplace plugin is older than this CLI, the launcher runs
\`claude plugin update agentparty@agentparty\` itself and then launches (the new
Claude process loads the updated plugin; nothing to restart). It prints which
command it ran and the version it moved the plugin from and to. It never runs
update when the plugin is *newer* than the CLI — that would be a downgrade;
upgrade the CLI with \`party upgrade\` instead. --no-auto-plugin-update turns the
self-heal off and falls back to printing the manual command.

Default launch args are opt-in per machine and never hard-coded: only what you
wrote with --default-args (file: $AGENTPARTY_HOME/claude-default-args.json;
fallback env ${CLAUDE_DEFAULT_ARGS_ENV}, lower priority) is prepended before your
explicit -- args. The launcher prints the defaults and their source every time.`;

/** #1013：自愈只碰「插件版本」这一条 blocker，且只在插件**旧于** CLI 时动手。 */
export const NO_AUTO_PLUGIN_UPDATE_FLAG = "--no-auto-plugin-update";

export type ClaudeLaunchPreflight = {
  blockers: ClaudePluginDoctorBlocker[];
  listener: ClaudePluginDoctorReport["channel"]["listener"];
  /** doctor 的逐项修法（#984：拒绝启动时直接印出来，不再只丢一句「去跑 doctor」）。 */
  fix_lines?: string[];
  /** 本机已装的插件版本（#1013 判「旧于 CLI」用；读不出来时缺席）。 */
  plugin_version?: string;
  /** 这个 party 二进制的版本，即插件该对齐到的目标。 */
  runtime_version?: string;
};

/**
 * 插件版本落后是否该由 `party claude` 自己修（#1013）。
 *
 * 三个条件缺一不可：命中 `plugin_version_mismatch`、两边版本都读得出、且插件**严格旧于** CLI。
 * 插件比 CLI 新时跑 update 等于降级（#1011），这里必须返回 false，让 fix_lines 去说 `party upgrade`。
 */
/**
 * 这一行修法是不是在讲插件本身（`claude plugin install/enable/update`、`party upgrade`）。
 * 只有这些会随「刚跑过的那次 update」而失效；其余 blocker 的修法与插件无关。
 */
export function isPluginFixLine(line: string): boolean {
  return /claude plugin (install|enable|update)|party upgrade/.test(line);
}

/** 版本号带预发行/构建后缀（-beta.1、+build）——数字段比较对它不成立。 */
export function hasPrerelease(version: string): boolean {
  return /[-+]/.test(version.trim());
}

export function shouldSelfHealPluginVersion(readiness: ClaudeLaunchPreflight): boolean {
  if (!readiness.blockers.includes("plugin_version_mismatch")) return false;
  const { plugin_version: plugin, runtime_version: runtime } = readiness;
  if (plugin === undefined || runtime === undefined) return false;
  // 预发行号（0.2.223-beta.1）在 compareVersions 里会被 parseInt 截成 0.2.223，比出来「相等」，
  // 于是既不自愈也不解释。本仓 release.sh 只发严格 X.Y.Z，但真撞上时要**显式**不自愈：
  // 版本关系都判不准，就别去动插件（coderabbit on #1014）。
  if (hasPrerelease(plugin) || hasPrerelease(runtime)) return false;
  return compareVersions(plugin, runtime) < 0;
}

/** 自愈结果的说明文案（纯函数，可测）。第一句永远说明「动了什么」。 */
export function pluginSelfHealNotice(result: ClaudePluginSyncResult, runtimeVersion: string): string {
  const from = typeof result.before === "string" ? result.before : "?";
  switch (result.kind) {
    case "updated":
      return `已自动运行 \`${CLAUDE_PLUGIN_UPDATE_COMMAND}\`：插件 ${from} → ${result.after}（与 CLI ${runtimeVersion} 对齐）；这就用新版本启动新的 Claude 会话。`;
    case "update_failed":
      return `自动运行 \`${CLAUDE_PLUGIN_UPDATE_COMMAND}\` 失败（命令退出非 0，插件仍是 ${result.after ?? from}）。`;
    case "still_mismatched":
      return `自动运行 \`${CLAUDE_PLUGIN_UPDATE_COMMAND}\` 后插件仍是 ${result.after ?? from}，没到 CLI 的 ${runtimeVersion}（marketplace 还没拿到这个 tag，或本机缓存未刷新）。`;
    case "claude_unavailable":
      return "无法自动更新插件：`claude` 不在 PATH 上，跑不了 `claude plugin update`。";
    case "unreadable":
      return "无法自动更新插件：`claude plugin list --json` 读不出插件清单，不确定动了会变成什么，没有动。";
    case "not_installed":
      return "无法自动更新插件：本机没装 agentparty 插件（装插件是 `party join` 的事，启动器不替你做主）。";
    case "current":
      return `插件已与 CLI ${runtimeVersion} 同版，无需更新。`;
  }
}

export interface ClaudeLaunchResult {
  status: number | null;
  error?: Error;
}

export interface ClaudeLaunchDependencies {
  preflight(channel: string | undefined): Promise<ClaudeLaunchPreflight>;
  /** #1013：把本机插件对齐到 `cliVersion`（默认 syncClaudePluginToCli）；测试注入。 */
  syncPlugin?: (cliVersion: string) => ClaudePluginSyncResult;
  launch(args: string[], env: NodeJS.ProcessEnv): ClaudeLaunchResult;
  /** 本机偏好根（默认 `agentpartyHome(env)`）；测试用临时目录注入。 */
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** #1003：把 `--lang` 写进当前 agent config（就地刷新，不双写）；返回 false＝没有 config 可写。测试注入。 */
  storeLang?: (lang: "zh" | "en") => boolean;
}

/** #1003 真实写法：读取时命中哪个 config 就只刷新它（refreshConfigInPlace），绝不新建、不双写。 */
function storeWakeLang(lang: "zh" | "en"): boolean {
  const cfg = readConfig();
  if (cfg === null) return false;
  refreshConfigInPlace({ ...cfg, lang });
  return true;
}

const defaultDependencies: ClaudeLaunchDependencies = {
  preflight: async (channel) => {
    const report = await inspectClaudePluginReadiness(channel);
    return {
      blockers: report.blockers,
      listener: report.channel.listener,
      fix_lines: claudePluginDoctorFixLines(report),
      ...(report.plugin.version === undefined ? {} : { plugin_version: report.plugin.version }),
      runtime_version: report.runtime_version,
    };
  },
  syncPlugin: (cliVersion) => syncClaudePluginToCli(spawnSync, cliVersion),
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
      // #1018：这是 owner 亲手起的会话，工具面照常放行（进程树内继承，别的会话拿不到）。
      [MCP_OPT_IN_ENV]: "1",
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
  const rawArgsBeforeSeparator = separator === -1 ? argv : argv.slice(0, separator);
  // #1013：`--no-auto-plugin-update` 先摘掉（它只关自愈，不进 claude 的参数、也不参与位置参数校验）。
  const autoPluginUpdate = !rawArgsBeforeSeparator.includes(NO_AUTO_PLUGIN_UPDATE_FLAG);
  const rawOwnArgs = rawArgsBeforeSeparator.filter((arg) => arg !== NO_AUTO_PLUGIN_UPDATE_FLAG);
  const claudeArgs = separator === -1 ? [] : argv.slice(separator + 1);
  // #1003：`--lang zh|en` 先从自有参数里摘出来（写进 config 后照常启动），其余参数的校验不变。
  const langIndex = rawOwnArgs.findIndex((arg) => arg === "--lang" || arg.startsWith("--lang="));
  let langFlag: string | undefined;
  let ownArgs = rawOwnArgs;
  if (langIndex !== -1) {
    const arg = rawOwnArgs[langIndex]!;
    const inline = arg.startsWith("--lang=") ? arg.slice("--lang=".length) : undefined;
    langFlag = inline ?? rawOwnArgs[langIndex + 1];
    if (langFlag === undefined || langFlag.startsWith("-")) {
      console.error("--lang needs a value: zh or en");
      return 1;
    }
    ownArgs = rawOwnArgs.filter((_, index) => index !== langIndex && (inline !== undefined || index !== langIndex + 1));
  }
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
  if (langFlag !== undefined) {
    const lang = normalizeWakeLang(langFlag);
    if (lang === null) {
      console.error("--lang must be one of: zh, en");
      return 1;
    }
    const written = deps.storeLang === undefined ? storeWakeLang(lang) : deps.storeLang(lang);
    if (!written) {
      console.error("--lang: no agent config to store it in; run party join / party init first");
      return 1;
    }
    console.log(`唤醒文案语言已写入 config：lang=${lang}`);
  }
  let readiness: ClaudeLaunchPreflight;
  try {
    readiness = await deps.preflight(channel);
  } catch {
    console.error("AgentParty Channel preflight failed; run: party doctor claude-plugin --json");
    return 1;
  }
  // #1013：插件旧于 CLI 是 `party claude` 自己修得掉的一条——它起的是**新**进程，更新后的插件
  // 本来就会被新会话加载，没有「重启当前会话」这回事。修完必须**重跑一次 preflight**：自愈只
  // 处理版本这一条，identity/listener 等 blocker 一个都不许因此被跳过。
  let staleFixAfterSelfHeal = false;
  if (autoPluginUpdate && shouldSelfHealPluginVersion(readiness)) {
    const target = readiness.runtime_version ?? RUNNING_VERSION;
    console.log(
      `插件 ${readiness.plugin_version} 落后于 CLI ${target}，正在运行 \`${CLAUDE_PLUGIN_UPDATE_COMMAND}\`` +
        `（不想让启动器动插件：加 ${NO_AUTO_PLUGIN_UPDATE_FLAG}）……`,
    );
    const sync = (deps.syncPlugin ?? ((cliVersion: string) => syncClaudePluginToCli(spawnSync, cliVersion)))(target);
    const notice = pluginSelfHealNotice(sync, target);
    if (sync.kind === "updated" || sync.kind === "current") {
      console.log(notice);
      try {
        readiness = await deps.preflight(channel);
      } catch {
        console.error("AgentParty Channel preflight failed; run: party doctor claude-plugin --json");
        return 1;
      }
    } else {
      console.error(notice);
      // 失败也要重跑 preflight：update 可能把状态换成了另一种不匹配（例如插件反而新于 CLI），
      // 沿用第一次的 fix_lines 就会给出过时的 `claude plugin update`（coderabbit on #1014）。
      //
      // 「这次尝试有没有可能真的动过插件」决定了重跑失败时该怎么说：
      //   update_failed / still_mismatched ⇒ update 命令**真的跑过**，状态可能已变；重跑又没成功，
      //     那我们就是不知道现在该怎么修——绝不能把更新前的修法当成当前修法端出去
      //     （codex stop-time review on a21d986）。
      //   claude_unavailable / unreadable / not_installed ⇒ 一个字节都没动，原修法仍然准确。
      const mutated = sync.kind === "update_failed" || sync.kind === "still_mismatched";
      try {
        readiness = await deps.preflight(channel);
      } catch {
        if (mutated) staleFixAfterSelfHeal = true;
      }
    }
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
    // 刚动过插件、又没能重新检查时，**只有插件那条**修法可能已经过时（它是按更新前的版本算的）；
    // auth / channel_unbound / identity 那些跟插件无关的修法照样准确，不该被连坐抹掉
    // （codex stop-time review on 916778f）。
    for (const line of readiness.fix_lines ?? []) {
      if (staleFixAfterSelfHeal && isPluginFixLine(line)) continue;
      console.error(line);
    }
    if (staleFixAfterSelfHeal) {
      console.error("  注意: 刚尝试过更新插件，但重新检查没成功——插件那条修法是更新前算出的，可能已经不适用，这里不给它。");
      console.error("  插件当前状态以此为准: party doctor claude-plugin --json");
    }
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
