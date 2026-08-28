// party join —— 一条命令跑完整段接入（issue #944）。
//
// 从前接入包是 108 行粘贴稿：用户逐条手工执行「写 config → 判重 → 绑定 → 注册 MCP →
// 装 hook → 批准 hook → 报到 → 自检」。每修一个坑就往粘贴稿里加一段说明，而说明没人读。
// 这个命令把那 8 步全部收进来，用户只跑一行，跑完自己打印「全部就绪」或「还差第 N 步」。
//
// 设计约束（issue 明确划的，别越）：
//  - **orchestrator，不是把逻辑复制一份**。写 config / 判重 / 绑定走 `party init`（init.ts）；
//    装+批准 hook 走 `party hook install --codex`（hook.ts，复用 #943 的 y/N 信任闸）；报到走
//    `party send`（send.ts）；自检复用 #926 的 wake 清单（wake-checklist.ts）。注册 MCP 没有
//    内部 API，只能 shell 到 claude/codex 二进制——但探测（先探后加，#898）自己做。
//  - **token 绝不进 argv（#676）**：只从 AGENTPARTY_TOKEN 环境变量读，往下游（init/send）也只
//    经由已写好的 config 文件或环境变量传，绝不落进命令行或日志。
//  - **失败要能看见，且是 #926 的口径**：哪一步没成、为什么、一条可执行的下一步。收尾自检从
//    **本地盘的真实状态**重新判定（不是信步骤返回码），任一步没落地都如实报「还差哪一步」。
//  - **幂等**：重复跑不叠加副作用（判重、先探后加、绑定替换本身都幂等，join 只负责正确编排）。
//  - **「前置条件齐了」≠「唤醒真的会发生」（#957/#961）**：收尾那句 ✅ 承诺的是「@ 一下就叫得醒」，
//    所以它的判据必须是唤醒层本身——claude 档是插件装到位且版本与 CLI 一致（doctor 的 shell 检查，
//    版本不一致时 SessionStart 根本没布上）**且本机有会接 @ 的武装监听进程**（#979：普通 `claude`
//    起的会话按 #615 是 local-only 蛰伏档，只有 `party claude` / `bridge claude` / `party serve
//    --runner claude` 会抢 serve 锁接 @——判据是锁的活持有者，不是开关）；codex 档是唤醒层
//    **进程真的在**（join 收尾主动拉起，再探活）。任一没成就不印 ✅，照实说本会话此刻能被怎么叫到。
//  - **分步引导（#988 / epic #987）**：收尾自检不再是一坨格子，而是第 0～4 步顺序跑——版本 → 身份 →
//    接收方式 → 起一个可唤醒的会话 → 真发一条 @ 验证。每步一条 check、过/不过、不过时恰一条修法并
//    **停在该步**（退出码非 0）；全部过了才印 ✅。步骤机在 onboarding/steps.ts，这里只按 harness 组装
//    每一步查什么、修法是哪条。无 TTY / --yes 不交互、逐步打印；有 TTY 第 2 步可选接收方式。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { atomicWriteText } from "../atomic-json";
import { agentpartyHome, readConfig } from "../config";
import { detectHarnessFromAncestry } from "../join-binding";
import {
  AGENT_NAME_RE,
  BEHAVIOR_CONTRACT_BODY_LINES,
  type JoinPackHarness,
  mcpServerName,
} from "@agentparty/shared/onboarding";
import { isSlug, normalizeServerUrl } from "../validation";
import { buildWakeChecklist, type WakeChecklist } from "../wake-checklist";
import { diagnoseCodexWake } from "../wake-diagnosis";
import { RUNNING_VERSION, compareVersions } from "../upgrade";
import {
  CLAUDE_PLUGIN as SHARED_CLAUDE_PLUGIN,
  CLAUDE_PLUGIN_MARKETPLACE,
  CLAUDE_PLUGIN_UPDATE_COMMAND,
  claudePluginMismatchFix,
  installedClaudePluginVersion,
  syncClaudePluginToCli,
} from "../claude-plugin-sync";
import {
  activeCodexAutoWakePid,
  codexAutoWakeAuth,
  codexAutoWakeMarkerPath,
  codexAutoWakeTarget,
  runningServePid,
} from "../codex-auto-wake";
import { defaultInstanceLockDir, isSameLiveProcess } from "../instance-lock";
import { listCodexSessions, registerCodexSession } from "../claude-session-registry";
import {
  claudeArmCommand,
  claudeServeCommand,
  describeClaudeArmedListener,
  describeDormantClaudeSessions,
  probeClaudeArmedListener,
  type ClaudeArmedListenerProbe,
} from "../claude-armed-listener";
import { resolveClaudeDefaultArgs, type ClaudeDefaultArgsResolution } from "../claude-default-args";
import { claudeLaunchPlan } from "./claude-launch";
import { runSteps, type Step, type StepResult } from "../onboarding/steps";
import { verifyWakeRoundTrip, type VerifyWakeDeps } from "../onboarding/verify-wake";
import { findHarnessAncestor } from "../join-binding";
import {
  CLAUDE_PLUGIN_MIN_VERSION,
  inspectClaudePluginShell,
  type ClaudePluginShellInspection,
} from "./doctor";
import type { CodexAutoWakeOutcome } from "./hook";

// 与 probeCodexWakeLayer 并排导出：两档的「唤醒层进程探活」都从这里拿（#957 / #979）。
export { probeClaudeArmedListener };

const JOIN_FLAGS = ["server", "channel", "as", "harness", "mention"];
/** 每一步「做完重跑」的那条命令——引导幂等，修好了就再跑同一条。 */
const RERUN = "party join";
const HELP = `usage: AGENTPARTY_TOKEN='<token>' party join --server URL --channel SLUG --as NAME [--harness codex|claude|other] [--mention name] [--yes] [--coexist]

One command that does the whole join as guided steps (#987/#988):
  第 0 步 版本      CLI version; claude plugin installed + aligned to the CLI (#961/#985)
  第 1 步 身份      write config + rules, dedupe (#907), bind (#924), register the MCP
                    server (probe-then-add, #898), check in
  第 2 步 接收方式  claude: interactive session vs resident serve (asked on a TTY; the
                    default is taken and printed with --yes / no TTY); codex: install +
                    approve the Stop hook (#901/#942/#943)
  第 3 步 起一个可唤醒的会话  claude: print the exact \`party claude\` launch and probe for
                    an armed listener (#979); codex: bring up the wake layer, probe it (#957)
  第 4 步 真发一条 @ 验证     send one \`[wake-verify]\` @ to yourself and wait for the
                    receipt; on timeout say which layer failed (#990, party wake verify)
Each step runs one check; the first failing step prints exactly one fix command and
join stops there (exit 1). ✅ is printed only when every step passed. Every step is
idempotent — do the fix, then re-run the same \`party join\`.

The token comes ONLY from the AGENTPARTY_TOKEN env var — never a flag, so it stays out
of argv / ps / shell history (#676).

Options:
  --server URL   AgentParty server URL
  --channel SLUG channel to join (created if missing)
  --as NAME      your agent identity name (config/rules filename, MCP name, check-in)
  --harness H    codex | claude | other. Omit to auto-detect from the process tree;
                 if it cannot be told, join proceeds as "other" and says so.
  --mention NAME @ the inviter in the check-in line (dropped if not a valid name)
  --yes          non-interactive: never prompt (第 2 步 takes the harness default and
                 prints it); also approves the codex hook trust flip (passed to
                 \`party hook install --codex --yes\`); never bypasses the gate
  --coexist      keep any identity this harness already had on this channel (passed to
                 \`party init --coexist\`); default is replace`;

