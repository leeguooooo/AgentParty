// #816：--on-mention 的典型用法就是拉起一个能干活的 agent——它会改文件、git checkout、跑构建，
// 甚至 commit。两个这样的 runner 落在同一棵 working tree 上不是「副作用」，是数据损坏，而且是
// 静默的：两边都以为自己在正常工作。这里守三件事：
//   ① 一个 serve 实例永远只跑一个 runner（串行保证，不能被以后的重构悄悄破掉）；
//   ② --workdir 对 --on-mention 真的生效（此前被静默丢弃，用户以为隔离了其实没有）；
//   ③ 另一个 serve 已经在用同一个目录时，起码要告警（此前完全静默，只能靠 pgrep 偶然发现）。
import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runServe, type ServeOptions } from "../src/commands/serve";
import { claimRunnerCwd } from "../src/instance-lock";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  server?.stop();
  server = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function opts(over: Partial<ServeOptions> & { server: string }): ServeOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: (line) => lines.push(line),
    lines,
    lockDir: tempDir("ap-lock-"),
    ...over,
  } as ServeOptions & { lines: string[] };
}

// 连发 count 条 @，等它们都被处理完再关闭。三条背靠背到达，正是「上一个还活着就起下一个」
// 会暴露的时机。
//
// 关闭时机不能用固定延时：整套测试并行跑时机器有负载，wall-clock 会漂，固定 400ms 关闭会让
// 这个测试间歇性只处理到一条、`order.length > 1` 挂掉——一个自己会抖的测试不比没有测试强。
// 改成由 runner 侧回调驱动：处理够 count 条才发 archived。
function burstOfMentions(count: number): { server: MockServer; onHandled: () => void } {
  let handled = 0;
  let closeSocket: (() => void) | null = null;
  server = startMockServer((frame, sock) => {
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    closeSocket = () => sock.send({ type: "error", code: "archived", message: "done" });
    for (let i = 1; i <= count; i++) {
      setTimeout(() => sock.send(msgFrame(i, `wake ${i}`, { mentions: ["me"] })), 10);
    }
  });
  return {
    server,
    onHandled: () => {
      handled += 1;
      if (handled >= count) closeSocket?.();
    },
  };
}

