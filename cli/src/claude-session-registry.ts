// 本机交互式会话注册表（issue #841 P1、#851 P2）。
//
// 目的：人日常开的交互式 `claude`（装了 agentparty 插件）/ `codex`（装了 codex hooks）
// 在 SessionStart 时入册，让 party 侧（蛰伏 MCP 的 announce 档、后续 serve 唤醒代理）
// 知道「本机有哪些还活着的交互式会话」。注册表只是本机发现提示：
// 频道仍是唯一数据源，条目永远不构成任何鉴权、路由或投递依据。
//
// 落盘：~/.agentparty/<harness>-sessions/<session_id 小写>.json（目录 0700、文件 0600）。
// **每个 harness 一个独立目录**，这是 #851 的硬安全边界：`listClaudeSessions()` 只读
// claude 目录，所以 claude 专用的 PID 寻址（claude-inbox-inject 的
// resolveSessionSocketByPid / nativeSessionName，都假定目标进程有 cc-socks 收件箱）
// 在结构上就拿不到 codex 条目——codex 没有那套 UDS，误用会把消息投到不存在的地方。
// 条目里额外记 `harness` 字段做二道防线：目录与字段不符的行按坏行丢弃。
// 旧条目（#841 时期写的、没有 harness 字段）视为 claude，读写完全兼容。
//
// 目录校验与 claude-cross-session-gate.ts 的 gateDirectory 同款：拒符号链接、
// 拒组/他人可读、拒非本 uid。AGENTPARTY_{CLAUDE,CODEX}_SESSION_REGISTRY_DIR 可覆盖（测试用）。
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { agentpartyHome } from "./config";
import { atomicWriteJson } from "./atomic-json";

/** 注册表覆盖的 harness 维度（#851 P2）。每个值对应一个独立目录。 */
export type SessionRegistryHarness = "claude" | "codex";

export const CLAUDE_SESSION_REGISTRY_DIR_ENV = "AGENTPARTY_CLAUDE_SESSION_REGISTRY_DIR";
export const CODEX_SESSION_REGISTRY_DIR_ENV = "AGENTPARTY_CODEX_SESSION_REGISTRY_DIR";

const REGISTRY_DIR_ENV: Record<SessionRegistryHarness, string> = {
  claude: CLAUDE_SESSION_REGISTRY_DIR_ENV,
  codex: CODEX_SESSION_REGISTRY_DIR_ENV,
};
const REGISTRY_DIR_NAME: Record<SessionRegistryHarness, string> = {
  claude: "claude-sessions",
  codex: "codex-sessions",
};

/** 容量上限：满了先剔死行，仍满则拒新——绝不覆盖活行。每个 harness 目录各自计数。 */
export const CLAUDE_SESSION_REGISTRY_CAPACITY = 128;

const SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTRY_FILE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const MAX_ENTRY_BYTES = 4 * 1024;
const REGISTER_LOCK_FILE = ".register.lock";
const REGISTER_LOCK_WAIT_MS = 250;
// 持锁进程死掉会留下孤儿锁；注册只有一次容量检查 + 一次原子写，10s 还没放锁必是尸体。
const REGISTER_LOCK_STALE_MS = 10_000;