// 每一步的结果。level 决定它在自检里怎么呈现；gate=true 的步骤决定「就绪 / 还差」。
type StepLevel = "ok" | "skip" | "warn" | "fail";
interface StepOutcome {
  level: StepLevel;
  msg: string;
  /** 失败时的一条可执行下一步（#926 口径）。 */
  remedy?: string;
}

/** 第 2 步 claude 档的接收方式：交互式会话（party claude）或常驻（party serve --runner claude）。 */
export type ReceiveMode = "interactive" | "serve";

/** 第 4 步的输入：第 3 步探活到的那个会被唤醒的进程（#990 的真实往返验证按它判「谁收到了」）。 */
export interface WakeVerifyInput {
  channel: string;
  identity: string;
  harness: JoinPackHarness;
  listener: { pid: number; description: string } | null;
}
/**
 * 第 4 步「真发一条 @ 验证」的可注入实现。缺省＝roundTripWakeVerifier（#990 的 verifyWakeRoundTrip：
 * 以本身份发一条 `[wake-verify]` @ 自己、等回执，超时按层说清哪一层没通）；测试注入桩。
 */
export type WakeVerifier = (input: WakeVerifyInput) => Promise<StepResult> | StepResult;

/**
 * 把 #990 的往返结果适配成一步：detail 直接当摘要（去掉它自带的 ✓/✗，行尾由步骤机补），fix 就是
 * 那一条修法。server/token 从 join 刚写的 config 读（AGENTPARTY_CONFIG 已指向它）。
 */
export function roundTripWakeVerifier(verifyDeps?: VerifyWakeDeps): WakeVerifier {
  return async (input) => {
    const cfg = readConfig();
    if (cfg === null || typeof cfg.server !== "string" || typeof cfg.token !== "string" || cfg.token === "") {
      return { ok: false, summary: "config 里没有 server/token，发不了验证帧", fix: { do: RERUN } };
    }
    const r = await verifyWakeRoundTrip(
      { server: cfg.server, token: cfg.token, channel: input.channel, identity: input.identity, harness: input.harness },
      verifyDeps,
    );
    const summary = r.detail.replace(/^✗\s*/, "").replace(/\s*✓/g, "");
    return r.ok ? { ok: true, summary } : { ok: false, summary, ...(r.fix === undefined ? {} : { fix: { do: r.fix } }) };
  };
}

/** codex 唤醒层的存活证据（#957）：判据是**进程真的在**，不是开关是否 default-on。 */
export interface CodexWakeLayerLiveness {
  pid: number;
  /** serve 已抢到实例锁（连上服务端了）；或只在启动标记里（刚拉起、还在连）。 */
  source: "serve-lock" | "starting-marker";
}

interface CodexWakeLayerState {
  outcome: CodexAutoWakeOutcome;
  live: CodexWakeLayerLiveness | null;
  /** 跑 join 的这个 codex 会话没能在注册表里挂到本频道时的说明（唤醒层会因此提前退场）。 */
  adoptionNote: string | null;
}

/** 注入点：测试喂假 spawn（不碰真机的 claude/codex 二进制），其余走真实 init/hook/send。 */
export interface JoinDeps {
  spawn: typeof spawnSync;
  initRun: (argv: string[]) => Promise<number>;
  hookRun: (argv: string[]) => Promise<number>;
  sendRun: (argv: string[]) => Promise<number>;
  log: (line: string) => void;
  errlog: (line: string) => void;
  /** HOME（claude settings / codex home 都从它派生）。缺省 process.env.HOME。 */
  home: string;
  /**
   * codex 收尾自检用的 wake 清单（#926）。缺省＝真实 `party wake check` 逻辑（读本地盘 + 惰性探测
   * 哪个 codex 带信任闸）。抽成注入点只为测试：默认实现会 spawn `codex --version`，测试里换成快桩，
   * 但 hook 步骤的 ok/fail 仍由 diagnoseCodexWake 读**真实盘状态**决定，探测只影响 remedy 文案。
   */
  codexWakeChecklist: () => WakeChecklist;
  /**
   * claude 档收尾自检（#961）：插件生命周期壳——装没装、启没启用、版本是否与 CLI 一致、包是否完整。
   * 复用 doctor 的 inspectClaudePluginShell（`party bridge claude --check` 的 lifecycle 就是它），
   * 不 shell 出去再解析文本。缺省实现会 spawn 真机 claude，测试换成桩。
   */
  claudePluginShell: () => ClaudePluginShellInspection;
  /**
   * claude 档收尾自检（#979）：本机有没有会接 @ 的武装监听——`party claude` / `bridge claude` 起的
   * claude-channel（非 --require-launch-opt-in 蛰伏档）或 `party serve --runner claude`，三者都持
   * 同一把 serve 锁。缺省＝probeClaudeArmedListener（锁持有者探活 + ps 认起法 + 注册表数蛰伏档）。
   */
  claudeArmedListener: () => ClaudeArmedListenerProbe;
  /**
   * codex 档收尾（#957）：主动拉起唤醒层。缺省＝hook.ts 的 maybeStartCodexAutoWake（与 SessionStart
   * 同一条路径，同一套去重/标记），join 只是多给它一次机会——它此刻已有身份和 token，不必等下次会话。
   */
  startCodexWakeLayer: () => Promise<CodexAutoWakeOutcome>;
  /** codex 档收尾自检（#957）：唤醒层进程真的在吗。缺省＝probeCodexWakeLayer（锁 + 启动标记 + 探活）。 */
  codexWakeLayerLive: () => Promise<CodexWakeLayerLiveness | null>;
  /** 跑 join 的那个 codex 进程 pid（进程祖先链）；找不到 null。用于把本会话在注册表里挂到本频道。 */
  codexAncestorPid: () => number | null;
  /**
   * 第 2 步（claude 档）：有 TTY 且未 --yes 时问用户选接收方式。返回 null ＝ 没法问（无 TTY），
   * 按 harness 默认走并把所选印出来。--yes 时 runJoin 根本不调它。缺省 readline 一问。
   */
  chooseReceiveMode: (channel: string) => Promise<ReceiveMode | null>;
  /** 第 3 步（claude 档）：本机 `party claude` 的默认启动参数（#978），只用来把最终命令印全。 */
  claudeDefaultArgs: () => ClaudeDefaultArgsResolution;
  /** 第 4 步：真发一条 @ 的往返验证。缺省 roundTripWakeVerifier（#990 的 verifyWakeRoundTrip）。 */
  verifyWake: WakeVerifier;
}

