// 跨机任务租约（#936）：把 #885 的本机文件锁与服务端 (identity, channel, task) 租约串成一条判定。
//
// #885 在认领时刻装了闸，#931 修好了它在本机恒不落闸的根因，但闸本身只在 `$AGENTPARTY_HOME/task-leases`
// 这一个目录里成立——同一身份在两台机器上并发认领同一个 task，两边都会成功。服务端要区分同一
// 身份的两个执行体，手上只有 token（两条腿的 token 完全一样），所以只能由客户端把执行体标识送上去。
//
// 顺序刻意是「先本机、后服务端」：
//   1. 本机能直接答「被拒」的时候不必发网络请求（同机双执行体是最常见的那一种）；
//   2. 拿到服务端拒绝时，本机那张刚取的租约要立刻还回去，不留一张自己不用却挡着别人的租约。
// 反过来（先服务端后本机）会在「服务端给了、本机拒了」时留下一张孤儿服务端租约，要靠 TTL 才
// 收得回——正好是 #908 那类锁残留。
//
// 降级路径是本模块的另一半。老服务端没有这条路由，此时**退回本机租约**，绝不是直接放行：
// 放行等于比现在更糟（现在至少同一个 HOME 内还挡得住）。降级的原因会一路带到调用方，让
// `--json` 与人读输出都能说清「这一刀落在哪一层」。
import type { TaskLeaseScope } from "@agentparty/shared";
import { RestError, claimServerTaskLease, releaseServerTaskLease } from "./rest";
import {
  acquireTaskLease,
  releaseTaskLease,
  taskLeaseDir,
  type TaskLeaseHolder,
  type TaskLeaseResult,
  type TaskLeaseState,
} from "./task-lease";

/** 退回本机租约的原因。两档的修法完全不同，绝不能塌缩成一个 boolean。 */
export type TaskLeaseDegradation =
  /** 服务端没有这条路由（老服务端）——升级服务端才有跨机互斥。 */
  | "server_unsupported"
  /** 服务端在，但这次没答上来（网络/超时/5xx/参数被拒）——本次退回本机，下次照常再试。 */
  | "server_unavailable";

export interface RemoteTaskLeaseResult extends TaskLeaseResult {
  /** 这一刀最终落在哪一层。`server` = 跨机互斥成立；`local_home` = 只挡得住同一个 HOME。 */
  scope: TaskLeaseScope;
  degraded?: TaskLeaseDegradation;
}

export interface AcquireAcrossMachinesOptions {
  server: string;
  token: string;
  /** 本机租约 key（`taskLeaseKey(server, token, channel, taskId)`）。 */
  key: string;
  channel: string;
  taskId: number;
  executorId: string | null;
  dir?: string;
  ttlMs?: number;
  now?: number;
  force?: boolean;
  /** 注入点，只给测试用；默认走真实 REST。 */
  claim?: typeof claimServerTaskLease;
  release?: typeof releaseServerTaskLease;
}

/**
 * 「老服务端不认这个字段」的判据。
 *
 * 未命中路由时 Hono 回的是**裸 404**（纯文本，没有 `error.code`）；本仓所有真实的 404 都走
 * `errorBody("not_found", …)`，一定带 code。两者形状不同，所以「路由不存在」与「频道/任务不存在」
 * 分得开——后者不该被当成老服务端，它说明服务端认得这条路由、只是这次的对象不在。
 */
export function serverLeaseUnsupported(error: unknown): boolean {
  if (!(error instanceof RestError)) return false;
  if (error.status === 405 || error.status === 501) return true;
  return error.status === 404 && error.code === null;
}

function isServerDenial(error: unknown): error is RestError {
  return error instanceof RestError && error.status === 409 && error.code === "task_lease_held";
}

