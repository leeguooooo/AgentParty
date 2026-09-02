// 「我此刻跑在哪个 Claude Code 会话里」（#1052 #2）。
//
// Claude 内置 cross-session 发消息自动带上发送方身份；AgentParty 里一个用 per-session config
// 接入的会话却得在每条 `party` 命令前手写 `AGENTPARTY_CONFIG=<path>`——config 按 cwd 查找，
// 同目录的两个会话会撞同一个 workspaceId。要让 `party` 自己认出宿主会话，先得知道宿主 pid。
//
// 两条路，先快后慢：
//   ① 环境变量（零 spawn）：Claude Code（本机 2.1.258 实测）给 Bash 子进程放了
//      `CLAUDE_CODE_SESSION_ID` 与 `CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<pid>.sock`。
//      从 socket 文件名取 pid，读 `~/.claude/sessions/<pid>.json`，要求文件里的 sessionId、
//      messagingSocketPath 与环境变量**逐字相等**、且 pid 活着——三者都对才算认出。这是防继承来的
//      陈旧环境：serve runner、嵌套 shell、`/clear` 之后换了会话，都会让其中一项对不上。
//   ② 父进程链（变量缺失：旧版 Claude Code、或不在 Bash 工具下）：沿父进程链往上走，第一个在
//      `~/.claude/sessions/<pid>.json` 里有寻址文件的祖先就是宿主（做法与 open-cross-session 的
//      src/wake.ts findSelfClaudePid 同款）。**不能只看 process.ppid**：`party` 是在 Claude 的
//      Bash 工具里经中间 shell 起的（party → zsh → claude），ppid 是那个 shell。
//
// 安全边界：
//   - 只读 sessions 目录（沿用 claude-inbox-inject 的目录/文件校验：非符号链接、属本 uid、
//     文件名 pid 与内容 pid 一致），绝不写任何 Claude 文件；
//   - 找不到 / `ps` 不可用 / 任一步出错 ⇒ null，调用方回落既有的 cwd 解析——绝不猜；
//   - 每个进程只爬一次（结果按 sessions 目录缓存），`party statusline` 这类高频调用不会反复起 `ps`；
//   - 只在 Claude 的子进程树里才爬：Claude Code 给所有子进程（Bash 工具、hook、MCP server）
//     设 `CLAUDECODE=1`，没有它就是终端 / serve runner 等场景，一次 `ps` 都不起。这个变量若将来
//     消失，结果只是退回按 cwd 解析（现状），不会更糟。
import { spawnSync } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import {
  CLAUDE_NATIVE_SESSIONS_DIR_ENV,
  nativeSessionsAvailable,
  resolveSessionSocketByPid,
  type NativeClaudeSession,
} from "./claude-inbox-inject";

/** 最多往上走多少层。Bash 工具链通常 2–3 层；10 层足够覆盖 wrapper / 嵌套 shell。 */
export const SELF_CLAUDE_SESSION_MAX_HOPS = 10;
/** 单次 `ps` 上限：绝不让一条 `party` 命令因 ps 卡住而挂死。 */
const PS_TIMEOUT_MS = 1_000;

export interface SelfClaudeSession {
  /** 宿主 Claude 进程 pid（＝ `<pid>.json` 的文件名，也＝注册表条目的 pid）。 */
  pid: number;
  /** 宿主会话的 sessionId（`<pid>.json` 的 `sessionId`）；文件里没写则 null（＝不可匹配）。 */
  sessionId: string | null;
  /** Claude 自己的会话名（`<pid>.json` 的 `name`，形如 `agentparty-83`）；没写则 null。 */
  name: string | null;
  /** 从起点到宿主走了几层（诊断用）；0＝由环境变量直接认出，没起过 `ps`。 */
  hops: number;
}

type SpawnLike = typeof spawnSync;

/** Claude Code 给子进程树打的标记；缺席 ⇒ 不在 Claude 会话里，不爬。 */
export const CLAUDE_CODE_MARKER_ENV = "CLAUDECODE";
/** Claude Code 给 Bash 子进程的宿主会话 id（2.1.258 实测）。 */
export const CLAUDE_CODE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
/** Claude Code 给 Bash 子进程的宿主收件箱 socket 路径（`/tmp/cc-socks/<pid>.sock`）。 */
export const CLAUDE_CODE_MESSAGING_SOCKET_ENV = "CLAUDE_CODE_MESSAGING_SOCKET";
const SOCKET_PID_RE = /^(\d+)\.sock$/;

