// party hook — Claude Code hooks 接入点（issue #602 / #615）。
// `party hook report` 挂在模型 session 的 PreToolUse/Stop/Notification 等 hook 上，
// 把「正在干什么」落成本地 activity 文件：
//   - serve 托管 lane（AP_ACTIVITY_FILE 有值）：serve 的任务心跳帧捎带上行，hook 零网络；
//   - 由 AgentParty launcher 明确激活的交互 lane（#615，不跑 serve）：节流后 spawn
//     一个 detached 的 `party hook push` 子进程直报 REST——hook 本体仍然即写即退，
//     绝不等网络。普通 Claude session 即使加载了 Marketplace Hook 也不准覆盖活跃
//     AgentParty session 的 presence activity。
// `party hook install` 是不使用 Marketplace plugin 时的手动兼容入口。
//
// report 铁律（跑在模型的工具调用热路径上）：
//   1. stdout 永远为空——hook 的 stdout 会被灌进模型上下文；
//   2. 任何失败都静默 exit 0——exit 2 会 block 模型的工具调用，坏 JSON/写盘失败都不配阻断模型；
//   3. 本体不等网络——上行要么归 serve 心跳，要么交给 detached 子进程。
import { existsSync, readFileSync } from "node:fs";
import { stripTerminalControls } from "../format";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AGENT_ACTIVITY_TTL_MS, type AgentActivity } from "@agentparty/shared";
import { activityFromHookEvent, readActivityFile, writeActivityFile } from "../activity";
import {
  agentpartyHome,
  loadCursor,
  loadCursorForConfig,
  loadStuck,
  loadStuckForConfig,
  readConfig,
  readConfigWithSource,
  readState,
  type ConfigSourceInfo,
  type StuckWake,
} from "../config";
import {
  defaultCodexHookIdentityDeps,
  resolveCodexHookIdentity,
  type CodexHookIdentity,
  type CodexHookIdentityDeps,
  type CodexHookIdentityRefusal,
  type CodexHookIdentityResolution,
} from "../codex-session-identity";
import {
  CODEX_STOP_WAKE_QUERY_TIMEOUT_MS,
  codexStopWakeConfigOption,
  codexStopWakeGate,
  codexStopWakeQuerySince,
  codexStopWakeReason,
  codexStopWakeScopedPartyCommand,
  codexStopWakeSeenPath,
  decideCodexStopWake,
  liveCodexStopWakeSeen,
  readCodexStopWakeSeen,
  recordCodexStopWakeSeen,
  type CodexStopWakePointer,
  type CodexStopWakeSeenEntry,
} from "../codex-stop-wake";
import type { WakeLang } from "../wake-note-i18n";
import type { NextMention } from "../rest";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
  type DeliveryRecoveryEntry,
} from "../delivery-recovery-journal";
import { atomicWriteJson, atomicWriteText } from "../atomic-json";
import {
  isClaudeSessionRegistrySessionId,
  listCodexSessions,
  readClaudeSessionEntry,
  registerClaudeSession,
  registerCodexSession,
  unregisterClaudeSession,
} from "../claude-session-registry";
import { syncNativeDisplayName } from "../claude-native-display-name";
import {
  CODEX_AUTO_WAKE_ENV,
  CODEX_AUTO_WAKE_MARKER_ENV,
  CODEX_AUTO_WAKE_POLL_MS,
  activeCodexAutoWakePid,
  appendCodexAutoWakeLog,
  claimCodexAutoWake,
  createCodexAutoWakeStartupBudget,
  codexAutoWakeAuth,
  codexAutoWakeLogPath,
  codexAutoWakeMarkerPath,
  codexAutoWakeSettingPath,
  codexAutoWakeTarget,
  decideCodexAutoWake,
  recentCodexAutoWakeFlap,
  recordCodexAutoWakePid,
  recordCodexAutoWakeReap,
  resolveCodexAutoWakeMode,
  runningServePid,
  shouldReapCodexAutoWake,
  writeCodexAutoWakeSetting,
  type CodexAutoWakeDecision,
  type CodexAutoWakeStartupBudget,
} from "../codex-auto-wake";
import { probeCodexSessionKind, type CodexSessionKindProbe } from "../codex-session-kind";
import { defaultInstanceLockDir, isSameLiveProcess } from "../instance-lock";
import { nativeSessionName } from "../claude-inbox-inject";
import { isHelpArg } from "../args";
import { codexStopHookStatus, diagnoseCodexWake, readCodexTrustRemedy, type CodexStopHookStatus } from "../wake-diagnosis";
import { buildWakeChecklist, formatWakeChecklist } from "../wake-checklist";
import {
  enableCodexHookTrust,
  type CodexHookTarget,
  type CodexTrustRemedy,
  codexOwnHookCommand,
} from "../codex-hook-trust";
import { isPartyBinaryPath } from "../upgrade";
import {
  codexDesktopIpcAvailable,
  selectCodexDesktopIpcRoute,
  type CodexDesktopIpcRoute,
} from "../codex-desktop-ipc";
import { CLAUDE_LIFECYCLE_OPT_IN_ENV } from "./claude-launch";
import type { ServeSupervisorOptions } from "./serve";

const HELP = `usage: party hook <report|codex-report|codex-stop|codex-autowake|stop-guard|push|install|uninstall|status>

Claude Code hook adapter (issues #602/#615): report what the model session is
actually doing (running a tool / waiting on permission / compacting / idle)
into channel presence, so \`party who\` and the web can see it.

  install [--user]     write the hooks into Claude Code settings
                       (default: <cwd>/.claude/settings.local.json — project-local,
                        normally git-ignored; --user: ~/.claude/settings.json).
                       This is a legacy/manual compatibility path: ordinary
                       Claude sessions remain local-only. Presence uplink needs
                       party claude, party bridge claude, or a managed serve lane.
                       --codex: write the codex SessionStart hook into
                        ~/.codex/hooks.json instead (#851). Existing content is
                        preserved; a parse failure aborts without writing.
                        Afterwards it offers to flip codex's trust switch for
                        OUR two hooks only (\`enabled = true\` in
                        ~/.codex/config.toml) and asks y/N first, because codex
                        itself no longer asks once an entry carries a
                        trusted_hash (#942). --yes approves non-interactively;
                        without it a non-TTY run never writes and prints the
                        exact TOML to paste instead. The trust gate itself is
                        never bypassed - we collect your approval, we do not
                        remove the control.
  uninstall [--user|--codex]   remove exactly the entries install added
  status [--user|--codex]      show whether the hooks are installed. With no scope flag it
                       reports BOTH the claude scope and the codex scope, each with the file
                       it actually checked and the hook events found there (#904).
  codex-report         (wired by \`install --codex\`) read one codex hook event
                       from stdin and register an interactive codex session into
                       ~/.agentparty/codex-sessions/ so party can discover it.
                       Registry only — never presence, never network. It also
                       starts the wake layer unless auto-wake is turned off (#893).
  codex-stop           (wired by \`install --codex\`) codex Stop hook (#899): at the
                       end of a turn, if this identity still has an unhandled @ on
                       its channel, block that one stop and hand the session a
                       ≤512B channel+seq pointer, so the wake happens **in the
                       session the user is looking at** instead of a new background
                       runner (#893). The channel stays the only source of truth:
                       the pointer carries no message body. One @ per turn, oldest
                       first; with a backlog the pointer says "第 1/N 条" and names
                       \`party ack --drain\` to read them all at once (#958).
                       Loop safety is entirely ours — codex honours repeated blocks
                       without any cap of its own. Three gates, any one of which
                       lets the stop through: stop_hook_active, a persisted
                       per-seq seen set, and fail-open on every error.
  codex-autowake [status|on|off]
                       codex has no MCP sampling and declines idle elicitation
                       (#893), so it can only be reached by a local wake layer.
                       ON BY DEFAULT — installing the codex hook already says "wire
                       me into AgentParty"; asking a second time is the experience
                       gap #893 exists to remove. Every codex SessionStart starts
                       \`party serve <channel> --runner codex\` in the background
                       (once per identity+channel — the serve instance lock is the
                       authority), and reaps it once no registered codex session on
                       that channel is alive. \`off\` disables it for good: the
                       default does the right thing, it never takes away control.
                       Honest boundary (#879): a mention wakes a NEW codex runner
                       session, never the terminal session you are looking at.
  codex-autowake --supervise --channel C
                       internal: the supervised wake layer itself.
  report               (wired by install / party serve) read one hook event from
                       stdin, record the local activity snapshot. Under a managed
                       \`party serve\` runner the serve heartbeat uplinks it; in an
                       explicitly armed interactive session a throttled detached
                       push uplinks it. Ordinary Claude sessions stay local-only.
  stop-guard           internal Stop hook: report activity, then block one stop
                       only in a party-launched Channel session while a delivered
                       AgentParty execution still needs its linked reply. Ordinary
                       Claude sessions and stop-hook continuations are never blocked.
  push <file> --channel C            internal: best-effort REST uplink (detached)

report never blocks the model: any failure exits 0 silently, stdout stays empty.
stop-guard emits only Claude's structured Stop decision and fails open.`;

// stdin 兜底上限：hook payload 正常几 KB，超过说明喂错了东西，读满即止防内存放大。
const MAX_STDIN_BYTES = 256 * 1024;

// 未走 serve 托管（无 AP_ACTIVITY_FILE）时按 session_id 落到全局 state 目录。
// session_id 直接进路径，白名单校验防穿越。
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

// 交互 lane 直报节流（#615）：普通活动 ≥15s 一报；waiting_permission 是无人值守最致命的
// 静默挂法，放宽到 3s——既立即可见，又不被重复 Notification 打成风暴。
export const PUSH_INTERVAL_MS = 15_000;
export const PUSH_INTERVAL_URGENT_MS = 3_000;
export const ACTIVITY_ATTACH_RETRY_DELAYS_MS = [200, 800, 2_000, 3_000] as const;

async function readStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    chunks.push(buf);
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).toString("utf8", 0, Math.min(total, maxBytes));
}

export function activityTargetFile(
  env: Record<string, string | undefined>,
  payload: Record<string, unknown>,
  home: string,
): string | null {
  const explicit = env.AP_ACTIVITY_FILE;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const sessionId = payload.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  return join(home, "state", "activity", `${sessionId}.json`);
}

// ---- 交互 lane 直报（#615）----

/** 节流判定（导出仅为单测）：sidecar 记上次上报时刻，waiting_permission 用更紧的紧急间隔。
 * 未来时间戳（时钟回跳后残留的标记）视为无效——否则时钟追上前会永久静默。 */
export function shouldPushActivity(activity: AgentActivity, lastPushTs: number | null, now: number): boolean {
  if (lastPushTs === null || lastPushTs > now) return true;
  // waiting_input 与 waiting_permission 同级：都是「无人值守卡死等人」，#608 UI 也同级高亮。
  const interval = activity.phase === "waiting_permission" || activity.phase === "waiting_input"
    ? PUSH_INTERVAL_URGENT_MS
    : PUSH_INTERVAL_MS;
  return now - lastPushTs >= interval;
}

function pushMarkerFile(activityFile: string): string {
  return `${activityFile}.push.json`;
}