function coerceHolder(raw: unknown, channel: string, taskId: number): TaskLeaseHolder | null {
  if (typeof raw !== "object" || raw === null) return null;
  const holder = (raw as { holder?: unknown }).holder;
  if (typeof holder !== "object" || holder === null) return null;
  const h = holder as Record<string, unknown>;
  if (typeof h.executor_id !== "string") return null;
  const num = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    executor_id: h.executor_id,
    channel: typeof h.channel === "string" ? h.channel : channel,
    task_id: num(h.task_id, taskId),
    acquired_at: num(h.acquired_at, 0),
    renewed_at: num(h.renewed_at, 0),
    expires_at: num(h.expires_at, 0),
    ...(typeof h.taken_over_from === "string" ? { taken_over_from: h.taken_over_from } : {}),
  };
}

/**
 * 取一次「跨机也成立」的任务租约。
 *
 * 返回 denied 时调用方必须**什么都不发**——不发 status 帧、不改服务端 task state，任务原样留着
 * （#885 立的红线，服务端租约同样守）。
 */
export async function acquireTaskLeaseAcrossMachines(
  options: AcquireAcrossMachinesOptions,
): Promise<RemoteTaskLeaseResult> {
  const dir = options.dir ?? taskLeaseDir();
  const local = acquireTaskLease({
    key: options.key,
    channel: options.channel,
    taskId: options.taskId,
    executorId: options.executorId,
    dir,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.force === undefined ? {} : { force: options.force }),
  });
  // 本机就能答「被拒」：不必再发网络请求，结论也不会变（服务端最多同样拒）。
  if (local.state === "denied") return { ...local, scope: "local_home" };
  // 认不出执行体 / 租约目录写不进去：没有可上送的标识，服务端那一半无从谈起。
  if (options.executorId === null) return { ...local, scope: "local_home" };

  const claim = options.claim ?? claimServerTaskLease;
  try {
    const granted = await claim(options.server, options.token, options.channel, options.taskId, {
      executor_id: options.executorId,
      ...(options.ttlMs === undefined ? {} : { ttl_ms: options.ttlMs }),
      ...(options.force === true ? { force: true } : {}),
    });
    const state: TaskLeaseState = granted.state;
    return {
      state,
      scope: "server",
      holder: granted.holder,
      ...(granted.reason === undefined ? {} : { reason: granted.reason }),
    };
  } catch (error) {
    if (isServerDenial(error)) {
      // 服务端说这个 task 归另一台机器上的执行体。本机那张刚取的租约立刻还回去——我们并不会
      // 去干这件事，不该占着它挡住别人（还只删自己的那张，别人合法接手的碰都不碰）。
      releaseTaskLease(options.key, options.executorId, dir);
      const holder = coerceHolder(error.body, options.channel, options.taskId);
      return {
        state: "denied",
        scope: "server",
        reason: "held_by_other",
        ...(holder === null ? {} : { holder }),
      };
    }
    // 降级：退回本机租约（已经在上面取到了），**不是**放行。
    return {
      ...local,
      scope: "local_home",
      degraded: serverLeaseUnsupported(error) ? "server_unsupported" : "server_unavailable",
    };
  }
}

/**
 * 交还租约。本机那张一定要还；服务端那张尽力而为——还不上也只是等它自然过期，绝不因此让
 * 一次正常的 `status done` 失败。
 */
export async function releaseTaskLeaseAcrossMachines(options: {
  server: string;
  token: string;
  key: string;
  channel: string;
  taskId: number;
  executorId: string | null;
  dir?: string;
  release?: typeof releaseServerTaskLease;
}): Promise<void> {
  const dir = options.dir ?? taskLeaseDir();
  releaseTaskLease(options.key, options.executorId, dir);
  if (options.executorId === null) return;
  const release = options.release ?? releaseServerTaskLease;
  try {
    await release(options.server, options.token, options.channel, options.taskId, options.executorId);
  } catch {
    /* 老服务端没有这条路由 / 网络抖动：租约会按 TTL 自然过期，不阻塞收尾。 */
  }
}
