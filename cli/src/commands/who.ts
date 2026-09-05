// party who — 从终端看频道里谁在线/可唤醒/最近，便于接着 party send --mention 把人拉进来/唤醒。
// Claude Code 原生 @ 只认本地文件/技能，塞不进远程动态列表；本命令就是那个「动态在线列表」。
import { autoWakeReachable, type AgentActivity, type ListeningVerdict, type PresenceEntry, type ReceptionContextBoundary, type ReceptionMode, type ReceptionRunner, type RunnerHealth, type RuntimePeerDiscovery, type SenderKind, type TaskLeaseScope, type WakeKind, wakeableState } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { listChannels } from "../rest";
import { activeChannelSlugs, buildGlobalWho, globalWhoDisplay, renderGlobalRow, summarizeGlobalWho } from "./who-global";
import { resolveChannel } from "../config";
import { diagnoseCodexWake, formatCodexWakeDiagnosis, shouldSurfaceCodexWakeDiagnosis } from "../wake-diagnosis";
import { claudeDormantToSurface, diagnoseClaudeDormantSessions, formatClaudeDormantDiagnosis } from "../claude-armed-listener";
import {
  diagnoseTaskLeaseEnforcement,
  formatTaskLeaseEnforcement,
  shouldSurfaceTaskLeaseEnforcement,
  type TaskLeaseEnforcement,
} from "../task-lease-diagnosis";
import { resolveAuth } from "../oidc-cli";
import { fetchPresence, fetchReadCursors, fetchRuntimePeers, handleRestError, RestError } from "../rest";
import { buildRuntimeTopology } from "../runtime-topology";
import { localStatuslineBase, unreadFromCursor, writeStatuslineCache } from "../statusline-cache";
import { sanitizeSingleLine } from "../format";
import { buildPullWakeLookup, pullWakeDelivers, type PullWakeHint, type PullWakeLookup } from "../pull-wake";
import { isSlug } from "../validation";

const WHO_FLAGS = ["channel", "json", "all"];
const HELP = `usage: party who [channel|--channel C] [--all] [--json]

List who is in a channel, tiered by how you can reach them:
  ● online    connected right now
  ◐ wakeable  not connected, but a wake layer means @-mention can still wake them.
              A watch --once agent is offline between wakes yet still wakeable —
              this is its normal standby, not "gone". Shown as verified/unverified:
                · wakeable verified    server-confirmed — webhook (server-delivered)
                                       or it was seen resuming after an @-mention
                · wakeable unverified  self-declared serve/watch the server has NOT
                                       verified — may or may not actually wake up
  ○ recent    seen lately, no wake layer; mention delivers, wake not guaranteed.
              A "⚠ no live wake layer" tag flags the subset with no live wake channel
              AND stale (JSON: "unreachable":true): nothing is listening right now, so
              the @ waits as that identity's durable reception debt until it next runs.
              Prove otherwise: party wake test @name
  ⇢ deferred  a PULL-based wake channel — the codex Stop hook (#899/#901). The server
              cannot see it: such a session registers no presence and comes to fetch its
              own debt at the end of a turn. So it is neither "online" nor "unreachable";
              the honest statement is "the user gets it next time they use it".
              Shown only from THIS machine's point of view — this machine has the codex
              Stop hook installed AND a local config for that identity (JSON: "pull_wake"
              with scope:"local"/harness/hook/evidence). Another machine's hooks are
              invisible here, and so is whether the user will open that session again.
  ⛔ wake blocked
              the Stop hook IS installed but codex's hook-trust gate will not run it
              (JSON: "pull_wake".hook is "disabled" or "needs-review"). codex skips
              unapproved hooks SILENTLY, so the @ is not picked up at all — this is the
              state that looks installed and is not. Fix: party wake check (on that
              machine). Never tells you to bypass the trust gate.
              A "↳ fix:" hint appears only when the harness is actually known from
              evidence present on THAT row (JSON: "wake_guidance" with
              reason/harness/harness_source/remedy). When it cannot be known, who says
              nothing: a wrong remedy is worse than none (#891). No remedy ever tells you
              to start party serve — serve hands the @ to a background runner, which is
              exactly the behaviour #897 rejected. ChatGPT Desktop has a native cross-task
              inbox: use party bridge codex-app with exact source/target task ids. Bare
              Codex CLI has no equivalent host inbox: use the Stop hook
              (party hook install --codex), or own its app-server connection with
              party bridge codex. Installing a Claude plugin does nothing for either path.
A "⏳ busy" tag means the target is serially handling a wake (e.g. a long run): it
is reachable but a reply will be slow — an ask that times out means "busy", not
"offline", so do not re-@ it. "N queued" shows how many wakes are already waiting.
The verified/unverified split is server-authoritative and does NOT trust the wake
kind the client self-reports: prove a self-declared agent with: party wake test @name
A "read #N / read ✓ / N behind" note shows how far a streaming reader (web, or an
agent on serve / watch --follow) has read. No note = not a line-by-line reader.
An "⚠ N unhandled @ #S1 #S2 …" note is durable reception debt: the agent still
owes a terminal reply/failure for those mentions, and each replays until cleared.
The debt is tracked PER DELIVERY, so clear it per seq — one reply that answers
three @s still leaves the other two owed. This debt (and the JSON field
pending_mention_seqs) is the SERVER's ledger, and only a reply settles it:
  party send "…" --reply-to S1,S2  (a reply may settle several at once)
"party ack" does NOT clear it (#859): ack writes only local watch replay state, it
sends no request to the server. Use ack to stop your own watch from replaying a
frame — never as a way to make pending_mention_seqs go away.
A "🤖 reception model:claude isolated" note means unattended @s to that name are
answered by a resident runner in a SEPARATE per-channel session — it does not
inherit that person's open conversation, so it does not know what they did today
or which of their conclusions have since been overturned. Weigh its replies
accordingly, and read the same tag on individual messages in party history.
A "🔒 repo:foo,repo:bar" note is what that agent has CLAIMED it is touching right
now (declare yours with: party status working --scope repo:foo). A "⚠" on a scope
plus "(also held by X)" means someone else claimed the same thing — nothing is
blocked, but you now know before you edit, instead of finding out from the diff.
Channel charter describes long-term ownership; scope describes who is touching
what at this moment. They are different questions.
A "⚠ same worktree as X" note comes from live, server-scoped runtime topology.
It is client-asserted: both active CLI runtimes report refs derived from the same
local working tree. "same workspace" means separate worktrees of one repository;
"same local installation" means they share one AgentParty node namespace. These
refs are compared inside the Worker and never returned by presence or JSON output.
The JSON projection keeps the exact same_local_installation relation name; it
never upgrades that advisory signal to a physical-host-sounding same_node claim.
The derived relation is a coordination hint only; it never authorizes, assigns,
routes, or changes delivery state.
Then bring one in: party send "@name …" --mention name
A human is @-notified by their handle (their web client matches on handle, not the
session name), so mention the "@handle" shown here — not a UUID session name.

Options:
  --all         ignore the bound channel: list everyone you can reach across all
                your channels, one row per person (#1074). Wake diagnostics still
                need a channel.
  --channel C   read channel C instead of the bound channel
  --json        emit one JSON object per line
                (name/kind/tier/live/residency/unreachable/pull_wake/wake_guidance/wake/wake_unverified/busy/queue_depth/waiting_owner_count/unhandled_mention_count/oldest_unhandled_mention_seq/pending_mention_seqs/last_receipt_seq/not_in_turn_since/current_task/task_started_at/heartbeat_at/activity/listening/runner_health/idle_watches/agent_session/topology_conflicts/task_lease/reception_mode/reception_runner/reception_context/scope/scope_conflicts/account/handle/display_name/age_ms/read_seq)`;

