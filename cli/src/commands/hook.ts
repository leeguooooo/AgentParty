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
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_ACTIVITY_TTL_MS, type AgentActivity } from "@agentparty/shared";
import { activityFromHookEvent, readActivityFile, writeActivityFile } from "../activity";
import { agentpartyHome, readConfig, readState } from "../config";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
  type DeliveryRecoveryEntry,
} from "../delivery-recovery-journal";
import { atomicWriteJson, atomicWriteText } from "../atomic-json";
import {
  isClaudeSessionRegistrySessionId,
  listCodexSessions,
  registerClaudeSession,
  registerCodexSession,
  unregisterClaudeSession,
} from "../claude-session-registry";
import {
  CODEX_AUTO_WAKE_ENV,
  CODEX_AUTO_WAKE_POLL_MS,
  activeCodexAutoWakePid,
  appendCodexAutoWakeLog,
  claimCodexAutoWake,
  codexAutoWakeAuth,
  codexAutoWakeLogPath,
  codexAutoWakeMarkerPath,
  codexAutoWakeSettingPath,
  codexAutoWakeTarget,
  decideCodexAutoWake,
  recordCodexAutoWakePid,
  resolveCodexAutoWakeMode,
  runningServePid,
  shouldReapCodexAutoWake,
  writeCodexAutoWakeSetting,
  type CodexAutoWakeDecision,
} from "../codex-auto-wake";
import { defaultInstanceLockDir, isSameLiveProcess } from "../instance-lock";
import { nativeSessionName } from "../claude-inbox-inject";
import { isHelpArg } from "../args";
import { isPartyBinaryPath } from "../upgrade";
import { CLAUDE_LIFECYCLE_OPT_IN_ENV } from "./claude-launch";