export interface FindSelfClaudeSessionOptions {
  env?: NodeJS.ProcessEnv;
  /** 起点 pid；默认 process.pid（第一跳就是 process.ppid）。 */
  startPid?: number;
  maxHops?: number;
  spawn?: SpawnLike;
}

/** 一跳：`ps -o ppid= -p <pid>`。解析不出 / 失败 ⇒ null。 */
function parentPid(pid: number, spawn: SpawnLike): number | null {
  try {
    const out = spawn("ps", ["-o", "ppid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
    });
    if (out.status !== 0 || typeof out.stdout !== "string") return null;
    const parent = Number(out.stdout.trim());
    return Number.isInteger(parent) && parent > 0 ? parent : null;
  } catch {
    return null;
  }
}

/**
 * 路 ①：按环境变量认宿主，零 spawn。变量缺任何一个 ⇒ null（调用方改走父进程链）；变量齐全但与
 * 寻址文件对不上（陈旧环境）⇒ 同样 null，由父进程链给出真实答案，绝不信环境变量单方面的说法。
 */
export function selfClaudeSessionFromEnv(env: NodeJS.ProcessEnv = process.env): SelfClaudeSession | null {
  const sessionId = env[CLAUDE_CODE_SESSION_ID_ENV];
  const socket = env[CLAUDE_CODE_MESSAGING_SOCKET_ENV];
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof socket !== "string" || socket === "" || !isAbsolute(socket)) return null;
  const match = SOCKET_PID_RE.exec(basename(socket));
  if (match === null) return null;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  // resolveSessionSocketByPid 已校验：文件名 pid＝内容 pid、pid 活、sessionId 与期望相等。
  const resolved = resolveSessionSocketByPid(pid, { expectSessionId: sessionId, env });
  if (!resolved.ok) return null;
  if (resolved.session.messagingSocketPath !== socket) return null;
  return fromNative(resolved.session, 0);
}

/**
 * 不带缓存的祖先链探测（路 ②）。返回第一个持有原生寻址文件的祖先；到根（pid ≤ 1）/ 超出跳数 /
 * `ps` 失败都返回 null。祖先的寻址文件坏掉（校验不过）同样 null——不继续往上猜别的会话。
 */
export function walkToSelfClaudeSession(
  options: FindSelfClaudeSessionOptions = {},
): SelfClaudeSession | null {
  const env = options.env ?? process.env;
  const spawn = options.spawn ?? spawnSync;
  const maxHops = options.maxHops ?? SELF_CLAUDE_SESSION_MAX_HOPS;
  let pid = options.startPid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return null;
  if ((env[CLAUDE_CODE_MARKER_ENV] ?? "") === "") return null;
  if (!nativeSessionsAvailable(env)) return null;
  for (let hop = 1; hop <= maxHops; hop += 1) {
    const parent = parentPid(pid, spawn);
    if (parent === null || parent <= 1 || parent === pid) return null;
    const resolved = resolveSessionSocketByPid(parent, { env });
    if (resolved.ok) return fromNative(resolved.session, hop);
    pid = parent;
  }
  return null;
}

function fromNative(session: NativeClaudeSession, hops: number): SelfClaudeSession {
  return { pid: session.pid, sessionId: session.sessionId, name: session.name, hops };
}

let cache: { key: string; value: SelfClaudeSession | null } | null = null;

/**
 * 带进程级缓存的探测：同一进程内按 sessions 目录 + 起点只爬一次。
 * 缓存 key 含目录覆盖变量，测试在同进程切换夹具目录时不会拿到旧答案。
 */
export function findSelfClaudeSession(
  options: FindSelfClaudeSessionOptions = {},
): SelfClaudeSession | null {
  const env = options.env ?? process.env;
  const key = [
    env[CLAUDE_CODE_MARKER_ENV] ?? "",
    env[CLAUDE_CODE_SESSION_ID_ENV] ?? "",
    env[CLAUDE_CODE_MESSAGING_SOCKET_ENV] ?? "",
    env[CLAUDE_NATIVE_SESSIONS_DIR_ENV] ?? "",
    String(options.startPid ?? process.pid),
  ].join("|");
  if (cache !== null && cache.key === key) return cache.value;
  let value: SelfClaudeSession | null = null;
  try {
    value = selfClaudeSessionFromEnv(env) ?? walkToSelfClaudeSession(options);
  } catch {
    value = null;
  }
  cache = { key, value };
  return value;
}

/** 测试用：清掉进程级缓存。 */
export function resetSelfClaudeSessionCache(): void {
  cache = null;
}