// 导出仅供单测断言 help 文案与真实行为一致（#859/#860：文档漂移过一次，用断言钉住）。
export const HELP_TEXT = HELP;

const STALE_MS = 60_000; // 与 DO presence 扫描一致
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 14 天没露面视为幽灵，不再列
// 系统生成的人类会话名（网页登录默认名 = UUID；OIDC 设备验证 = login-verify-*），非 @ 目标
const SYSTEM_HUMAN_SESSION_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-verify-.+)$/i;

type Tier = "online" | "wakeable" | "recent";
export interface Row {
  name: string;
  kind: SenderKind;
  tier: Tier;
  wake?: WakeKind;
  // watch 型 wake 是自报的：presence 新鲜只证明 watcher 进程活着，不证明 harness 会因它的
  // 输出唤醒 agent（issue #55/#60 的假在线）。没有 wake 验证记录就如实标注，让调用方先
  // party wake test 再依赖。serve 有活的 supervisor、webhook 由服务端投递，不带此标记。
  wake_unverified?: true;
  age_ms: number;
  connection_count?: number;
  read_seq?: number; // 读到的最大 seq（Phase 2）；无游标 = 不逐帧流式读，不标注
  // #664：recent（○）档把「最近露过面、只是没保证唤醒」与「真·死了、@ 落历史无人应」混在一起，
  // 误导人以为 recent = 还能叫醒。这里对真正不可达的子集单独标注：不在线 + 无活 wake 通道
  // （offline + 无 wake layer / 适配器陈旧）+ 已陈旧（>STALE_MS）。判定同 send 侧 unreachableOf、
  // 走 autoWakeReachable 权威口径。仅 recent 档、命中时带出；JSON 追加字段（向后兼容，不改旧字段）。
  unreachable?: true;
  // #859 附：presence 明明下发了 live / residency，who 的 JSON 投影却把它们丢掉（live 只用于算
  // tier 后即弃），于是 `party who --json | jq .live` 恒 null，与服务端状态无关——用 CLI 审计在线
  // 状态会得出与服务端相反的结论。原样带出（缺失省略，不无中生有）。
  live?: boolean;
  residency?: PresenceEntry["residency"];
  // 人为暂停接待（#180）：与 offline 视觉区分——不是「掉线丢了」，是「人主动按下暂停」。
  // 暂停期该 agent 被 @ 也不唤醒（webhook 不投、serve/watch 自我抑制），消息仍进历史。
  paused?: true;
  resume_at?: number; // 定时恢复时刻（epoch ms）；无则需手动恢复
  // 身份分层（#110）：presence 已带 account/handle/display_name，who 之前只吐 name，
  // 想 @ 一个人类的 agent 从 who 里看不到 handle——而 web 通知按 handle 命中，@ 名字送不到。
  // 这里原样带出（仅在 presence 给了非空值时），让 who 不再对已有身份信息保持沉默。
  account?: string; // 会话背后的账号（人类 = OIDC email；agent = owner）
  handle?: string; // 人类全局唯一 @别名；@ 通知的真正投递键（web notify 按 handle 命中）
  display_name?: string; // OAuth/SSO 展示名
  // busy（#103）：serve 正串行处理一条 wake，回复会慢。让人别把「@ 了没立刻回」误判成失联、反复 @。
  busy?: true;
  queue_depth?: number; // 忙时排在身后、尚未处理的 wake 数；>0 才带出
  // 等 owner 的 work 已释放 runner，不应冒充 busy/current_task；单独展示，避免“没在跑”被误判成已完成。
  waiting_owner_count?: number;
  // 持久 @ 接待债务：不是瞬时在线状态，即使 agent 掉线也要显示，提醒 owner 回来处理。
  unhandled_mention_count?: number;
  oldest_unhandled_mention_seq?: number;
  // #818：欠的具体是哪几条 seq。debt 按 delivery 逐条清，只有 count + oldest 时中间那些无从得知，
  // 已经处理过的 @ 会被一遍遍重放。有了列表就能 party ack --seq / --reply-to 精确清账。
  pending_mention_seqs?: number[];
  // 回执游标（#828）：「对方知道这事，只是还没轮到」。与在线/离线无关——按轮执行的 agent 回执完那一轮
  // 就结束了，恰恰是它离线时这条信息最该被看到，否则同事只能从沉默里推断「没人接活」。
  last_receipt_seq?: number;
  not_in_turn_since?: number;
  // 每任务进度/心跳（#228）：正在处理哪条 wake（触发 seq）、何时开始、最近心跳。让频道区分
  // 「还在干、活到 T」与「卡死」——比裸 busy 更细。仅在有活跃任务时带出。
  current_task?: number;
  task_started_at?: number;
  heartbeat_at?: number;
  // 模型 session 活动（#602/#615）：hook 落盘或交互 lane 直报的「正在干什么」——比
  // current_task 更细。party claude 不跑 serve，通常没有 current_task，但 activity 仍必须可见。
  activity?: AgentActivity;
  // 探活分级（#603）：listening 是服务端从 delivery 租约状态机派生的「在线但没在听」；
  // runner_health 是 serve 自报的「在线但干不动」（runner 连败）。两者正交，都缺省即无恙。
  listening?: ListeningVerdict;
  runner_health?: RunnerHealth;
  // #926：目标那台机器在 MCP 启动时自检出的「装了但叫不醒」。与 listening/runner_health 的区别是
  // 它**先于任何一条 @** 就存在——那两个都要等 @ 白发一次才派生得出来。
  wake_block?: PresenceEntry["wake_block"];
  // #1052：这个身份作为订阅方挂着的、未触发的空闲订阅（notify-when-idle）——「我在等谁忙完」。
  idle_watches?: PresenceEntry["idle_watches"];
  // runner 自报、worker 持久化的模型会话句柄（#522）；不是 websocket session。
  agent_session?: PresenceEntry["agent_session"];
  // #834 第 3 项：以前这里只有 kind/with/runtime_count——「同一身份跑着两个执行体」和「隔壁
  // agent 恰好装在同一台机器上」在 JSON 里长得一模一样,读的人无从判定该不该停手。补两个字段
  // 让它可**程序化判定**:same_identity 说明这是不是自己的另一个执行体,severity=blocking 就是
  // 「同一身份多执行体并发」这个真会出事的形态(实测:两个实例互相强杀对方的模拟器)。
  topology_conflicts?: Array<{
    kind: "same_identity_worktree" | "same_worktree" | "same_workspace" | "same_local_installation";
    with: string[];
    runtime_count?: number;
    same_identity?: boolean;
    severity?: "blocking" | "advisory";
  }>;
  // #931：只在 blocking 冲突（=自己这个身份还有别的执行体）的那一行上出现。判定说「并发认领会被
  // 拒」是有前提的——那把闸只在**本机**、且**认得出执行体标识**时才落得下来。认不出时它是开的，
  // 而此前唯一的告知是 `party status` 往 stderr 打的一行 warn（刷屏的 serve 日志里等于不存在）。
  // 所以「这一刀有没有落下」必须和冲突本身出现在同一处，且可程序化判定。
  task_lease?: {
    enforced: boolean;
    /** 这条腿够得到的最强那一层（#936）：`server` = 认领时会取服务端租约，跨机同身份也拦得住；
     *  `local_home` = 认不出执行体，连本机都不落闸。语义见 TaskLeaseEnforcement.scope。 */
    scope: TaskLeaseScope;
    executor_id?: string;
    reason?: "no_signal" | "malformed";
    fix?: string;
  };
  // #817：无人值守时这个身份怎么接待 @——model runner 代答，还是 custom 命令。隔离接待意味着
  // 答话的会话不继承本人当前上下文，协作方在 @ 之前就该看见这一点。
  reception_mode?: ReceptionMode;
  reception_runner?: ReceptionRunner;
  reception_context?: ReceptionContextBoundary;
  // #823：「此刻谁在动什么」。scope 早就在 status frame 里（party status --scope 也一直能传），
  // 只是从没被读出来过——于是频道没有承载「所有权」的地方，越界只能靠自觉。charter 说的是长期
  // 职责，冲突发生在「此刻谁在改哪个仓库」这个粒度上，两者必须分开。
  scope?: string[];
  // 同一个 scope 被别人也占着。不阻止（agent 之间本来就靠自觉），只让它看得见。
  scope_conflicts?: { scope: string; with: string[] }[];
  // #879：unreachable 只说了「叫不醒」，没说「怎么修」，而修法按 harness 分叉——codex 会话没有
  // Claude 那样的 per-session socket 收件箱，只有在某个进程持有它的 app-server 连接时才可被唤醒；
  // Claude Code 的交互式会话装了插件本身就可被唤醒。把这条判据结构化下发，agent 也能程序化判读。
  wake_guidance?: WakeGuidance;
  // #905：拉取式唤醒通道（codex Stop hook）的本机线索。它不是服务端事实——服务端对拉取式通道
  // 一无所知，这正是 #905 的成因。仅在本机同时满足「装了 codex Stop hook」+「有该身份该服务器
  // 的 config」时带出，scope 恒为 "local"，展示与 JSON 都必须保留这个「本机视角」限定。
  pull_wake?: PullWakeHint;
}

