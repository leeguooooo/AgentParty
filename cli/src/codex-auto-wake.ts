// codex 侧「零手动挂」唤醒层（issue #893）。
//
// 痛点：Claude 侧装上 Marketplace plugin 就能被跨机唤醒，codex 侧却必须人工挂一个
// `party bridge codex` / `party serve` 进程。owner 原话：「他不监听」。
//
// 为什么不是 MCP 自己反向唤醒（已实测证伪，别再走）：
//   ① codex 0.145 的 initialize 只声明 `{"elicitation":{...}}`，**不声明 sampling**——
//      二进制里那 16 处 `sampling/createMessage` 是协议完整性，运行时不给 server 用；
//   ② 会话 idle 时主动发 `elicitation/create`，23ms 自动回 `{"action":"decline"}`，
//      不弹用户、不拉起会话。与 Claude Code 的 #844 结论一致。
//
// ChatGPT Desktop 新路径：连接 App 自己的 0600 IPC router，发现目标 task 的 renderer owner，
// 再用 thread-follower-start-turn + codex_app toolOutput 把 @ 送进已有 task。裸 Codex CLI
// 没有这条 host 能力，才回落 `party serve --runner codex`。
//
// 三条硬约束：
//   1. **语义诚实**（#879）：native 路径进入现有 ChatGPT task；裸 CLI 回落才是一个
//      **全新的 runner 会话**。任何文案都必须说清当前走的是哪一条。
//   2. **默认开启**（owner 拍板：「我们应该做到直接能用，不要让用户选择」）——多拨一个开关
//      本身就是体验断层。但 `off` 必须仍然有效：默认替用户做对的事，不等于剥夺控制权。
//   3. **hook 铁律**：stdout 恒空、不阻塞、失败静默 exit 0。所以「失败要响亮」只能落到
//      日志文件（codexAutoWakeLogPath），绝不写 stdout。
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import { instanceLockHolderPid, instanceLockTarget, isSameLiveProcess, processStartedAt } from "./instance-lock";
import { healServerUrl } from "./validation";

export const CODEX_AUTO_WAKE_ENV = "AGENTPARTY_CODEX_AUTO_WAKE";
export const CODEX_AUTO_WAKE_SETTING_FILE = "codex-auto-wake.json";
export const CODEX_AUTO_WAKE_LOG_FILE = join("logs", "codex-auto-wake.log");
/** 日志上限；超过就滚一份 `.1`，绝不无限长。 */
export const CODEX_AUTO_WAKE_LOG_MAX_BYTES = 256 * 1024;
/** 存活探测间隔。 */
export const CODEX_AUTO_WAKE_POLL_MS = 30_000;
/**
 * 起步宽限：codex 没有 SessionEnd（#877 查证：十种 hook input 里没有任何会话结束事件），
 * 收尾只能靠注册表 pid 探活。宽限期内一律不回收，避免注册表写入/读取的短暂空窗把刚拉起的
 * serve 立刻打掉。
 */
export const CODEX_AUTO_WAKE_GRACE_MS = 60_000;
/**
 * 「一次跑够久就算这轮健康」的门槛。serve 连不上时每次 runOnce 几毫秒就返回；真正连上并
 * 服务过一段时间的会话不该消耗放弃预算。
 */
export const CODEX_AUTO_WAKE_HEALTHY_RUN_MS = 60_000;
/**
 * 连续失败多少次就不再自愈、自己退场（默认开启后这条尤其重要，见 decideCodexAutoWake 上方注释）。
 * 手工挂的 serve 该无限自愈——是人主动要它守着；自动拉起的这层不是，配置坏了/服务端没了
 * 就该安静退场，而不是在每个人机器上留一个永远重试的后台进程。
 * 配合 serve 的指数退避（1s→30s 封顶），20 次约等于 8 分钟连不上才放弃。
 */
