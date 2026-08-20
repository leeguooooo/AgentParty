// 同一身份多执行体的任务租约（#834 第 3 项）。
//
// 事故实录：同一个 `king-claude` 身份同时跑着两个执行体——一个交互式 harness 会话，一个由
// `party serve` 拉起的 reception runner。两个都在认领同一件事、都在动同一台模拟器，互相强杀
// 对方的进程；其中一个基于假前提派出了消耗真实资产的 worker，另一个据此做了验收。`party who`
// 当时只打印 `topology_conflicts: [{kind: same_local_installation, runtime_count: 1}]`，**零 enforcement**。
//
// instance-lock 那把锁按 (身份, 频道) 互斥，管的是「同一个频道别被 serve/watch 服务两次」。
// 它挡不住这一类：两个**不同来源**的执行体（一个是 serve runner，一个是人在 harness 里手敲）
// 各自去认领**同一个 task**。粒度不同，锁也就不同：这里按 (身份, 频道, task) 发租约。
//
// 为什么不能复用 pid 锁：`party status working --task N` 是一次性进程，认领完立刻退出。
// pid 存活探测在这里毫无意义（写完就死）。所以租约靠两样东西成立：
//   1. **执行体身份**（executor id）——跨多次 `party status` 调用稳定，且两个执行体必须不同；
//   2. **TTL**——执行体崩了/被 kill 了，租约必须能自然过期被接手，绝不能把 task 永久锁死。
//
// 红线：被拒的那个执行体**不许把任务吞掉**。拒绝路径不碰服务端 task 状态、不发 working 帧，
// 任务原样留在频道里，正确的执行体照常认领。拒绝 ≠ 任务消失。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentpartyHome } from "./config";

/** 默认租期。与 serve 的 DEFAULT_RUNNER_TIMEOUT_MS（30min）对齐：一个 runner 最多能占这么久。 */
export const DEFAULT_TASK_LEASE_TTL_MS = 30 * 60_000;

const EXECUTOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export interface TaskLeaseHolder {
  executor_id: string;
  channel: string;
  task_id: number;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
  /** 由 --force-lease 抢占时，记下被抢的那个执行体，便于事后对账。 */
  taken_over_from?: string;
}

export type TaskLeaseState =
  /** 首次拿到（含接手已过期的租约）。 */
  | "acquired"
  /** 本执行体自己的租约续期。 */
  | "renewed"
  /** 另一个执行体持有且未过期——拒绝，降级为只读。 */
  | "denied"
  /** --force-lease 显式抢占。 */
  | "forced"
  /** 无法识别本执行体身份，不做判定（既不放行也不冒充放行结论）。 */
  | "unenforced";

export interface TaskLeaseResult {
  state: TaskLeaseState;
  /** denied 时是对方的租约；acquired/renewed/forced 时是本执行体自己的租约。 */
  holder?: TaskLeaseHolder;
  /** 被抢占/被接手/无法判定的原因，供 --json 与人读输出复用。 */
  reason?: "no_executor_identity" | "expired" | "taken_over" | "held_by_other";
}

export function taskLeaseDir(home: string = agentpartyHome()): string {
  return join(home, "task-leases");
}

/** token 只参与不可逆摘要，不落盘；不同 server/身份互不阻塞。 */
export function taskLeaseKey(server: string, token: string, channel: string, taskId: number): string {
  const identity = createHash("sha256").update(server).update("\0").update(token).digest("hex").slice(0, 24);
  return `${identity}-${channel.replace(/[^a-z0-9-]/g, "_")}-task-${taskId}`;
}

function leasePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

function readLease(path: string): TaskLeaseHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TaskLeaseHolder>;
    if (typeof parsed.executor_id !== "string" || !EXECUTOR_ID_RE.test(parsed.executor_id)) return null;
    if (typeof parsed.expires_at !== "number" || !Number.isFinite(parsed.expires_at)) return null;
    if (typeof parsed.task_id !== "number" || !Number.isFinite(parsed.task_id)) return null;
    return parsed as TaskLeaseHolder;
  } catch {
    return null;
  }
}

export interface ResolveExecutorEnv {
  [key: string]: string | undefined;
}

/**
 * 解析「当前执行体」的稳定身份。
 *
 * 顺序刻意从最显式排到最隐式。**最后没有兜底**：识别不出来就返回 null，调用方按 unenforced
 * 处理。宁可明说「这一刀没落下」，也不要靠一个不稳定的推断（比如 ppid——Claude Code 每次
 * Bash 调用的父进程都不同，会让同一个 harness 会话把自己上一次的租约当成别人的而自锁）去
 * 制造一个看着像 enforcement 的假象。
 */
