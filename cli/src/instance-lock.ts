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

export function acquireInstanceLock(kind: InstanceKind, channel: string, dir: string): InstanceLock {
  const path = lockPath(kind, channel, dir);
  mkdirSync(dir, { recursive: true });
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    // 关键：只有确认写锁的进程**已经死了**才接管。反方向（把活着的当陈旧）会重新引入 bug。
    if (typeof held.pid === "number" && pidAlive(held.pid)) {
      return { ok: false, heldByPid: held.pid };
    }
  } catch {
    /* 没有锁文件,或内容坏了：往下走,重新写一个 */
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, kind, channel, ts: Date.now() }), { mode: 0o600 });
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