function pushFailureMarkerFile(activityFile: string): string {
  return `${activityFile}.push.failed.json`;
}

export function readLastPushTs(activityFile: string): number | null {
  try {
    const body = JSON.parse(readFileSync(pushMarkerFile(activityFile), "utf8")) as {
      last_push_ts?: unknown;
      attempt_id?: unknown;
    };
    let failedAttempt: unknown;
    try {
      failedAttempt = (JSON.parse(readFileSync(pushFailureMarkerFile(activityFile), "utf8")) as {
        attempt_id?: unknown;
      }).attempt_id;
    } catch {
      failedAttempt = undefined;
    }
    // The detached child marks only its own failed attempt. A late failure
    // cannot invalidate a newer marker because the random attempt IDs differ.
    if (
      typeof body.attempt_id === "string" &&
      body.attempt_id !== "" &&
      failedAttempt === body.attempt_id
    ) return null;
    return typeof body.last_push_ts === "number" && Number.isFinite(body.last_push_ts) ? body.last_push_ts : null;
  } catch {
    return null;
  }
}

// 交互 lane：解析出频道 + 身份就 spawn 一个 detached push 子进程，本体立刻返回。
// 节流标记在 spawn 前先落（乐观占位）：hook 风暴下绝不并发起一堆子进程。
function maybeSpawnPush(
  activityFile: string,
  activity: AgentActivity,
  payload: Record<string, unknown>,
  now: number,
  force = false,
): void {
  const cwd = typeof payload.cwd === "string" && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const channel = process.env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel;
  if (!channel) return;
  if (!force && !shouldPushActivity(activity, readLastPushTs(activityFile), now)) return;
  const attemptId = randomUUID();
  atomicWriteJson(pushMarkerFile(activityFile), { last_push_ts: now, attempt_id: attemptId });
  // 编译版二进制：execPath 即 party；dev（bun run）：execPath 是 bun，argv[1] 是入口脚本。
  const self = isPartyBinaryPath(process.execPath) || process.argv[1] === undefined
    ? [process.execPath]
    : [process.execPath, process.argv[1]];
  // 子进程直接落在 session 的 cwd 里：readConfig/resolveAuthDetailed 都按 process.cwd() 解析
  // workspace 级配置，让 push 拿到与该项目一致的身份与服务端。
  try {
    const proc = Bun.spawn([
      ...self,
      "hook",
      "push",
      activityFile,
      "--channel",
      channel,
      "--attempt-id",
      attemptId,
    ], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
  } catch {
    atomicWriteJson(pushFailureMarkerFile(activityFile), { attempt_id: attemptId });
  }
}

async function runPush(argv: string[]): Promise<number> {
  // 全程静默 best-effort：这是 detached 后台子进程，没有任何人看它的输出。
  const file = argv[0];
  const attemptIdIdx = argv.indexOf("--attempt-id");
  const attemptId = attemptIdIdx >= 0 ? argv[attemptIdIdx + 1] : undefined;
  let published = false;
  try {
    const channelIdx = argv.indexOf("--channel");
    const channel = channelIdx >= 0 ? argv[channelIdx + 1] : undefined;
    if (!file || !channel) return 0;
    const activity = readActivityFile(file, Date.now(), AGENT_ACTIVITY_TTL_MS);
    if (activity === null) return 0;
    const { resolveAuthDetailed } = await import("../oidc-cli");
    const { fetchMe } = await import("../rest");
    const auth = await resolveAuthDetailed();
    if (!auth.server || !auth.token) return 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      // The bearer identity is authoritative. A recovered or stale local
      // config may have no usable identity even though the token and Channel
      // connection are valid; using its cached name makes activity silently
      // target the wrong presence row.
      const identity = await fetchMe(auth.server, auth.token, controller.signal);
      if (identity.kind !== "agent") return 0;
      const endpoint =
        `${auth.server}/api/channels/${encodeURIComponent(channel)}` +
        `/presence/${encodeURIComponent(identity.name)}/activity`;
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({ activity }),
          signal: controller.signal,
        });
        if (!response.ok) return 0;
        const result = await response.json().catch(() => null) as { attached?: unknown } | null;
        // Only an explicit not-attached response means SessionStart raced the
        // Channel presence row. Older servers without this field are treated
        // as accepted. Retry is bounded and stays inside the detached helper.
        if (result?.attached !== false) {
          published = true;
          return 0;
        }
        const retryDelay = ACTIVITY_ATTACH_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined) return 0;
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelay));
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // 断网/凭据缺失/服务端拒绝——全部静默，由 finally 释放这一次节流占位。
  } finally {
    if (
      !published &&
      typeof file === "string" &&
      typeof attemptId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)
    ) {
      try {
        atomicWriteJson(pushFailureMarkerFile(file), { attempt_id: attemptId });
      } catch {
        // Best effort only; a marker write failure must never block the hook.
      }
    }
  }
  return 0;
}

// ---- hooks 安装（#615）----

const HOOK_COMMAND_MARKERS = [
  "hook report",
  "hook stop-guard",
  "hook codex-report",
  "hook codex-stop",
] as const;

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

function isOurCommand(hook: unknown): boolean {
  return typeof (hook as { command?: unknown })?.command === "string" &&
    HOOK_COMMAND_MARKERS.some((marker) => (hook as { command: string }).command.includes(marker));
}

function isOurEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as HookEntry).hooks;
  return Array.isArray(hooks) && hooks.some(isOurCommand);
}

// 逐命令摘除：用户若把自己的命令混进了含我们命令的条目里，只摘我们的那条，绝不整条目连坐。
// 摘空 hooks 数组的条目才整体删除。
function stripOurCommands(entries: unknown[]): unknown[] {
  return entries
    .map((entry) => {
      if (!isOurEntry(entry)) return entry;
      const rec = entry as HookEntry;
      const kept = rec.hooks.filter((h) => !isOurCommand(h));
      return kept.length > 0 ? { ...rec, hooks: kept } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export type HookScope = "project" | "user" | "codex";

export function settingsPath(
  scope: HookScope,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  // codex 的 hooks 跟着 CODEX_HOME 走——它就是 codex 自己判定「我的家在哪」的那个变量。
  // 写死 homedir() 会让「用临时 CODEX_HOME 试一下」变成「悄悄改了用户真正在用的那份
  // hooks.json」（#924 验收时真的踩到了，改回来才发现）。项目级 CODEX_HOME 同理。
  if (scope === "codex") {
    const codexHome = env.CODEX_HOME?.trim();
    return join(codexHome !== undefined && codexHome !== "" ? codexHome : join(homedir(), ".codex"), "hooks.json");
  }
  return scope === "user"
    ? join(homedir(), ".claude", "settings.json")
    : join(cwd, ".claude", "settings.local.json");
}

/**
 * codex 的 hooks 片段（#851 P2）。~/.codex/hooks.json 的顶层就是 `{ "hooks": { … } }`，
 * 条目形状（`{ hooks: [{ type: "command", command, timeout? }] }`）与 Claude settings
 * 的 hooks 完全同形，所以 mergeHookSettings/removeHookSettings 原样复用——包括它
 * 「只增删自己的命令、解析失败即抛错拒写」的保护。
 *
 * codex 只有 SessionStart 可用于入册：其内嵌 schema 没有任何会话结束事件。
 * （#899 复核：二进制里那 10 个 hook 事件 `pre-tool-use / permission-request /
 * post-tool-use / pre-compact / post-compact / session-start / user-prompt-submit /
 * subagent-start / subagent-stop / stop` 确实不含 SessionEnd——#877 的结论是对的。
 * 二进制里另有的 `SessionEnd` 字符串属于 realtime 会话 API，不是 hook 事件。）
 *
 * Stop 则用于前台唤醒（#899）：turn 结束时把还没处理的 @ 以 channel+seq 指针的形式
 * block 回**用户眼前那个会话**，而不是像 #893 那样另起一个后台 runner。
 */
export function codexHookSettingsJson(execPath: string = process.execPath): string {
  // 命令串由 codexOwnHookCommand 单点生成——归属判定（codex-hook-trust）拿的是**同一个**
  // 函数的输出来做相等比较。两边各写一份就会漂移，而漂移的后果是「装了却认不出是自己的」。
  return JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{ type: "command", command: codexOwnHookCommand("codex-report", execPath), timeout: 10 }],
      }],
      Stop: [{
        hooks: [{ type: "command", command: codexOwnHookCommand("codex-stop", execPath), timeout: 10 }],
      }],
    },
  });
}

/**
 * 幂等合并：只增删「command 含 hook report」的条目，绝不动用户已有 hooks。
 * source 为 null 表示文件不存在（从空对象起步）；JSON 坏了抛错（拒绝覆盖用户手写内容）。
 */