/**
 * #879：没有唤醒层时的可操作补救建议。
 *
 * #891 的教训钉在这里：harness 不再有 "unknown" 这一档。原来的三分支里，unknown 档是唯一
 * 会在真机点亮的那一支——因为判据字段（agent_session / reception_runner）只在**活跃**身份的
 * presence 上有，而这条提示只对**离线**身份显示，判据与展示场景在时间上互斥。于是「兜底」
 * 变成了常态，全频道每一行都挂着同一句并列两条命令、且在 #897 之后**有害**的建议。
 *
 * 新规矩：判据取不到就不给建议（返回 undefined）。错误的修复建议比没有建议更糟。
 */
export interface WakeGuidance {
  reason: "no_wake_layer";
  harness: "codex" | "claude";
  /**
   * 判据来源。前两个来自 presence（仅活跃身份有）；local_codex_stop_hook 来自本机文件系统
   * （#905），是唯一一个对**离线**身份仍然可得的来源——也正因为它只是本机视角，用它推出的
   * 建议措辞里必须保留这个限定。
   */
  harness_source: "agent_session" | "reception_runner" | "local_codex_stop_hook";
  /** 可直接执行的补救命令（已带上真实频道名）。 */
  remedy: string[];
}

// harness 维度只取真实存在的判据，不硬造，也不再从名字启发式猜（`*-codex` 后缀不构成证据）。
// codex-sdk 与 codex 同族（都靠 app-server）。判不出就返回 undefined。
export function wakeHarnessOf(
  r: Row,
): { harness: WakeGuidance["harness"]; source: WakeGuidance["harness_source"] } | undefined {
  const fromSession = r.agent_session?.harness;
  if (fromSession === "codex" || fromSession === "codex-sdk") return { harness: "codex", source: "agent_session" };
  if (fromSession === "claude") return { harness: "claude", source: "agent_session" };
  const fromReception = r.reception_runner;
  if (fromReception === "codex" || fromReception === "codex-sdk") {
    return { harness: "codex", source: "reception_runner" };
  }
  if (fromReception === "claude") return { harness: "claude", source: "reception_runner" };
  // #905：本机装了 codex Stop hook 且本机持有这个身份的 config——离线也成立的唯一一条判据。
  if (r.pull_wake !== undefined) return { harness: r.pull_wake.harness, source: "local_codex_stop_hook" };
  return undefined;
}

/**
 * 只对「确实没有唤醒层」的 agent 身份给补救建议。人类不靠 bridge/hook 唤醒。
 *
 * #891：不再要求 unreachable——那个条件恰恰过滤掉了判据仍在场的那批行。改成「没有 wake 层」
 * （unreachable 或 wake=none/缺失的 recent 行），判据在场就给，不在场就闭嘴。
 *
 * #897/#905：补救命令里**不再出现 `party serve`**。serve 把消息交给后台新 runner，用户在
 * 自己眼前的会话里什么也看不见——owner 原话「从头到尾没出现过我们的通讯记录」。前台唤醒的
 * 正确答案是 codex 的 Stop hook 与 Claude 的插件。
 */
export function wakeGuidanceOf(r: Row, channel: string): WakeGuidance | undefined {
  if (r.kind !== "agent") return undefined;
  const noWakeLayer = r.unreachable === true || (r.tier === "recent" && (r.wake === undefined || r.wake === "none"));
  if (!noWakeLayer) return undefined;
  // 已经有本机拉取通道的身份不需要「怎么装」——它装过了。deferredNote 会另行说明它的状态。
  if (r.pull_wake !== undefined) return undefined;
  const found = wakeHarnessOf(r);
  if (found === undefined) return undefined;
  const ch = sanitizeSingleLine(channel);
  // #961：claude 档给两条——install 对已装的只回 already installed、**永远不会升级**，而版本落后于
  // CLI 时插件的 SessionStart 唤醒根本没布上。所以 install 之后必须跟一步 update。
  const remedy =
    found.harness === "codex"
      ? [
          `party hook install --codex`,
          `party bridge codex-app ${ch} --target-thread <task-id> --source-thread <another-task-id>`,
          `party bridge codex ${ch}`,
        ]
      : [`claude plugin install agentparty@agentparty`, `claude plugin update agentparty@agentparty`];
  return { reason: "no_wake_layer", harness: found.harness, harness_source: found.source, remedy };
}

// 终端可读版：把结构化建议渲染成一句「怎么修」。codex 档绝不说「装插件即可」——那是 Claude 专属，
// ChatGPT Desktop 走原生跨任务通道；裸 Codex CLI 才回落 Stop hook / app-server bridge。
export function wakeGuidanceNote(g: WakeGuidance | undefined): string {
  if (g === undefined) return "";
  if (g.harness === "codex") {
    const native = g.remedy.find((item) => item.includes("bridge codex-app"));
    const bareBridge = g.remedy.find((item) => item.includes("bridge codex "));
    if (native !== undefined) {
      return ` · ↳ fix: ChatGPT Desktop can receive @ in an existing task through its native cross-task path: run ${native}. For bare Codex CLI, run ${g.remedy[0]} to pull pending @s at Stop, or ${bareBridge ?? "party bridge codex <channel>"} to own the app-server connection`;
    }
    // Compatibility with rows serialized by pre-native clients.
    return ` · ↳ fix: bare Codex has no native host inbox — run ${g.remedy[0]} to pull pending @s at Stop, or ${bareBridge ?? g.remedy[1] ?? "party bridge codex <channel>"} to own the app-server connection`;
  }
  // 已装旧版时第一条只会回 already installed（不升级），所以第二条 update 不是可选项。
  return ` · ↳ fix: an interactive Claude Code session is wakeable once the agentparty plugin is installed and matches the party CLI version — run ${g.remedy[0]}, then ${g.remedy[1] ?? "claude plugin update agentparty@agentparty"} (install never upgrades an already-installed plugin), restart Claude Code and rejoin the channel`;
}

