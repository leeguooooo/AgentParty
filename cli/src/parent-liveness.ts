// 宿主进程存活检测（issue #908）。
//
// 背景：`party claude-channel`（announce 档）、`party mcp` 都是 harness 通过 stdio 拉起的
// **子进程**——它们没有自己的生命周期，只该活到宿主会话活着为止。实测宿主 Claude 会话死掉后
// 这些子进程被 init 收养（ppid=1）继续活着：持有 WS 连接 → `party who` 里假在线；继续收该
// 身份的 @ → 按 channel+cwd 注入进**另一个身份**的会话（#906 那次跨身份误投的实际来源，就是
// 一个跑了 21 小时的孤儿 announce）。全仓此前只有 instance-lock.ts 读过一次 process.ppid，
// 没有任何长驻进程用它做**运行期**的生命周期判定。
//
// 本模块不新造轮子，把仓里已有的两块拼起来：
//  - 父进程身份：instance-lock 的 `captureParentProcessOwner()`（#755 为 `watch --once` 写的）。
//    它已经处理了本模块最容易写错的三件事——僵尸进程、pid 复用（比对出生时间）、ps 不可用时
//    保守判活。自己再写一遍 kill(pid,0) 一定会漏掉其中某一条。
//  - 收尾动作：#893 codex 唤醒层那套「打一行 `reaping:` 日志 + 自发 SIGTERM 复用已有的优雅
//    收口路径」（见 codex-auto-wake / hook.ts 的 runCodexAutoWakeSupervise），不另起看护进程。
//
// 判定只认**确证死亡**（与 `party mcp prune` 同一策略）：拿不准一律当宿主还活着。宁可多留一个
// 进程，也不能在宿主还活着的时候把它眼前的 announce 关掉。
import { captureParentProcessOwner, type ProcessOwner } from "./instance-lock";

/**
 * 默认探测周期。宿主死后本进程最多多活这么久。
 * 开销：一次 `kill(pid,0)` + 一次 `ps -o lstart= -o stat= -p <pid>`（instance-lock 内部，1s
 * 超时）。按 30s 一次算，单个进程 ≈ 每天 2880 次短命 ps，实测不可测量；与 #893 唤醒层的
 * CODEX_AUTO_WAKE_POLL_MS 取同一个数量级，方便一起调。
 */
export const PARENT_LIVENESS_POLL_MS = 30_000;

/** 探测周期覆盖，只给验收/测试用（真机端到端验收不该等 30s）。非法值一律回落默认。 */
export const PARENT_LIVENESS_POLL_MS_ENV = "AGENTPARTY_PARENT_LIVENESS_POLL_MS";

export function parentLivenessPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PARENT_LIVENESS_POLL_MS_ENV];
  if (typeof raw !== "string" || raw === "") return PARENT_LIVENESS_POLL_MS;
  const parsed = Number(raw);
  // 下限 50ms：别让一个手滑的 0 把探测变成忙等。
  if (!Number.isFinite(parsed) || parsed < 50) return PARENT_LIVENESS_POLL_MS;
  return Math.floor(parsed);
}

export interface ParentLivenessHandle {
  /** 停止探测（正常退出路径上调用；重复调用安全）。 */
  stop: () => void;
  /** 本次绑定的宿主 pid；≤1 表示启动时就没有可辨认的宿主，探测未启用。 */
  hostPid: number;
  /** 探测是否真的挂上了。 */
  armed: boolean;
}

export interface WatchParentLivenessOptions {
  /** 进程标签，只进日志（`claude-channel` / `mcp` …）。 */
  label: string;
  /** 覆盖宿主身份（测试用）；默认取启动时的父进程。 */
  owner?: ProcessOwner;
  pollMs?: number;
  /** 收尾：默认给自己发 SIGTERM，复用各命令已有的优雅收口路径（#893 同款）。 */
  terminate?: () => void;
  log?: (line: string) => void;
  /** 覆盖定时器（测试用）。 */
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
}

function defaultSchedule(fn: () => void, ms: number): { stop: () => void } {
  const timer = setInterval(fn, ms);
  // 探测本身绝不该成为进程活着的理由。
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(timer) };
}

/**
 * 启动时就已经是孤儿吗。`captureParentProcessOwner()` 在 pid≤1 时 alive() 恒 false，所以
 * 「没有可辨认的宿主」和「宿主已死」在这一层是同一个信号；调用方按 armed=false 处理前者。
 */
export function hasIdentifiableHost(owner: ProcessOwner): boolean {
  return Number.isInteger(owner.pid) && owner.pid > 1;
}

/**
 * 挂上宿主存活探测。命中即打一行**说明为什么退**的日志，然后调用 terminate() 干净退出。
 *
 * 刻意不做的事：不在这里关连接、不在这里删注册条目。各命令自己的 SIGTERM / transport-close
 * 路径已经会做这些（serve 放实例锁、claude-channel 关 WS、SessionEnd hook 出册），这里再来
 * 一遍只会写出两套互相打架的收尾逻辑。
 */
export function watchParentLiveness(opts: WatchParentLivenessOptions): ParentLivenessHandle {
  const owner = opts.owner ?? captureParentProcessOwner();
  if (!hasIdentifiableHost(owner)) {
    // 启动时就没有宿主（进程被人有意 daemonize，或平台不给 ppid）：不接管它的生命周期。
    return { stop: () => undefined, hostPid: owner.pid, armed: false };
  }
  const log = opts.log ?? ((line: string) => console.error(line));
  const terminate = opts.terminate ?? (() => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch {
      /* 已经在退了 */
    }
  });
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  const handle = schedule(() => {
    if (stopped) return;
    if (owner.alive()) return;
    stopped = true;
    handle.stop();
    log(
      `reaping: ${opts.label} 的宿主会话（pid=${String(owner.pid)}）已退出，` +
        `本进程随之退场——不再持有连接、不再接收该身份的 @（#908）`,
    );
    terminate();
  }, opts.pollMs ?? parentLivenessPollMs());
  return {
    stop: () => {
      stopped = true;
      handle.stop();
    },
    hostPid: owner.pid,
    armed: true,
  };
}