describe("#816 一个 serve 实例内 runner 串行", () => {
  test("连发三条 @：任一时刻只有一个 runner 在跑，且顺序处理", async () => {
    const { server: s, onHandled } = burstOfMentions(3);
    let concurrent = 0;
    let maxConcurrent = 0;
    const order: number[] = [];
    const o = opts({
      server: s.url,
      runCommand: async (frame: MsgFrame) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(frame.seq);
        // 真 runner 会跑几分钟；这里只需要一个足以让后续帧到达、重叠能被观测到的窗口。
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
        onHandled();
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 三条全部处理到，这个测试才谈得上「观察过并发窗口」。
    expect(order).toEqual([1, 2, 3]);
    // 这是本 issue 最担心的那件事：两个 runner 同时落在一棵 working tree 上。
    expect(maxConcurrent).toBe(1);
  }, 15_000);
});

describe("#816 --workdir 对 --on-mention 生效", () => {
  test("显式 workdir 通过 ctx.cwd 传给自定义命令（此前被静默丢弃）", async () => {
    const { server: s, onHandled } = burstOfMentions(1);
    const workdir = tempDir("ap-runner-workdir-");
    const seen: (string | undefined)[] = [];
    const o = opts({
      server: s.url,
      runnerCwd: workdir,
      runCommand: async (_frame, ctx) => {
        seen.push(ctx.cwd);
        onHandled();
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([workdir]);
  }, 15_000);

  test("没给 --workdir 时不传 cwd —— 继承 serve 的 cwd 是既有行为，不能悄悄改掉", async () => {
    const { server: s, onHandled } = burstOfMentions(1);
    const seen: (string | undefined)[] = [];
    const o = opts({
      server: s.url,
      runCommand: async (_frame, ctx) => {
        seen.push(ctx.cwd);
        onHandled();
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([undefined]);
  }, 15_000);
});

describe("#816 同目录多实例告警", () => {
  test("另一个活着的 serve 已登记同一目录 → 报出冲突方（pid + 频道）", () => {
    const lockDir = tempDir("ap-lock-claim-");
    const shared = tempDir("ap-shared-tree-");
    // 起一个真活着的子进程冒充「另一台 serve」——只有真 pid 才能走通存活探测那条路径。
    const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      const claimDir = join(lockDir, "runner-cwd");
      mkdirSync(claimDir, { recursive: true });
      const key = createHash("sha256").update(realpathSync(shared)).digest("hex").slice(0, 24);
      writeFileSync(
        join(claimDir, `${key}-chan-a-${other.pid}.json`),
        JSON.stringify({ pid: other.pid, channel: "chan-a", cwd: shared }),
      );

      const claim = claimRunnerCwd(shared, "chan-b", lockDir);
      expect(claim.conflicts).toEqual([{ pid: other.pid, channel: "chan-a" }]);
      claim.release();
    } finally {
      other.kill();
    }
  });

  test("自己的登记不算冲突（否则每个 serve 都会告自己一状）", () => {
    const lockDir = tempDir("ap-lock-self-");
    const shared = tempDir("ap-self-tree-");
    const first = claimRunnerCwd(shared, "chan-a", lockDir);
    expect(first.conflicts).toEqual([]);
    const again = claimRunnerCwd(shared, "chan-b", lockDir);
    expect(again.conflicts).toEqual([]);
    first.release();
    again.release();
  });

  test("陈旧登记（写它的进程已死）不会造成永久假告警", () => {
    const lockDir = tempDir("ap-lock-stale-");
    const shared = tempDir("ap-stale-tree-");
    // 一个必然不存在的 pid 冒充崩溃残留。
    const claimDir = join(lockDir, "runner-cwd");
    mkdirSync(claimDir, { recursive: true });
    const key = createHash("sha256").update(realpathSync(shared)).digest("hex").slice(0, 24);
    writeFileSync(
      join(claimDir, `${key}-ghost-999999.json`),
      JSON.stringify({ pid: 999_999, channel: "ghost", cwd: shared }),
    );

    const claim = claimRunnerCwd(shared, "dev", lockDir);
    expect(claim.conflicts).toEqual([]);
    // 陈旧文件顺手清掉，不留着每次启动都扫一遍。
    expect(readdirSync(claimDir).some((f) => f.includes("ghost"))).toBe(false);
    claim.release();
  });

  // 同一棵树写法不同（相对路径 / 尾随斜杠 / symlink）时若算出不同 key，两个 runner 就落在
  // 同一棵树上却互相看不见——恰好是这套告警要挡的那个场景，却完全静默。
  test("路径规范化：尾随斜杠、相对路径、symlink 都视作同一个目录", () => {
    const lockDir = tempDir("ap-lock-canon-");
    const shared = realpathSync(tempDir("ap-canon-tree-"));
    const link = join(realpathSync(tmpdir()), `ap-canon-link-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(shared, link);
    const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      // 先由「另一台 serve」用最朴素的绝对路径登记。
      const claimDir = join(lockDir, "runner-cwd");
      mkdirSync(claimDir, { recursive: true });
      const key = createHash("sha256").update(realpathSync(shared)).digest("hex").slice(0, 24);
      writeFileSync(
        join(claimDir, `${key}-chan-a-${other.pid}.json`),
        JSON.stringify({ pid: other.pid, channel: "chan-a", cwd: shared }),
      );

      for (const variant of [`${shared}/`, `${shared}/./`, link]) {
        const claim = claimRunnerCwd(variant, "chan-b", lockDir);
        expect(claim.conflicts).toEqual([{ pid: other.pid, channel: "chan-a" }]);
        claim.release();
      }
    } finally {
      other.kill();
      rmSync(link, { force: true });
    }
  });

  // 先扫后写会让同时启动的两个 serve 都扫到空目录、各自写入、双方 conflicts 都为空——
  // 一条告警都不出，正是最该出告警的时刻。先写后扫至少保证后扫的那个看得见先来的。
  test("先写后扫：登记文件在扫描之前就已落盘", () => {
    const lockDir = tempDir("ap-lock-order-");
    const shared = tempDir("ap-order-tree-");
    const claim = claimRunnerCwd(shared, "dev", lockDir);
    const claimDir = join(lockDir, "runner-cwd");
    const key = createHash("sha256").update(realpathSync(shared)).digest("hex").slice(0, 24);
    const mine = readdirSync(claimDir).filter((f) => f.startsWith(`${key}-`) && f.includes(String(process.pid)));
    expect(mine).toHaveLength(1);
    // 自己刚写的那条不能把自己算成冲突。
    expect(claim.conflicts).toEqual([]);
    claim.release();
    expect(readdirSync(claimDir).filter((f) => f.startsWith(`${key}-`))).toEqual([]);
  });

  test("不同目录互不干扰", () => {
    const lockDir = tempDir("ap-lock-distinct-");
    const a = claimRunnerCwd(tempDir("ap-tree-a-"), "chan-a", lockDir);
    const b = claimRunnerCwd(tempDir("ap-tree-b-"), "chan-b", lockDir);
    expect(a.conflicts).toEqual([]);
    expect(b.conflicts).toEqual([]);
    a.release();
    b.release();
  });
});