/** O_EXCL 锁 + 有界等待（模式同 claude-cross-session-gate 的 waitForConsumeLock）。 */
function waitForRegisterLock(lockPath: string): number | null {
  const deadline = Date.now() + REGISTER_LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch {
      try {
        if (Date.now() - lstatSync(lockPath).mtimeMs > REGISTER_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // 锁刚被释放：直接重试。
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      Atomics.wait(sleeper, 0, 0, Math.min(5, remaining));
    }
  }
}

export interface ClaudeSessionRegistryEntry {
  version: 1;
  session_id: string;
  pid: number;
  display_name: string | null;
  channel: string;
  cwd: string;
  registered_at: number;
  /**
   * 条目所属 harness（#851 P2）。#841 时期写的旧条目没有这个字段 → 读作 "claude"。
   * 目录才是权威身份；这个字段只是「目录与内容不符即丢弃」的二道防线。
   */
  harness?: SessionRegistryHarness;
}

/** 旧条目（无 harness 字段）视为 claude。 */
export function sessionEntryHarness(entry: ClaudeSessionRegistryEntry): SessionRegistryHarness {
  return entry.harness ?? "claude";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isClaudeSessionRegistrySessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function validEntry(value: unknown): value is ClaudeSessionRegistryEntry {
  return record(value) &&
    value.version === 1 &&
    isClaudeSessionRegistrySessionId(value.session_id) &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    (value.display_name === null ||
      (typeof value.display_name === "string" && DISPLAY_NAME_RE.test(value.display_name))) &&
    typeof value.channel === "string" &&
    CHANNEL_RE.test(value.channel) &&
    typeof value.cwd === "string" &&
    value.cwd !== "" &&
    isAbsolute(value.cwd) &&
    typeof value.registered_at === "number" &&
    Number.isFinite(value.registered_at) &&
    (value.harness === undefined || value.harness === "claude" || value.harness === "codex");
}

function validDirectory(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    return path;
  } catch {
    return null;
  }
}

/** 解析注册表目录；`create` 只对默认路径生效——环境变量覆盖的目录必须已存在且合规。 */
export function sessionRegistryDirectory(
  harness: SessionRegistryHarness,
  env: NodeJS.ProcessEnv = process.env,
  create = false,
): string | null {
  const override = env[REGISTRY_DIR_ENV[harness]];
  if (typeof override === "string" && override !== "") {
    return isAbsolute(override) ? validDirectory(override) : null;
  }
  const path = join(agentpartyHome(), REGISTRY_DIR_NAME[harness]);
  const existing = validDirectory(path);
  if (existing !== null || !create) return existing;
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return validDirectory(path);
}

/** @deprecated 保留 #841 的名字；等价于 `sessionRegistryDirectory("claude", …)`。 */
export function claudeSessionRegistryDirectory(
  env: NodeJS.ProcessEnv = process.env,
  create = false,
): string | null {
  return sessionRegistryDirectory("claude", env, create);
}

/** kill(pid, 0) 探活：EPERM 也算活（进程在，只是不属于我们——注册表不该出现，但按活处理更保守）。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readEntry(
  directory: string,
  filename: string,
  harness: SessionRegistryHarness,
): ClaudeSessionRegistryEntry | null {
  const path = join(directory, filename);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_ENTRY_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!validEntry(value)) return null;
    // 文件名就是身份：不一致的行按坏行处理，防止一个 session 冒名另一个。
    if (`${value.session_id.toLowerCase()}.json` !== filename) return null;
    // 二道防线（#851）：目录是权威 harness 身份。内容自称另一个 harness 的行按坏行丢弃——
    // 否则一个写进 claude-sessions/ 的 codex 条目会被 claude 专用的 PID/UDS 寻址捡走。
    if (sessionEntryHarness(value) !== harness) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * 列出仍然存活的入册会话（按 registered_at 升序）。
 * 死行（pid 不在）与坏行（解析/校验失败）现场清除。
 */
export function listSessions(
  harness: SessionRegistryHarness,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeSessionRegistryEntry[] {
  const directory = sessionRegistryDirectory(harness, env);
  if (directory === null) return [];
  let filenames: string[];
  try {
    filenames = readdirSync(directory);
  } catch {
    return [];
  }
  const alive: ClaudeSessionRegistryEntry[] = [];
  for (const filename of filenames) {
    if (!ENTRY_FILE_RE.test(filename)) continue;
    const entry = readEntry(directory, filename, harness);
    if (entry !== null && pidAlive(entry.pid)) {
      alive.push(entry);
      continue;
    }
    try {
      rmSync(join(directory, filename), { force: true });
    } catch {
      // 清不掉就留给下次；列出结果不受影响。
    }
  }
  return alive.sort((a, b) => a.registered_at - b.registered_at);
}

/**
 * **只读 claude 目录**（#851 硬约束②）：调用方（serve-wake-proxy 的唤醒代理、
 * claude-channel 的蛰伏 announce 档）随后都会走 claude 专用的 PID→cc-socks UDS 寻址。
 * codex 会话没有那套收件箱，必须永远出现不了在这个列表里——所以按目录隔离，而不是
 * 「一个目录 + 过滤」，漏一次过滤就是投错。codex 用 `listCodexSessions()`。
 */
export function listClaudeSessions(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeSessionRegistryEntry[] {
  return listSessions("claude", env);
}

/** 列出仍然存活的入册 codex 会话（#851 P2）。绝不喂给 claude 的 UDS 寻址。 */
export function listCodexSessions(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeSessionRegistryEntry[] {
  return listSessions("codex", env);
}

/**
 * 入册会话在 party 侧的宣告名（#841 P2/P3、#851 共用同一权威定义，防词表漂移）：
 * 有 display_name 用 display_name，否则回退 `<harness>-<session_id 前 12 个 hex>`。
 */
export function sessionAnnounceName(entry: ClaudeSessionRegistryEntry): string {
  if (entry.display_name !== null) return entry.display_name;
  const prefix = sessionEntryHarness(entry);
  return `${prefix}-${entry.session_id.toLowerCase().replace(/-/g, "").slice(0, 12)}`;
}

/** @deprecated #841 的名字；等价于 `sessionAnnounceName`（claude 条目行为逐字不变）。 */
export const claudeSessionAnnounceName = sessionAnnounceName;

export function claudeSessionAlive(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isClaudeSessionRegistrySessionId(sessionId)) return false;
  const wanted = sessionId.toLowerCase();
  return listClaudeSessions(env).some((entry) => entry.session_id.toLowerCase() === wanted);
}

export interface RegisterClaudeSessionInput {
  session_id: string;
  pid: number;
  display_name: string | null;
  channel: string;
  cwd: string;
  registered_at?: number;
  /** 省略即 claude（保持 #841 调用点逐字不变）。 */
  harness?: SessionRegistryHarness;
}

/**
 * 入册一个交互式会话。已入册的同一 session 重复注册（resume/clear）覆盖自身。
 * 容量满时先剔死行；仍满则拒绝（返回 false），绝不覆盖别人的活行。
 * 容量与锁都按 harness 目录各自独立——codex 会话刷满不会挤掉 claude 会话。
 */
export function registerSession(
  input: RegisterClaudeSessionInput,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const harness: SessionRegistryHarness = input.harness ?? "claude";
  const entry: ClaudeSessionRegistryEntry = {
    version: 1,
    harness,
    session_id: input.session_id,
    pid: input.pid,
    display_name:
      typeof input.display_name === "string" && DISPLAY_NAME_RE.test(input.display_name)
        ? input.display_name
        : null,
    channel: input.channel,
    cwd: input.cwd,
    registered_at: input.registered_at ?? Date.now(),
  };
  if (!validEntry(entry)) return false;
  const directory = sessionRegistryDirectory(harness, env, true);
  if (directory === null) return false;
  const filename = `${entry.session_id.toLowerCase()}.json`;
  // 容量检查 + 写入必须互斥：并发 SessionStart hook 是多进程，两个进程同时通过
  // 「还差一个才满」的检查会超额写入。拿不到锁按拒绝处理（hook 静默，安全侧）。
  const lockPath = join(directory, REGISTER_LOCK_FILE);
  const lockFd = waitForRegisterLock(lockPath);
  if (lockFd === null) return false;
  try {
    // listSessions 顺带剔死行/坏行，让容量判断只数活行。
    const alive = listSessions(harness, env);
    const replacingSelf = alive.some(
      (existing) => existing.session_id.toLowerCase() === entry.session_id.toLowerCase(),
    );
    if (!replacingSelf && alive.length >= CLAUDE_SESSION_REGISTRY_CAPACITY) return false;
    atomicWriteJson(join(directory, filename), entry, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

/** @deprecated #841 的名字；等价于 `registerSession`（默认 harness=claude）。 */
export const registerClaudeSession = registerSession;

/** 入册一个交互式 codex 会话（#851 P2）。 */
export function registerCodexSession(
  input: Omit<RegisterClaudeSessionInput, "harness">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return registerSession({ ...input, harness: "codex" }, env);
}

export function unregisterSession(
  harness: SessionRegistryHarness,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isClaudeSessionRegistrySessionId(sessionId)) return false;
  const directory = sessionRegistryDirectory(harness, env);
  if (directory === null) return false;
  try {
    rmSync(join(directory, `${sessionId.toLowerCase()}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** @deprecated #841 的名字；等价于 `unregisterSession("claude", …)`。 */
export function unregisterClaudeSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return unregisterSession("claude", sessionId, env);
}

/**
 * 出册一个 codex 会话（#851 P2）。
 *
 * 注意：codex 0.145 **没有 SessionEnd/SessionStop 这类会话结束 hook**（实测其内嵌
 * JSON schema 只有 pre/post-tool-use、permission-request、pre/post-compact、
 * session-start、subagent-start/stop、user-prompt-submit、stop 十种）。所以正常退出
 * 路径上没人调用这个函数——codex 条目靠 `listSessions` 的 kill(pid,0) 探活现场剔除。
 * 这里保留显式出册入口给测试与将来 codex 补上结束事件时接线。
 */
export function unregisterCodexSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return unregisterSession("codex", sessionId, env);
}