export interface JoinOptions {
  server: string;
  channel: string;
  agentName: string;
  /** 显式 --harness；未给为 null（join 会自己探测）。 */
  harnessFlag: JoinPackHarness | null;
  mention: string | null;
  yes: boolean;
  coexist: boolean;
  token: string;
}

function configFileName(agentName: string, slug: string): string {
  return `agentparty-${agentName}-${slug}.json`;
}
function rulesFileName(agentName: string, slug: string): string {
  return `agentparty-${agentName}-${slug}.rules.md`;
}

/** claude MCP 注册：先探（claude mcp get）后加（claude mcp add）。探不到二进制 → skip 并说明。 */
function registerClaudeMcp(deps: JoinDeps, name: string, configPath: string, slug: string): StepOutcome {
  const addCmd =
    `claude mcp add ${name} --env AGENTPARTY_CONFIG="${configPath}" -- party mcp --channel ${slug} --identity ${name}`;
  const probe = deps.spawn("claude", ["mcp", "get", name], { encoding: "utf8", timeout: 30_000 });
  if (probe.error !== undefined) {
    return { level: "skip", msg: `claude 二进制不可用，跳过 MCP 注册。装好 claude 后手动：${addCmd}` };
  }
  // 已注册就跳过——每条注册在每个会话里都是一个常驻进程（#898）。幂等。
  if (probe.status === 0) {
    return { level: "ok", msg: `MCP 已注册（跳过重复添加）：${name}（多余的用 party mcp prune 清）` };
  }
  const add = deps.spawn(
    "claude",
    ["mcp", "add", name, "--env", `AGENTPARTY_CONFIG=${configPath}`, "--", "party", "mcp", "--channel", slug, "--identity", name],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (add.error !== undefined || add.status !== 0) {
    return { level: "fail", msg: `claude MCP 注册失败：${name}`, remedy: addCmd };
  }
  return { level: "ok", msg: `MCP 已注册：${name}` };
}

/** codex MCP 注册：先探（读注册表）后加（codex mcp add）。探不到二进制 → skip 并说明。 */
function registerCodexMcp(deps: JoinDeps, name: string, configPath: string, slug: string): StepOutcome {
  const addCmd =
    `codex mcp add ${name} --env AGENTPARTY_CONFIG="${configPath}" -- party mcp --channel ${slug} --identity ${name}`;
  const probe = deps.spawn("codex", ["mcp", "get", name], { encoding: "utf8", timeout: 30_000 });
  if (probe.error !== undefined) {
    return { level: "skip", msg: `codex 二进制不可用，跳过 MCP 注册。装好 codex 后手动：${addCmd}` };
  }
  if (probe.status === 0) {
    return { level: "ok", msg: `MCP 已注册（跳过重复添加）：${name}` };
  }
  const add = deps.spawn(
    "codex",
    ["mcp", "add", name, "--env", `AGENTPARTY_CONFIG=${configPath}`, "--", "party", "mcp", "--channel", slug, "--identity", name],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (add.error !== undefined || add.status !== 0) {
    return { level: "fail", msg: `codex MCP 注册失败：${name}`, remedy: addCmd };
  }
  return { level: "ok", msg: `MCP 已注册：${name}` };
}

const CLAUDE_PLUGIN = SHARED_CLAUDE_PLUGIN;
const MARKETPLACE = CLAUDE_PLUGIN_MARKETPLACE;

/**
 * 装 claude 插件（marketplace）——best-effort：装不上不阻断，只提示；能不能唤醒由收尾自检判。
 *
 * #961：`claude plugin install` 对已装的只回一句 "already installed"（exit 0），**永远不会升级**。
 * 于是本机插件停在旧版、CLI 已经是新版，doctor 判 plugin_version_mismatch，SessionStart 唤醒根本
 * 没布上。所以 install 之后交给 syncClaudePluginToCli（与 `party upgrade` 共用，#985）：读已装版本，
 * ≠ 当前 CLI 就跟一步 `plugin update`，再读一次核实。
 *
 * 装了 / 更新了都要**重开 Claude 会话**才生效（当前会话还挂着旧插件）——这句必须进结论，
 * 不能埋在 warn 里，所以用 restartNeeded 带出去。
 */
interface ClaudePluginInstallOutcome extends StepOutcome {
  restartNeeded: boolean;
  before: string | null | undefined;
  after: string | null | undefined;
  updated: boolean;
}
function installClaudePlugin(deps: JoinDeps): ClaudePluginInstallOutcome {
  const first = deps.spawn("claude", ["plugin", "marketplace", "add", MARKETPLACE], { encoding: "utf8", timeout: 60_000 });
  if (first.error !== undefined) {
    return {
      level: "skip",
      msg: "claude 二进制不可用，跳过插件安装（不影响 CLI 协作）",
      restartNeeded: false,
      before: undefined,
      after: undefined,
      updated: false,
    };
  }
  const before = installedClaudePluginVersion(deps.spawn);
  let anyFail = first.status !== 0;
  for (const args of [["plugin", "install", CLAUDE_PLUGIN], ["plugin", "enable", CLAUDE_PLUGIN]]) {
    const r = deps.spawn("claude", args, { encoding: "utf8", timeout: 60_000 });
    if (r.error !== undefined || r.status !== 0) anyFail = true;
  }
  const sync = syncClaudePluginToCli(deps.spawn, RUNNING_VERSION);
  if (sync.kind === "update_failed") anyFail = true;
  const updated = sync.kind === "updated";
  const after = sync.after;
  // 装上了（之前没有）或换了版本 ⇒ 当前会话还挂着旧的，必须重开。
  const restartNeeded = before !== after && after !== undefined;
  if (anyFail) {
    // 修法要对症：已装旧版就是 update（install 原地踏步），没装才是 install。
    const fix = after === null || after === undefined
      ? `claude plugin install ${CLAUDE_PLUGIN}`
      : CLAUDE_PLUGIN_UPDATE_COMMAND;
    return {
      level: "warn",
      msg: `claude 插件未完全装上（best-effort；手动 ${fix}，然后重开会话）`,
      remedy: fix,
      restartNeeded,
      before,
      after,
      updated,
    };
  }
  if (after !== undefined && after !== null && after !== RUNNING_VERSION) {
    const fix = claudePluginMismatchFix(after, RUNNING_VERSION);
    return {
      level: "warn",
      msg: `claude 插件是 ${after}，CLI 是 ${RUNNING_VERSION}，版本不一致时 SessionStart 唤醒不会布上——手动 ${fix}`,
      remedy: fix,
      restartNeeded,
      before,
      after,
      updated,
    };
  }
  const msg = updated
    ? `claude 插件已从 ${before} 更新到 ${after}（需重开 Claude 会话才生效）`
    : before === null
      ? `claude 插件已安装（${after}；需重开 Claude 会话才生效）`
      : `claude 插件已是 ${after ?? RUNNING_VERSION}（跳过）`;
  return { level: "ok", msg, restartNeeded, before, after, updated };
}

/** 装 codex 插件（marketplace）——best-effort：装不上不阻断，只提示。 */
function installCodexPlugin(deps: JoinDeps): StepOutcome {
  const steps: string[][] = [
    ["plugin", "marketplace", "add", MARKETPLACE],
    ["plugin", "add", CLAUDE_PLUGIN],
  ];
  const first = deps.spawn("codex", steps[0]!, { encoding: "utf8", timeout: 60_000 });
  if (first.error !== undefined) {
    return { level: "skip", msg: "codex 二进制不可用，跳过插件安装（不影响 CLI 协作）" };
  }
  let anyFail = first.status !== 0;
  for (const args of steps.slice(1)) {
    const r = deps.spawn("codex", args, { encoding: "utf8", timeout: 60_000 });
    if (r.error !== undefined || r.status !== 0) anyFail = true;
  }
  return anyFail
    ? { level: "warn", msg: `codex 插件未完全装上（best-effort，不阻断；重开会话或手动 codex plugin add ${CLAUDE_PLUGIN}）` }
    : { level: "ok", msg: "codex 插件已安装" };
}

/**
 * claude 档：把 ~/.claude/settings.json 的 crossSessionInbound 设为 accept（#844）——
 * 否则跨会话 @ 默认 hold、5 分钟无人处理会被 drop。幂等、写前备份（首写即定）、失败不阻断。
 */
function setClaudeInboxAccept(deps: JoinDeps): StepOutcome {
  const dir = pathJoin(deps.home, ".claude");
  const file = pathJoin(dir, "settings.json");
  const bak = `${file}.agentparty.bak`;
  try {
    mkdirSync(dir, { recursive: true });
    let obj: Record<string, unknown> = {};
    if (existsSync(file)) {
      const raw = readFileSync(file, "utf8");
      if (raw.trim() !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { level: "warn", msg: `~/.claude/settings.json 解析不了，未改动——跨会话 @ 唤醒需手动把 crossSessionInbound 设为 accept` };
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { level: "warn", msg: `~/.claude/settings.json 不是对象，未改动` };
        }
        obj = parsed as Record<string, unknown>;
      }
      // 备份首写即定：重复跑接入不能把备份覆盖成「已改过」的版本，否则原始设置找不回。
      if (!existsSync(bak)) copyFileSync(file, bak);
    }
    if (obj.crossSessionInbound === "accept") {
      return { level: "ok", msg: `crossSessionInbound 已是 accept（跳过）` };
    }
    obj.crossSessionInbound = "accept";
    atomicWriteText(file, `${JSON.stringify(obj, null, 2)}\n`);
    return { level: "ok", msg: `已把 ~/.claude/settings.json 的 crossSessionInbound 设为 accept（原文件备份在 ${bak}）` };
  } catch (e) {
    return { level: "warn", msg: `设置 crossSessionInbound 失败：${e instanceof Error ? e.message : String(e)}（不阻断）` };
  }
}

/**
 * claude 插件壳每种 blocker 对应的那一条修法（#961）。**版本不一致的修法是 update，不是 install**——
 * install 对已装的只回 already installed。插件比 CLI 还新时反过来升 CLI。
 */
function claudePluginRemedy(shell: ClaudePluginShellInspection): { do: string; notes: string[] } {
  const restart = "做完【重开一个 Claude 会话】才生效——当前会话还挂着旧插件";
  switch (shell.status) {
    case "ready":
      return { do: "", notes: [] };
    case "plugin_version_mismatch": {
      const v = shell.plugin.version ?? "?";
      if (shell.plugin.version !== undefined && compareVersions(shell.plugin.version, RUNNING_VERSION) > 0) {
        return { do: "party upgrade", notes: [`本机插件 ${v} 比 CLI ${RUNNING_VERSION} 新：升 CLI，不是降插件`] };
      }
      return {
        do: `claude plugin update ${CLAUDE_PLUGIN}`,
        notes: [
          `本机插件 ${v}，CLI ${RUNNING_VERSION}——\`claude plugin install\` 对已装的只回 already installed、不会升级，要 update`,
          restart,
        ],
      };
    }
    case "plugin_missing":
      return {
        do: `claude plugin marketplace add ${MARKETPLACE} && claude plugin install ${CLAUDE_PLUGIN} && claude plugin enable ${CLAUDE_PLUGIN}`,
        notes: [restart],
      };
    case "plugin_disabled":
      return { do: `claude plugin enable ${CLAUDE_PLUGIN}`, notes: [restart] };
    case "plugin_bundle_invalid":
      return {
        do: `claude plugin update ${CLAUDE_PLUGIN}`,
        notes: ["本机插件包与这个版本的 CLI 对不上（缺 launcher / hooks 接线）", restart],
      };
    case "claude_unavailable":
      return { do: "把 claude 放到 PATH 上（或先装 Claude Code），然后重跑 party join", notes: [] };
    case "claude_version_unsupported":
      return { do: `把 Claude Code 升到 >= ${CLAUDE_PLUGIN_MIN_VERSION.join(".")}，然后重跑 party join`, notes: [] };
    case "plugin_state_unavailable":
      return { do: "claude plugin list --json   看它为什么读不出插件状态，修好后重跑 party join", notes: [] };
  }
}

/**
 * 唤醒层进程探活（#957）——`party hook codex-autowake status` 用的同一把锁，再加启动标记：
 * serve 连上服务端才抢实例锁，刚拉起那几秒只有标记里的 pid。两处都用 isSameLiveProcess
 * 判「进程真的在」（pid + 出生时间），不是看开关、也不是信 spawn 返回值。
 *
 * 等一小会儿（waitMs）让 serve 有机会拿到锁：拿到＝已连上服务端，证据更硬；没拿到但进程活着
 * ＝刚拉起、还在连，也算在。进程不在（或压根没拉）⇒ null。
 */
export async function probeCodexWakeLayer(input: {
  home: string;
  lockDir: string;
  config: { server?: unknown; token?: unknown } | null;
  channel: string;
  alive?: (pid: number, startedAt?: number) => boolean;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CodexWakeLayerLiveness | null> {
  const auth = codexAutoWakeAuth(input.config);
  if (auth === null) return null;
  const alive = input.alive ?? isSameLiveProcess;
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
  const deadline = now() + (input.waitMs ?? 3_000);
  const marker = codexAutoWakeMarkerPath(input.home, codexAutoWakeTarget(auth, input.channel));
  for (;;) {
    const locked = runningServePid(auth, input.channel, input.lockDir);
    if (locked !== null) return { pid: locked, source: "serve-lock" };
    // 0 ＝ 只占了位还没回填 pid（还不算「进程在」）；null ＝ 没标记或标记里的进程已死。
    const starting = activeCodexAutoWakePid(marker, now(), alive);
    if (starting === null) return null;
    if (now() >= deadline) return starting > 0 ? { pid: starting, source: "starting-marker" } : null;
    await sleep(250);
  }
}

/**
 * 把跑 join 的这个 codex 会话在注册表里挂到本频道（#957）。
 *
 * 唤醒层的回收判据是「频道上还有没有活着的入册 codex 会话」（hook.ts 的 supervise）。本会话
 * SessionStart 时往往还没绑频道（或解析不出身份），注册表里要么没有它、要么挂在别的频道——
 * 那样 join 刚拉起的唤醒层会在宽限期一过被自己判成孤儿退场。这里只**更新已有条目**：
 * session_id 由 codex 给，没有条目就没法凭空造一个（绝不伪造），只能如实说。
 */
function adoptCodexSessionForChannel(
  deps: JoinDeps,
  slug: string,
  identity: string | null,
  server: string | null,
): string | null {
  try {
    const pid = deps.codexAncestorPid();
    if (pid === null) {
      return "找不到跑 join 的 codex 进程（不在 codex 会话里跑？）——唤醒层在没有入册 codex 会话时会自动退场";
    }
    const entry = listCodexSessions().find((e) => e.pid === pid);
    if (entry === undefined) {
      return "本会话没入册（SessionStart 时还没绑频道）——唤醒层约 60s 后会判无人使用而退场；新开一个 codex 会话即可长期挂着";
    }
    if (entry.channel === slug && (entry.identity ?? null) === identity) return null;
    const ok = registerCodexSession({
      session_id: entry.session_id,
      pid: entry.pid,
      display_name: entry.display_name,
      channel: slug,
      identity,
      server,
      cwd: entry.cwd,
    });
    return ok ? null : "会话注册表更新失败——唤醒层可能约 60s 后退场；新开一个 codex 会话即可";
  } catch (e) {
    return `会话注册表更新失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** codex 档第 3 步：先认领本会话、再主动拉起唤醒层、再探活。三步各自失败都不抛，全部进证据。 */
async function bringUpCodexWakeLayer(
  deps: JoinDeps,
  slug: string,
  record: (name: string, outcome: StepOutcome) => void,
): Promise<CodexWakeLayerState> {
  const cfg = readConfig();
  const adoptionNote = adoptCodexSessionForChannel(deps, slug, cfg?.identity?.name ?? null, cfg?.server ?? null);
  let outcome: CodexAutoWakeOutcome;
  try {
    outcome = await deps.startCodexWakeLayer();
  } catch (e) {
    outcome = { action: "start-failed", channel: slug, detail: e instanceof Error ? e.message : String(e) };
  }
  let live: CodexWakeLayerLiveness | null = null;
  try {
    live = await deps.codexWakeLayerLive();
  } catch {
    live = null;
  }
  if (outcome.action === "start") {
    record("拉起唤醒层", live === null
      ? { level: "warn", msg: `已尝试拉起 party serve ${slug} --runner codex，但探不到它的进程` }
      : { level: "ok", msg: `已拉起 party serve ${slug} --runner codex（pid ${live.pid}）` });
  } else if (outcome.action === "skip" && outcome.reason === "already-serving") {
    record("拉起唤醒层", { level: "ok", msg: `已有唤醒层在跑（${outcome.detail}）` });
  } else {
    record("拉起唤醒层", { level: "warn", msg: `没拉起：${outcome.detail}` });
  }
  return { outcome, live, adoptionNote };
}

function symbol(level: StepLevel): string {
  return level === "ok" ? "✓" : level === "skip" ? "·" : level === "warn" ? "!" : "✗";
}

// ── 步骤（#988）────────────────────────────────────────────────────────────────
//
// 每一步都是 onboarding/steps.ts 的 Step<JoinCtx>：一条 check、过/不过、不过时恰一条修法。
// 步骤之间靠 ctx 传状态（第 0 步的「要重开」、第 1 步解析出的身份、第 2 步选的接收方式、
// 第 3 步探到的进程）。best-effort 的小动作（MCP 注册、装插件、inbox accept）不决定过/不过，
// 只作为该步的补充行印出来——失败要能看见，但不该把整段接入判死。

interface JoinCtx {
  opts: JoinOptions;
  deps: JoinDeps;
  harness: JoinPackHarness;
  slug: string;
  agentName: string;
  configPath: string;
  rulesPath: string;
  mcpName: string;
  /** 第 0 步：插件刚装 / 刚更新，当前会话还挂着旧的——「要重开」是 ✅ 句的一部分。 */
  claudePluginRestart: boolean;
  /** 第 1 步：服务端确认的身份（config.identity.name）。 */
  identity: string | null;
  /** 第 2 步：claude 档所选接收方式。 */
  receiveMode: ReceiveMode;
  /** 第 3 步：探活到的那个会被唤醒的进程。 */
  listener: { pid: number; description: string } | null;
}

/** best-effort 小动作的一行：`✓ 注册 claude MCP: …`，作为步骤的补充行。 */
function outcomeLine(name: string, outcome: StepOutcome): string {
  return `${symbol(outcome.level)} ${name}: ${outcome.msg}`;
}

/** 第 0 步 版本：CLI 版本；claude 档还要插件装到位、已启用、与 CLI 同版（#961/#985）。 */
function versionStep(): Step<JoinCtx> {
  return {
    id: "version",
    title: "版本",
    run(ctx) {
      const { deps, harness } = ctx;
      const cli = `CLI ${RUNNING_VERSION}`;
      if (harness === "codex") {
        return { ok: true, summary: cli, detail: [outcomeLine("装 codex 插件", installCodexPlugin(deps))] };
      }
      if (harness !== "claude") return { ok: true, summary: cli };
      const install = installClaudePlugin(deps);
      ctx.claudePluginRestart = install.restartNeeded;
      const detail: string[] = install.level === "ok" || install.level === "skip" ? [] : [outcomeLine("装 claude 插件", install)];
      // 判据是 doctor 的插件壳检查（与 bridge claude --check 同一份）：版本不一致时 SessionStart 根本没布上。
      const shell = deps.claudePluginShell();
      if (shell.status !== "ready") {
        const remedy = claudePluginRemedy(shell);
        const versions = shell.plugin.version === undefined ? "" : `（本机插件 ${shell.plugin.version}，CLI ${RUNNING_VERSION}）`;
        return {
          ok: false,
          summary: `${cli} · claude 插件 blocker: ${shell.blockers.join(", ")}${versions}`,
          detail,
          fix: { do: remedy.do, notes: remedy.notes },
        };
      }
      const v = shell.plugin.version ?? RUNNING_VERSION;
      const plugin = install.updated
        ? `claude 插件 ${install.before} → 已更新到 ${v}（需重开会话）`
        : install.before === null
          ? `claude 插件已安装 ${v}（需重开会话）`
          : `claude 插件 ${v} 版本与 CLI 一致`;
      return { ok: true, summary: `${cli} · ${plugin}`, detail };
    },
  };
}

/** 第 1 步 身份：rules 落盘、party init（config + 判重 + 绑定）、服务端确认、MCP 注册、报到。 */
function identityStep(harnessKnown: boolean): Step<JoinCtx> {
  return {
    id: "identity",
    title: "身份",
    async run(ctx) {
      const { deps, opts, harness, slug, agentName, configPath, rulesPath, mcpName } = ctx;
      const detail: string[] = [];
      // 行为契约的持久拷贝（#845）。正文是 shared 静态常量，绝不掺 charter 等管理员可控文本。
      try {
        mkdirSync(pathJoin(rulesPath, ".."), { recursive: true });
        atomicWriteText(rulesPath, `${BEHAVIOR_CONTRACT_BODY_LINES.join("\n")}\n`);
        detail.push(outcomeLine("行为契约落盘", { level: "ok", msg: rulesPath }));
      } catch (e) {
        detail.push(outcomeLine("行为契约落盘", { level: "warn", msg: `写 rules 文件失败：${e instanceof Error ? e.message : String(e)}` }));
      }
      // party init：写 config + 同频道判重（#907）+ 加入即绑定（#924）+ 拉 charter。全部复用 init.ts。
      // harness 探不出时不传 --harness——让 init 也如实说「不知道是哪个 harness、没写绑定」。
      const initArgs = ["--server", opts.server, "--channel", slug];
      if (harnessKnown) initArgs.push("--harness", harness);
      if (opts.coexist) initArgs.push("--coexist");
      const initCode = await deps.initRun(initArgs);
      if (initCode !== 0) {
        return {
          ok: false,
          summary: `party init 失败（退出码 ${initCode}）——token / server 有问题`,
          detail,
          fix: { do: `检查 AGENTPARTY_TOKEN 是否有效、--server ${opts.server} 是否可达，然后重跑 ${RERUN}` },
        };
      }
      // 从本地盘的真实状态重判（不信步骤返回码）：config 写了没、服务端确认的身份是谁。
      const cfg = readConfig();
      if (cfg?.server === undefined || cfg.server === null) {
        return {
          ok: false,
          summary: "本频道的身份配置没写下来",
          detail,
          fix: { do: `AGENTPARTY_TOKEN='<token>' party join --server ${opts.server} --channel ${slug} --as ${agentName}` },
        };
      }
      const identity = cfg.identity?.name ?? null;
      if (identity === null) {
        return {
          ok: false,
          summary: "服务端没确认身份（config 里没有 identity）",
          detail,
          fix: { do: `检查 AGENTPARTY_TOKEN 是否有效、--server ${opts.server} 是否可达，然后重跑 ${RERUN}` },
        };
      }
      ctx.identity = identity;
      // 注册 MCP（先探后加，#898）。claude/codex 各走各的；other（探不出）两条都试——「不知道就都覆盖」。
      if (harness === "claude" || harness === "other") detail.push(outcomeLine("注册 claude MCP", registerClaudeMcp(deps, mcpName, configPath, slug)));
      if (harness === "codex" || harness === "other") detail.push(outcomeLine("注册 codex MCP", registerCodexMcp(deps, mcpName, configPath, slug)));
      // claude 档：crossSessionInbound=accept（#844），否则跨会话 @ 默认 hold 会被 drop。
      if (harness === "claude") detail.push(outcomeLine("开启跨会话 @ 接收", setClaudeInboxAccept(deps)));
      // 报到（#597）。init 只写配置不发言，必须补这一条，否则网页/频道里看不到你。能 @ 邀请人就 @。
      const sendArgs = [`👋 ${agentName} 报到，来参与协作`, "--channel", slug];
      if (opts.mention !== null) sendArgs.push("--mention", opts.mention);
      const sendCode = await deps.sendRun(sendArgs);
      if (sendCode !== 0) {
        return {
          ok: false,
          summary: `#${slug} 上以 ${identity} 报到失败（退出码 ${sendCode}）——别人看不到你`,
          detail,
          fix: { do: `party send "👋 ${agentName} 报到" --channel ${slug}` },
        };
      }
      return { ok: true, summary: `#${slug} 上以 ${identity} 报到`, detail };
    },
  };
}

