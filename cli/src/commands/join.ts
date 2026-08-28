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
//    版本不一致时 SessionStart 根本没布上）；codex 档是唤醒层**进程真的在**（join 收尾主动拉起，
//    再探活）。任一没成就不印 ✅，照实说本会话此刻能被怎么叫到。
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
  activeCodexAutoWakePid,
  codexAutoWakeAuth,
  codexAutoWakeMarkerPath,
  codexAutoWakeTarget,
  runningServePid,
} from "../codex-auto-wake";
import { defaultInstanceLockDir, isSameLiveProcess } from "../instance-lock";
import { listCodexSessions, registerCodexSession } from "../claude-session-registry";
import { findHarnessAncestor } from "../join-binding";
import {
  CLAUDE_PLUGIN_MIN_VERSION,
  inspectClaudePluginShell,
  parseClaudePluginList,
  type ClaudePluginShellInspection,
} from "./doctor";
import type { CodexAutoWakeOutcome } from "./hook";

const JOIN_FLAGS = ["server", "channel", "as", "harness", "mention"];
const HELP = `usage: AGENTPARTY_TOKEN='<token>' party join --server URL --channel SLUG --as NAME [--harness codex|claude|other] [--mention name] [--yes] [--coexist]

One command that does the whole join: write config + rules, dedupe (#907), bind
identity (#924), register the MCP server (probe-then-add, #898), install and approve
the codex wake hook (#901/#942/#943), check in, and print one final verdict — either
"全部就绪" or "还差第 N 步: <one command>". No 108-line paste, no per-line reading.

The token comes ONLY from the AGENTPARTY_TOKEN env var — never a flag, so it stays out
of argv / ps / shell history (#676).

Options:
  --server URL   AgentParty server URL
  --channel SLUG channel to join (created if missing)
  --as NAME      your agent identity name (config/rules filename, MCP name, check-in)
  --harness H    codex | claude | other. Omit to auto-detect from the process tree;
                 if it cannot be told, join proceeds as "other" and says so.
  --mention NAME @ the inviter in the check-in line (dropped if not a valid name)
  --yes          approve the codex hook trust flip non-interactively (passed to
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

// 收尾自检的一格。gate 步骤全绿才「全部就绪」；best-effort 步骤只呈现、不决定结论。
interface GateStep {
  id: string;
  ok: boolean;
  label: string;
  evidence: string;
  remedy?: string;
  /** 做 remedy 之前必须知道的话（版本错配、要重开会话……），不是第二件待办。 */
  notes?: string[];
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
   * codex 档收尾（#957）：主动拉起唤醒层。缺省＝hook.ts 的 maybeStartCodexAutoWake（与 SessionStart
   * 同一条路径，同一套去重/标记），join 只是多给它一次机会——它此刻已有身份和 token，不必等下次会话。
   */
  startCodexWakeLayer: () => Promise<CodexAutoWakeOutcome>;
  /** codex 档收尾自检（#957）：唤醒层进程真的在吗。缺省＝probeCodexWakeLayer（锁 + 启动标记 + 探活）。 */
  codexWakeLayerLive: () => Promise<CodexWakeLayerLiveness | null>;
  /** 跑 join 的那个 codex 进程 pid（进程祖先链）；找不到 null。用于把本会话在注册表里挂到本频道。 */
  codexAncestorPid: () => number | null;
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

const CLAUDE_PLUGIN = "agentparty@agentparty";
const MARKETPLACE = "leeguooooo/AgentParty";

/**
 * 本机已装的 agentparty 插件版本。`undefined`＝读不出（claude 不可用 / 输出解析不了）；`null`＝没装。
 * 走的是 doctor 同一个解析器（parseClaudePluginList），判据不另写一份。
 */
function installedClaudePluginVersion(deps: JoinDeps): string | null | undefined {
  const r = deps.spawn("claude", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 30_000 });
  if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== "string") return undefined;
  const list = parseClaudePluginList(r.stdout);
  if (list === null) return undefined;
  return list.find((p) => p.id === CLAUDE_PLUGIN)?.version ?? null;
}

/**
 * 装 claude 插件（marketplace）——best-effort：装不上不阻断，只提示；能不能唤醒由收尾自检判。
 *
 * #961：`claude plugin install` 对已装的只回一句 "already installed"（exit 0），**永远不会升级**。
 * 于是本机插件停在旧版、CLI 已经是新版，doctor 判 plugin_version_mismatch，SessionStart 唤醒根本
 * 没布上。所以 install 之后读一次已装版本，≠ 当前 CLI 就跟一步 `plugin update`。
 *
 * 装了 / 更新了都要**重开 Claude 会话**才生效（当前会话还挂着旧插件）——这句必须进结论，
 * 不能埋在 warn 里，所以用 restartNeeded 带出去。
 */
function installClaudePlugin(deps: JoinDeps): StepOutcome & { restartNeeded: boolean } {
  const first = deps.spawn("claude", ["plugin", "marketplace", "add", MARKETPLACE], { encoding: "utf8", timeout: 60_000 });
  if (first.error !== undefined) {
    return { level: "skip", msg: "claude 二进制不可用，跳过插件安装（不影响 CLI 协作）", restartNeeded: false };
  }
  const before = installedClaudePluginVersion(deps);
  let anyFail = first.status !== 0;
  for (const args of [["plugin", "install", CLAUDE_PLUGIN], ["plugin", "enable", CLAUDE_PLUGIN]]) {
    const r = deps.spawn("claude", args, { encoding: "utf8", timeout: 60_000 });
    if (r.error !== undefined || r.status !== 0) anyFail = true;
  }
  let updated = false;
  if (before !== undefined && before !== null && before !== RUNNING_VERSION) {
    const r = deps.spawn("claude", ["plugin", "update", CLAUDE_PLUGIN], { encoding: "utf8", timeout: 60_000 });
    if (r.error !== undefined || r.status !== 0) anyFail = true;
    else updated = true;
  }
  const after = installedClaudePluginVersion(deps);
  // 装上了（之前没有）或换了版本 ⇒ 当前会话还挂着旧的，必须重开。
  const restartNeeded = before !== after && after !== undefined;
  if (anyFail) {
    // 修法要对症：已装旧版就是 update（install 原地踏步），没装才是 install。
    const fix = after === null || after === undefined
      ? `claude plugin install ${CLAUDE_PLUGIN}`
      : `claude plugin update ${CLAUDE_PLUGIN}`;
    return {
      level: "warn",
      msg: `claude 插件未完全装上（best-effort，不阻断；手动 ${fix}，然后重开会话）——能不能被唤醒见下方自检`,
      remedy: fix,
      restartNeeded,
    };
  }
  if (after !== undefined && after !== null && after !== RUNNING_VERSION) {
    const fix = compareVersions(after, RUNNING_VERSION) > 0 ? "party upgrade" : `claude plugin update ${CLAUDE_PLUGIN}`;
    return {
      level: "warn",
      msg: `claude 插件是 ${after}，CLI 是 ${RUNNING_VERSION}，版本不一致时 SessionStart 唤醒不会布上——手动 ${fix}`,
      remedy: fix,
      restartNeeded,
    };
  }
  const msg = updated
    ? `claude 插件已从 ${before} 更新到 ${after}（需重开 Claude 会话才生效）`
    : before === null
      ? `claude 插件已安装（${after}；需重开 Claude 会话才生效）`
      : `claude 插件已是 ${after ?? RUNNING_VERSION}（跳过）`;
  return { level: "ok", msg, restartNeeded };
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

/** codex 档收尾：先认领本会话、再主动拉起唤醒层、再探活。三步各自失败都不抛，全部进证据。 */
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
      ? { level: "warn", msg: `已尝试拉起 party serve ${slug} --runner codex，但探不到它的进程——见下方自检` }
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

/** 收尾自检：从**本地盘的真实状态**重判「就绪 / 还差哪一步」（#926），不信步骤返回码。 */
function buildJoinGate(
  harness: JoinPackHarness,
  slug: string,
  checkinOk: boolean,
  deps: JoinDeps,
  codexWake: CodexWakeLayerState | null,
): { steps: GateStep[]; remaining: number; next: { do: string; notes: string[] } | null } {
  const cfg = readConfig();
  const identity = cfg?.identity?.name ?? null;
  const server = cfg?.server ?? null;
  const steps: GateStep[] = [
    {
      id: "channel_bound",
      ok: server !== null,
      label: "写下了本频道的身份配置",
      evidence: server === null ? "" : `#${slug} @ ${server}`,
      remedy: "AGENTPARTY_TOKEN='<token>' party join --server <url> --channel <slug> --as <name>",
    },
    {
      id: "identity_resolved",
      ok: identity !== null,
      label: "服务端确认了身份",
      evidence: identity === null ? "" : `${identity}`,
      remedy: "检查 token 是否有效、server 是否可达，然后重跑 party join",
    },
  ];
  // codex 档：把 #926 的 hook 两步原样并进来（装了 hook、批了信任）——那是 codex 能不能被 @ 唤醒的闸。
  // 复用同一份 wake 清单：hook 步骤的 ok/fail 由 diagnoseCodexWake 读**真实盘状态**决定，
  // next.do 的探测式修法（#942）也直接取它的，别自己另写一套判定。
  let codexWakeNext: { do: string; notes: string[] } | null = null;
  if (harness === "codex") {
    const wake = deps.codexWakeChecklist();
    codexWakeNext = wake.next === null ? null : { do: wake.next.do, notes: wake.next.notes };
    for (const s of wake.steps) {
      if (s.id === "hook_installed" || s.id === "hook_trusted") {
        steps.push({ id: s.id, ok: s.ok, label: s.label, evidence: s.evidence });
      }
    }
  }
  // claude 档（#961）：唤醒层就是 Marketplace 插件的 SessionStart hook。装没装、启没启用、版本是否
  // 与 CLI 一致、包是否完整——doctor 的 shell 检查（bridge claude --check 的 lifecycle）说了算。
  // 版本不一致时插件的 hooks 与本版 CLI 对不上，SessionStart 根本没布上，✅ 就是假的。
  if (harness === "claude") {
    const shell = deps.claudePluginShell();
    const ok = shell.status === "ready";
    const remedy = claudePluginRemedy(shell);
    steps.push({
      id: "plugin_lifecycle_ready",
      ok,
      label: "claude 插件装到位、已启用、版本与 CLI 一致（SessionStart 唤醒靠它）",
      evidence: ok
        ? `${CLAUDE_PLUGIN} ${shell.plugin.version ?? RUNNING_VERSION}`
        : `blocker: ${shell.blockers.join(", ")}${shell.plugin.version === undefined ? "" : `（本机插件 ${shell.plugin.version}，CLI ${RUNNING_VERSION}）`}`,
      remedy: remedy.do,
      notes: remedy.notes,
    });
  }
  steps.push({
    id: "checkin_sent",
    ok: checkinOk,
    label: "在频道里报到了（否则别人看不到你）",
    evidence: checkinOk ? "已发送" : "",
    remedy: `party send "👋 <你> 报到" --channel ${slug}`,
  });
  // codex 档（#957）：四项静态前置条件齐了 ≠ 唤醒真的会发生。唤醒层是 `party serve --runner codex`
  // 这个进程；它在不在，判据只有一个——进程探活。放在最后：前面任一步没过，这一步的修法都没意义。
  if (harness === "codex" && codexWake !== null) {
    const live = codexWake.live;
    const why = codexWake.outcome.action === "skip" || codexWake.outcome.action === "start-failed"
      ? codexWake.outcome.detail
      : "拉起了但探不到进程（可能刚退出：看 ~/.agentparty/logs/codex-auto-wake.log）";
    steps.push({
      id: "wake_layer_live",
      ok: live !== null,
      label: "唤醒层进程在跑（无人值守时被 @ 也能拉起 codex runner）",
      evidence: live === null
        ? ""
        : `pid ${live.pid} · ${live.source === "serve-lock" ? "serve 已持锁（连上服务端了）" : "刚拉起，正在连服务端"}` +
          (codexWake.adoptionNote === null ? "" : `    ⚠ ${codexWake.adoptionNote}`),
      remedy: `新开一个 codex 会话（SessionStart 会重新拉起唤醒层），或手动：party serve ${slug} --runner codex`,
      notes: [why],
    });
  }
  const failed = steps.find((s) => !s.ok);
  let next: { do: string; notes: string[] } | null = null;
  if (failed !== undefined) {
    // codex 的 hook 步骤走 #942 的探测式修法（含桌面版/exec 等注记）；其余步骤给自己的一条 remedy。
    if (failed.id === "hook_installed" || failed.id === "hook_trusted") {
      next = codexWakeNext;
    } else {
      next = { do: failed.remedy ?? "重跑 party join", notes: failed.notes ?? [] };
    }
  }
  return { steps, remaining: steps.filter((s) => !s.ok).length, next };
}