export function resolveExecutorId(
  env: ResolveExecutorEnv = process.env,
  explicit?: { executorId?: string; sessionHarness?: string; sessionId?: string },
): string | null {
  const candidates: (string | undefined)[] = [
    explicit?.executorId,
    env.AGENTPARTY_EXECUTOR_ID,
    // serve 内建 runner 已经在给子进程注入这两个（见 serve.ts 的 AP_RUNNER_* 块）。
    // session id 每次 resume 会换，workdir 不换——所以 workdir 才是「哪个 runner」的稳定标识。
    env.AP_RUNNER_WORKDIR === undefined || env.AP_RUNNER_WORKDIR === ""
      ? undefined
      : `runner:${env.AP_RUNNER_HARNESS ?? "unknown"}:${createHash("sha256").update(env.AP_RUNNER_WORKDIR).digest("hex").slice(0, 16)}`,
    explicit?.sessionId === undefined || explicit.sessionHarness === undefined
      ? undefined
      : `session:${explicit.sessionHarness}:${explicit.sessionId}`,
    env.CLAUDE_SESSION_ID === undefined || env.CLAUDE_SESSION_ID === "" ? undefined : `session:claude:${env.CLAUDE_SESSION_ID}`,
    env.CODEX_THREAD_ID === undefined || env.CODEX_THREAD_ID === "" ? undefined : `session:codex:${env.CODEX_THREAD_ID}`,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    const trimmed = candidate.slice(0, 128);
    if (EXECUTOR_ID_RE.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * 长驻进程（MCP server、daemon）自己的执行体身份。
 *
 * 一次性 CLI 不能用 pid 当身份（写完就死，下一次调用就成了「另一个执行体」而自锁）；但一个
 * 跟着 harness 会话活一整场的 MCP server 进程，pid 恰恰就是最诚实的「这个会话的执行体」标识。
 * 仍然优先让环境里的显式声明覆盖它。
 */
export function processScopedExecutorId(env: ResolveExecutorEnv = process.env, pid: number = process.pid): string {
  return resolveExecutorId(env) ?? `mcp:${pid}`;
}

export interface AcquireTaskLeaseOptions {
  key: string;
  channel: string;
  taskId: number;
  executorId: string | null;
  dir?: string;
  ttlMs?: number;
  now?: number;
  force?: boolean;
}

/**
 * 认领时刻的那一刀。返回 denied 时调用方必须**什么都不发**——不发 working 帧、不改服务端
 * task state，让任务原样留着。
 */
export function acquireTaskLease(options: AcquireTaskLeaseOptions): TaskLeaseResult {
  const { key, channel, taskId, executorId, force = false } = options;
  if (executorId === null) return { state: "unenforced", reason: "no_executor_identity" };
  const dir = options.dir ?? taskLeaseDir();
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TASK_LEASE_TTL_MS;
  const path = leasePath(dir, key);
  const existing = readLease(path);
  const mine = existing !== null && existing.executor_id === executorId;
  const live = existing !== null && existing.expires_at > now;

  if (existing !== null && live && !mine && !force) {
    return { state: "denied", holder: existing, reason: "held_by_other" };
  }

  const state: TaskLeaseState = mine ? "renewed" : existing !== null && live ? "forced" : "acquired";
  const reason: TaskLeaseResult["reason"] | undefined = state === "forced"
    ? "taken_over"
    : state === "acquired" && existing !== null
      ? "expired"
      : undefined;
  const holder: TaskLeaseHolder = {
    executor_id: executorId,
    channel,
    task_id: taskId,
    acquired_at: mine ? existing.acquired_at : now,
    renewed_at: now,
    expires_at: now + ttlMs,
    ...(state === "forced" && existing !== null ? { taken_over_from: existing.executor_id } : {}),
  };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(holder), { mode: 0o600 });
  } catch {
    // 落盘失败只损失 enforcement 能力，绝不该让一次正常认领失败。
    return { state: "unenforced", reason: "no_executor_identity" };
  }
  return { state, holder, ...(reason === undefined ? {} : { reason }) };
}

/**
 * 交还租约。只删自己的那张——别人已经接手（过期后被合法接管）时绝不动它，否则一个迟到的
 * `status done` 会把新执行体的租约抹掉。
 */
export function releaseTaskLease(key: string, executorId: string | null, dir: string = taskLeaseDir()): boolean {
  if (executorId === null) return false;
  const path = leasePath(dir, key);
  const existing = readLease(path);
  if (existing === null || existing.executor_id !== executorId) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/** 只读查询，供 `--json` 与诊断使用。过期的租约按「没有」返回。 */
export function readTaskLease(key: string, dir: string = taskLeaseDir(), now: number = Date.now()): TaskLeaseHolder | null {
  const existing = readLease(leasePath(dir, key));
  return existing === null || existing.expires_at <= now ? null : existing;
}

/** 顺手清掉早已过期的租约文件，避免目录无限增长。失败无所谓——过期租约本来就不挡人。 */
export function pruneExpiredTaskLeases(dir: string = taskLeaseDir(), now: number = Date.now()): number {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(dir, entry);
    const holder = readLease(path);
    if (holder !== null && holder.expires_at > now) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      /* 另一个进程已经清掉了。 */
    }
  }
  return removed;
}

/** 人读的拒绝说明。刻意把「任务没丢」和「怎么合法接手」写在同一句里。 */
export function describeDeniedLease(holder: TaskLeaseHolder, channel: string, taskId: number, now: number): string {
  const remainingS = Math.max(0, Math.ceil((holder.expires_at - now) / 1000));
  return [
    `refused: task ${taskId} on #${channel} is already held by another execution runtime of this identity`,
    `  holder=${holder.executor_id} expires_in=${remainingS}s`,
    "  this claim was NOT published: the task is untouched and the current holder keeps working on it.",
    "  read-only is still available (party task list / party history); do not start side-effecting work.",
    "  if you are certain the holder is gone, take over explicitly: party status working --task " +
      `${taskId} --force-lease`,
  ].join("\n");
}