export const CODEX_AUTO_WAKE_MAX_CONSECUTIVE_FAILURES = 20;
/**
 * 退避窗口（#959）：同 (身份, 频道) 的唤醒层刚被回收过，这段时间内 SessionStart 不再拉起。
 * 一次性 codex 一个接一个来时，没有这条就是「拉起 → 发帧 → 60 秒回收 → 再拉起」的死循环。
 */
export const CODEX_AUTO_WAKE_FLAP_WINDOW_MS = 10 * 60_000;
/**
 * 「短命」的定义：拉起后不到这么久就被回收 ＝ 没有人真的用过它。只对短命回收退避——
 * 一个人开着交互式 codex 干了半小时再关掉、两分钟后重新打开，唤醒层理应立刻回来。
 */
export const CODEX_AUTO_WAKE_FLAP_SHORT_LIFE_MS = 5 * 60_000;
/** 拉起时把标记文件路径交给唤醒层子进程：回收时它据此把「刚被回收」写回标记，供退避判定。 */
export const CODEX_AUTO_WAKE_MARKER_ENV = "AGENTPARTY_CODEX_AUTO_WAKE_MARKER";

export type CodexAutoWakeMode = "off" | "serve";

export interface CodexAutoWakeModeResolution {
  mode: CodexAutoWakeMode;
  source: "env" | "config" | "default";
}

/** `1/true/on/yes/serve` → serve；`0/false/off/no` → off；其它 → null（当没设过）。 */
export function parseCodexAutoWakeValue(value: unknown): CodexAutoWakeMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return null;
  if (["1", "true", "on", "yes", "serve"].includes(normalized)) return "serve";
  if (["0", "false", "off", "no", "none"].includes(normalized)) return "off";
  return null;
}

export function codexAutoWakeSettingPath(home: string): string {
  return join(home, CODEX_AUTO_WAKE_SETTING_FILE);
}

export function codexAutoWakeLogPath(home: string): string {
  return join(home, CODEX_AUTO_WAKE_LOG_FILE);
}