/**
 * 第 2 步 接收方式。
 *  - claude：交互式会话（party claude）还是常驻（party serve --runner claude）。有 TTY 且未 --yes 问一句；
 *    否则按 claude 档默认（交互式）并把所选印出来。这一步不会不过——它只决定第 3 步印哪条命令。
 *  - codex：接 @ 的路是 Stop hook + 唤醒层。装 + 当场批准 Stop hook（#901/#942/#943，复用
 *    party hook install --codex），check 是 #926 wake 清单里的 hook_installed / hook_trusted（读真实盘状态）。
 *  - other：没有唤醒层，只能用 CLI 收消息。
 */
function receiveModeStep(): Step<JoinCtx> {
  return {
    id: "receive_mode",
    title: "接收方式",
    async run(ctx) {
      const { deps, opts, harness, slug } = ctx;
      if (harness === "claude") {
        const chosen = opts.yes ? null : await deps.chooseReceiveMode(slug);
        ctx.receiveMode = chosen ?? "interactive";
        const summary = ctx.receiveMode === "interactive"
          ? `你选：交互式 Claude 会话（可选：常驻 ${claudeServeCommand(slug)}）`
          : `你选：常驻 ${claudeServeCommand(slug)}（可选：交互式 ${claudeArmCommand(slug)}）`;
        const detail = chosen === null ? [`${opts.yes ? "--yes" : "无 TTY"}：不交互，按 claude 档默认选了${ctx.receiveMode === "interactive" ? "交互式会话" : "常驻"}`] : [];
        return { ok: true, summary, detail };
      }
      if (harness === "codex") {
        const hookArgs = ["install", "--codex"];
        if (opts.yes) hookArgs.push("--yes");
        const hookCode = await deps.hookRun(hookArgs);
        const detail = hookCode === 0 ? [] : [outcomeLine("装 + 批准 codex hook", { level: "warn", msg: `party hook install --codex 退出码 ${hookCode}` })];
        // hook 的 ok/fail 由 diagnoseCodexWake 读真实盘状态决定；修法走 #942 的探测式（桌面版 / exec 等注记）。
        const wake = deps.codexWakeChecklist();
        const failed = wake.steps.find((s) => (s.id === "hook_installed" || s.id === "hook_trusted") && !s.ok);
        if (failed !== undefined) {
          return {
            ok: false,
            summary: `Stop hook 没到位：${failed.label}`,
            detail,
            fix: wake.next === null ? { do: `party hook install --codex` } : { do: wake.next.do, notes: wake.next.notes },
          };
        }
        return { ok: true, summary: "Stop hook 已装、已批准；无人值守时由唤醒层（party serve --runner codex）接 @", detail };
      }
      return { ok: true, summary: `CLI 收消息（harness 是 other，没有唤醒层）：party watch ${slug} 或常驻 party serve ${slug}` };
    },
  };
}