export function mergeHookSettings(source: string | null, hookSettingsJson: string): string {
  const settings = source === null ? {} : (JSON.parse(source) as Record<string, unknown>);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("settings file is not a JSON object");
  }
  const ours = JSON.parse(hookSettingsJson) as { hooks: Record<string, HookEntry[]> };
  // hooks 键存在但不是对象（用户写坏了）：拒绝覆盖，和坏 JSON 同等对待——绝不静默吞掉用户内容。
  if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || settings.hooks === null || Array.isArray(settings.hooks))) {
    throw new Error("settings.hooks is not a JSON object");
  }
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  for (const [event, entries] of Object.entries(ours.hooks)) {
    // 事件值存在但不是数组（用户写坏了）：拒绝覆盖——「仅管理自身 hook」不容许吞掉用户内容。
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`settings.hooks.${event} is not an array`);
    }
    // #942：**位置必须稳定**。codex 的 hook 信任键是位置式的
    // （`<hooks.json>:<event>:<组下标>:<条下标>`），所以「先删后追加」等于把我们的条目换到
    // 另一个下标上——它会顶着邻居的信任行跑，邻居也顶着我们的。真机实测过一次：重装之后
    // 我们的 Stop hook 从 2:0 挪到 3:0，直接继承了 vibe-island 那一行的信任状态。
    // 已经存在就**原地替换**，只有全新安装才追加到末尾。
    const currentArr = (current ?? []) as unknown[];
    const at = currentArr.findIndex(isOurEntry);
    const kept = stripOurCommands(currentArr);
    hooks[event] = at < 0 ? [...kept, ...entries] : [...kept.slice(0, at), ...entries, ...kept.slice(at)];
  }
  settings.hooks = hooks;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function removeHookSettings(source: string): string {
  const settings = JSON.parse(source) as Record<string, unknown>;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    throw new Error("settings file is not a JSON object");
  }
  const hooks = settings.hooks;
  if (typeof hooks === "object" && hooks !== null && !Array.isArray(hooks)) {
    const record = hooks as Record<string, unknown>;
    for (const event of Object.keys(record)) {
      if (!Array.isArray(record[event])) continue;
      const kept = stripOurCommands(record[event] as unknown[]);
      if (kept.length > 0) record[event] = kept;
      else delete record[event];
    }
    if (Object.keys(record).length === 0) delete settings.hooks;
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function hookScope(argv: string[]): HookScope {
  // 只认 `--` 终止符之前的旗标；`hook install -- --user` 保持 project 作用域。
  const boundary = argv.indexOf("--");
  const flags = boundary === -1 ? argv : argv.slice(0, boundary);
  if (flags.includes("--codex")) return "codex";
  return flags.includes("--user") ? "user" : "project";
}

/**
 * 写前备份（#864 教训：接入包曾整份覆盖用户 settings.json，销毁数据）。
 * merge/remove 本身解析失败即抛错、调用方直接中止不写；备份是第二层保险，
 * 让「写了但结果不对」也能人工回退。备份失败不阻断（原文件仍在，且写是原子的）。
 */
function backupBeforeWrite(path: string, source: string): void {
  try {
    atomicWriteText(`${path}.agentparty.bak`, source);
  } catch {
    // best effort
  }
}

// 终端输出的动态部分（路径/异常消息）统一剥控制字符——路径可能来自不受信的 repo 目录名。
function termText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

async function runInstall(argv: string[]): Promise<number> {
  const scope = hookScope(argv);
  const path = settingsPath(scope);
  const source = existsSync(path) ? readFileSync(path, "utf8") : null;
  // serve 用同一份 hooks 配置生成器（#602），装出来的行为与托管 lane 完全一致。
  const { claudeHookSettingsJson } = await import("./serve");
  const fragment = scope === "codex" ? codexHookSettingsJson() : claudeHookSettingsJson();
  let next: string;
  try {
    next = mergeHookSettings(source, fragment);
  } catch (e) {
    // 解析失败即中止不写（#864）：宁可让人手工修，也绝不覆盖看不懂的用户内容。
    console.error(`无法解析 ${termText(path)}（${termText(e instanceof Error ? e.message : String(e))}）；请先手工修复该文件`);
    return 1;
  }
  if (source !== null) backupBeforeWrite(path, source);
  // 进程死在写中途会留半截 JSON——毁掉的正是 merge 拼命保护的用户手写配置（#617 评审）。
  atomicWriteText(path, next);
  console.log(`hooks installed -> ${termText(path)}`);
  console.log(
    scope === "codex"
      ? "codex 交互式会话现在会在 SessionStart 入册到 ~/.agentparty/codex-sessions/；" +
        "codex 无会话结束事件，出册靠进程探活。\n" +
        "已同时启用自动唤醒层：ChatGPT Desktop IPC 可用且有第二个同身份 task 时，" +
        "@ 会通过原生 cross-task 通道进入现有 task；裸 Codex CLI 才回落到新的 runner 会话。\n" +
        "没人用了自动退场——不用再手挂任何东西。\n" +
        "如需关闭：`party hook codex-autowake off`。"
      : "普通 Claude session 只写本地 activity；频道 presence 上行仍需 party claude、" +
        "party bridge claude 或托管 serve lane。",
  );
  // #910：装完不能只说「装好了」就收工。codex 0.149+ 对新装/改动过的 hook 默认**不信任**，
  // 要在 TUI 里确认一次才会运行——不确认就一次都不跑，且**没有任何报错**。此前这里正是
  // 「看起来成功、实际不生效、且无提示」的现场：用户以为装好了，然后在原会话里等唤醒等到怀疑人生。
  // 所以最后一步不是再给一条指令（没人读），而是**当场验证并报出还差几步**。
  // #942：这份清单给出的修法现在会**探测本机**——它说得出该在哪个 codex 二进制里批准。
  // 别再往这里塞「直接跑 codex」：桌面版没有那个界面，PATH 上的旧版也没有那道闸。
  if (scope === "codex") {
    // #942 第二轮：光报出「还差批准」没用——codex 那边**已经没有批准入口了**（启动 review 只对
    // 「新的或改动过的」hook 发问，带 trusted_hash 且 enabled=false 的它再也不会问；桌面版连
    // 界面都没有）。所以这一步由我们收集用户的确认：问一句，敲 y 才写。
    await offerCodexHookTrust(argv);
    console.log("");
    for (const line of formatWakeChecklist(buildWakeChecklist(diagnoseCodexWake()))) console.log(line);
  }
  return 0;
}

/** `hook install --codex --yes`：非交互场景下**显式**表示批准。没有它就必须当面回答。 */
export function hasYesFlag(argv: string[]): boolean {
  const boundary = argv.indexOf("--");
  return (boundary === -1 ? argv : argv.slice(0, boundary)).includes("--yes");
}

/**
 * 问一句 y/N。
 * 非 TTY（脚本、接入包粘贴执行、CI）一律返回 null ——**沉默绝不等于同意**，
 * 那种场景只有显式 `--yes` 才算数。
 */
export async function promptYesNo(question: string): Promise<boolean | null> {
  if (process.stdin.isTTY !== true) return null;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

/** 一行「我们打算改哪一条」。给人看的，写前写后各打一遍。 */
function describeTarget(t: CodexHookTarget): string {
  return `  ${termText(t.key)}   ${t.label}`;
}

/**
 * 装完之后就地把**我们自己那两条**的信任开关翻上去——前提是用户当面说了 y（或显式 --yes）。
 *
 * 边界见 codex-hook-trust.ts 顶部：只按命令本体定位、只翻已有 trusted_hash 的行、
 * 写前备份、写后逐字段核对，绝不碰 `--dangerously-bypass-hook-trust`。
 * 任何一步不确定 ⇒ 不写，并把用户要粘的 TOML 原样打出来（那是本切片的底线交付）。
 */
async function offerCodexHookTrust(argv: string[]): Promise<void> {
  let remedy: CodexTrustRemedy;
  try {
    remedy = readCodexTrustRemedy();
  } catch {
    return;
  }
  if (remedy.enableable.length === 0) return; // 没什么可翻的（已启用 / 还没进信任表 / 读不出）
  console.log("");
  console.log("codex 把下面这些 hook 标成了 enabled = false —— 它们一次都不会跑，@ 你不会有任何反应：");
  for (const t of remedy.enableable) console.log(describeTarget(t));
  console.log(
    "codex 的启动 review 只对「新的或改动过的」hook 发问，这几条它认为「已经问过」，" +
      "所以【不会再问你】；桌面版更是没有那个界面。要启用只能由我们把你的确认写进 config.toml。",
  );

  const approved = hasYesFlag(argv) ? true : await promptYesNo("要启用 AgentParty 的这些 hook 吗？(y/N) ");
  if (approved !== true) {
    console.log(
      approved === null
        ? "非交互环境，没有你的当面确认——不写。（确定要启用就加 --yes 重跑一次。）"
        : "好，不动它。",
    );
    for (const line of remedy.snippet) console.log(line);
    return;
  }

  let source: string;
  try {
    source = readFileSync(remedy.configPath, "utf8");
  } catch (e) {
    console.log(`读不出 ${termText(remedy.configPath)}（${termText(e instanceof Error ? e.message : String(e))}）——不写。`);
    for (const line of remedy.snippet) console.log(line);
    return;
  }
  const result = enableCodexHookTrust(
    source,
    remedy.enableable.map((t) => t.key),
    (text) => Bun.TOML.parse(text),
  );
  if (!result.ok) {
    console.log(`没有写：${termText(result.detail)}（${result.reason}）。config.toml 一个字都没动。`);
    for (const line of remedy.snippet) console.log(line);
    return;
  }
  backupBeforeWrite(remedy.configPath, source);
  atomicWriteText(remedy.configPath, result.text);
  console.log(`已写入 ${termText(remedy.configPath)}（原文件备份在 ${termText(remedy.configPath)}.agentparty.bak，可整份回退）：`);
  for (const change of result.changes) {
    console.log(`  ${termText(change.key)}`);
    console.log(`    改前: ${change.before === null ? "（没有 enabled 这一行）" : termText(change.before.trim())}`);
    console.log(`    改后: ${termText(change.after.trim())}`);
  }
  console.log("其余内容逐字段核对过，没有任何别的改动。若你用的是桌面版 codex，重启它之后生效。");
}

async function runUninstall(argv: string[]): Promise<number> {
  const scope = hookScope(argv);
  const path = settingsPath(scope);
  if (!existsSync(path)) {
    console.log(`nothing to remove（${termText(path)} 不存在）`);
    return 0;
  }
  const source = readFileSync(path, "utf8");
  let next: string;
  try {
    next = removeHookSettings(source);
  } catch (e) {
    console.error(`无法解析 ${termText(path)}（${termText(e instanceof Error ? e.message : String(e))}）；请先手工修复该文件`);
    return 1;
  }
  backupBeforeWrite(path, source);
  atomicWriteText(path, next);
  console.log(`hooks removed <- ${termText(path)}`);
  return 0;
}

/** 一档 hooks 文件的检查结果（#904）。events 是**实际检出**的事件名，不是我们期望装的。 */
export interface HookScopeStatus {
  scope: HookScope;
  path: string;
  installed: boolean;
  /** 装着我们条目的 hook 事件名，按文件里的顺序。 */
  events: string[];
  /** 文件存在但解析不了。 */
  unreadable: boolean;
}

export function inspectHookScope(scope: HookScope, path: string, source: string | null): HookScopeStatus {
  if (source === null) return { scope, path, installed: false, events: [], unreadable: false };
  let hooks: Record<string, unknown>;
  try {
    hooks = (JSON.parse(source) as { hooks?: Record<string, unknown> }).hooks ?? {};
  } catch {
    return { scope, path, installed: false, events: [], unreadable: true };
  }
  const events = Object.keys(hooks).filter(
    (event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(isOurEntry),
  );
  return { scope, path, installed: events.length > 0, events, unreadable: false };
}

/**
 * #910：`installed` 之外必须有「装了但 codex 不会跑它」这一档——**这是最需要被看见的状态**，
 * 因为它长得像装好了。判定复用 #925 的四态 `codexStopHookStatus`（老版本 codex 没有信任闸时
 * 判 ok，绝不喊狼来了），不另写一套。
 */
export function formatHookScopeStatus(status: HookScopeStatus, trust?: CodexStopHookStatus): string {
  const where = `${status.scope} scope: ${termText(status.path)}`;
  if (status.unreadable) return `unreadable — ${where}`;
  if (!status.installed) return `not installed — ${where}`;
  const events = `[${status.events.map(termText).join(", ")}]`;
  if (trust === "disabled") {
    return `installed but NOT TRUSTED — ${where} ${events}\n  codex 把它标成了 enabled=false，会【静默跳过】它 —— 等于没装。修：party wake check`;
  }
  if (trust === "needs-review") {
    return `installed but NOT TRUSTED — ${where} ${events}\n  codex 还没批准它，未获批准的 hook 会被【静默跳过】 —— 等于没装。修：party wake check`;
  }
  return `installed — ${where} ${events}`;
}

/**
 * `party hook status`（#904）。
 *
 * 不带 scope 参数时**两档都报**：只报 claude 那档会在「codex hook 明明装好了」时给出与事实
 * 相反的结论——实测中它把一轮排查引向了错路。带 `--codex` / `--user` 则只报那一档。
 */
function runStatus(argv: string[]): number {
  const explicit = argv.some((arg) => arg === "--codex" || arg === "--user" || arg === "--project");
  const scopes: HookScope[] = explicit ? [hookScope(argv)] : ["project", "codex"];
  const results = scopes.map((scope) => {
    const path = settingsPath(scope);
    return inspectHookScope(scope, path, existsSync(path) ? readFileSync(path, "utf8") : null);
  });
  // 信任闸只对 codex 那档有意义（Claude 侧没有这道闸）。读盘失败一律不加档，别无中生有。
  let trust: CodexStopHookStatus | undefined;
  try {
    trust = codexStopHookStatus();
  } catch {
    trust = undefined;
  }
  for (const result of results) {
    console.log(formatHookScopeStatus(result, result.scope === "codex" ? trust : undefined));
  }
  if (results.some((r) => r.unreadable)) return 1;
  // #910：装了但没被信任**不算装好**——它一次都不会跑。返回非零，好让脚本/接入包判得出来。
  if (results.some((r) => r.scope === "codex" && r.installed) && (trust === "disabled" || trust === "needs-review")) {
    console.log("codex 那档装了但没被信任，跑 `party wake check` 看还差哪一步。");
    return 1;
  }
  if (results.some((r) => r.installed)) return 0;
  console.log(
    scopes.length > 1
      ? "两档都没装。claude 侧用 `party hook install`（或 --user），codex 侧用 `party hook install --codex`。"
      : "这一档没装；另一档没查，用 `party hook status` 不带参数可两档都看。",
  );
  return 1;
}

const STOP_GUARD_PHASES = new Set<DeliveryRecoveryEntry["phase"]>([
  "harness_issued",
  "harness_accepted",
]);

/** Pure policy seam: one top-level Stop may be continued for unfinished AgentParty work. */
export function shouldBlockAgentPartyStop(
  payload: Record<string, unknown>,
  entries: readonly Pick<DeliveryRecoveryEntry, "phase">[],
  lifecycleOptedIn: boolean,
): boolean {
  return lifecycleOptedIn &&
    payload.hook_event_name === "Stop" &&
    (payload.agent_id === undefined || payload.agent_id === null) &&
    payload.stop_hook_active === false &&
    entries.some((entry) => STOP_GUARD_PHASES.has(entry.phase));
}

/** State boundaries that must bypass the ordinary interactive-lane throttle. */
export function shouldForceActivityPush(
  previous: AgentActivity | null,
  next: AgentActivity,
  event: string,
): boolean {
  const waitPhase = (phase: AgentActivity["phase"]): boolean =>
    phase === "waiting_permission" || phase === "waiting_input";
  return (
    (waitPhase(next.phase) && previous?.phase !== next.phase) ||
    (previous !== null && waitPhase(previous.phase) && previous.phase !== next.phase) ||
    (next.phase === "idle" && previous?.phase !== "idle") ||
    event === "PostToolUseFailure" ||
    event === "StopFailure"
  );
}

/** SessionStart hook payload 里可能带的展示名字段（当前 Claude 实测都不发；拿不到记 null）。 */
export function claudeSessionDisplayNameFromHookPayload(
  record: Record<string, unknown>,
): string | null {
  for (const key of ["display_name", "session_name", "agent_name"]) {
    const value = record[key];
    if (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) return value;
  }
  return null;
}

/**
 * 入册时记进条目的 config 路径（#1052 #2）：只认「绑过」的来源——显式 AGENTPARTY_CONFIG /
 * 注册表 / cwd 面包屑（kind=explicit）与本目录 workspace config。全局兜底不是绑定：记进去会让
 * 后续命令把它当显式绑定用，也会绕过 #1018 的 MCP 闸。
 */
export function boundConfigPathForRegistry(source: ConfigSourceInfo): string | null {
  if (source.path === null) return null;
  return source.kind === "explicit" || source.kind === "workspace" ? source.path : null;
}

/**
 * 本机会话注册表接线（issue #841 P1）：SessionStart 入册、SessionEnd 出册。
 * 严守 hook 铁律：stdout 恒空、任何失败静默、不等网络。serve 托管 lane
 * （AP_ACTIVITY_FILE 有值）不入册——那是被管理的 runner 会话，不是交互式会话。
 * 频道解析与 maybeSpawnPush 同款：AGENTPARTY_CHANNEL ?? readState(cwd)?.channel，
 * 无频道不入册。pid 记 process.ppid（hook 子进程的父进程即 Claude 本体）。
 */
export function recordClaudeSessionLifecycle(
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.ppid,
): void {
  try {
    const event = record.hook_event_name;
    const sessionId = record.session_id;
    if (!isClaudeSessionRegistrySessionId(sessionId)) return;
    if (event !== "SessionStart" && event !== "SessionEnd") {
      // #1052 #6：SessionStart 常早于 Claude 写出 `~/.claude/sessions/<pid>.json`，那一轮拿不到
      // 原生会话名。后续每一轮 hook（每轮一个新进程）再读一次；pid 与 session_id 都对得上才写回。
      if (env.AP_ACTIVITY_FILE) return;
      const entry = readClaudeSessionEntry(sessionId, env);
      if (entry !== null && entry.pid === pid) syncNativeDisplayName(entry, env);
      return;
    }
    if (event === "SessionEnd") {
      unregisterClaudeSession(sessionId, env);
      return;
    }
    if (env.AP_ACTIVITY_FILE) return;
    const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
    const channel = env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel;
    if (!channel) return;
    const bound = readConfigWithSource(cwd);
    registerClaudeSession({
      session_id: sessionId,
      pid,
      // hook payload 目前不带展示名（实测），退而求其次机会性读 Claude 原生会话名
      // （`~/.claude/sessions/<pid>.json` 的 name，如 `agentparty-d4`）：宣告名从
      // `claude-<12hex>` 变成人能读的名字，频道 peers 列表也更可读。SessionStart 时
      // 该文件可能还没写出来 → 读不到就保持 null，绝不重试等待（hook 铁律）。
      display_name:
        claudeSessionDisplayNameFromHookPayload(record) ??
        nativeSessionName(pid, { expectSessionId: sessionId, env }),
      channel,
      // #865：条目必须带实例维度——频道 slug 跨实例不唯一（两台生产实例上都有
      // `agentparty`）。取该会话绑定 config 的 server；解析不出就不写，条目随之
      // 不可匹配（宁可这一轮叫不醒，也不跨实例误投）。
      server: bound.config?.server ?? null,
      cwd,
      // #1052 #2：记下这个会话绑的 config，后续 `party` 命令沿父进程链认出宿主会话后直接用它，
      // 不必再手写 AGENTPARTY_CONFIG。
      config_path: boundConfigPathForRegistry(bound.source),
    }, env);
  } catch {
    // hook 铁律：注册表任何失败都不配影响模型。
  }
}

/**
 * codex 会话入册（issue #851 P2）——`party hook codex-report` 的全部职责。
 *
 * 为什么不复用 `hook report`：codex 的 SessionStart payload 与 Claude 的**同形**
 * （都带 hook_event_name/session_id/cwd），单看 payload 分不出 harness。同一个入口
 * 会把 codex 会话写进 claude 注册表，进而被 claude 专用的 PID→cc-socks UDS 寻址捡走
 * 投递到不存在的收件箱。harness 只能由「装在谁的 hooks 里」决定，所以给 codex 一个
 * 独立子命令，写独立目录。
 *
 * codex 0.145 实测 SessionStart payload（取自二进制内嵌的 session-start.command.input
 * JSON schema，required 全在）：
 *   { cwd, hook_event_name: "SessionStart", model, permission_mode, session_id,
 *     source: "startup"|"resume"|"clear"|"compact", transcript_path: string|null }
 * 没有 pid（同 Claude），所以记 process.ppid；没有任何展示名字段，display_name 恒 null，
 * 宣告名回退 `codex-<12hex>`。codex 也没有 SessionEnd——出册靠 kill(pid,0) 探活剔除。
 *
 * 铁律同 report：stdout 恒空、任何失败静默 exit 0、不等网络。
 */
export function recordCodexSessionLifecycle(
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.ppid,
): void {
  try {
    if (record.hook_event_name !== "SessionStart") return;
    const sessionId = record.session_id;
    if (!isClaudeSessionRegistrySessionId(sessionId)) return;
    // serve 托管 lane 是被管理的 runner 会话，不是人开的交互式会话——同 Claude 档不入册。
    if (env.AP_ACTIVITY_FILE) return;
    const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
    const channel = env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel;
    if (!channel) return;
    // #917：身份/实例都由会话身份解析器给（env → MCP 注册 → 本机唯一），**绝不按 cwd 猜**。
    // 解析不出就两个字段都不写——条目随之不可匹配（#906/#865 的安全侧），也让 Stop hook
    // 的「按 session_id 回查」明确失败，而不是拿到一个猜错的身份。
    const resolved = resolveCodexHookIdentity({
      cwd,
      channel,
      sessionId,
      deps: defaultCodexHookIdentityDeps(env, pid),
    });
    // #971：候选全是别的 harness 的＝这台机就没打算让 codex 接本频道，是预期状态：不刷日志
    // （唤醒层决策会以一条 skip(no-codex-binding) 留痕，够定位）。其余解析失败照旧记。
    if (!resolved.ok && resolved.reason !== "no-codex-binding") {
      appendCodexAutoWakeLog(
        agentpartyHome(env),
        `codex-report: 入册时解析不出会话身份（${resolved.reason}）：${resolved.detail}`,
      );
    }
    registerCodexSession({
      session_id: sessionId,
      pid,
      display_name: claudeSessionDisplayNameFromHookPayload(record),
      channel,
      // #865：同 claude 档——实例维度是匹配的一部分。
      server: resolved.ok ? resolved.identity.server : null,
      // #906：显式传（含 null），绝不让注册表回落到 readConfig(cwd) 的猜测。
      identity: resolved.ok ? resolved.identity.name : null,
      cwd,
    }, env);
  } catch {
    // hook 铁律：注册表任何失败都不配影响模型。
  }
}

// ---- codex 零手动唤醒层（#893）----

/**
 * 唤醒层的身份查询结果：一份可用的 config、或「解析器明确拒绝了」（带原因，#960 的
 * harness-mismatch 要在日志里以自己的名字出现，不能混进 no-agent-token）、或什么都没有。
 */
export type CodexAutoWakeIdentityLookup =
  | { server?: unknown; token?: unknown; configPath?: unknown }
  | { refused: CodexHookIdentityRefusal; detail: string }
  | null;

export interface CodexAutoWakeSpawnDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  lockDir: string;
  readConfigAt: (cwd: string) => CodexAutoWakeIdentityLookup;
  channelAt: (cwd: string) => string | null;
  /** 触发本次 SessionStart 的 codex 是不是人在用的会话（#959）；缺省按交互式处理。 */
  sessionKind?: () => CodexSessionKindProbe;
  /** 当前进程是否处在 ChatGPT Desktop 且私有 IPC router 可用。 */
  nativeDesktop?: () => boolean;
  /** 当前 task 与另一个同身份 task 的精确 native 路由。 */
  nativeRoute?: () => CodexDesktopIpcRoute | null;
  /** 返回子进程 pid；起不来返回 null。 */
  spawn: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => number | null;
  now: () => number;
  log: (line: string) => void;
  /** 「这个 pid 还是当初那个进程吗」——注入仅为可测。 */
  processAlive: (pid: number, startedAt?: number) => boolean;
  recordPid: (markerPath: string, channel: string, pid: number, now: number) => void;
}

export function defaultCodexAutoWakeDeps(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.ppid,
  sessionId: string | null = null,
): CodexAutoWakeSpawnDeps {
  const home = agentpartyHome(env);
  return {
    home,
    env,
    lockDir: defaultInstanceLockDir(),
    // #917：后台唤醒层同样不许按 cwd 猜身份——猜错就是替另一个身份拉起 serve、
    // 用别人的 token 接别人的 @。解析不出唯一身份就当「没有 agent token」跳过拉起。
    readConfigAt: (cwd) => {
      const channel = env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel ?? null;
      const resolved = resolveCodexHookIdentity({
        cwd,
        channel,
        sessionId: null,
        deps: defaultCodexHookIdentityDeps(env, pid),
      });
      if (resolved.ok) {
        return {
          server: resolved.identity.server,
          token: resolved.identity.token,
          configPath: resolved.identity.configPath,
        };
      }
      // #960/#971：绑给别的 harness 的身份由决策层以 skip(harness-mismatch) / skip(no-codex-binding)
      // 留痕，这里不重复记。
      if (resolved.reason !== "harness-mismatch" && resolved.reason !== "no-codex-binding") {
        appendCodexAutoWakeLog(
          home,
          `codex-report: 唤醒层解析不出会话身份（${resolved.reason}）：${resolved.detail}——不拉起`,
        );
      }
      return { refused: resolved.reason, detail: resolved.detail };
    },
    channelAt: (cwd) => env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel ?? null,
    // #976：先读本会话的 rollout 头（originator / subagent 派生），读不到再看进程形态。
    sessionKind: () => probeCodexSessionKind({ hookParentPid: pid, sessionId, env }),
    nativeDesktop: () =>
      isClaudeSessionRegistrySessionId(sessionId) &&
      codexDesktopIpcAvailable(env),
    nativeRoute: () => {
      if (!isClaudeSessionRegistrySessionId(sessionId)) return null;
      return selectCodexDesktopIpcRoute(sessionId, pid, listCodexSessions(env));
    },
    spawn: (args, cwd, childEnv) => {
      // 编译版二进制：execPath 即 party；dev（bun run）：execPath 是 bun，argv[1] 是入口脚本。
      const self = isPartyBinaryPath(process.execPath) || process.argv[1] === undefined
        ? [process.execPath]
        : [process.execPath, process.argv[1]];
      try {
        const proc = Bun.spawn([...self, ...args], {
          cwd,
          env: childEnv,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          // 必须脱离 codex 的进程组：唤醒层要活过用户这个终端会话，直到探活判定没人要了才退场。
          detached: process.platform !== "win32",
        });
        proc.unref();
        return proc.pid ?? null;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    log: (line) => appendCodexAutoWakeLog(home, line),
    processAlive: isSameLiveProcess,
    recordPid: (markerPath, channel, pid, now) => recordCodexAutoWakePid(markerPath, channel, pid, now),
  };
}

/**
 * SessionStart 时按配置决定是否把唤醒层拉起来（#893）。返回决策仅为可测；调用方不看返回值。
 *
 * 诚实边界（#879）：拉起的是 `party serve --runner codex`——被 @ 时起的是一个**新的
 * codex runner 会话**，不是用户眼前这个终端会话。日志里也这么写。
 */
export type CodexAutoWakeOutcome =
  | CodexAutoWakeDecision
  | { action: "start-failed"; channel: string; detail: string };

export function maybeStartCodexAutoWake(
  record: Record<string, unknown>,
  deps: CodexAutoWakeSpawnDeps,
): CodexAutoWakeOutcome {
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
  const resolution = resolveCodexAutoWakeMode(deps.env, deps.home);
  const channel = deps.channelAt(cwd);
  // #959：先判「这是不是人在用的 codex」，再去解析身份。一次性 codex 连身份都不必解析——
  // 省一次 ps + 一次绑定文件读取，也不给日志添「解析不出身份」的噪音。
  const sessionKind = resolution.mode === "serve" && channel !== null && deps.sessionKind !== undefined
    ? deps.sessionKind()
    : null;
  // #976：unknown 同样不拉起（决策层记 skip(session-kind-unknown)），身份也不必解析。
  const lookup = sessionKind !== null && sessionKind.kind !== "interactive" ? null : deps.readConfigAt(cwd);
  const refused = lookup !== null && "refused" in lookup ? lookup : null;
  const selected = lookup !== null && !("refused" in lookup) ? lookup : null;
  const auth = selected === null ? null : codexAutoWakeAuth(selected);
  const configPath = selected !== null &&
      typeof selected.configPath === "string" && isAbsolute(selected.configPath)
    ? selected.configPath
    : null;
  const nativeDesktop = auth !== null && deps.nativeDesktop?.() === true;
  const nativeRoute = nativeDesktop ? deps.nativeRoute?.() ?? null : null;
  const now = deps.now();
  const markerPath = auth !== null && channel !== null
    ? codexAutoWakeMarkerPath(deps.home, codexAutoWakeTarget(auth, channel))
    : null;
  const decision = decideCodexAutoWake({
    mode: resolution.mode,
    channel,
    cwd,
    now,
    sessionKind,
    identityRefusal: refused !== null && (refused.refused === "harness-mismatch" || refused.refused === "no-codex-binding")
      ? { reason: refused.refused, detail: refused.detail }
      : null,
    hasAgentToken: auth !== null,
    nativeDesktop,
    nativeRoute,
    // 已有 serve（不管是用户手挂的还是上一次自动拉的）就绝不拉第二个：一条 @ 触发两次
    // 完整 runner ＝ 双份回帖、git push 类副作用跑两遍。
    serveHolderPid: auth !== null && channel !== null ? runningServePid(auth, channel, deps.lockDir) : null,
    // 锁之外的第二层：serve 连不上服务端时会无限重连、根本走不到抢锁那步（真机实测），
    // 只看锁的话断网时每开一个 codex 会话就多堆一个永远重试的进程。
    startingPid: markerPath === null ? null : activeCodexAutoWakePid(markerPath, now, deps.processAlive),
    // #959 退避：同 (身份, 频道) 的唤醒层刚被短命回收过，这一轮不拉。
    flapping: markerPath === null ? null : recentCodexAutoWakeFlap(markerPath, now),
  });
  // #976：每条决策日志都带探测结论——事后要能从日志分辨「判成了 interactive 还是 unknown」。
  const kindTag = codexSessionKindLogTag(sessionKind);
  if (decision.action === "skip") {
    // disabled 是绝大多数机器的常态，逐次记会把日志刷成噪音；其余跳过原因都值得留痕。
    if (decision.reason !== "disabled") deps.log(`skip(${decision.reason}): ${decision.detail} ${kindTag}`);
    return decision;
  }
  if (markerPath !== null && !claimCodexAutoWake(markerPath, decision.channel, now, deps.processAlive)) {
    // 同一瞬间启动的另一个 codex 会话抢先了。
    const detail = `#${decision.channel} 上另一个 codex 会话正在拉起唤醒层，本次不拉`;
    deps.log(`skip(already-starting): ${detail} ${kindTag}`);
    return { action: "skip", reason: "already-starting", detail };
  }
  const childEnv = {
    ...deps.env,
    // The native bridge must resolve the exact same identity selected above;
    // never fall back to another global/cwd config in a multi-identity app-server.
    ...(configPath === null ? {} : { AGENTPARTY_CONFIG: configPath }),
    // 二道防线：这个 serve 起的 codex runner 自己也会触发 SessionStart hook，绝不许再套娃。
    [CODEX_AUTO_WAKE_ENV]: "off",
    // #959：唤醒层退场时要把「刚被回收」写回同一份标记，供下一次 SessionStart 退避。
    ...(markerPath === null ? {} : { [CODEX_AUTO_WAKE_MARKER_ENV]: markerPath }),
  };
  const pid = deps.spawn(decision.args, decision.cwd, childEnv);
  if (pid !== null && markerPath !== null) deps.recordPid(markerPath, decision.channel, pid, now);
  if (pid === null) {
    const native = decision.args.includes("--target-thread");
    const detail = native
      ? `拉 ChatGPT native bridge 失败（spawn 没返回 pid）；手动重试：party bridge codex-app ${decision.channel}`
      : `拉 \`party serve ${decision.channel} --runner codex\` 失败（spawn 没返回 pid）；` +
        `这台机器上没有唤醒层在跑。手动兜底：party serve ${decision.channel} --runner codex`;
    deps.log(`start-failed: ${detail} ${kindTag}`);
    return { action: "start-failed", channel: decision.channel, detail };
  }
  deps.log(decision.args.includes("--target-thread")
    ? `started-native: pid=${pid} channel=#${decision.channel} cwd=${decision.cwd} —— AgentParty @ 会进入现有 ChatGPT task ${kindTag}`
    : `started: pid=${pid} channel=#${decision.channel} cwd=${decision.cwd} —— ` +
      `被 @ 时唤醒的是一个新的 codex runner 会话，不是你眼前这个终端会话 ${kindTag}`);
  return decision;
}

/**
 * 决策日志尾部的形态标签（#976）：`kind=<interactive|non-interactive|unknown> detail=<探测依据>`。
 * 没探测（开关关着 / 没绑频道 / join 路径没给探测器）写 `kind=not-probed`，绝不假装探过。
 */
export function codexSessionKindLogTag(probe: CodexSessionKindProbe | null): string {
  if (probe === null) return "kind=not-probed";
  // detail 里有 rollout 头的 originator/source（外部文件内容），写日志前剥掉终端控制字符，
  // 免得 cat/tail 日志时被改写终端输出（CWE-117）。
  return `kind=${probe.kind} detail=${stripTerminalControls(probe.detail).replace(/\s+/g, " ")}`;
}

/**
 * 一条 codex hook 事件的全部处理：入册 +（按配置）拉起唤醒层。
 * 入册必须先于拉起：唤醒层的回收判据就是「频道上还有没有活着的入册 codex 会话」，
 * 本会话没入册就拉起，会在宽限期结束时被自己判成孤儿。
 */
export function handleCodexHookRecord(
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  autoWakeDeps?: CodexAutoWakeSpawnDeps,
): void {
  recordCodexSessionLifecycle(record, env);
  // serve 托管 lane（AP_ACTIVITY_FILE 有值）是被管理的 runner 会话，不是人开的交互式会话：
  // 它既不入册，也绝不许再拉一层唤醒层。
  if (record.hook_event_name !== "SessionStart" || env.AP_ACTIVITY_FILE) return;
  try {
    // #976：session_id 是定位本会话 rollout 头的钥匙，随 deps 一起交给形态探测。
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    maybeStartCodexAutoWake(record, autoWakeDeps ?? defaultCodexAutoWakeDeps(env, process.ppid, sessionId));
  } catch {
    // hook 铁律：拉不起来也绝不阻断 codex 启动。原因已进日志文件（stdout 恒空）。
  }
}

/** `party hook codex-stop` 的可注入依赖——测试直接塞假值，不碰真盘也不碰网。 */
export interface CodexStopWakeDeps {
  /** 本 cwd 绑定的频道。 */
  channel: (cwd: string) => string | null;
  /** 前台唤醒是否启用（沿用 #893 的 codex-autowake 开关）。 */
  enabled: () => boolean;
  /**
   * 触发本次 Stop 的 codex 是不是人在用的会话（#982，与 codex-report 同一道判定）。
   * `non-interactive` ⇒ 放行不注入、不解析身份；`interactive` / `unknown` / 缺省 ⇒ 原路径。
   */
  sessionKind?: () => CodexSessionKindProbe;
  /** serve/watch 落在本地的欠账——**可选快路径**，没有也照样能判（#903）。 */
  stuck: (channel: string, cwd: string) => Pick<StuckWake, "seq" | "first_wake_ts"> | null;
  /**
   * 问服务端「> since 的第一条 @ 我的消息是第几条」（#903）。只回 seq，不拉正文。
   * #958 起同时带回 since 之后全部 @ 我的 seq（`seqs`，老服务端为 null），用来说出积压深度。
   * 实现必须自带独立超时并吞掉一切异常：拿不到就返回 null（= 本次放行）。
   */
  nextMention: (channel: string, cwd: string, since: number) => Promise<NextMention | null>;
  cursor: (channel: string, cwd: string) => number;
  /**
   * 查询/游标实际使用的身份 config。注入 prompt 必须把后续 CLI 命令钉在同一路径；缺省保留
   * 老调用方的 cwd/global 行为。
   */
  configPath?: (channel: string, cwd: string) => string | null;
  /** 已注入过的 seq 集合的落盘路径；拿不到身份时返回 null（→ 无法去重，必须放行）。 */
  seenPath: (channel: string, cwd: string) => string | null;
  readSeen: (path: string) => CodexStopWakeSeenEntry[];
  recordSeen: (path: string, seq: number, now: number) => void;
  emit: (line: string) => void;
  log: (line: string) => void;
  now: () => number;
  /**
   * 注入提示的语言（#1003）：config `lang` 覆盖 > 本身份在频道最近的消息 > LANG > en。只在真要 block 时才调
   * （放行路径一次网络都不多发）；实现必须自带超时并吞掉异常。缺省（老调用方/测试）⇒ zh，即这条文案的历史行为。
   */
  wakeLang?: (channel: string, cwd: string) => Promise<WakeLang>;
}

export function defaultCodexStopWakeDeps(
  env: NodeJS.ProcessEnv = process.env,
  sessionId: string | null = null,
  pid: number = process.ppid,
  hookIdentityDeps: CodexHookIdentityDeps = defaultCodexHookIdentityDeps(env, pid),
): CodexStopWakeDeps {
  const home = agentpartyHome(env);
  // #917：身份只解析一次，全部下游（查询用的 token/实例、游标作用域、seen 集合）都用它。
  // 此前这里每处各调一次 `readConfig(cwd)`——按 cwd 猜，真机上猜到了同目录下另一个身份、
  // 还跨了实例，于是查询恒空、唤醒静默失效（#917 现场）。解析不出就统一返回 null ＝ 放行。
  let cached: { key: string; resolution: CodexHookIdentityResolution } | null = null;
  let logged = false;
  const identity = (channel: string, cwd: string): CodexHookIdentity | null => {
    const key = `${channel} ${cwd}`;
    if (cached === null || cached.key !== key) {
      cached = {
        key,
        resolution: resolveCodexHookIdentity({
          cwd,
          channel,
          sessionId,
          deps: hookIdentityDeps,
        }),
      };
    }
    if (cached.resolution.ok) return cached.resolution.identity;
    // #971：本目录的身份全是别的 harness 的＝codex 不接本频道是预期状态，每个 Stop 都记一行只是噪音。
    if (!logged && cached.resolution.reason !== "no-codex-binding") {
      logged = true;
      appendCodexAutoWakeLog(
        home,
        `codex-stop: 解析不出本会话身份（${cached.resolution.reason}）：` +
          `${cached.resolution.detail}——本次放行不注入`,
      );
    }
    return null;
  };
  const target = (channel: string, cwd: string): string | null => {
    const resolved = identity(channel, cwd);
    if (resolved === null) return null;
    const auth = codexAutoWakeAuth(resolved);
    return auth === null ? null : codexAutoWakeTarget(auth, channel);
  };
  return {
    channel: (cwd) => env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel ?? null,
    enabled: () => resolveCodexAutoWakeMode(env, home).mode !== "off",
    // #982：与 SessionStart 同一道探测——先读本会话的 rollout 头（#976），读不到再看进程形态。
    sessionKind: () => probeCodexSessionKind({ hookParentPid: pid, sessionId, env }),
    // 游标/欠账必须落在**解析出来那个身份**的作用域里：拿另一个身份的游标当 since，
    // 查询要么恒空（漏叫）要么把老 @ 翻出来。env / cwd 两档的作用域与历史逐字一致。
    stuck: (channel, cwd) => {
      const resolved = identity(channel, cwd);
      return resolved !== null && resolved.configScopedState && resolved.configPath !== null
        ? loadStuckForConfig(channel, resolved.configPath)
        : loadStuck(channel, cwd);
    },
    nextMention: async (channel, cwd, since) => {
      const resolved = identity(channel, cwd);
      const auth = resolved === null ? null : codexAutoWakeAuth(resolved);
      if (auth === null) return null;
      try {
        const { fetchNextMention } = await import("../rest");
        return await fetchNextMention(
          auth.server,
          auth.token,
          channel,
          since,
          AbortSignal.timeout(CODEX_STOP_WAKE_QUERY_TIMEOUT_MS),
        );
      } catch {
        // 超时 / 401 / 断网 / 服务端还没这个端点（旧实例回 404）——一律当「不知道」，放行。
        return null;
      }
    },
    cursor: (channel, cwd) => {
      const resolved = identity(channel, cwd);
      return resolved !== null && resolved.configScopedState && resolved.configPath !== null
        ? loadCursorForConfig(channel, resolved.configPath)
        : loadCursor(channel, cwd);
    },
    configPath: (channel, cwd) => identity(channel, cwd)?.configPath ?? null,
    seenPath: (channel, cwd) => {
      const resolved = target(channel, cwd);
      return resolved === null ? null : codexStopWakeSeenPath(home, resolved);
    },
    readSeen: readCodexStopWakeSeen,
    recordSeen: (path, seq, at) => recordCodexStopWakeSeen(path, seq, at),
    emit: (line) => emitHookLine(line),
    log: (line) => appendCodexAutoWakeLog(home, line),
    now: () => Date.now(),
    wakeLang: async (channel, cwd) => {
      const resolved = identity(channel, cwd);
      const auth = resolved === null ? null : codexAutoWakeAuth(resolved);
      // config `lang` 覆盖：读**解析出来那个身份**的 config（#917 教训：按 cwd 猜会猜到别的身份）；没路径才退回 cwd 档。
      let override: unknown = null;
      try {
        override = resolved?.configPath !== null && resolved?.configPath !== undefined
          ? (JSON.parse(readFileSync(resolved.configPath, "utf8")) as { lang?: unknown }).lang ?? null
          : readConfig(cwd)?.lang ?? null;
      } catch {
        override = null;
      }
      const { resolveWakeLang } = await import("../wake-note-i18n");
      // 历史那一跳与 next-mention 同一预算（独立 3s 超时）；拉不到就按 LANG/en，绝不卡住 Stop hook。
      const name = resolved?.name ?? null;
      return resolveWakeLang({
        override,
        source: auth === null || name === null ? null : { server: auth.server, token: auth.token, channel, identity: name },
        env,
        signal: AbortSignal.timeout(CODEX_STOP_WAKE_QUERY_TIMEOUT_MS),
      });
    },
  };
}

/**
 * 一条 codex Stop 事件的全部处理（#899）。
 *
 * 唯一允许写 stdout 的路径就是最后那一行 block JSON——契约要求 `decision:"block"` 必须
 * 配一个非空 `reason`，而 `reason` 同时就是注入给模型的 prompt（**没有 `prompt` 字段**，
 * 多带一个会让 codex 整份输出作废，见 codex-stop-wake.ts 文件头）。
 *
 * 放行（不写任何 stdout）是所有异常路径的统一归宿：拿不到身份、读盘炸了、判定说不该叫——
 * 一律安静让会话正常停止。宁可漏叫一次，也绝不把用户的会话卡在无限续跑里。
 */
export async function handleCodexStopRecord(
  record: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  injected?: CodexStopWakeDeps,
): Promise<void> {
  // #917：session_id 是「按会话回查身份」的钥匙，必须在建 deps 之前从 payload 里取出来。
  const deps = injected ?? defaultCodexStopWakeDeps(
    env,
    typeof record.session_id === "string" ? record.session_id : null,
  );
  // serve 托管 lane 是被管理的 runner 会话，不是用户眼前那个终端会话——前台唤醒对它没有意义，
  // 而且它自己就是 #893 那条后台通道，在这里再 block 一次等于同一条 @ 被两边各处理一次。
  if (env.AP_ACTIVITY_FILE) return;
  if (record.hook_event_name !== "Stop") return;
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
  const channel = deps.channel(cwd);
  // 先过便宜闸再花网络：不是 Stop / 是续跑 / 被关掉 / 没绑频道，一次请求都不发（#903）。
  if (!codexStopWakeGate({ payload: record, channel, enabled: deps.enabled() }).ok) return;
  const boundChannel = channel as string;
  // #982：身份解析之前先判会话形态——被 Claude 委托的一次性 codex 每回合都触发 Stop，此前每回合
  // 都走一遍身份解析、打一条 harness-mismatch / 解析不出的长文，与 SessionStart（codex-report）
  // 的 skip(non-interactive) 一行不一致。non-interactive ⇒ 放行，一行留痕即止；interactive /
  // unknown ⇒ 原路径（Stop 不拉唤醒层，unknown 在这里没有更贵的一侧）。探测炸了也按原路径。
  const sessionKind = probeCodexStopSessionKind(deps);
  if (sessionKind?.kind === "non-interactive") {
    deps.log(`codex-stop: skip(non-interactive) ${codexSessionKindLogTag(sessionKind)}`);
    return;
  }
  const cursor = deps.cursor(boundChannel, cwd);
  const seenPath = deps.seenPath(boundChannel, cwd);
  const seenEntries = seenPath === null ? [] : deps.readSeen(seenPath);
  const seen = liveCodexStopWakeSeen(seenEntries, deps.now());
  // #922：查询的 since 抬到「游标 与 已提示过且仍在时效内的最大 seq」的较大者。
  // 只用游标的话，被提示过却没处理的那条会永久占住队首，后面的 @ 一条都够不着（真机实测）。
  const since = codexStopWakeQuerySince(cursor, seen);
  // 快路径：serve/watch 恰好留了欠账就直接用，省掉这次网络。同样以 since 为底——
  // 本地欠账若正是那条已提示过的队首，它一样会把后面的 @ 挡死。
  const stuck = deps.stuck(boundChannel, cwd);
  let pending: { seq: number; first_wake_ts?: number } | null =
    stuck !== null && Number.isFinite(stuck.seq) && stuck.seq > since ? stuck : null;
  if (pending === null) {
    // 慢路径也是**主路径**：本 hook 的目标场景恰恰是「没人挂 serve」，那时本地永远没有欠账。
    const startedAt = deps.now();
    const next = await deps.nextMention(boundChannel, cwd, since);
    // #958：积压深度＝队首之后还有几条。老服务端不报列表 ⇒ 不知道 ⇒ 提示里不说深度（绝不假装只有一条）。
    const backlog = codexStopWakeBacklog(next);
    deps.log(
      `codex-stop: next-mention 查询（since ${since}）耗时 ${deps.now() - startedAt}ms，` +
        `结果 ${next === null ? "无/不可用" : `seq ${next.seq}`}` +
        (backlog === undefined ? "" : `，之后还排着 ${backlog.remaining}${backlog.exact ? "" : "+"} 条`),
    );
    // 服务端问来的是「此刻仍未处理」，天然不可能是陈年欠账，故 first_wake_ts 取现在。
    pending = next === null
      ? null
      : { seq: next.seq, first_wake_ts: deps.now(), ...(backlog === undefined ? {} : { backlog }) };
  }
  const decision = decideCodexStopWake({
    payload: record,
    channel: boundChannel,
    enabled: true,
    pending,
    cursor,
    seen,
    now: deps.now(),
  });
  if (!decision.wake) return;
  // 去不了重就绝不注入：没有落盘的 seen 集合，同一条 @ 会在每个 turn 结束时反复 block。
  if (seenPath === null) {
    deps.log("codex-stop: 拿不到本会话的唯一身份（见上一条解析日志），无法去重，本次放行不注入");
    return;
  }
  const configPath = deps.configPath?.(boundChannel, cwd) ?? null;
  const configOption = configPath === null ? null : codexStopWakeConfigOption(configPath);
  if (configPath !== null && configOption === null) {
    deps.log("codex-stop: 本会话 config 路径无法安全编码进 prompt，本次放行不注入");
    return;
  }
  // #1003：只有确定要 block 才去判语言（可能多一跳历史查询）；任何异常都退到 zh（历史行为），不影响注入。
  let lang: WakeLang = "zh";
  if (deps.wakeLang !== undefined) {
    try {
      lang = await deps.wakeLang(boundChannel, cwd);
    } catch {
      lang = "zh";
    }
  }
  const pointer: CodexStopWakePointer = {
    ...decision.pointer,
    ...(configPath === null ? {} : { configPath }),
  };
  const reason = codexStopWakeReason(pointer, lang);
  if (configOption !== null) {
    const requiredCommand = pointer.backlog !== undefined && pointer.backlog.remaining > 0
      ? codexStopWakeScopedPartyCommand(configPath!, ["ack", "--drain", "--channel", pointer.channel])
      : codexStopWakeScopedPartyCommand(
        configPath!,
        ["history", pointer.channel, "--since", String(Math.max(0, pointer.seq - 1))],
      );
    // 512B 截断绝不能留下半条 config 或裸命令；装不下就放行，宁可这次不叫也不误投另一实例。
    if (requiredCommand === null || !reason.includes(`\`${requiredCommand}\``)) {
      deps.log("codex-stop: 固定身份的可执行命令装不进 512B prompt，本次放行不注入");
      return;
    }
  }
  // 先落盘再打印。反过来的话，打印后崩一次就会对同一条 @ 反复注入。
  deps.recordSeen(seenPath, decision.pointer.seq, deps.now());
  deps.emit(JSON.stringify({
    decision: "block",
    reason,
  }));
  const depth = decision.pointer.backlog;
  deps.log(
    `codex-stop: 在当前 codex 会话里注入了 #${decision.pointer.channel} seq ${decision.pointer.seq} 的指针` +
      (depth === undefined ? "" : `（第 1/${depth.remaining + 1}${depth.exact ? "" : "+"} 条，提示里已给出排空命令）`),
  );
}

/** #982：Stop 路径的形态探测；没注入 / 探测抛异常都当「没结论」，走原路径。 */
function probeCodexStopSessionKind(deps: CodexStopWakeDeps): CodexSessionKindProbe | null {
  if (deps.sessionKind === undefined) return null;
  try {
    return deps.sessionKind();
  } catch {
    return null;
  }
}

/**
 * 从 next-mention 的回答里算积压深度（#958）：`seqs` 是 since 之后全部 @ 我的 seq，队首之外的就是
 * 还排着的。老服务端没有 `seqs` ⇒ undefined ⇒ 提示里不提深度。纯函数，便于单测。
 */
export function codexStopWakeBacklog(next: NextMention | null): CodexStopWakePointer["backlog"] | undefined {
  if (next === null || next.seqs === null) return undefined;
  return { remaining: Math.max(0, next.seqs.length - 1), exact: !next.truncated };
}

/** `party hook codex-stop`：读一条 codex Stop 事件，必要时 block 一次让会话继续跑一轮。 */
async function runCodexStopHookInput(): Promise<number> {
  try {
    const payload = JSON.parse(await readStdin(MAX_STDIN_BYTES)) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return 0;
    await handleCodexStopRecord(payload as Record<string, unknown>);
  } catch {
    // hook 铁律高于唤醒：坏 JSON / 读盘失败 / 任何意外，一律安静放行让会话正常停止。
  }
  return 0;
}

/** `party hook codex-report`：读一条 codex hook 事件，入册 + 按配置拉起唤醒层。stdout 恒空。 */
async function runCodexHookInput(): Promise<number> {
  try {
    const payload = JSON.parse(await readStdin(MAX_STDIN_BYTES)) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return 0;
    handleCodexHookRecord(payload as Record<string, unknown>);
  } catch {
    // 坏 JSON / 写盘失败都不配阻断 codex。
  }
  return 0;
}

/**
 * 给自动拉起的 serve 套上「放弃预算」（#893）。
 *
 * serve 自己的 supervisor 无限自愈——对**人手工挂**的 serve 是对的（人要它守着），对
 * **自动拉起**的这层不对：token 失效、服务端搬家、频道被删这类不会自己好的故障，会在每台
 * 装了 codex hook 的机器上留一个永远重试的后台进程。默认开启之后这条影响所有人，所以必需。
 *
 * 独立成函数只为可测：不真起 serve 也能验「短命失败累计到上限就当终局、跑够久就清零」。
 */
export function codexAutoWakeServeDeps(input: {
  channel: string;
  budget: CodexAutoWakeStartupBudget;
  log: (line: string) => void;
  now: () => number;
  superviseServe: (opts: ServeSupervisorOptions) => Promise<number>;
  isTerminalServeExit: (code: number) => boolean;
}): { superviseServe: (opts: ServeSupervisorOptions) => Promise<number> } {
  return {
    superviseServe: (opts) => input.superviseServe({
      ...opts,
      runOnce: async () => {
        const attemptStartedAt = input.now();
        try {
          return await opts.runOnce();
        } finally {
          input.budget.recordRun(input.now() - attemptStartedAt);
        }
      },
      // 预算用完就把这次退出当成终局，让 serve 的 supervisor 停止自愈并返回。
      isTerminal: (code) => {
        if (input.budget.exhausted()) {
          input.log(
            `giving-up: #${input.channel} 上唤醒层连续 ${input.budget.consecutiveFailures()} 次起不来` +
              `（最后退出码 ${code}）——退场，不再无限重试。查 \`party doctor\` / 凭据 / 网络；` +
              `修好后新开一个 codex 会话即可重新拉起`,
          );
          return true;
        }
        return (opts.isTerminal ?? input.isTerminalServeExit)(code);
      },
    }),
  };
}

/**
 * 被监管的唤醒层本体（#893）：**同一个进程**里跑 `party serve <ch> --runner codex`，
 * 另挂一条存活探测负责收尾。
 *
 * 为什么不另起一个看护进程：serve 自己已经处理 SIGTERM 优雅收口（关连接、放实例锁、
 * 结清欠账）。给自己发 SIGTERM 就能复用那条路径，一个进程解决，不必新增第二个常驻。
 *
 * 去重完全交给 serve 自己的实例锁（身份+频道粒度）：hook 侧的预检是省一次 spawn 的
 * 优化，锁才是权威。两个会话同时启动时，第二个 serve 拿不到锁，打印后以
 * EXIT_ALREADY_SERVING 退出，绝不会出现两个唤醒层。
 */
export async function runCodexAutoWakeSupervise(
  channel: string,
  deps: {
    env?: NodeJS.ProcessEnv;
    liveOwners?: () => number;
    now?: () => number;
    terminate?: () => void;
    log?: (line: string) => void;
    serve?: (argv: string[]) => Promise<number>;
    nativeRoute?: CodexDesktopIpcRoute | null;
    nativeBridge?: (options: {
      channel: string;
      sourceThreadId: string;
      targetThreadId: string;
      env?: NodeJS.ProcessEnv;
    }) => Promise<number>;
    budget?: CodexAutoWakeStartupBudget;
    pollMs?: number;
    graceMs?: number;
    /** #959：回收时把「刚被回收」写回的标记文件；缺省从拉起方传的环境变量里取，没有就不记。 */
    markerPath?: string | null;
  } = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const home = agentpartyHome(env);
  const markerPath = deps.markerPath === undefined ? env[CODEX_AUTO_WAKE_MARKER_ENV] ?? null : deps.markerPath;
  const log = deps.log ?? ((line: string) => appendCodexAutoWakeLog(home, line));
  const now = deps.now ?? (() => Date.now());
  const liveOwners = deps.liveOwners ??
    (() => listCodexSessions(env).filter((entry) => entry.channel === channel).length);
  const terminate = deps.terminate ?? (() => {
    // serve 自己监听 SIGTERM 并优雅收口；自发一刀即可复用那条路径。
    try { process.kill(process.pid, "SIGTERM"); } catch { /* 已经在退了 */ }
  });
  // 放弃预算（默认开启后必需）：serve 自己的 supervisor 无限自愈——对**人手工挂**的 serve
  // 是对的，对**自动拉起**的这层不是。token 失效 / 服务端搬家 / 频道被删这类不会自己好的故障，
  // 会在每台装了 codex hook 的机器上留一个永远重试的后台进程。连续短命失败够多次就安静退场，
  // 下一次 codex SessionStart 自然会再试（那时故障可能已经修好）。
  const budget = deps.budget ?? createCodexAutoWakeStartupBudget();
  const serve = deps.serve ?? (async (argv: string[]) => {
    const serveModule = await import("./serve");
    return serveModule.run(argv, codexAutoWakeServeDeps({
      channel,
      budget,
      log,
      now,
      superviseServe: serveModule.superviseServe,
      isTerminalServeExit: serveModule.isTerminalServeExit,
    }));
  });
  const nativeBridge = deps.nativeBridge ?? (async (options) => {
    const native = await import("./codex-native-bridge");
    return native.runCodexNativeBridge(options);
  });
  const startedAt = now();
  const timer = setInterval(() => {
    const owners = liveOwners();
    if (!shouldReapCodexAutoWake({ startedAt, now: now(), liveOwners: owners, graceMs: deps.graceMs })) return;
    clearInterval(timer);
    const reapedAt = now();
    // #959：先落退避证据再退场——下一个 SessionStart 看到「刚被短命回收」就不会再拉起。
    if (markerPath !== null && markerPath !== "") recordCodexAutoWakeReap(markerPath, reapedAt, reapedAt - startedAt);
    log(`reaping: #${channel} 上已无存活的交互式 codex 会话，唤醒层退场（下次交互式 SessionStart 会重新拉起）`);
    terminate();
  }, deps.pollMs ?? CODEX_AUTO_WAKE_POLL_MS);
  try {
    return deps.nativeRoute == null
      ? await serve([channel, "--runner", "codex"])
      : await nativeBridge({
          channel,
          sourceThreadId: deps.nativeRoute.sourceThreadId,
          targetThreadId: deps.nativeRoute.targetThreadId,
          env,
        });
  } finally {
    clearInterval(timer);
  }
}

export function parseCodexAutoWakeSupervisorArgs(argv: readonly string[]): {
  channel?: string;
  targetThreadId?: string;
  sourceThreadId?: string;
} {
  const boundary = argv.indexOf("--");
  const flags = boundary === -1 ? argv : argv.slice(0, boundary);
  const valueAfter = (name: string): string | undefined => {
    const index = flags.indexOf(name);
    return index >= 0 ? flags[index + 1] : undefined;
  };
  return {
    channel: valueAfter("--channel"),
    targetThreadId: valueAfter("--target-thread"),
    sourceThreadId: valueAfter("--source-thread"),
  };
}

function runCodexAutoWakeCommand(argv: string[]): Promise<number> | number {
  const env = process.env;
  const home = agentpartyHome(env);
  if (argv[0] === "--supervise") {
    const { channel, targetThreadId, sourceThreadId } = parseCodexAutoWakeSupervisorArgs(argv);
    if (!channel) {
      console.error("hook codex-autowake --supervise 需要 --channel <channel>");
      return 1;
    }
    if ((targetThreadId === undefined) !== (sourceThreadId === undefined)) {
      console.error("native codex-autowake 必须同时给 --target-thread 与 --source-thread");
      return 1;
    }
    if (targetThreadId !== undefined &&
        (!isClaudeSessionRegistrySessionId(targetThreadId) ||
          !isClaudeSessionRegistrySessionId(sourceThreadId) ||
          targetThreadId.toLowerCase() === sourceThreadId.toLowerCase())) {
      console.error("native codex-autowake 需要两个不同且有效的 ChatGPT task id");
      return 1;
    }
    return runCodexAutoWakeSupervise(channel, {
      nativeRoute: targetThreadId === undefined
        ? null
        : { targetThreadId, sourceThreadId: sourceThreadId! },
    });
  }
  const sub = argv[0] ?? "status";
  if (sub === "on" || sub === "off") {
    writeCodexAutoWakeSetting(home, sub === "on" ? "serve" : "off");
    console.log(
      sub === "on"
        ? "codex auto-wake: on（这也是默认值）—— ChatGPT Desktop 优先把 @ 原生送进现有 task；" +
          "裸 Codex CLI 回落 `party serve <channel> --runner codex`，那一档会新建 runner 会话。"
        : "codex auto-wake: off —— 已显式关闭，不再自动拉起任何后台进程" +
          "（已在跑的用 `party serve <channel> --stop` 停；想恢复默认行为：`party hook codex-autowake on`）。",
    );
    return 0;
  }
  if (sub !== "status") {
    console.error("usage: party hook codex-autowake [status|on|off]");
    return 1;
  }
  const resolution = resolveCodexAutoWakeMode(env, home);
  console.log(
    `mode: ${resolution.mode} (source: ${resolution.source})` +
      (resolution.source === "default" ? " —— 默认开启，装了 codex hook 就能被唤醒，不用再拨开关" : "") +
      (resolution.mode === "off" ? "；显式关闭中，`party hook codex-autowake on` 恢复默认行为" : ""),
  );
  console.log("ChatGPT Desktop 优先原生进入现有 task；裸 Codex CLI 回落时才会新建 runner 会话");
  console.log(`setting: ${codexAutoWakeSettingPath(home)}`);
  console.log(`log: ${codexAutoWakeLogPath(home)}`);
  const cwd = process.cwd();
  const channel = env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel ?? null;
  const auth = codexAutoWakeAuth(readConfig(cwd));
  if (channel === null) {
    console.log("channel: (本目录没有绑定频道)");
  } else if (auth === null) {
    console.log(`channel: #${channel}；config 里没有 agent token，不会自动拉起`);
  } else {
    const pid = runningServePid(auth, channel, defaultInstanceLockDir());
    console.log(`channel: #${channel}；serve: ${pid === null ? "未在跑" : `pid ${pid}`}`);
  }
  return 0;
}

function reportHookPayload(
  record: Record<string, unknown>,
  overridePhase?: AgentActivity["phase"],
  forcePush = false,
): void {
  const now = Date.now();
  const activity: AgentActivity | null = overridePhase === undefined
    ? activityFromHookEvent(record, now)
    : { phase: overridePhase, ts: now };
  if (activity === null) return;
  const target = activityTargetFile(process.env, record, agentpartyHome());
  if (target === null) return;
  const previous = readActivityFile(target, now, AGENT_ACTIVITY_TTL_MS);
  writeActivityFile(target, activity);
  // 交互 lane（#615）：serve 托管时（AP_ACTIVITY_FILE 有值）上行归 serve 心跳，这里绝不直报。
  // Marketplace hooks load in every enabled-plugin session. Only an explicit
  // AgentParty launcher may project this session's activity onto the shared
  // identity/channel presence row; otherwise an unrelated ordinary Claude
  // session could overwrite the real listener's tool/waiting state.
  if (
    !process.env.AP_ACTIVITY_FILE &&
    process.env[CLAUDE_LIFECYCLE_OPT_IN_ENV] === "1"
  ) {
    // Permission/Elicitation waits must become visible immediately even when
    // PreToolUse just consumed the ordinary throttle window. Clearing a wait,
    // ending a turn, and a rare tool/turn failure are also state boundaries;
    // repeated notifications in the same phase remain throttled.
    const event = typeof record.hook_event_name === "string" ? record.hook_event_name : "";
    maybeSpawnPush(target, activity, record, now, forcePush || shouldForceActivityPush(previous, activity, event));
  }
}

async function unfinishedClaudeChannelEntries(record: Record<string, unknown>): Promise<DeliveryRecoveryEntry[]> {
  const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
  const channel = process.env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel;
  if (!channel) return [];
  const { resolveAuthDetailed } = await import("../oidc-cli");
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) return [];
  const journal = new DeliveryRecoveryJournal(
    deliveryRecoveryJournalPath("claude", auth.server, auth.token, channel),
    channel,
    "claude",
  );
  return journal.entries();
}

async function runHookInput(blockStop: boolean): Promise<number> {
  try {
    const raw = await readStdin(MAX_STDIN_BYTES);
    const payload = JSON.parse(raw) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return 0;
    const record = payload as Record<string, unknown>;
    recordClaudeSessionLifecycle(record);
    if (!blockStop || record.hook_event_name !== "Stop" || record.stop_hook_active !== false) {
      reportHookPayload(record);
      return 0;
    }
    // Plugin hooks are loaded into every Claude session when the plugin is
    // enabled. Only an explicit AgentParty launcher owns this recovery
    // journal and may continue a Stop. Otherwise an unrelated ordinary Claude
    // session in the same workspace could be blocked by another session's
    // delivered AgentParty work.
    const lifecycleOptedIn = process.env[CLAUDE_LIFECYCLE_OPT_IN_ENV] === "1";
    if (!lifecycleOptedIn) {
      reportHookPayload(record);
      return 0;
    }
    let entries: DeliveryRecoveryEntry[];
    try {
      entries = await unfinishedClaudeChannelEntries(record);
    } catch {
      // A failed journal/auth probe must not suppress the ordinary Stop/idle
      // snapshot even though the guard itself fails open.
      reportHookPayload(record);
      return 0;
    }
    if (!shouldBlockAgentPartyStop(record, entries, lifecycleOptedIn)) {
      reportHookPayload(record);
      return 0;
    }
    const pendingCount = entries.filter((entry) => STOP_GUARD_PHASES.has(entry.phase)).length;
    // A blocked Stop starts another Claude continuation. Never publish idle
    // first: the optimistic push marker would throttle this correction and
    // leave the channel claiming the agent stopped while it is still working.
    // Force this single correction through the ordinary activity throttle: a
    // recent permission/tool/idle push must not mask that the model was kept
    // alive for another continuation.
    reportHookPayload(record, "working", true);
    // 唯一允许写 stdout 的出口（#1032）：闸内其余 console.log 都被改道去了 stderr。
    emitHookLine(JSON.stringify({
      decision: "block",
      reason:
        `AgentParty still has ${pendingCount} delivered execution${pendingCount === 1 ? "" : "s"} ` +
        "without a linked channel reply. Finish the claim/accept/reply flow, or explicitly move the " +
        "execution to waiting_owner, before stopping.",
    }));
  } catch {
    // Activity reporting and the stop guard both fail open. A broken local file or auth
    // probe must not strand an unrelated Claude session in an unbounded continuation.
  }
  return 0;
}

/**
 * hook 路径的 stdout 闸（#1032）。
 *
 * 这些子命令的输出契约是「要么零字节，要么恰好一行 JSON」——codex 拿 stdout 当 Stop hook 的
 * 决策，Claude 拿 stdout 当模型上下文。可路径上任何一处 `console.log`（我们自己的、还是某个
 * 被 import 进来的模块的）都会直接落进那条信道并让它变成非法输出。真机实测：一个交互式 codex
 * 会话轮次结束时报 `hook returned invalid stop hook JSON output`。
 *
 * `party mcp` 早就为同一个原因做过这件事（#596：stdio 是 JSON-RPC 信道）。这里照抄：把
 * console.log 改道到 stderr，只留一条显式通道给真正要写的那行。
 *
 * 注意这不是「猜哪里会打印」——它让契约与打印点解耦：以后谁往这条路径上加日志都不会再破坏它。
 */
export async function withHookStdoutGuard(body: () => Promise<number>): Promise<number> {
  const previous = console.log;
  hookStdoutWrite = (line: string) => previous(line);
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    return await body();
  } finally {
    console.log = previous;
    hookStdoutWrite = null;
  }
}

/** 闸打开期间，唯一允许写 stdout 的通道；闸外为 null（照常用 console.log）。 */
let hookStdoutWrite: ((line: string) => void) | null = null;

/** hook 决策行的唯一出口：闸内走保留下来的真 stdout，闸外退回 console.log。 */
export function emitHookLine(line: string): void {
  if (hookStdoutWrite === null) console.log(line);
  else hookStdoutWrite(line);
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const [sub, ...rest] = argv;
  if (sub === "install") return runInstall(rest);
  if (sub === "uninstall") return runUninstall(rest);
  if (sub === "status") return runStatus(rest);
  if (sub === "push") return runPush(rest);
  if (sub === "codex-report") return withHookStdoutGuard(() => runCodexHookInput());
  if (sub === "codex-stop") return withHookStdoutGuard(() => runCodexStopHookInput());
  if (sub === "codex-autowake") return runCodexAutoWakeCommand(rest);
  if (sub !== "report" && sub !== "stop-guard") {
    // 会写 stderr 的分支只剩人在终端敲错子命令。真 hook 调用恒为 `hook report`，不受影响。
    console.error(HELP);
    return 1;
  }
  return withHookStdoutGuard(() => runHookInput(sub === "stop-guard"));
}