export function readCodexAutoWakeSetting(home: string): CodexAutoWakeMode | null {
  try {
    const value = JSON.parse(readFileSync(codexAutoWakeSettingPath(home), "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return parseCodexAutoWakeValue((value as { mode?: unknown }).mode);
  } catch {
    return null;
  }
}

export function writeCodexAutoWakeSetting(home: string, mode: CodexAutoWakeMode): void {
  atomicWriteJson(codexAutoWakeSettingPath(home), { version: 1, mode });
}

/**
 * **默认开启**（owner 拍板）：「我们应该做到直接能用，不要让用户选择」。
 *
 * Claude 侧装上插件就能被唤醒；codex 侧如果还要多拨一个开关，**这个额外步骤本身就是
 * 体验断层**——而消除断层正是 #893 的全部目的。把 codex hook 装进去这个动作，已经表达了
 * 「我要接入 AgentParty」的意图，不该再问一次。
 *
 * 但 `off` 必须仍然有效：默认替用户做对的事，不等于剥夺控制权。显式关掉就绝不再自动拉。
 *
 * 优先级：环境变量 > 配置文件 > 默认开启。环境变量优先是刻意的：serve 会给自己的 codex
 * runner 子进程设 `off`，杜绝「serve 的 runner 又去拉一个 serve」的递归。
 */
export const CODEX_AUTO_WAKE_DEFAULT_MODE: CodexAutoWakeMode = "serve";

export function resolveCodexAutoWakeMode(
  env: NodeJS.ProcessEnv,
  home: string,
): CodexAutoWakeModeResolution {
  const fromEnv = parseCodexAutoWakeValue(env[CODEX_AUTO_WAKE_ENV]);
  if (fromEnv !== null) return { mode: fromEnv, source: "env" };
  const fromConfig = readCodexAutoWakeSetting(home);
  if (fromConfig !== null) return { mode: fromConfig, source: "config" };
  return { mode: CODEX_AUTO_WAKE_DEFAULT_MODE, source: "default" };
}

export interface CodexAutoWakeStartupBudget {
  /** 记一次 serve 运行的时长；够久就把连续失败清零。 */
  recordRun: (durationMs: number) => void;
  /** 连续失败是否已经用完预算——用完就别再自愈了。 */
  exhausted: () => boolean;
  consecutiveFailures: () => number;
}

/**
 * 自动拉起的唤醒层的「放弃预算」。
 *
 * 默认开启之后影响面变了：以前只有主动开开关的人会走这条路，现在装了 codex hook 的人都会。
 * serve 自己的 supervisor 是**无限自愈**的（对手工挂的 serve 正确：人要它守着），但对
 * 自动拉起的这层不对——token 失效、服务端搬家、频道被删这类不会自己好的故障，会让每台机器
 * 上留一个永远重试的后台进程。所以给它一个有限预算：连续短命失败够多次就安静退场，
 * 下一次 codex SessionStart 自然会再试（那时故障可能已经修好）。
 */
export function createCodexAutoWakeStartupBudget(
  maxConsecutiveFailures: number = CODEX_AUTO_WAKE_MAX_CONSECUTIVE_FAILURES,
  healthyRunMs: number = CODEX_AUTO_WAKE_HEALTHY_RUN_MS,
): CodexAutoWakeStartupBudget {
  let failures = 0;
  return {
    recordRun: (durationMs: number) => {
      // 真的连上并服务过一段时间 → 这轮健康，之后的一次断线重连不该被前面的失败拖累。
      if (durationMs >= healthyRunMs) failures = 0;
      else failures += 1;
    },
    exhausted: () => failures >= maxConsecutiveFailures,
    consecutiveFailures: () => failures,
  };
}

export function appendCodexAutoWakeLog(home: string, line: string, now: number = Date.now()): void {
  try {
    const path = codexAutoWakeLogPath(home);
    mkdirSync(join(home, "logs"), { recursive: true });
    try {
      if (statSync(path).size > CODEX_AUTO_WAKE_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // 还没有日志文件，或滚动失败——都不值得让 hook 出事。
    }
    appendFileSync(path, `${new Date(now).toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // hook 铁律：连日志都不许炸。
  }
}

// ---- 「只拉一次」的标记 ----
//
// serve 的实例锁是去重的**权威**，但它在真机上有个窗口：serve 连不上服务端时会在它自己的
// 重连 supervisor 里无限重试，**根本走不到抢锁那一步**（本机实测：连 127.0.0.1:9 的 serve
// 重试到第 5 轮，instances 目录压根没建）。断网/服务端故障时每开一个 codex 会话就多堆一个
// 永远重试的后台进程——正是这套东西最不该干的事。
//
// 所以在锁之外再加一层本地标记：先 O_EXCL 占位（挡住同一瞬间起的两个会话），拿到子进程 pid
// 后回填。标记的有效性由 pid 存活 + 出生时间决定，进程一死就自然失效，SIGKILL 也锁不死。
export const CODEX_AUTO_WAKE_CLAIM_TTL_MS = 15_000;
export const CODEX_AUTO_WAKE_MARKER_DIR = "codex-auto-wake";

export interface CodexAutoWakeMarker {
  /** 已拉起的唤醒层 pid；仅占位、还没回填时为 null。 */
  pid: number | null;
  started_at: number | null;
  claimed_at: number;
  channel: string;
  /** 上一次唤醒层被回收的时刻（#959 退避判定）；没回收过 / 老标记为 null。 */
  reaped_at?: number | null;
  /** 上一次唤醒层从拉起到被回收活了多久；与 reaped_at 成对。 */
  lived_ms?: number | null;
}

/** 退避判定的证据（#959）：刚被回收、且是短命的那种。 */
export interface CodexAutoWakeFlap {
  reaped_at: number;
  lived_ms: number;
}

export function codexAutoWakeMarkerPath(home: string, target: string): string {
  return join(home, CODEX_AUTO_WAKE_MARKER_DIR, `${target.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

export function readCodexAutoWakeMarker(path: string): CodexAutoWakeMarker | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    if (typeof value.claimed_at !== "number" || !Number.isFinite(value.claimed_at)) return null;
    return {
      pid: typeof value.pid === "number" && Number.isFinite(value.pid) && value.pid > 0 ? value.pid : null,
      started_at: typeof value.started_at === "number" && Number.isFinite(value.started_at)
        ? value.started_at
        : null,
      claimed_at: value.claimed_at,
      channel: typeof value.channel === "string" ? value.channel : "",
      reaped_at: typeof value.reaped_at === "number" && Number.isFinite(value.reaped_at) ? value.reaped_at : null,
      lived_ms: typeof value.lived_ms === "number" && Number.isFinite(value.lived_ms) ? value.lived_ms : null,
    };
  } catch {
    return null;
  }
}

/**
 * 唤醒层退场时把「刚被回收」写回标记（#959）。只补两个字段，pid / claimed_at 原样保留——
 * 标记的存活判定仍然由 pid 决定，回收记录只服务退避。写失败静默：退避是兜底，不是新的单点。
 */
export function recordCodexAutoWakeReap(path: string, now: number, livedMs: number): void {
  try {
    const marker = readCodexAutoWakeMarker(path);
    atomicWriteJson(path, {
      pid: marker?.pid ?? null,
      started_at: marker?.started_at ?? null,
      claimed_at: marker?.claimed_at ?? now,
      channel: marker?.channel ?? "",
      reaped_at: now,
      lived_ms: Math.max(0, Math.floor(livedMs)),
    });
  } catch {
    // 退避写不进去，下次 SessionStart 顶多多拉一次——比让回收路径炸掉好。
  }
}

/**
 * 「同 (身份, 频道) 刚被回收过、而且是短命的」→ 返回证据，调用方据此 skip(flapping)；否则 null。
 * 两个条件缺一不可：只看「刚回收过」会误伤关掉重开的交互式用户；只看「短命」则没有时间边界。
 */
export function recentCodexAutoWakeFlap(
  path: string,
  now: number,
  opts: { windowMs?: number; shortLifeMs?: number } = {},
): CodexAutoWakeFlap | null {
  const marker = readCodexAutoWakeMarker(path);
  if (marker === null || marker.reaped_at === null || marker.reaped_at === undefined) return null;
  if (marker.lived_ms === null || marker.lived_ms === undefined) return null;
  const windowMs = opts.windowMs ?? CODEX_AUTO_WAKE_FLAP_WINDOW_MS;
  const shortLifeMs = opts.shortLifeMs ?? CODEX_AUTO_WAKE_FLAP_SHORT_LIFE_MS;
  if (marker.reaped_at > now || now - marker.reaped_at >= windowMs) return null;
  if (marker.lived_ms > shortLifeMs) return null;
  return { reaped_at: marker.reaped_at, lived_ms: marker.lived_ms };
}

/**
 * 标记还作数吗。已回填 pid → 看进程是否还是那一个；只占了位还没回填 → 只在很短的 TTL 内作数
 * （写标记的 hook 可能在 spawn 前就崩了，不能让一次崩溃把这台机器永久锁在「不拉」）。
 */
export function codexAutoWakeMarkerActive(
  marker: CodexAutoWakeMarker | null,
  now: number,
  alive: (pid: number, startedAt?: number) => boolean,
): boolean {
  if (marker === null) return false;
  if (marker.pid !== null) return alive(marker.pid, marker.started_at ?? undefined);
  return marker.claimed_at <= now && now - marker.claimed_at < CODEX_AUTO_WAKE_CLAIM_TTL_MS;
}

export function writeCodexAutoWakeMarker(path: string, marker: CodexAutoWakeMarker): void {
  atomicWriteJson(path, marker);
}

/**
 * 抢下「这一轮由我拉」。O_EXCL 让同一瞬间启动的两个 codex 会话只有一个能拉。
 * 已有标记但已失效（进程死了 / 占位过期）→ 接管。抢不到返回 false，调用方就此打住。
 */
export function claimCodexAutoWake(
  path: string,
  channel: string,
  now: number,
  alive: (pid: number, startedAt?: number) => boolean,
): boolean {
  const body = JSON.stringify({ pid: null, started_at: null, claimed_at: now, channel });
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) return false;
  }
  if (codexAutoWakeMarkerActive(readCodexAutoWakeMarker(path), now, alive)) return false;
  try {
    atomicWriteJson(path, { pid: null, started_at: null, claimed_at: now, channel });
    return true;
  } catch {
    return false;
  }
}

export type CodexAutoWakeSkipReason =
  | "disabled"
  | "no-channel"
  | "non-interactive"
  | "session-kind-unknown"
  | "harness-mismatch"
  | "no-codex-binding"
  | "no-agent-token"
  | "native-source-missing"
  | "already-serving"
  | "already-starting"
  | "flapping";

export type CodexAutoWakeDecision =
  | { action: "skip"; reason: CodexAutoWakeSkipReason; detail: string }
  | { action: "start"; channel: string; cwd: string; args: string[] };

export interface CodexAutoWakeDecisionInput {
  mode: CodexAutoWakeMode;
  channel: string | null | undefined;
  cwd: string;
  /** 该身份在该频道上已在跑的 serve 的 pid；null = 没在跑。 */
  serveHolderPid: number | null;
  /** config 里是否有可用的 agent 身份（server+token）。 */
  hasAgentToken: boolean;
  /** ChatGPT Desktop 的私有 IPC 可用；此时不应再悄悄退回新 runner。 */
  nativeDesktop?: boolean;
  /** 同 app-server、同频道身份下的一对真实 ChatGPT task。 */
  nativeRoute?: { targetThreadId: string; sourceThreadId: string } | null;
  /**
   * 上一次拉起的唤醒层进程（标记仍然作数）。serve 连不上服务端时会在自己的重连 supervisor
   * 里无限重试、走不到抢锁那步，只靠 serveHolderPid 会让断网时每开一个会话堆一个进程。
   */
  startingPid?: number | null;
  /**
   * 触发这次 SessionStart 的 codex 是不是人在用的会话（#959）。一次性 / 嵌入式 codex 压根不该
   * 拉唤醒层：它 60 秒后必被回收，留下的只有一条零信息的 waiting 帧。缺省（null / undefined，没探测）
   * = 按交互式处理；unknown（探测过但没结论）= 不拉（#976：一次性 codex 高频的机器上「不知道就拉」
   * 错在更贵的一侧——拉起→发帧→60 秒回收；交互式会话的下一次 SessionStart 会再来）。
   */
  sessionKind?: CodexSessionKindLike | null;
  /**
   * 身份解析被「绑给别的 harness」拒掉（#960 harness-mismatch）或候选按 harness 过滤后一个不剩
   * （#971 no-codex-binding）时的原因；null = 没这回事。两者都以自己的名字进日志，绝不混进 no-agent-token。
   */
  identityRefusal?: { reason: "harness-mismatch" | "no-codex-binding"; detail: string } | null;
  /** 同 (身份, 频道) 刚被回收过的证据（#959 退避）；null = 没有。 */
  flapping?: CodexAutoWakeFlap | null;
  /** 决策时刻；只用于把退避说明里的「多久前」算出来。缺省 Date.now()。 */
  now?: number;
}

/** 与 codex-session-kind.ts 的探测结果同形；这里只依赖形状，不引入 ps。 */
export interface CodexSessionKindLike {
  kind: "interactive" | "non-interactive" | "unknown";
  detail: string;
}

/**
 * 纯决策：拉不拉、拉什么。所有 I/O 由调用方提供，测试不需要真起进程。
 *
 * 拉的是 `party hook codex-autowake --supervise --channel C`。ChatGPT Desktop 有两个
 * 同身份 task 时它跑 native bridge；裸 Codex CLI 才在同进程回落 serve runner。
 * 旧 `party bridge codex` 要接管 TUI，天然不适合被 hook 自动拉起。
 */
export function decideCodexAutoWake(input: CodexAutoWakeDecisionInput): CodexAutoWakeDecision {
  if (input.mode !== "serve") {
    return {
      action: "skip",
      reason: "disabled",
      detail:
        `codex auto-wake 被显式关掉了（默认是开的）——恢复：\`party hook codex-autowake on\`，` +
        `或去掉 ${CODEX_AUTO_WAKE_ENV}=off`,
    };
  }
  const channel = typeof input.channel === "string" && input.channel !== "" ? input.channel : null;
  if (channel === null) {
    return { action: "skip", reason: "no-channel", detail: `本会话 cwd 没有绑定频道：${input.cwd}` };
  }
  if (input.sessionKind?.kind === "non-interactive") {
    return {
      action: "skip",
      reason: "non-interactive",
      detail:
        `${input.sessionKind.detail}——一次性 codex 不拉唤醒层` +
        `（拉了也会在 60 秒后被回收，只给 #${channel} 留一条零信息的 waiting 帧）`,
    };
  }
  if (input.sessionKind?.kind === "unknown") {
    return {
      action: "skip",
      reason: "session-kind-unknown",
      detail:
        `${input.sessionKind.detail}——判不出这个 codex 是不是人在用的会话，不拉唤醒层` +
        `（拉错了就是 #959 那种「拉起→发帧→60 秒回收」的刷屏；交互式会话下一次 SessionStart 会再来）`,
    };
  }
  if (input.identityRefusal !== null && input.identityRefusal !== undefined) {
    return { action: "skip", reason: input.identityRefusal.reason, detail: input.identityRefusal.detail };
  }
  if (!input.hasAgentToken) {
    return {
      action: "skip",
      reason: "no-agent-token",
      detail: "config 里没有 agent token（人类账号会话不自动拉 serve）——先 `party init` 绑定 agent 身份",
    };
  }
  if (input.nativeDesktop === true && input.nativeRoute == null) {
    return {
      action: "skip",
      reason: "native-source-missing",
      detail:
        `ChatGPT Desktop IPC 已可用，但 #${channel} 上当前只有一个同身份 task；` +
        `等待第二个 task 入册后再建立原生跨任务通道，不退回后台新 runner`,
    };
  }
  if (input.serveHolderPid !== null) {
    return {
      action: "skip",
      reason: "already-serving",
      detail: `#${channel} 上本身份已有 serve 在跑（pid ${input.serveHolderPid}），不再拉第二个`,
    };
  }
  if (input.startingPid !== null && input.startingPid !== undefined) {
    return {
      action: "skip",
      reason: "already-starting",
      detail:
        `#${channel} 上已有本身份拉起的唤醒层（` +
        `${input.startingPid > 0 ? `pid ${input.startingPid}` : "另一个会话正在拉起中"}）——它可能还在连服务端。` +
        `不再拉第二个（断网时 serve 会无限重连、拿不到实例锁，只看锁会越堆越多）`,
    };
  }
  if (input.flapping !== null && input.flapping !== undefined) {
    const ago = Math.max(0, Math.round(((input.now ?? Date.now()) - input.flapping.reaped_at) / 1000));
    return {
      action: "skip",
      reason: "flapping",
      detail:
        `#${channel} 上本身份的唤醒层 ${ago}s 前刚被回收（只活了 ${Math.round(input.flapping.lived_ms / 1000)}s）` +
        `——${Math.round(CODEX_AUTO_WAKE_FLAP_WINDOW_MS / 60_000)} 分钟内不再拉起，免得「拉起→发帧→回收」循环刷屏`,
    };
  }
  return {
    action: "start",
    channel,
    cwd: input.cwd,
    args: [
      "hook",
      "codex-autowake",
      "--supervise",
      "--channel",
      channel,
      ...(input.nativeRoute == null
        ? []
        : [
            "--target-thread",
            input.nativeRoute.targetThreadId,
            "--source-thread",
            input.nativeRoute.sourceThreadId,
          ]),
    ],
  };
}

export interface CodexAutoWakeAuth {
  server: string;
  token: string;
}

/**
 * config 同步解析出实例锁身份。`resolveAuthDetailed()` 在 config 有 token 时返回的正是
 * `healServerUrl(cfg.server)` + `cfg.token`，所以这里同步复算得到的锁 target 与 serve
 * 自己抢的那把**逐字一致**；hook 不需要 await 任何异步鉴权。
 * config 没有 token（人类账号会话）→ null，调用方据此跳过。
 */
export function codexAutoWakeAuth(config: { server?: unknown; token?: unknown } | null): CodexAutoWakeAuth | null {
  if (config === null) return null;
  const { server, token } = config;
  if (typeof server !== "string" || typeof token !== "string" || token === "") return null;
  const healed = healServerUrl(server);
  return healed === null ? null : { server: healed, token };
}

/** 实例锁 / auto-wake 标记共用的身份+频道 key。 */
export function codexAutoWakeTarget(auth: CodexAutoWakeAuth, channel: string): string {
  return instanceLockTarget(auth.server, auth.token, channel);
}

/**
 * 仍然作数的唤醒层：返回 pid；只占了位还没回填 pid 时返回 0（也算「有人在拉」）；没有则 null。
 */
export function activeCodexAutoWakePid(
  path: string,
  now: number = Date.now(),
  alive: (pid: number, startedAt?: number) => boolean = isSameLiveProcess,
): number | null {
  const marker = readCodexAutoWakeMarker(path);
  if (!codexAutoWakeMarkerActive(marker, now, alive)) return null;
  return marker?.pid ?? 0;
}

/** 拉起成功后把子进程 pid 回填进标记；出生时间探得到就一起记，用于 PID 复用判定。 */
export function recordCodexAutoWakePid(path: string, channel: string, pid: number, now: number = Date.now()): void {
  writeCodexAutoWakeMarker(path, {
    pid,
    started_at: processStartedAt(pid) ?? null,
    claimed_at: now,
    channel,
  });
}

/** 该身份在该频道上正在跑的 serve pid（没有则 null）。 */
export function runningServePid(auth: CodexAutoWakeAuth, channel: string, lockDir: string): number | null {
  return instanceLockHolderPid("serve", instanceLockTarget(auth.server, auth.token, channel), lockDir);
}

export interface CodexAutoWakeReapInput {
  startedAt: number;
  now: number;
  /** 该频道上仍然存活的、已入册的交互式 codex 会话数。 */
  liveOwners: number;
  graceMs?: number;
}

/**
 * 回收判据：宽限期过后、频道上一个活着的 codex 会话都不剩，就该退场。
 *
 * codex 没有 SessionEnd，注册表的 pid 探活是唯一可信信号。注册表读不出来时 liveOwners=0
 * → 照样回收：宁可少活一会（下一次 SessionStart 就会重新拉起），也不留一个没人要的
 * 后台进程在别人机器上跑 runner、改工作树、往频道发帖。
 */
export function shouldReapCodexAutoWake(input: CodexAutoWakeReapInput): boolean {
  const graceMs = input.graceMs ?? CODEX_AUTO_WAKE_GRACE_MS;
  if (input.now - input.startedAt < graceMs) return false;
  return input.liveOwners <= 0;
}