/**
 * 第 3 步 起一个可唤醒的会话。
 *  - claude（#979）：印出按第 2 步所选拼好的那条命令（party claude 展开成 claudeLaunchPlan 的最终 argv +
 *    本机默认参数 #978），check 是本机有没有会接 @ 的武装监听——serve 锁的活持有者，不是插件状态、不是开关。
 *    这一步不替人起会话（那是 #989）；探不到就停在这，修法就是那条命令。
 *  - codex（#957）：主动拉起唤醒层再探活，判据是进程真的在。
 */
function wakeableSessionStep(): Step<JoinCtx> {
  return {
    id: "wakeable_session",
    title: "起一个可唤醒的会话",
    async run(ctx) {
      const { deps, harness, slug } = ctx;
      const identity = ctx.identity ?? ctx.agentName;
      if (harness === "claude") {
        const detail: string[] = [];
        let command: string;
        if (ctx.receiveMode === "serve") {
          command = claudeServeCommand(slug);
          detail.push(`运行：${command}`);
        } else {
          command = claudeArmCommand(slug);
          const defaults = deps.claudeDefaultArgs();
          const plan = claudeLaunchPlan(slug, [], {}, defaults.args);
          const defaultsNote = defaults.args.length === 0 ? "无本机默认参数" : `默认参数：${defaults.args.join(" ")}（来自 ${defaults.origin}）`;
          detail.push(`运行：${command}        （已自动带 dev-channels；${defaultsNote}）`);
          detail.push(`展开：AGENTPARTY_CHANNEL=${slug} claude ${plan.args.join(" ")}`);
        }
        // 探活失败按「没有」算——绝不因探不到就假定有。
        let probe: ClaudeArmedListenerProbe;
        try {
          probe = deps.claudeArmedListener();
        } catch {
          probe = { live: null, sessions: 0 };
        }
        if (probe.live === null) {
          return {
            ok: false,
            summary: `本机没有会接 @ 的 Claude 会话——${describeDormantClaudeSessions(probe.sessions, slug)}`,
            detail,
            fix: {
              do: command,
              notes: [
                `⚠ 已绑定身份 ${identity}，但这台机现在没有会接 @ 的 Claude 会话。`,
                `普通 \`claude\` 起的会话不接频道消息（local-only）；要能被 @ 唤醒，用 ${claudeArmCommand(slug)} 起一个会话（或 ${claudeServeCommand(slug)} 常驻）。`,
              ],
            },
          };
        }
        const description = describeClaudeArmedListener(probe.live, slug);
        ctx.listener = { pid: probe.live.pid, description };
        return { ok: true, summary: `${description}在接 @`, detail };
      }
      if (harness === "codex") {
        const detail: string[] = [];
        const wake = await bringUpCodexWakeLayer(deps, slug, (name, outcome) => detail.push(outcomeLine(name, outcome)));
        if (wake.adoptionNote !== null) detail.push(`⚠ ${wake.adoptionNote}`);
        if (wake.live === null) {
          const why = wake.outcome.action === "skip" || wake.outcome.action === "start-failed"
            ? wake.outcome.detail
            : "拉起了但探不到进程（可能刚退出：看 ~/.agentparty/logs/codex-auto-wake.log）";
          return {
            ok: false,
            summary: `唤醒层没起来：${why}`,
            detail,
            fix: {
              do: `party serve ${slug} --runner codex`,
              notes: [
                "本会话只能在你下次发言、回合结束时收到 @（Stop hook 会把积压的 @ 交给你）；" +
                  "要无人值守被唤醒，请新开一个 codex 会话（SessionStart 会重新拉起唤醒层），或手动拉起：",
              ],
            },
          };
        }
        const description = `唤醒层 party serve ${slug} --runner codex（pid ${wake.live.pid}）`;
        ctx.listener = { pid: wake.live.pid, description };
        const state = wake.live.source === "serve-lock" ? "serve 已持锁（连上服务端了）" : "刚拉起，正在连服务端";
        return { ok: true, summary: `唤醒层进程在跑 pid ${wake.live.pid} · ${state}`, detail };
      }
      return { ok: true, summary: "harness 是 other，没有可唤醒的会话可起（用 CLI 收消息）" };
    },
  };
}

