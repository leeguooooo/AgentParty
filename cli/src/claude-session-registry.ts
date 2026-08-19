// 本机 Claude 会话注册表（issue #841 P1）。
//
// 目的：人日常开的交互式 `claude`（装了 agentparty 插件）在 SessionStart 时入册、
// SessionEnd 时出册，让 party 侧（蛰伏 MCP 的 announce 档、后续 serve 唤醒代理）
// 知道「本机有哪些还活着的交互式 Claude 会话」。注册表只是本机发现提示：
// 频道仍是唯一数据源，条目永远不构成任何鉴权、路由或投递依据。
//
// 落盘：~/.agentparty/claude-sessions/<session_id 小写>.json（目录 0700、文件 0600）。
// 目录校验与 claude-cross-session-gate.ts 的 gateDirectory 同款：拒符号链接、
// 拒组/他人可读、拒非本 uid。AGENTPARTY_CLAUDE_SESSION_REGISTRY_DIR 可覆盖（测试用）。
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

export const CLAUDE_SESSION_REGISTRY_DIR_ENV = "AGENTPARTY_CLAUDE_SESSION_REGISTRY_DIR";
/** 容量上限：满了先剔死行，仍满则拒新——绝不覆盖活行。 */
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
    Number.isFinite(value.registered_at);
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
export function claudeSessionRegistryDirectory(
  env: NodeJS.ProcessEnv = process.env,
  create = false,
): string | null {
  const override = env[CLAUDE_SESSION_REGISTRY_DIR_ENV];
  if (typeof override === "string" && override !== "") {
    return isAbsolute(override) ? validDirectory(override) : null;
  }
  const path = join(agentpartyHome(), "claude-sessions");
  const existing = validDirectory(path);
  if (existing !== null || !create) return existing;
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  return validDirectory(path);
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

function readEntry(directory: string, filename: string): ClaudeSessionRegistryEntry | null {
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
    return value;
  } catch {
    return null;
  }
}

/**
 * 列出仍然存活的入册会话（按 registered_at 升序）。
 * 死行（pid 不在）与坏行（解析/校验失败）现场清除。
 */
export function listClaudeSessions(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeSessionRegistryEntry[] {
  const directory = claudeSessionRegistryDirectory(env);
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
    const entry = readEntry(directory, filename);
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
 * 入册会话在 party 侧的宣告名（#841 P2/P3 共用同一权威定义，防词表漂移）：
 * 有 display_name 用 display_name，否则回退 `claude-<session_id 前 12 个 hex>`。
 */
export function claudeSessionAnnounceName(entry: ClaudeSessionRegistryEntry): string {
  if (entry.display_name !== null) return entry.display_name;
  return `claude-${entry.session_id.toLowerCase().replace(/-/g, "").slice(0, 12)}`;
}

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
}

/**
 * 入册一个交互式 Claude 会话。已入册的同一 session 重复注册（resume/clear）覆盖自身。
 * 容量满时先剔死行；仍满则拒绝（返回 false），绝不覆盖别人的活行。
 */
export function registerClaudeSession(
  input: RegisterClaudeSessionInput,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const entry: ClaudeSessionRegistryEntry = {
    version: 1,
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
  const directory = claudeSessionRegistryDirectory(env, true);
  if (directory === null) return false;
  const filename = `${entry.session_id.toLowerCase()}.json`;
  // 容量检查 + 写入必须互斥：并发 SessionStart hook 是多进程，两个进程同时通过
  // 「还差一个才满」的检查会超额写入。拿不到锁按拒绝处理（hook 静默，安全侧）。
  const lockPath = join(directory, REGISTER_LOCK_FILE);
  const lockFd = waitForRegisterLock(lockPath);
  if (lockFd === null) return false;
  try {
    // listClaudeSessions 顺带剔死行/坏行，让容量判断只数活行。
    const alive = listClaudeSessions(env);
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

export function unregisterClaudeSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isClaudeSessionRegistrySessionId(sessionId)) return false;
  const directory = claudeSessionRegistryDirectory(env);
  if (directory === null) return false;
  try {
    rmSync(join(directory, `${sessionId.toLowerCase()}.json`), { force: true });
    return true;
  } catch {
    return false;
  }
}