const HELP = `usage: party hook <report|codex-report|codex-autowake|stop-guard|push|install|uninstall|status>

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
  uninstall [--user|--codex]   remove exactly the entries install added
  status [--user|--codex]      show whether the hooks are installed
  codex-report         (wired by \`install --codex\`) read one codex hook event
                       from stdin and register an interactive codex session into
                       ~/.agentparty/codex-sessions/ so party can discover it.
                       Registry only — never presence, never network. When codex
                       auto-wake is ON it also starts the wake layer (#893).
  codex-autowake [status|on|off]
                       codex has no MCP sampling and declines idle elicitation
                       (#893), so it can only be reached by a local wake layer.
                       Turning this ON makes every codex SessionStart start
                       \`party serve <channel> --runner codex\` in the background
                       (once per identity+channel — the serve instance lock is the
                       authority), and reap it once no registered codex session on
                       that channel is alive. Default OFF: starting a background
                       process on someone's machine is intrusive.
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

const HOOK_COMMAND_MARKERS = ["hook report", "hook stop-guard", "hook codex-report"] as const;

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

export function settingsPath(scope: HookScope, cwd: string = process.cwd()): string {
  if (scope === "codex") return join(homedir(), ".codex", "hooks.json");
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
 */
export function codexHookSettingsJson(execPath: string = process.execPath): string {
  const partyBin = isPartyBinaryPath(execPath) ? execPath : "party";
  const command = `${partyBin === "party" ? partyBin : JSON.stringify(partyBin)} hook codex-report`;
  return JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }],
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
    const kept = stripOurCommands((current ?? []) as unknown[]);
    hooks[event] = [...kept, ...entries];
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
        "跨机被唤醒还需要本机有一个唤醒层（codex 既不支持 MCP sampling，idle 时也自动 decline " +
        "elicitation，#893）。`party hook codex-autowake on` 让它随 codex 会话自动起、没人用了自动退；" +
        "默认关闭，因为那是在你机器上起后台进程。开了之后被 @ 唤醒的是一个**新的 codex runner 会话**，" +
        "不是你眼前这个终端会话（#879）。也可以继续手挂 party bridge codex。"
      : "普通 Claude session 只写本地 activity；频道 presence 上行仍需 party claude、" +
        "party bridge claude 或托管 serve lane。",
  );
  return 0;
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

function runStatus(argv: string[]): number {
  const scope = hookScope(argv);
  const path = settingsPath(scope);
  const source = existsSync(path) ? readFileSync(path, "utf8") : null;
  let installed = false;
  if (source !== null) {
    try {
      const hooks = (JSON.parse(source) as { hooks?: Record<string, unknown[]> }).hooks ?? {};
      installed = Object.values(hooks).some((entries) => Array.isArray(entries) && entries.some(isOurEntry));
    } catch {
      console.error(`无法解析 ${termText(path)}`);
      return 1;
    }
  }
  console.log(`${installed ? "installed" : "not installed"} (${termText(path)})`);
  return installed ? 0 : 1;
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
    if (event !== "SessionStart" && event !== "SessionEnd") return;
    const sessionId = record.session_id;
    if (!isClaudeSessionRegistrySessionId(sessionId)) return;
    if (event === "SessionEnd") {
      unregisterClaudeSession(sessionId, env);
      return;
    }
    if (env.AP_ACTIVITY_FILE) return;
    const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : process.cwd();
    const channel = env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel;
    if (!channel) return;
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
      server: readConfig(cwd)?.server ?? null,
      cwd,
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
    registerCodexSession({
      session_id: sessionId,
      pid,
      display_name: claudeSessionDisplayNameFromHookPayload(record),
      channel,
      // #865：同 claude 档——实例维度是匹配的一部分。
      server: readConfig(cwd)?.server ?? null,
      cwd,
    }, env);
  } catch {
    // hook 铁律：注册表任何失败都不配影响模型。
  }
}

// ---- codex 零手动唤醒层（#893）----

export interface CodexAutoWakeSpawnDeps {
  home: string;
  env: NodeJS.ProcessEnv;
  lockDir: string;
  readConfigAt: (cwd: string) => { server?: unknown; token?: unknown } | null;
  channelAt: (cwd: string) => string | null;
  /** 返回子进程 pid；起不来返回 null。 */
  spawn: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => number | null;
  now: () => number;
  log: (line: string) => void;
  /** 「这个 pid 还是当初那个进程吗」——注入仅为可测。 */
  processAlive: (pid: number, startedAt?: number) => boolean;
  recordPid: (markerPath: string, channel: string, pid: number, now: number) => void;
}

function defaultCodexAutoWakeDeps(env: NodeJS.ProcessEnv = process.env): CodexAutoWakeSpawnDeps {
  const home = agentpartyHome(env);
  return {
    home,
    env,
    lockDir: defaultInstanceLockDir(),
    readConfigAt: (cwd) => readConfig(cwd),
    channelAt: (cwd) => env.AGENTPARTY_CHANNEL ?? readState(cwd)?.channel ?? null,
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
  const auth = codexAutoWakeAuth(deps.readConfigAt(cwd));
  const now = deps.now();
  const markerPath = auth !== null && channel !== null
    ? codexAutoWakeMarkerPath(deps.home, codexAutoWakeTarget(auth, channel))
    : null;
  const decision = decideCodexAutoWake({
    mode: resolution.mode,
    channel,
    cwd,
    hasAgentToken: auth !== null,
    // 已有 serve（不管是用户手挂的还是上一次自动拉的）就绝不拉第二个：一条 @ 触发两次
    // 完整 runner ＝ 双份回帖、git push 类副作用跑两遍。
    serveHolderPid: auth !== null && channel !== null ? runningServePid(auth, channel, deps.lockDir) : null,
    // 锁之外的第二层：serve 连不上服务端时会无限重连、根本走不到抢锁那步（真机实测），
    // 只看锁的话断网时每开一个 codex 会话就多堆一个永远重试的进程。
    startingPid: markerPath === null ? null : activeCodexAutoWakePid(markerPath, now, deps.processAlive),
  });
  if (decision.action === "skip") {
    // disabled 是绝大多数机器的常态，逐次记会把日志刷成噪音；其余跳过原因都值得留痕。
    if (decision.reason !== "disabled") deps.log(`skip(${decision.reason}): ${decision.detail}`);
    return decision;
  }
  if (markerPath !== null && !claimCodexAutoWake(markerPath, decision.channel, now, deps.processAlive)) {
    // 同一瞬间启动的另一个 codex 会话抢先了。
    const detail = `#${decision.channel} 上另一个 codex 会话正在拉起唤醒层，本次不拉`;
    deps.log(`skip(already-starting): ${detail}`);
    return { action: "skip", reason: "already-starting", detail };
  }
  const childEnv = {
    ...deps.env,
    // 二道防线：这个 serve 起的 codex runner 自己也会触发 SessionStart hook，绝不许再套娃。
    [CODEX_AUTO_WAKE_ENV]: "off",
  };
  const pid = deps.spawn(decision.args, decision.cwd, childEnv);
  if (pid !== null && markerPath !== null) deps.recordPid(markerPath, decision.channel, pid, now);
  if (pid === null) {
    const detail =
      `拉 \`party serve ${decision.channel} --runner codex\` 失败（spawn 没返回 pid）；` +
      `这台机器上没有唤醒层在跑。手动兜底：party serve ${decision.channel} --runner codex`;
    deps.log(`start-failed: ${detail}`);
    return { action: "start-failed", channel: decision.channel, detail };
  }
  deps.log(
    `started: pid=${pid} channel=#${decision.channel} cwd=${decision.cwd} —— ` +
      `被 @ 时唤醒的是一个新的 codex runner 会话，不是你眼前这个终端会话`,
  );
  return decision;
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
    maybeStartCodexAutoWake(record, autoWakeDeps ?? defaultCodexAutoWakeDeps(env));
  } catch {
    // hook 铁律：拉不起来也绝不阻断 codex 启动。原因已进日志文件（stdout 恒空）。
  }
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
    pollMs?: number;
    graceMs?: number;
  } = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const home = agentpartyHome(env);
  const log = deps.log ?? ((line: string) => appendCodexAutoWakeLog(home, line));
  const now = deps.now ?? (() => Date.now());
  const liveOwners = deps.liveOwners ??
    (() => listCodexSessions(env).filter((entry) => entry.channel === channel).length);
  const terminate = deps.terminate ?? (() => {
    // serve 自己监听 SIGTERM 并优雅收口；自发一刀即可复用那条路径。
    try { process.kill(process.pid, "SIGTERM"); } catch { /* 已经在退了 */ }
  });
  const serve = deps.serve ?? (async (argv: string[]) => (await import("./serve")).run(argv));
  const startedAt = now();
  const timer = setInterval(() => {
    const owners = liveOwners();
    if (!shouldReapCodexAutoWake({ startedAt, now: now(), liveOwners: owners, graceMs: deps.graceMs })) return;
    clearInterval(timer);
    log(`reaping: #${channel} 上已无存活的交互式 codex 会话，唤醒层退场（下次 SessionStart 会重新拉起）`);
    terminate();
  }, deps.pollMs ?? CODEX_AUTO_WAKE_POLL_MS);
  try {
    return await serve([channel, "--runner", "codex"]);
  } finally {
    clearInterval(timer);
  }
}