/** 第 4 步 真发一条 @ 验证：以本身份发一条 `[wake-verify]` @ 自己、等回执（#990）；可注入（测试用桩）。 */
function verifyStep(): Step<JoinCtx> {
  return {
    id: "verify",
    title: "真发一条 @ 验证",
    run(ctx) {
      return ctx.deps.verifyWake({
        channel: ctx.slug,
        identity: ctx.identity ?? ctx.agentName,
        harness: ctx.harness,
        listener: ctx.listener,
      });
    },
  };
}

/** ✅ 句：写明谁会被唤醒（pid / 起法），别让人以为是眼前这个普通会话（#979 修法 3）。 */
function completionLine(ctx: JoinCtx): string {
  const { harness, slug } = ctx;
  const identity = ctx.identity ?? ctx.agentName;
  if (harness === "claude" && ctx.claudePluginRestart) {
    // #961：插件刚装/刚更新，当前这个会话还挂着旧的——「要重开」是结论的一部分，不能埋在补充行里。
    // #979：重开也得用 party claude 起，普通 claude 起的会话是蛰伏档。
    return (
      `✅ 接入完成，差一次重开：claude 插件已是 ${RUNNING_VERSION}，【用 ${claudeArmCommand(slug)} 新开一个 Claude 会话】后 @ ${identity} 就能唤醒它；` +
      `当前这个会话还挂着旧插件，不会被唤醒。`
    );
  }
  if (ctx.listener !== null) {
    return `✅ 接入完成：现在 @ ${identity}，这台机器上${ctx.listener.description}就能被唤醒来协作。`;
  }
  return `✅ 接入完成：${identity} 已绑到 #${slug}（harness 是 ${harness}，没有唤醒层）；收消息用 party watch ${slug} 或常驻 party serve ${slug}。`;
}

