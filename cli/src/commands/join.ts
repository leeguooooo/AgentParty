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

/** 装 harness 插件（marketplace）——best-effort：装不上不阻断，只提示。 */
function installHarnessPlugin(deps: JoinDeps, harness: "claude" | "codex"): StepOutcome {
  const bin = harness;
  const steps: string[][] =
    harness === "claude"
      ? [
          ["plugin", "marketplace", "add", "leeguooooo/AgentParty"],
          ["plugin", "install", "agentparty@agentparty"],
          ["plugin", "enable", "agentparty@agentparty"],
        ]
      : [
          ["plugin", "marketplace", "add", "leeguooooo/AgentParty"],
          ["plugin", "add", "agentparty@agentparty"],
        ];
  const first = deps.spawn(bin, steps[0]!, { encoding: "utf8", timeout: 60_000 });
  if (first.error !== undefined) {
    return { level: "skip", msg: `${bin} 二进制不可用，跳过插件安装（不影响 CLI 协作）` };
  }
  let anyFail = first.status !== 0;
  for (const args of steps.slice(1)) {
    const r = deps.spawn(bin, args, { encoding: "utf8", timeout: 60_000 });
    if (r.error !== undefined || r.status !== 0) anyFail = true;
  }
  return anyFail
    ? { level: "warn", msg: `${bin} 插件未完全装上（best-effort，不阻断；重开会话或手动 ${bin} plugin install agentparty@agentparty）` }
    : { level: "ok", msg: `${bin} 插件已安装` };
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

function symbol(level: StepLevel): string {
  return level === "ok" ? "✓" : level === "skip" ? "·" : level === "warn" ? "!" : "✗";
}

/** 收尾自检：从**本地盘的真实状态**重判「就绪 / 还差哪一步」（#926），不信步骤返回码。 */
function buildJoinGate(
  harness: JoinPackHarness,
  slug: string,
  checkinOk: boolean,
  deps: JoinDeps,
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
  steps.push({
    id: "checkin_sent",
    ok: checkinOk,
    label: "在频道里报到了（否则别人看不到你）",
    evidence: checkinOk ? "已发送" : "",
    remedy: `party send "👋 <你> 报到" --channel ${slug}`,
  });
  const failed = steps.find((s) => !s.ok);
  let next: { do: string; notes: string[] } | null = null;
  if (failed !== undefined) {
    // codex 的 hook 步骤走 #942 的探测式修法（含桌面版/exec 等注记）；其余步骤给自己的一条 remedy。
    if (failed.id === "hook_installed" || failed.id === "hook_trusted") {
      next = codexWakeNext;
    } else {
      next = { do: failed.remedy ?? "重跑 party join", notes: [] };
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
  if (harness === "claude") record("装 claude 插件", installHarnessPlugin(deps, "claude"));
  if (harness === "codex") record("装 codex 插件", installHarnessPlugin(deps, "codex"));

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

  // 7) 收尾自检（#926）：这是包的末尾，用户看到的就这一句结论。从本地盘真实状态重判，不信步骤返回码。
  const gate = buildJoinGate(harness, slug, checkinOk, deps);
  deps.log("");
  deps.log(`接入自检 · #${slug}`);
  for (const s of gate.steps) {
    deps.log(`  ${s.ok ? "✓" : "✗"} ${s.label}${s.evidence === "" ? "" : `    ${s.evidence}`}`);
  }
  deps.log("");
  if (gate.remaining === 0) {
    deps.log(`✅ 全部就绪：现在 @ ${agentName}，这台机器上的 ${harness} 会话就能被唤醒来协作。`);
    return 0;
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
  };
  return runJoin(
    { server, channel: slug, agentName, harnessFlag, mention, yes: flags.yes === true, coexist: flags.coexist === true, token },
    deps,
  );
}
