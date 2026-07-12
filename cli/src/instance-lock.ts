// 本机单实例锁（#195 watch / #99 serve 的同机那半）。
//
// `watch --once` 的「退出 → 处理 → 重挂」和 serve 的重启,两者的重挂步骤都无人守卫。
// 实测（#195 作者）：10 个唤醒周期后同一 (channel, identity) 上并存两个 watcher,
// 一条 @ 触发两次 runner,agent 把同一条消息回了两遍——而 `party who` 只显示一个 ● online。
// serve 更贵：每次重复都是一次完整的 codex/claude run,可能重复 git push、重复开 PR。
//
// 用 pid 锁而不是 flock：Bun 没有跨平台 flock,而且我们要能告诉用户**是哪个 pid 占着**。
// 陈旧锁（写锁的进程已死）必须能接管,否则一次 SIGKILL 就把频道永久锁死。
//
// ⚠️ 这把锁只挡**同一台机器**。跨机器的重复执行（工位机 + 家里机各跑一个 serve）
// 需要服务端租约（#99 的另一半,`do.ts` 广播发给同名所有连接）。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type InstanceKind = "watch" | "serve";

export interface InstanceLock {
  ok: boolean;
  /** ok=false 时,当前持锁的进程 pid。 */
  heldByPid?: number;
  release?: () => void;
}

function lockPath(kind: InstanceKind, channel: string, dir: string): string {
  return join(dir, `${kind}-${channel.replace(/[^a-zA-Z0-9._-]/g, "_")}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0：只探测存活,不真的发信号
    return true;
  } catch {
    return false;
  }
}

interface LockHolder {
  pid?: number;
  id?: string;
}

function readHolder(path: string): LockHolder | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LockHolder;
  } catch {
    return null;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export function acquireInstanceLock(kind: InstanceKind, channel: string, dir: string): InstanceLock {
  const path = lockPath(kind, channel, dir);
  const reclaimPath = `${path}.reclaim`;
  const lockId = randomUUID();
  const body = JSON.stringify({ pid: process.pid, id: lockId, kind, channel, ts: Date.now() });
  let staleGeneration: string | null = null;
  mkdirSync(dir, { recursive: true });

  for (;;) {
    try {
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    const held = readHolder(path);
    if (typeof held?.pid === "number" && pidAlive(held.pid)) {
      return { ok: false, heldByPid: held.pid };
    }
    const generation = held?.id ?? `legacy:${held?.pid ?? "invalid"}`;
    // If the file changed since this contender observed the stale owner, another
    // contender won the takeover. Never delete that newer generation.
    if (staleGeneration !== null && generation !== staleGeneration) {
      return { ok: false, heldByPid: held?.pid };
    }
    staleGeneration = generation;

    const reclaimId = randomUUID();
    try {
      // O_EXCL serializes stale-file removal; the winner recreates the main lock
      // with O_EXCL while still holding this short-lived reclaim lock.
      writeFileSync(reclaimPath, JSON.stringify({ pid: process.pid, id: reclaimId }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const reclaimer = readHolder(reclaimPath);
      if (typeof reclaimer?.pid === "number" && !pidAlive(reclaimer.pid)) {
        try {
          unlinkSync(reclaimPath);
        } catch {
          /* Another contender already removed the stale reclaim lock. */
        }
      } else {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      continue;
    }

    try {
      const current = readHolder(path);
      if (typeof current?.pid === "number" && pidAlive(current.pid)) {
        return { ok: false, heldByPid: current.pid };
      }
      const currentGeneration = current?.id ?? `legacy:${current?.pid ?? "invalid"}`;
      if (currentGeneration !== staleGeneration) {
        return { ok: false, heldByPid: current?.pid };
      }
      try {
        unlinkSync(path);
      } catch {
        /* Another stale cleanup may already have removed the old file. */
      }
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    } finally {
      try {
        unlinkSync(reclaimPath);
      } catch {
        /* Reclaim lock already disappeared. */
      }
    }
  }

  return {
    ok: true,
    release: () => {
      try {
        // 只删自己的锁：别人接管过就不动它
        const cur = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
        if (cur.pid === process.pid) unlinkSync(path);
      } catch {
        /* 已经没了 */
      }
    },
  };
}