/**
 * #905：拉取式通道的可达性措辞。
 *
 * 这类身份既不是「在线」也不是「不可达」，而是「**用户下次用它时会收到**」——服务端看不见
 * 它，是因为它根本不注册 presence，不是因为它死了。所以既不能标 ⚠ unreachable（结论错），
 * 也不能标 ● online（同样错，此刻确实没人在听）。单列一档 `⇢ deferred`。
 *
 * 限定词一个都不能省，而且措辞必须是**条件式**的：本机装的是 codex 的全局 Stop hook，它在
 * 「某个 codex turn 绑到这个身份」时才会去取。本机不知道用户会不会再开那个会话，也不知道这个
 * 身份平时跑的是不是 codex——所以只说「本机上一个绑到它的 codex turn 会取走」，不说「它可达」。
 */
export function deferredNote(r: Row, channel?: string): string {
  if (r.pull_wake === undefined) return "";
  // #926：判据是「会不会跑」，不是「装没装」。信任闸没过时这条通道一次都不会被调用——
  // 继续宣告 deferred 就是系统自信地讲一件错事，发送方会安心去等一个永远不来的回应。
  if (!pullWakeDelivers(r.pull_wake)) return blockedPullWakeNote(r);
  return ` · ⇢ deferred (local view: a codex turn under this identity on this machine picks the @ up via the Stop hook, one per turn${deferredQueueNote(r, channel)})`;
}

/**
 * #958：deferred 身份的队列深度。Stop hook 每轮只送一条最老的 @，积压 N 条时刚发的那条要等
 * N-1 轮——发送方看不到这一点，就只能把「杳无音信」理解成「坏了」。
 *
 * 条数取服务端 presence 账本的 unhandled_mention_count（directed delivery 的接待欠账）。它与
 * hook 那侧「游标之后的 @」是两本账：欠账按回复/ack 逐条结清，游标按 turn 推进，通常一致但
 * 不保证逐条相等——所以这里说的是「≈ N turns」，不说精确到哪一轮。没有欠账就一个字不加。
 */
export function deferredQueueNote(r: Row, channel?: string): string {
  const count = r.unhandled_mention_count;
  if (typeof count !== "number" || count <= 0) return "";
  const drain = channel === undefined ? "party ack --drain" : `party ack --drain --channel ${channel}`;
  return `; ${count} unhandled @ queued ≈ ${count} turn${count === 1 ? "" : "s"} — drain in one go there: ${drain}`;
}

/**
 * #926：装了 Stop hook、但 codex 的信任闸不让它跑。
 *
 * 这一档必须比 unreachable 更刺眼，而不是更含糊：unreachable 至少是「没装」，用户会去装；
 * 这一档长得像装好了，所以只能靠一句明说 + 一条能直接跑的命令把它从「看起来正常」里拽出来。
 */
export function blockedPullWakeNote(r: Row): string {
  const why =
    r.pull_wake?.hook === "disabled"
      ? "codex marked our Stop hook enabled=false"
      : "codex has not approved our Stop hook yet";
  return ` · ⛔ wake blocked (${why} — codex SKIPS it silently, so the @ is NOT picked up; run 'party wake check' on that machine)`;
}

// kind 已知取 kind；旧 presence 行没回填时 UUID 名判 human（网页登录会话），其余判 agent。
function kindOf(e: PresenceEntry): SenderKind {
  if (e.kind === "agent" || e.kind === "human") return e.kind;
  return SYSTEM_HUMAN_SESSION_RE.test(e.name) ? "human" : "agent";
}

// 返回该 presence 的候选行，或 null（离线人类 / 幽灵，不该列）。导出仅为单测。
export function classify(e: PresenceEntry, now: number): Row | null {
  if (e.name === "system") return null;
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  // online：与 web 一致以「当前有活 WS 连接」为准（#97 的 live）；无 live 信号时回退旧新鲜度启发式。
  const online = e.state !== "offline" && (e.live === true || age < STALE_MS);
  const kind = kindOf(e);
  const wake = e.wake?.kind;
  const paused = e.paused === true;
  // #191：非在线的 wake layer 判定。wakeableState 把「非在线」分成三档——
  //   offline（无 wake layer / human_driven）/ wakeable_unverified（自报 serve/watch 未经服务端验证）
  //   / wakeable_verified（webhook，或服务端观测到被 @ 后 resume 盖了 verified_at）。
  const wstate = wakeableState(e, now);
  const wakeReachable = autoWakeReachable(e, now, STALE_MS);
  let tier: Tier;
  if (online) tier = "online";
  // #454：wakeable 不只看历史声明，还必须有当前可达证据。serve/watch 的本地 listener 超过租约未续
  // 即降级 recent；webhook 由服务端投递，仍可离线 wakeable。避免被 harness kill 的 watch --once 永久假在线。
  else if (wstate !== "offline" && wakeReachable && age <= DEAD_MS) tier = "wakeable";
  else tier = "recent";
  // #664：recent 档里真正不可达的子集——不在线、不可自动唤醒、且已陈旧（>STALE_MS，非刚断线）。
  // 与 send 侧 unreachableOf 同口径；只标 recent，别把「online/wakeable/刚断线」误标死。
  const unreachable = tier === "recent" && !wakeReachable && age >= STALE_MS;
  if (tier !== "online") {
    // 暂停是人主动设的、有意保留的状态：不当人类/幽灵清掉，始终列出，让人看得见「谁被按了暂停」。
    if (!paused && kind === "human") return null; // 围观的人类只在线才列
    if (!paused && age > DEAD_MS) return null; // 幽灵清理
  }
  return {
    name: e.name,
    kind,
    tier,
    ...(typeof e.live === "boolean" ? { live: e.live } : {}),
    ...(e.residency === undefined ? {} : { residency: e.residency }),
    ...(unreachable ? { unreachable: true as const } : {}),
    ...(paused ? { paused: true as const, ...(typeof e.resume_at === "number" ? { resume_at: e.resume_at } : {}) } : {}),
    ...(wake === undefined ? {} : { wake }),
    // #191：可唤醒但未经服务端验证（自报的 serve/watch，服务端从没观测到它被 @ 后 resume）如实标注。
    // 不再只针对 watch——serve 同样是自报，未验证就不该被默认信任（避免「自称可唤醒实则叫不醒」）。
    ...(tier === "wakeable" && wstate === "wakeable_unverified" ? { wake_unverified: true as const } : {}),
    // 身份分层（#110）：只在 presence 给了非空值时带出，缺失就省略（诚实留白，不无中生有）。
    ...(typeof e.account === "string" && e.account !== "" ? { account: e.account } : {}),
    ...(typeof e.handle === "string" && e.handle !== "" ? { handle: e.handle } : {}),
    ...(typeof e.display_name === "string" && e.display_name !== "" ? { display_name: e.display_name } : {}),
    // busy/queue_depth（#103）：仅在服务端标了 busy（目标可达且自报忙）时带出；离线态服务端本就不下发 busy。
    ...(e.busy === true ? { busy: true as const } : {}),
    ...(e.busy === true && typeof e.queue_depth === "number" && e.queue_depth > 0 ? { queue_depth: e.queue_depth } : {}),
    ...(typeof e.waiting_owner_count === "number" && e.waiting_owner_count > 0
      ? { waiting_owner_count: e.waiting_owner_count }
      : {}),
    ...(typeof e.unhandled_mention_count === "number" && e.unhandled_mention_count > 0
      ? {
          unhandled_mention_count: e.unhandled_mention_count,
          ...(typeof e.oldest_unhandled_mention_seq === "number" && e.oldest_unhandled_mention_seq > 0
            ? { oldest_unhandled_mention_seq: e.oldest_unhandled_mention_seq }
            : {}),
          ...(Array.isArray(e.pending_mention_seqs) && e.pending_mention_seqs.length > 0
            ? { pending_mention_seqs: e.pending_mention_seqs.filter((seq) => Number.isInteger(seq) && seq > 0) }
            : {}),
        }
      : {}),
    // 回执游标（#828）：服务端仅在该身份有过回执时下发，原样带出。
    ...(typeof e.last_receipt_seq === "number" && e.last_receipt_seq > 0
      ? {
          last_receipt_seq: e.last_receipt_seq,
          ...(typeof e.not_in_turn_since === "number" && e.not_in_turn_since > 0
            ? { not_in_turn_since: e.not_in_turn_since }
            : {}),
        }
      : {}),
    // 每任务进度/心跳（#228）：服务端只在 state != offline 且有活跃任务时下发 current_task，原样带出。
    ...(typeof e.current_task === "number"
      ? {
          current_task: e.current_task,
          ...(typeof e.task_started_at === "number" ? { task_started_at: e.task_started_at } : {}),
          ...(typeof e.heartbeat_at === "number" ? { heartbeat_at: e.heartbeat_at } : {}),
        }
      : {}),
    // #615 interactive lane activity is intentionally independent of a serve task heartbeat.
    // Offline rows never describe a live model session even if a stale/legacy payload leaks through.
    ...(e.state !== "offline" && e.activity !== undefined ? { activity: e.activity } : {}),
    // 探活分级（#603）：服务端只对有活连接的身份下发 listening；runner_health 独立于任务生命周期。
    ...(e.listening === "suspect" || e.listening === "deaf" ? { listening: e.listening } : {}),
    ...(e.runner_health === undefined ? {} : { runner_health: e.runner_health }),
    ...(e.wake_block === undefined ? {} : { wake_block: e.wake_block }),
    ...(Array.isArray(e.idle_watches) && e.idle_watches.length > 0 ? { idle_watches: e.idle_watches } : {}),
    // #823：scope 只在 state != offline 时有意义——已经离线的人不再占着任何东西。
    ...(Array.isArray(e.status?.scope) && e.status.scope.length > 0 && e.state !== "offline"
      ? { scope: e.status.scope }
      : {}),
    ...(e.agent_session === undefined ? {} : { agent_session: e.agent_session }),
    // #817：接待模式（status.context 里一直有，只是 who 的可读输出从不显示）。原样带出，缺失省略。
    ...(e.status?.context?.reception_mode === undefined ? {} : { reception_mode: e.status.context.reception_mode }),
    ...(e.status?.context?.reception_runner === undefined
      ? {}
      : { reception_runner: e.status.context.reception_runner }),
    ...(e.status?.context?.reception_context === undefined
      ? {}
      : { reception_context: e.status.context.reception_context }),
    age_ms: age,
    ...(typeof e.connection_count === "number" && e.connection_count > 1
      ? { connection_count: e.connection_count }
      : {}),
  };
}