function runCodexAutoWakeCommand(argv: string[]): Promise<number> | number {
  const env = process.env;
  const home = agentpartyHome(env);
  if (argv[0] === "--supervise") {
    const idx = argv.indexOf("--channel");
    const channel = idx >= 0 ? argv[idx + 1] : undefined;
    if (!channel) {
      console.error("hook codex-autowake --supervise 需要 --channel <channel>");
      return 1;
    }
    return runCodexAutoWakeSupervise(channel);
  }
  const sub = argv[0] ?? "status";
  if (sub === "on" || sub === "off") {
    writeCodexAutoWakeSetting(home, sub === "on" ? "serve" : "off");
    console.log(
      sub === "on"
        ? "codex auto-wake: on —— 下次 codex 会话启动时会自动拉起 `party serve <channel> --runner codex`。\n" +
          "注意：被 @ 时唤醒的是一个新的 codex runner 会话，**不是**你眼前这个终端会话（issue #879）。"
        : "codex auto-wake: off —— 不再自动拉起任何后台进程（已在跑的用 `party serve <channel> --stop` 停）。",
    );
    return 0;
  }
  if (sub !== "status") {
    console.error("usage: party hook codex-autowake [status|on|off]");
    return 1;
  }
  const resolution = resolveCodexAutoWakeMode(env, home);
  console.log(`mode: ${resolution.mode} (source: ${resolution.source})`);
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
    console.log(JSON.stringify({
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
  if (sub === "codex-report") return runCodexHookInput();
  if (sub === "codex-autowake") return runCodexAutoWakeCommand(rest);
  if (sub !== "report" && sub !== "stop-guard") {
    // 会写 stderr 的分支只剩人在终端敲错子命令。真 hook 调用恒为 `hook report`，不受影响。
    console.error(HELP);
    return 1;
  }
  return runHookInput(sub === "stop-guard");
}