// ── orchestrator ────────────────────────────────────────────────────────────
export async function runJoin(opts: JoinOptions, deps: JoinDeps): Promise<number> {
  const { server, channel: slug, agentName, token } = opts;
  const home = agentpartyHome();
  const agentsDir = pathJoin(home, "agents");
  const configPath = pathJoin(agentsDir, configFileName(agentName, slug));
  const rulesPath = pathJoin(agentsDir, rulesFileName(agentName, slug));

  // token 只经环境变量往下游传（init/send 从 AGENTPARTY_TOKEN / config 读），绝不进 argv。
  process.env.AGENTPARTY_TOKEN = token;
  process.env.AGENTPARTY_CONFIG = configPath;

  // harness：显式 --harness 是**事实**，永远优先；没给就从进程祖先链探测；探不出＝other 并说出来（#924）。
  const detected = opts.harnessFlag === null ? detectHarnessFromAncestry(process.ppid) : null;
  const harness: JoinPackHarness = opts.harnessFlag ?? detected ?? "other";
  const harnessKnown = opts.harnessFlag !== null || detected !== null;

  deps.log(`party join → #${slug} as ${agentName}（harness: ${harness}${harnessKnown ? "" : " · 探测不出，按 other 处理"}，server ${server}）`);

  const ctx: JoinCtx = {
    opts,
    deps,
    harness,
    slug,
    agentName,
    configPath,
    rulesPath,
    mcpName: mcpServerName(agentName),
    claudePluginRestart: false,
    identity: null,
    receiveMode: "interactive",
    listener: null,
  };
  // other 档没有唤醒层：第 3、4 步无物可查，只跑到第 2 步（接收方式＝CLI）。
  const steps: Step<JoinCtx>[] = harness === "other"
    ? [versionStep(), identityStep(harnessKnown), receiveModeStep()]
    : [versionStep(), identityStep(harnessKnown), receiveModeStep(), wakeableSessionStep(), verifyStep()];
  const outcome = await runSteps({ steps, ctx, log: deps.log, rerun: RERUN });
  deps.log("");
  if (outcome.ok) {
    deps.log(completionLine(ctx));
    return 0;
  }
  deps.log(`接入停在第 ${outcome.stoppedAt.index} 步（${outcome.stoppedAt.title}）——做完上面那一条，重跑同一条 ${RERUN}。`);
  // 这句是整段引导存在的理由：这类失败**没有任何报错**，不明说就没人知道自己坏了。
  deps.log("在这一步完成之前：@ 你可能不会有任何反应，而且不会有任何报错——别人只会以为你在忙。");
  return 1;
}