// ── orchestrator ────────────────────────────────────────────────────────────
export async function runJoin(opts: JoinOptions, deps: JoinDeps): Promise<number> {
  const { server, channel: slug, agentName, token } = opts;
  const home = agentpartyHome();
  const agentsDir = pathJoin(home, "agents");
  const configPath = pathJoin(agentsDir, configFileName(agentName, slug));
  const rulesPath = pathJoin(agentsDir, rulesFileName(agentName, slug));
  const mcpName = mcpServerName(agentName);

  // token 只经环境变量往下游传（init/send 从 AGENTPARTY_TOKEN / config 读），绝不进 argv。
  process.env.AGENTPARTY_TOKEN = token;
  process.env.AGENTPARTY_CONFIG = configPath;

  // harness：显式 --harness 是**事实**，永远优先；没给就从进程祖先链探测；探不出＝other 并说出来（#924）。
  const detected = opts.harnessFlag === null ? detectHarnessFromAncestry(process.ppid) : null;
  const harness: JoinPackHarness = opts.harnessFlag ?? detected ?? "other";
  const harnessKnown = opts.harnessFlag !== null || detected !== null;

  const bestEffort: { name: string; outcome: StepOutcome }[] = [];
  const record = (name: string, outcome: StepOutcome): void => {
    bestEffort.push({ name, outcome });
    deps.log(`  ${symbol(outcome.level)} ${name}: ${outcome.msg}`);
  };

  deps.log(`party join → #${slug} as ${agentName}（harness: ${harness}${harnessKnown ? "" : " · 探测不出，按 other 处理"}）`);

  // 1) 落盘 rules 文件——行为契约的持久拷贝（#845）。正文是 shared 静态常量，绝不掺 charter 等
  //    管理员可控文本（那有注释化防 RCE 的约束）。上下文被压缩/丢失后可重读。
  try {
    mkdirSync(agentsDir, { recursive: true });
    atomicWriteText(rulesPath, `${BEHAVIOR_CONTRACT_BODY_LINES.join("\n")}\n`);
    record("行为契约落盘", { level: "ok", msg: rulesPath });
  } catch (e) {
    record("行为契约落盘", { level: "warn", msg: `写 rules 文件失败：${e instanceof Error ? e.message : String(e)}` });
  }

  // 2) party init：写 config + 同频道判重（#907）+ 加入即绑定（#924）+ 拉 charter。全部复用 init.ts。
  //    harness 探不出时不传 --harness——让 init 也如实说「不知道是哪个 harness、没写绑定」（不硬编 other）。
  const initArgs = ["--server", server, "--channel", slug];
  if (harnessKnown) initArgs.push("--harness", harness);
  if (opts.coexist) initArgs.push("--coexist");
  const initCode = await deps.initRun(initArgs);
  if (initCode !== 0) {
    // init 失败是硬失败（config 没写 = 后面全白搭）。如实报，别继续假装成功。
    deps.errlog(`party init 失败（退出码 ${initCode}）——token / server 有问题。修好后重跑 party join。`);
    return initCode;
  }

  // 3) 注册 MCP（先探后加，#898）。claude/codex 各走各的；other（探不出）两条都试——「不知道就都覆盖」。
  if (harness === "claude" || harness === "other") {
    record("注册 claude MCP", registerClaudeMcp(deps, mcpName, configPath, slug));
  }
  if (harness === "codex" || harness === "other") {
    record("注册 codex MCP", registerCodexMcp(deps, mcpName, configPath, slug));
  }

  // 4) 装 harness 插件（best-effort）。claude 插件承载 SessionStart/End→会话注册表+可发现+跨会话（#848）；
  //    codex 插件同理（#850）。other 档不装（不知道装哪个）。
  let claudePluginRestart = false;
  if (harness === "claude") {
    const outcome = installClaudePlugin(deps);
    claudePluginRestart = outcome.restartNeeded;
    record("装 claude 插件", outcome);
  }
  if (harness === "codex") record("装 codex 插件", installCodexPlugin(deps));

  // 5a) claude 档：crossSessionInbound=accept（#844），否则跨会话 @ 默认 hold 会被 drop。
  if (harness === "claude") record("开启跨会话 @ 接收", setClaudeInboxAccept(deps));

  // 5b) codex 档：装 + 当场批准 Stop hook（#901/#942/#943）。复用 party hook install --codex：
  //     它当场问一句 y/N（--yes 非交互直批），只翻我们自己那两条，绝不用 --dangerously-bypass-hook-trust。
  if (harness === "codex") {
    const hookArgs = ["install", "--codex"];
    if (opts.yes) hookArgs.push("--yes");
    const hookCode = await deps.hookRun(hookArgs);
    record(
      "装 + 批准 codex hook",
      hookCode === 0
        ? { level: "ok", msg: "hook 已装（信任状态见下方自检）" }
        : { level: "warn", msg: `party hook install --codex 退出码 ${hookCode}——信任状态见下方自检` },
    );
  }

  // 6) 报到（#597）。init 只写配置不发言，必须补这一条，否则网页/频道里看不到你。能 @ 邀请人就 @。
  const checkinMsg = `👋 ${agentName} 报到，来参与协作`;
  const sendArgs = [checkinMsg, "--channel", slug];
  if (opts.mention !== null) sendArgs.push("--mention", opts.mention);
  const sendCode = await deps.sendRun(sendArgs);
  const checkinOk = sendCode === 0;
  record(
    "频道报到",
    checkinOk ? { level: "ok", msg: "已在频道报到" } : { level: "fail", msg: `报到失败（退出码 ${sendCode}）` },
  );

  // 6b) codex 档（#957）：主动拉起唤醒层。跑 join 的这个会话的 SessionStart 早过去了（那会儿还没身份），
  //     不拉它就从生到死没有唤醒层——只有用户下次发言、回合结束时 Stop hook 才把 @ 交给他。
  let codexWake: CodexWakeLayerState | null = null;
  if (harness === "codex") codexWake = await bringUpCodexWakeLayer(deps, slug, record);

  // 7) 收尾自检（#926）：这是包的末尾，用户看到的就这一句结论。从本地盘真实状态重判，不信步骤返回码。
  const gate = buildJoinGate(harness, slug, checkinOk, deps, codexWake);
  deps.log("");
  deps.log(`接入自检 · #${slug}`);
  for (const s of gate.steps) {
    deps.log(`  ${s.ok ? "✓" : "✗"} ${s.label}${s.evidence === "" ? "" : `    ${s.evidence}`}`);
  }
  deps.log("");
  if (gate.remaining === 0) {
    if (harness === "claude" && claudePluginRestart) {
      // #961：插件刚装/刚更新，当前这个会话还挂着旧的——「要重开」是结论的一部分，不能埋在 warn 里。
      deps.log(
        `✅ 全部就绪，差一次重开：claude 插件已是 ${RUNNING_VERSION}，【新开一个 Claude 会话】后 @ ${agentName} 就能唤醒它；` +
          `当前这个会话还挂着旧插件，不会被唤醒。`,
      );
      return 0;
    }
    deps.log(`✅ 全部就绪：现在 @ ${agentName}，这台机器上的 ${harness} 会话就能被唤醒来协作。`);
    return 0;
  }
  const failed = gate.steps.find((s) => !s.ok);
  if (failed?.id === "wake_layer_live") {
    // #957：前置条件全齐、唯独唤醒层没起来。此刻的真实能力是 Stop hook 兜底——照实说，绝不说「就能被唤醒」。
    deps.log(`⚠ 接入完成，但唤醒层没起来：${gate.next?.notes[0] ?? "原因不明"}`);
    deps.log(
      `本会话只能在你下次发言、回合结束时收到 @（Stop hook 会把积压的 @ 交给你）；` +
        `要无人值守被唤醒，请新开一个 codex 会话。`,
    );
    deps.log(`  或手动拉起：party serve ${slug} --runner codex`);
    return 1;
  }
  deps.log(`还差 ${gate.remaining} 步。现在只做这一件事：`);
  if (gate.next !== null) {
    deps.log(`  ${gate.next.do}`);
    for (const note of gate.next.notes) deps.log(`  ${note}`);
  }
  deps.log(`  做完回来再跑一次：party wake check`);
  deps.log("");
  // 这句是整段自检存在的理由：这类失败**没有任何报错**，不明说就没人知道自己坏了。
  deps.log("在这一步完成之前：@ 你可能不会有任何反应，而且不会有任何报错——别人只会以为你在忙。");
  return 1;
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
  };
  return runJoin(
    { server, channel: slug, agentName, harnessFlag, mention, yes: flags.yes === true, coexist: flags.coexist === true, token },
    deps,
  );
}
