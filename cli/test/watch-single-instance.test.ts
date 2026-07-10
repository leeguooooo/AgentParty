// #195：`watch --once` 的推荐用法是「退出 → 处理 → 重挂」，但重挂这一步无人守卫。
// 实测（issue 作者）：10 个唤醒周期后同一 (channel, identity) 上挂了**两个** watcher，
// 一条 @ 触发两次 runner，agent 把同一条消息回了两遍。而 `party who` 只显示一个 ● online——
// 重复从产品内部完全不可见。
//
// 在有 loop guard 的频道里，这是直接给熔断计数器加了个乘数（每条重复回复都是一条 agent 消息）。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ALREADY_WATCHING, runWatch } from "../src/commands/watch";
import { acquireInstanceLock } from "../src/instance-lock";
import { startMockServer, welcomeFrame } from "./mock-server";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-lock-"));
  dirs.push(d);
  return d;
}

describe("watch 单实例保护 (#195)", () => {
  test("第一个 watcher 拿到锁", () => {
    const lock = acquireInstanceLock("watch", "dev", dir());
    expect(lock.ok).toBe(true);
    lock.release?.();
  });

  test("同一 (channel, workspace) 的第二个 watcher 被拒，并告知已有 watcher 的 pid", () => {
    const d = dir();
    const first = acquireInstanceLock("watch", "dev", d);
    expect(first.ok).toBe(true);

    const second = acquireInstanceLock("watch", "dev", d);
    expect(second.ok).toBe(false);
    expect(second.heldByPid).toBe(process.pid);

    first.release?.();
  });

  test("不同频道互不阻塞", () => {
    const d = dir();
    const a = acquireInstanceLock("watch", "alpha", d);
    const b = acquireInstanceLock("watch", "beta", d);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    a.release?.();
    b.release?.();
  });

  test("释放之后可以重挂（正常的 exit → 处理 → 重挂 循环）", () => {
    const d = dir();
    const first = acquireInstanceLock("watch", "dev", d);
    first.release?.();
    const second = acquireInstanceLock("watch", "dev", d);
    expect(second.ok).toBe(true);
    second.release?.();
  });

  test("陈旧锁（写锁的进程已经死了）会被接管，不会把频道永久锁死", () => {
    const d = dir();
    // 手写一个指向不存在进程的锁：kill -0 会失败 → 判定陈旧 → 接管
    const dead = 999_999;
    expect(() => process.kill(dead, 0)).toThrow(); // 先确认这个 pid 真的不存在
    writeFileSync(join(d, "watch-dev.lock"), JSON.stringify({ pid: dead, channel: "dev" }));

    const lock = acquireInstanceLock("watch", "dev", d);
    expect(lock.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(d, "watch-dev.lock"), "utf8")).pid).toBe(process.pid);
    lock.release?.();
  });

  test("活着的锁不会被误判成陈旧（这是最危险的错误方向）", () => {
    const d = dir();
    writeFileSync(join(d, "watch-dev.lock"), JSON.stringify({ pid: process.pid, channel: "dev" }));
    const lock = acquireInstanceLock("watch", "dev", d);
    expect(lock.ok).toBe(false);
    expect(lock.heldByPid).toBe(process.pid);
  });
});

// 光有锁函数没接进 runWatch 等于没修。这几条断言观测的是**过程**：
// 第二个 watcher 有没有真的去连服务端、有没有消费掉那条 @。
describe("runWatch 接线 (#195)", () => {
  test("第二个 watcher 直接被拒，且连 WS 都不建（否则它已经在消费 @ 了）", async () => {
    const d = dir();
    let connections = 0;
    const server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      connections++;
      sock.send(welcomeFrame(0, "me"));
    });
    try {
      writeFileSync(join(d, "watch-dev.lock"), JSON.stringify({ pid: process.pid, channel: "dev" }));
      const lines: string[] = [];
      const code = await runWatch({
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        since: 0,
        timeoutSec: 2,
        follow: false,
        mentionsOnly: true,
        once: true,
        lockDir: d,
        out: (l) => lines.push(l),
        backoffBaseMs: 20,
      });
      expect(code).toBe(EXIT_ALREADY_WATCHING);
      expect(connections).toBe(0); // 关键：没有建立连接
      expect(lines.some((l) => l.includes(String(process.pid)))).toBe(true); // 告知占锁的 pid
    } finally {
      server.stop();
    }
  });

  test("--allow-multiple 是逃生舱：明知故犯时放行", async () => {
    const d = dir();
    writeFileSync(join(d, "watch-dev.lock"), JSON.stringify({ pid: process.pid, channel: "dev" }));
    const server = startMockServer((f, sock) => {
      if (f.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 30);
    });
    try {
      const code = await runWatch({
        server: server.url,
        token: "ap_tok",
        channel: "dev",
        since: 0,
        timeoutSec: 2,
        follow: false,
        mentionsOnly: true,
        lockDir: d,
        allowMultiple: true,
        out: () => {},
        backoffBaseMs: 20,
      });
      expect(code).not.toBe(EXIT_ALREADY_WATCHING);
    } finally {
      server.stop();
    }
  });
});