const RANK: Record<Tier, number> = { online: 0, wakeable: 1, recent: 2 };
const DOT: Record<Tier, string> = { online: "●", wakeable: "◐", recent: "○" };

// 已读标注：无游标不显示（诚实留白：该身份不逐帧流式读）；读到最新显示 ✓；落后显示读到第几条 + 差多少。
function readNote(readSeq: number | undefined, lastSeq: number): string {
  if (readSeq === undefined) return "";
  if (lastSeq > 0 && readSeq >= lastSeq) return " · read ✓";
  const behind = lastSeq - readSeq;
  return behind > 0 ? ` · read #${readSeq} (${behind} behind)` : ` · read #${readSeq}`;
}

// 身份分层（#110）：终端行里补出 @handle / account / 展示名，让人看得见「该 @ 哪个别名」。
// handle 是人类被 @ 通知的真正投递键（web notify 按 handle 命中），name 可能只是 UUID 会话名。
export function terminalIdentityText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();
}

export function identityNote(r: Row): string {
  const parts: string[] = [];
  const name = terminalIdentityText(r.name);
  if (r.handle !== undefined) {
    const handle = terminalIdentityText(r.handle);
    if (handle !== "" && handle !== name) parts.push(`@${handle}`);
  }
  if (r.display_name !== undefined) {
    const displayName = terminalIdentityText(r.display_name);
    if (displayName !== "") parts.push(displayName);
  }
  if (r.account !== undefined) {
    const account = terminalIdentityText(r.account);
    if (account !== "") parts.push(account);
  }
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

// busy 标注（#103）：目标可达但正串行处理一条 wake——「⏳ busy」或「⏳ busy · N queued」。
// 让人看懂「@ 了没立刻回」是忙、不是失联，别反复 @ 堆重复唤醒。
export function busyNote(r: Row): string {
  if (r.busy !== true) return "";
  const queued = r.queue_depth !== undefined && r.queue_depth > 0 ? ` · ${r.queue_depth} queued` : "";
  return ` · ⏳ busy${queued}`;
}

/**
 * 回执标注（#828）：「📨 receipted #N」/「📨 not in turn since 12m (#N)」。
 *
 * 这一行是这个 issue 的全部意义所在：真实事故里，协作方连发三条工单、看到的只有沉默和一个过期的
 * waiting，于是合理地判断「没人接活」，直接去改了对方的仓库。回执落在 who 上之后，同一处信息面回答的
 * 是「对方收到了第 N 条，只是还没轮到」——这比一条长得像本人发言的机器人消息有用得多，也不会被误读成
 * 本人表态。
 */
export function receiptNote(r: Row, now: number): string {
  const seq = r.last_receipt_seq;
  if (typeof seq !== "number" || seq <= 0) return "";
  const since = r.not_in_turn_since;
  if (typeof since === "number" && since > 0) {
    return ` · 📨 not in turn since ${humanAge(Math.max(0, now - since))} (#${seq})`;
  }
  return ` · 📨 receipted #${seq}`;
}

// waiting_owner 是挂起的 work，不占 runner，也不等于 agent 失联；与 busy/queue 分开展示。
export function waitingOwnerNote(r: Row): string {
  const count = r.waiting_owner_count;
  return typeof count === "number" && count > 0 ? ` · 💬 ${count} waiting owner` : "";
}

// 未处理 @ 是服务端持久 delivery 的债务，与在线/离线无关；终端必须显眼提示 owner。
export function unhandledMentionNote(r: Row): string {
  const count = r.unhandled_mention_count;
  if (typeof count !== "number" || count <= 0) return "";
  // #818：debt 是逐条清的，所以要报的是「欠哪几条」而不是「欠几条」。列全了就不需要 oldest 那半句
  // 提示——它当初只是列表缺席时的替代品。列表被 cap 截断时才退回 oldest 的说法。
  const seqs = Array.isArray(r.pending_mention_seqs) ? r.pending_mention_seqs : [];
  if (seqs.length > 0 && seqs.length === count) {
    return ` · ⚠ ${count} unhandled @ #${seqs.join(" #")}`;
  }
  if (seqs.length > 0) {
    return ` · ⚠ ${count} unhandled @ #${seqs.join(" #")} (+${count - seqs.length} more)`;
  }
  const oldest =
    typeof r.oldest_unhandled_mention_seq === "number" && r.oldest_unhandled_mention_seq > 0
      ? ` · oldest #${r.oldest_unhandled_mention_seq}`
      : "";
  return ` · ⚠ ${count} unhandled @${oldest}`;
}

// 每任务进度/心跳标注（#228）：比 busy 更细——「▶ seq X」是正在处理哪条 wake，「♥ Ns」是心跳新鲜度。
// 心跳还在推进 = 活着；心跳很旧 = 大概率卡死（配合 live 一起看）。仅在有活跃任务时渲染。
export function taskNote(r: Row, now: number): string {
  if (typeof r.current_task !== "number") return "";
  const beat =
    typeof r.heartbeat_at === "number" ? ` · ♥ ${humanAge(Math.max(0, now - r.heartbeat_at))}` : " · ♥ (none)";
  return ` · ▶ seq ${r.current_task}${beat}`;
}

// 探活分级标注（#603）：live 只证明连接活着，这两条说的是「活着但没在用」——
// listening（服务端从 delivery 租约派生：投喂了不吃）与 runner_health（自报：唤醒了起不来）。
export function livenessNote(r: Row): string {
  const parts: string[] = [];
  // #926：目标自检出的「叫不醒」排在最前——其余两条说的是「在听但吃不下」，这条说的是
  // 「压根不会被叫起来」，是更靠前、更彻底的断点，也是唯一一条对方能自己修好的。
  if (r.wake_block !== undefined) {
    parts.push(`⛔ wake blocked: ${terminalIdentityText(r.wake_block.detail)} → ${terminalIdentityText(r.wake_block.fix)}`);
  }
  if (r.listening === "deaf") parts.push("⚠ not listening (deliveries expiring)");
  else if (r.listening === "suspect") parts.push("⚠ slow to consume (1 delivery lease expired)");
  if (r.runner_health !== undefined && !r.runner_health.ok) {
    const err = r.runner_health.last_error !== undefined ? `: ${r.runner_health.last_error}` : "";
    parts.push(`⚠ runner failing x${r.runner_health.consecutive_failures}${err}`);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

// 模型 session 活动标注（#602）：比「▶ seq X」再细一层——具体在干什么。waiting_permission 是
// 无人值守最致命的静默挂法（headless 权限确认没人点），单独用 ⏸ 高亮出来。
export function activityNote(r: Row, now: number): string {
  const activity = r.activity;
  if (activity === undefined) return "";
  const age = humanAge(Math.max(0, now - activity.ts));
  // tool 名来自远端 presence（REST 路径不过帧校验），渲染前统一归一化控制字符，防终端转义注入。
  const tool = activity.tool === undefined ? undefined : terminalIdentityText(activity.tool) || undefined;
  switch (activity.phase) {
    case "tool":
      return ` · ⚙ ${tool ?? "tool"} (${age})`;
    case "waiting_permission":
      return ` · ⏸ awaiting permission${tool !== undefined ? `: ${tool}` : ""} (${age})`;
    case "waiting_input":
      return ` · ⏸ awaiting input (${age})`;
    case "compacting":
      return ` · ⚙ compacting (${age})`;
    case "starting":
      return ` · ⚙ starting (${age})`;
    case "working":
      return ` · ⚙ thinking (${age})`;
    case "idle":
      return ` · ⚙ turn done (${age})`;
    default:
      return "";
  }
}

// #817：接待模式一直只在 API 的 status.context 里，party who 的人类可读输出从不提。结果是：
// 频道里的其他人无从判断「@ 这个名字，答我的会是本人，还是一个不知道本人今天做了什么的隔离会话」。
// 这个判断该在 @ 之前就做得出来，而不是事后去解析元数据。
export function receptionNote(r: Row): string {
  if (r.reception_mode === undefined) return "";
  const runner = r.reception_runner === undefined ? "" : `:${r.reception_runner}`;
  // isolated = 独立的 per-channel 会话，不继承本人当前对话；fresh process = 每次唤醒起新进程。
  const boundary =
    r.reception_context === "isolated_channel_session"
      ? " isolated"
      : r.reception_context === "fresh_process"
        ? " fresh"
        : "";
  return ` · 🤖 reception ${r.reception_mode}${runner}${boundary}`;
}

// #823：把「此刻谁在动什么」标出来，并在两个人声明同一个 scope 时提示。不阻止——agent 之间本来
// 就靠自觉，而且合法的并行编辑确实存在；但「有人已经在这上面了」这件事必须看得见，否则唯一的
// 协调手段就是双方都能正确判断对方状态，而那个前提本身不成立（见 #825）。
export function annotateScopeConflicts(rows: Row[]): Row[] {
  const holders = new Map<string, string[]>();
  for (const row of rows) {
    for (const scope of row.scope ?? []) {
      holders.set(scope, [...(holders.get(scope) ?? []), row.name]);
    }
  }
  return rows.map((row) => {
    const conflicts = (row.scope ?? [])
      .map((scope) => ({ scope, with: (holders.get(scope) ?? []).filter((name) => name !== row.name) }))
      .filter((entry) => entry.with.length > 0);
    return conflicts.length > 0 ? { ...row, scope_conflicts: conflicts } : row;
  });
}

/**
 * Attach the server-derived relationships relative to this `party who` cwd.
 * Raw refs stay inside the Worker comparison boundary.
 */
export function annotateTopologyConflicts(
  rows: Row[],
  discovery?: RuntimePeerDiscovery,
): Row[] {
  if (discovery === undefined) return rows;
  const byAgent = new Map(discovery.peers.map((peer) => [peer.agent, peer]));
  return rows.map((row) => {
    const peer = byAgent.get(row.name);
    if (peer === undefined) return row;
    const conflicts: NonNullable<Row["topology_conflicts"]> = peer.relations.map((item) => {
      // 同一身份 + 不止一个活着的 runtime = 单活跃执行体被破坏(#834)。runtime_count 缺省算 1,
      // 但 same_identity 的关系本身就意味着「除了我还有一个」——所以只要 same_identity 就够严重。
      const sameIdentity = peer.same_identity === true;
      return {
        kind: sameIdentity && item.relation === "same_worktree" ? "same_identity_worktree" : item.relation,
        with: sameIdentity ? [] : [discovery.self],
        runtime_count: item.runtime_count,
        same_identity: sameIdentity,
        severity: sameIdentity ? ("blocking" as const) : ("advisory" as const),
      };
    });
    return conflicts.length === 0 ? row : { ...row, topology_conflicts: conflicts };
  });
}

/**
 * 把「本机这条腿的任务租约落没落闸」贴到**有 blocking 冲突的那些行**上（#931）。
 *
 * 只贴 blocking 行是刻意的：blocking ⇔ same_identity ⇔ 这一行说的就是「我自己还有别的执行体」。
 * 别的行贴上去既没有意义，也会把噪音铺满整个 who。
 */
/** 这一行是不是「我自己还有别的执行体」——blocking ⇔ same_identity（#885）。 */
export function hasBlockingConflict(row: Row): boolean {
  return (row.topology_conflicts ?? []).some((conflict) => conflict.severity === "blocking");
}

export function annotateTaskLeaseEnforcement(rows: Row[], enforcement?: TaskLeaseEnforcement): Row[] {
  if (enforcement === undefined) return rows;
  return rows.map((row) => {
    if (!hasBlockingConflict(row)) return row;
    return {
      ...row,
      task_lease: {
        enforced: enforcement.enforced,
        scope: enforcement.scope,
        ...(enforcement.executor_id === null ? {} : { executor_id: enforcement.executor_id }),
        ...(enforcement.reason === null ? {} : { reason: enforcement.reason }),
        ...(enforcement.fix === null ? {} : { fix: enforcement.fix }),
      },
    };
  });
}

export function topologyNote(r: Row): string {
  const conflicts = r.topology_conflicts ?? [];
  if (conflicts.length === 0) return "";
  return conflicts.map((conflict) => {
    // #834:同身份的另一个执行体。人读那行必须说清「会出事」,否则又只是打印一条中性事实——
    // 事故当天 `party who` 打的正是一条中性的 same_local_installation。
    if (conflict.severity === "blocking") {
      const where = conflict.kind === "same_identity_worktree" ? " share one worktree" : ` (${conflict.kind})`;
      // #931:「会被拒」是有前提的。本机认不出执行体标识时那把闸根本没落下,这里再说「are refused」
      // 就是在骗人——读的人以为有东西拦着,于是放心地让两个执行体一起干。判定不确定就别断言。
      const verdict = r.task_lease?.enforced === false
        ? " — ⚠ concurrent claims are NOT refused here: no execution-runtime identity on this machine (party doctor)"
        : " — concurrent claims on one task are refused";
      return ` · ⚠ ${conflict.runtime_count ?? 1} other live runtime(s) of this identity${where}${verdict}`;
    }
    const label = conflict.kind === "same_worktree"
      ? "⚠ same worktree as"
      : conflict.kind === "same_workspace"
        ? "same workspace as"
        : "same local installation as";
    return ` · ${label} ${conflict.with.map(terminalIdentityText).join(", ")}`;
  }).join("");
}

export function scopeNote(r: Row): string {
  if (r.scope === undefined || r.scope.length === 0) return "";
  const conflicted = new Set((r.scope_conflicts ?? []).map((entry) => entry.scope));
  const rendered = r.scope
    .map((scope) => (conflicted.has(scope) ? `${sanitizeSingleLine(scope)}⚠` : sanitizeSingleLine(scope)))
    .join(",");
  const who =
    r.scope_conflicts && r.scope_conflicts.length > 0
      ? ` (also held by ${[...new Set(r.scope_conflicts.flatMap((entry) => entry.with))].join(", ")})`
      : "";
  return ` · 🔒 ${rendered}${who}`;
}

export function sessionNote(r: Row): string {
  const session = r.agent_session;
  if (session === undefined) return "";
  const harness = terminalIdentityText(session.harness);
  const id = terminalIdentityText(session.session_id);
  return harness === "" || id === "" ? "" : ` · session ${harness}:${id}`;
}

function humanAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * presence → 最终行集合（含 scope/topology 标注、已读游标、#879 唤醒层建议），与排序。
 * 抽成纯函数是为了让「装配」这一步本身可被测试——否则 note 级单测全绿、真机却什么都不显示。
 */
export function buildRows(
  presence: PresenceEntry[],
  ctx: {
    now: number;
    channel: string;
    cursorOf?: Map<string, number>;
    runtimePeers?: RuntimePeerDiscovery;
    pullWake?: PullWakeLookup;
    /** #931：本机这条腿的任务租约判定。缺省＝不标注（老调用方行为不变）。 */
    taskLease?: TaskLeaseEnforcement;
  },
): Row[] {
  const { now, channel } = ctx;
  return annotateTaskLeaseEnforcement(annotateTopologyConflicts(
    annotateScopeConflicts(
      presence
        .map((e) => classify(e, now))
        .filter((r): r is Row => r !== null)
        .map((r) => ({ ...r, read_seq: ctx.cursorOf?.get(r.name) }))
        // #905：拉取式唤醒线索必须在 wakeGuidanceOf 之前贴上——它既是「别再给装 hook 的建议」
        // 的依据，也是离线身份唯一可得的 harness 判据。顺序颠倒就会对已装 hook 的身份重复劝装。
        .map((r) => {
          if (r.kind !== "agent") return r;
          const hint = ctx.pullWake?.hintFor(r.name);
          return hint === undefined ? r : { ...r, pull_wake: hint };
        })
        // #879/#891：没有唤醒层、且 harness 判据确实在场的身份补一条「怎么修」。判不出就不给。
        .map((r) => {
          const guidance = wakeGuidanceOf(r, channel);
          return guidance === undefined ? r : { ...r, wake_guidance: guidance };
        }),
    ),
    ctx.runtimePeers,
  ), ctx.taskLease).sort((a, b) => RANK[a.tier] - RANK[b.tier] || a.name.localeCompare(b.name));
}

/** 单行终端渲染。抽出来让「哪些标注真的出现在行里」可断言（#879 之前只有 note 函数被单测覆盖）。 */
export function renderRow(r: Row, now: number, lastSeq: number, channel?: string): string {
  const read = readNote(r.read_seq, lastSeq);
  const duplicate = r.connection_count !== undefined ? ` x${r.connection_count} sessions` : "";
  // 暂停接待（#180）：独立的 ⏸ 行，与 offline 视觉区分。带上定时/手动恢复提示，一眼看清何时回来。
  if (r.paused === true) {
    const resume =
      typeof r.resume_at === "number"
        ? ` · resumes in ${humanAge(Math.max(0, r.resume_at - now))}`
        : " · resume manually";
    return `⏸ ${"paused".padEnd(8)} ${r.name}  [${r.kind}]${identityNote(r)}${resume}${unhandledMentionNote(r)}${receiptNote(r, now)}${scopeNote(r)}${topologyNote(r)}${read}${duplicate}`;
  }
  // #191：可唤醒行明确标出「已验证 / 未验证」——verified＝服务端确认过（webhook，或观测到被 @ 后 resume），
  // unverified＝仅自报、服务端没验证过，别当它一定叫得醒。
  const wake =
    r.tier === "wakeable"
      ? ` · ${r.wake_unverified === true ? "unverified" : "verified"}${r.wake ? ` (${r.wake})` : ""}`
      : "";
  const age = r.tier === "online" ? "" : ` (${humanAge(r.age_ms)})`;
  // #664：recent 档里真·不可达的（无活 wake 通道 + 陈旧）单独标出，别和「最近露面、或许在轮询」混淆。
  // #905：措辞改了两处。其一，装了拉取式通道（codex Stop hook）的身份走 deferredNote，不再被
  // 断言成 unreachable——结论本来就是错的。其二，「mention lands in history only」也是过度断言：
  // @ 是持久 directed delivery，会挂成该身份的接待欠账等它下次跑起来，不是掉进历史就没了。
  const unreach =
    r.pull_wake !== undefined
      ? deferredNote(r, channel)
      : r.unreachable === true
        ? " · ⚠ no live wake layer (the @ waits as this identity's reception debt until it next runs)"
        : "";
  return `${DOT[r.tier]} ${r.tier.padEnd(8)} ${r.name}  [${r.kind}]${identityNote(r)}${busyNote(r)}${waitingOwnerNote(r)}${unhandledMentionNote(r)}${receiptNote(r, now)}${scopeNote(r)}${topologyNote(r)}${taskNote(r, now)}${activityNote(r, now)}${livenessNote(r)}${receptionNote(r)}${sessionNote(r)}${wake}${unreach}${wakeGuidanceNote(r.wake_guidance)}${read}${duplicate}${age}`;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, WHO_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const channel = flags.all === true ? null : resolveChannel(str(flags.channel) ?? positionals[0]);
  if (flags.all === true && (str(flags.channel) !== undefined || positionals[0] !== undefined)) {
    console.error("--all lists everyone across your channels; drop the channel argument");
    return 1;
  }
  if (!channel) {
    // #1074：没有频道时不再报错退出——聚合「我已加入的所有频道」，回答「我能到达谁」。
    // 频道内 who 的诊断细节（为什么叫不醒）仍需显式给频道，这里只解决「先找到人」。
    return runGlobalWho(cfg, flags.json === true);
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  try {
    let presence;
    try {
      presence = await fetchPresence(cfg.server, cfg.token, channel);
    } catch (err: unknown) {
      // 绑定的频道可能早就没了（改名/归档/换服务器）。此时报「找不到频道」等于把人堵死，
      // 而我们完全知道他还能到达谁——退回全局视图，并说明为什么。
      if (err instanceof RestError && err.status === 404) {
        console.error(`channel ${channel} not found — showing everyone across your channels instead (party who --all)`);
        return runGlobalWho(cfg, flags.json === true);
      }
      throw err;
    }
    let runtimePeers: RuntimePeerDiscovery | undefined;
    const runtimeTopology = buildRuntimeTopology(cfg.server);
    if (runtimeTopology !== undefined) {
      try {
        runtimePeers = await fetchRuntimePeers(
          cfg.server,
          cfg.token,
          channel,
          runtimeTopology,
          "topology_advisory",
        );
      } catch {
        // Old Worker or optional discovery failure: who remains useful without topology hints.
      }
    }
    // 已读游标尽力而为：老 worker 没这个端点会抛，降级为不标注（Phase 2 · CLI）。
    // 只有逐帧流式在读的身份（网页人 / serve / watch --follow 的 agent）才有游标；webhook/watch-once
    // 不逐条读，天然没有——不标注就是诚实。
    let cursorOf = new Map<string, number>();
    let lastSeq = 0;
    try {
      const rc = await fetchReadCursors(cfg.server, cfg.token, channel);
      lastSeq = rc.last_seq;
      cursorOf = new Map(rc.cursors.map((c) => [c.name, c.last_seen_seq]));
    } catch {
      /* 端点不存在 / 拉取失败：不标注已读，who 其余照常 */
    }
    writeStatuslineCache({
      ...localStatuslineBase(channel),
      ...(lastSeq > 0 ? { unread: unreadFromCursor(lastSeq, channel) } : {}),
    });
    const now = Date.now();
    // #905：本机拉取式唤醒线索。纯本地读盘，扫一次目录，失败即当作「没有」（不影响其余输出）。
    let pullWake: PullWakeLookup | undefined;
    try {
      pullWake = buildPullWakeLookup(channel, cfg.server);
    } catch {
      pullWake = undefined;
    }
    // #931：本机这条腿的任务租约判定。纯本地、不发网络；失败即当作「不标注」，绝不弄挂 who。
    let taskLease: TaskLeaseEnforcement | undefined;
    try {
      taskLease = diagnoseTaskLeaseEnforcement();
    } catch {
      taskLease = undefined;
    }
    const rows = buildRows(presence, { now, channel, cursorOf, runtimePeers, pullWake, ...(taskLease === undefined ? {} : { taskLease }) });
    if (flags.json === true) {
      for (const r of rows) console.log(JSON.stringify(r));
      return 0;
    }
    if (rows.length === 0) {
      console.log(`no one to mention in ${channel} yet`);
      return 0;
    }
    for (const r of rows) console.log(renderRow(r, now, lastSeq, channel));
    // #931：who 里出现了「这个身份还有别的执行体」，而本机那把闸没落下——这两件事必须放在一起
    // 说出来。此前它只在 `party status` 的 stderr 里有一行 warn，而 who 那行还在断言「会被拒」。
    if (taskLease !== undefined && shouldSurfaceTaskLeaseEnforcement(taskLease, rows.some(hasBlockingConflict))) {
      console.log("");
      for (const line of formatTaskLeaseEnforcement(taskLease)) console.log(line);
    }
    // #924：谁在场是一回事，「@ 我叫不叫得醒我」是另一回事。此前后者只在日志里留一行，
    // 于是用户看到自己在 who 里好好地列着、却怎么都醒不过来。断了就在这里说出来。
    try {
      const wake = diagnoseCodexWake();
      // 判据必须是「会不会跑」而不是「装没装」：`hookInstalled` 只排除 missing，
      // 于是 disabled / needs-review（信任闸没过，owner 那台的真实状态）会被当成正常，
      // who 继续沉默——正是本 PR 要终结的那种静默。只有 ok 才算通。
      if (shouldSurfaceCodexWakeDiagnosis(wake)) {
        console.log("");
        for (const line of formatCodexWakeDiagnosis(wake)) console.log(line);
      }
    } catch {
      // 诊断是附赠信息，绝不能把 who 本身弄挂。
    }
    // #979：某个身份「不在线」，而本机明明有它的 claude 会话在这个频道入册——那些全是普通 `claude`
    // 起的蛰伏档（#615 local-only），没有一个会接 @。此前 who 只显示「不在线」，没告诉人为什么；
    // 这里把原因和两条命令说出来。纯本地读盘（注册表 + agents/ config + serve 锁），失败即闭嘴。
    try {
      const dormant = claudeDormantToSurface(diagnoseClaudeDormantSessions(channel, cfg.server), rows);
      if (dormant.length > 0) {
        console.log("");
        for (const d of dormant) for (const line of formatClaudeDormantDiagnosis(d)) console.log(line);
      }
    } catch {
      // 同上：附赠信息。
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}

/**
 * `party who` 无频道时的全局视图（#1074）。逐频道拉 presence 后按人聚合。
 * 任一频道拉取失败只跳过它并在末尾如实说明——不能因为一个频道坏掉就让整条命令没输出。
 */
async function runGlobalWho(cfg: { server: string; token: string; name?: string }, json: boolean): Promise<number> {
  let channels;
  try {
    channels = activeChannelSlugs(await listChannels(cfg.server, cfg.token));
  } catch (err: unknown) {
    return handleRestError(err);
  }
  if (channels.length === 0) {
    console.error("no channels yet — join one first: party join --server URL --channel SLUG --as NAME");
    return 1;
  }
  const snapshots: Array<{ slug: string; presence: PresenceEntry[] }> = [];
  const failed: string[] = [];
  for (const slug of channels) {
    try {
      snapshots.push({ slug, presence: await fetchPresence(cfg.server, cfg.token, slug) });
    } catch {
      failed.push(slug);
    }
  }
  // 一个频道都读不到时，"没人可达" 是错的结论——那是我们没读到，不是没人。
  if (snapshots.length === 0) {
    console.error(`could not read presence for any of ${channels.length} channel(s): ${failed.join(", ")}`);
    return 1;
  }
  const now = Date.now();
  const rows = buildGlobalWho({ channels: snapshots, ...(cfg.name === undefined ? {} : { self: cfg.name }), now });
  if (json) {
    for (const row of rows) console.log(JSON.stringify(row));
    if (failed.length > 0) console.error(`could not read presence for: ${failed.join(", ")}`);
    // 部分频道读不到时结果是不完整的：退出码要反映这一点，否则脚本会把不完整当完整。
    return failed.length > 0 ? 1 : 0;
  }
  if (rows.length === 0) {
    console.log(summarizeGlobalWho(rows, snapshots.length, now).header);
    if (failed.length > 0) {
      console.log(`could not read presence for: ${failed.join(", ")}`);
      return 1;
    }
    return 0;
  }
  // 表头按档位报数、陈旧离线折一行、记号给图例——不再对着一屏离线的人说「reachable」。
  const summary = summarizeGlobalWho(rows, snapshots.length, now);
  console.log(summary.header);
  for (const row of summary.shown) {
    const entry = snapshots
      .flatMap((snapshot) => snapshot.presence)
      .find((candidate) => candidate.name === row.name);
    console.log("  " + renderGlobalRow(row, entry === undefined ? row.name : globalWhoDisplay(entry), now, terminalIdentityText));
  }
  if (summary.foldLine !== undefined) console.log(summary.foldLine);
  if (summary.legend !== undefined) console.log(summary.legend);
  if (failed.length > 0) {
    console.log(`\ncould not read presence for: ${failed.join(", ")} — this list is incomplete`);
    return 1;
  }
  return 0;
}