/**
 * 第 2 步的那一问（有 TTY 才问）。非 TTY 返回 null——沉默不等于选择，按默认走并印出所选。
 * 只用 node:readline，不引新依赖。
 */
async function promptReceiveMode(slug: string): Promise<ReceiveMode | null> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `         1) 交互式 Claude 会话（${claudeArmCommand(slug)}）\n` +
          `         2) 常驻 ${claudeServeCommand(slug)}\n` +
          "         选 [1/2]（回车＝1）：",
        resolve,
      );
    });
    return answer.trim() === "2" ? "serve" : "interactive";
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { flags } = parseArgs(argv, { booleans: ["yes", "coexist"] });
  const unknown = unknownFlagError(flags, [...JOIN_FLAGS, "yes", "coexist"]);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, JOIN_FLAGS);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }

  const rawServer = str(flags.server);
  const slug = str(flags.channel);
  const agentName = str(flags.as);
  if (rawServer === undefined || slug === undefined || agentName === undefined) {
    console.error("need --server, --channel and --as. See: party join --help");
    return 1;
  }
  const server = normalizeServerUrl(rawServer);
  if (server === null) {
    console.error("--server must be an http(s) URL without credentials");
    return 1;
  }
  if (!isSlug(slug)) {
    console.error("--channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  if (!AGENT_NAME_RE.test(agentName)) {
    console.error("--as must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  const harnessFlagRaw = str(flags.harness);
  if (harnessFlagRaw !== undefined && !["codex", "claude", "other"].includes(harnessFlagRaw)) {
    console.error("--harness must be one of: codex, claude, other");
    return 1;
  }
  const harnessFlag = (harnessFlagRaw ?? null) as JoinPackHarness | null;
  // #597：邀请人的频道身份可能是 account id（lark:on_xxx），不满足 name 正则——不 @，别让报到报错。
  const mentionRaw = str(flags.mention);
  const mention = mentionRaw !== undefined && AGENT_NAME_RE.test(mentionRaw) ? mentionRaw : null;
  if (mentionRaw !== undefined && mention === null) {
    console.error(`note: --mention ${mentionRaw} 不是合法 name，报到不 @（用 party who 反查 handle）`);
  }

  // token 只从环境变量读（#676）——绝不接受 --token，那会把凭据落进 argv/ps/history。
  const token = process.env.AGENTPARTY_TOKEN?.trim();
  if (token === undefined || token === "") {
    console.error(
      "need a token via the AGENTPARTY_TOKEN env var, e.g.\n" +
        `  AGENTPARTY_TOKEN='<token>' party join --server ${server} --channel ${slug} --as ${agentName}`,
    );
    return 1;
  }

  const deps: JoinDeps = {
    spawn: spawnSync,
    initRun: (a) => import("./init").then((m) => m.run(a)),
    hookRun: (a) => import("./hook").then((m) => m.run(a)),
    sendRun: (a) => import("./send").then((m) => m.run(a)),
    log: (line) => console.log(line),
    errlog: (line) => console.error(line),
    home: process.env.HOME ?? homedir(),
    codexWakeChecklist: () => buildWakeChecklist(diagnoseCodexWake()),
    claudePluginShell: () => inspectClaudePluginShell(),
    claudeArmedListener: () =>
      probeClaudeArmedListener({ lockDir: defaultInstanceLockDir(), config: readConfig(), channel: slug }),
    startCodexWakeLayer: async () => {
      const hook = await import("./hook");
      // 与 SessionStart 完全同一条路径（同一套开关 / 去重 / 标记 / 日志），只是由 join 触发。
      // 身份靠 AGENTPARTY_CONFIG（上面已设）走 env 档解析，绝不按 cwd 猜（#917）。
      return hook.maybeStartCodexAutoWake(
        { hook_event_name: "SessionStart", source: "party-join", cwd: process.cwd() },
        hook.defaultCodexAutoWakeDeps(process.env),
      );
    },
    codexWakeLayerLive: () =>
      probeCodexWakeLayer({
        home: agentpartyHome(),
        lockDir: defaultInstanceLockDir(),
        config: readConfig(),
        channel: slug,
      }),
    codexAncestorPid: () => {
      const found = findHarnessAncestor(process.ppid);
      return found !== null && found.harness === "codex" ? found.pid : null;
    },
    chooseReceiveMode: promptReceiveMode,
    claudeDefaultArgs: () => resolveClaudeDefaultArgs(process.env, agentpartyHome()),
    verifyWake: roundTripWakeVerifier(),
  };
  return runJoin(
    { server, channel: slug, agentName, harnessFlag, mention, yes: flags.yes === true, coexist: flags.coexist === true, token },
    deps,
  );
}
