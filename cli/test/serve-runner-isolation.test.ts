// #816：--on-mention 的典型用法就是拉起一个能干活的 agent——它会改文件、git checkout、跑构建，
// 甚至 commit。两个这样的 runner 落在同一棵 working tree 上不是「副作用」，是数据损坏，而且是
// 静默的：两边都以为自己在正常工作。这里守三件事：
//   ① 一个 serve 实例永远只跑一个 runner（串行保证，不能被以后的重构悄悄破掉）；
//   ② --workdir 对 --on-mention 真的生效（此前被静默丢弃，用户以为隔离了其实没有）；
//   ③ 另一个 serve 已经在用同一个目录时，起码要告警（此前完全静默，只能靠 pgrep 偶然发现）。
import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// 连发三条 @，然后关闭。三条会背靠背到达——正是「上一个还活着就起下一个」会暴露的时机。
function burstOfMentions(count: number): MockServer {
  server = startMockServer((frame, sock) => {
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    for (let i = 1; i <= count; i++) {
      setTimeout(() => sock.send(msgFrame(i, `wake ${i}`, { mentions: ["me"] })), 10);
    }
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 400);
  });
  return server;
}

describe("#816 一个 serve 实例内 runner 串行", () => {
  test("连发三条 @：任一时刻只有一个 runner 在跑，且顺序处理", async () => {
    const s = burstOfMentions(3);
    let concurrent = 0;
    let maxConcurrent = 0;
    const order: number[] = [];
    const o = opts({
      server: s.url,
      runCommand: async (frame: MsgFrame) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(frame.seq);
        // 真 runner 会跑几分钟；这里只需要一个足以让后续帧到达的窗口。
        await new Promise((r) => setTimeout(r, 40));
        concurrent -= 1;
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(order.length).toBeGreaterThan(1); // 确实处理了不止一条，否则这个断言没意义
    // 这是本 issue 最担心的那件事：两个 runner 同时落在一棵 working tree 上。
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 15_000);
});

describe("#816 --workdir 对 --on-mention 生效", () => {
  test("显式 workdir 通过 ctx.cwd 传给自定义命令（此前被静默丢弃）", async () => {
    const s = burstOfMentions(1);
    const workdir = tempDir("ap-runner-workdir-");
    const seen: (string | undefined)[] = [];
    const o = opts({
      server: s.url,
      runnerCwd: workdir,
      runCommand: async (_frame, ctx) => {
        seen.push(ctx.cwd);
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([workdir]);
  }, 15_000);

  test("没给 --workdir 时不传 cwd —— 继承 serve 的 cwd 是既有行为，不能悄悄改掉", async () => {
    const s = burstOfMentions(1);
    const seen: (string | undefined)[] = [];
    const o = opts({
      server: s.url,
      runCommand: async (_frame, ctx) => {
        seen.push(ctx.cwd);
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
      const key = createHash("sha256").update(shared).digest("hex").slice(0, 24);
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
    const key = createHash("sha256").update(shared).digest("hex").slice(0, 24);
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
