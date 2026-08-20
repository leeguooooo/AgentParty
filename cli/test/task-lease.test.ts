// #834 第 3 项：同一身份多 runner 并发,零 enforcement。
//
// 实测事故:一个 `king-claude` 身份同时跑着 harness 会话与 `party serve` 拉起的 reception
// runner,两个都在认领同一件事、互相强杀对方的模拟器;其中一个基于假前提派出了消耗真实资产的
// worker。当时 `party who` 只打印 topology_conflicts,没有任何一刀落下来。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskLease,
  describeDeniedLease,
  processScopedExecutorId,
  pruneExpiredTaskLeases,
  readTaskLease,
  releaseTaskLease,
  resolveExecutorId,
  taskLeaseKey,
} from "../src/task-lease";

const NOW = 1_786_000_000_000;
const TTL = 60_000;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ap-task-lease-"));
}

function claim(d: string, executorId: string | null, taskId = 7, now = NOW, force = false) {
  return acquireTaskLease({
    key: taskLeaseKey("https://s", "tok", "king", taskId),
    channel: "king",
    taskId,
    executorId,
    dir: d,
    ttlMs: TTL,
    now,
    force,
  });
}

describe("单活跃执行体：同一 (identity, task) 只有一个执行体能认领", () => {
  test("第二个执行体认领同一个 task 被拒", () => {
    const d = dir();
    expect(claim(d, "runner:claude:aaa").state).toBe("acquired");
    const second = claim(d, "session:claude:harness-1");
    expect(second.state).toBe("denied");
    expect(second.reason).toBe("held_by_other");
    expect(second.holder?.executor_id).toBe("runner:claude:aaa");
  });

  test("被拒后任务不丢：租约仍属原持有者，原执行体可以继续续租", () => {
    const d = dir();
    claim(d, "runner:claude:aaa");
    claim(d, "session:claude:harness-1"); // 被拒
    // 被拒的那次不许改写租约文件——否则原持有者续租时会看到别人的 id 而被自己的 task 拒之门外。
    const renewed = claim(d, "runner:claude:aaa", 7, NOW + 1_000);
    expect(renewed.state).toBe("renewed");
    expect(renewed.holder?.acquired_at).toBe(NOW);
    expect(readTaskLease(taskLeaseKey("https://s", "tok", "king", 7), d, NOW + 1_000)?.executor_id)
      .toBe("runner:claude:aaa");
  });

  test("同一执行体重复认领是续租而不是自锁", () => {
    const d = dir();
    claim(d, "runner:claude:aaa");
    const again = claim(d, "runner:claude:aaa", 7, NOW + 5_000);
    expect(again.state).toBe("renewed");
    expect(again.holder?.expires_at).toBe(NOW + 5_000 + TTL);
  });

  test("不同 task 互不影响", () => {
    const d = dir();
    expect(claim(d, "runner:claude:aaa", 7).state).toBe("acquired");
    expect(claim(d, "session:claude:harness-1", 8).state).toBe("acquired");
  });

  test("不同身份（server+token）在同一 task 号上不互斥", () => {
    expect(taskLeaseKey("https://s", "tok-a", "king", 7)).not.toBe(taskLeaseKey("https://s", "tok-b", "king", 7));
    expect(taskLeaseKey("https://s", "tok", "king", 7)).not.toBe(taskLeaseKey("https://other", "tok", "king", 7));
  });
});

describe("绝不把任务永久锁死", () => {
  test("租约到期后另一个执行体可以接手", () => {
    const d = dir();
    claim(d, "runner:claude:aaa");
    const late = claim(d, "session:claude:harness-1", 7, NOW + TTL + 1);
    expect(late.state).toBe("acquired");
    expect(late.reason).toBe("expired");
  });

  test("--force-lease 显式抢占并留下被抢者的记录", () => {
    const d = dir();
    claim(d, "runner:claude:aaa");
    const forced = claim(d, "session:claude:harness-1", 7, NOW + 10, true);
    expect(forced.state).toBe("forced");
    expect(forced.holder?.taken_over_from).toBe("runner:claude:aaa");
  });

  test("release 只删自己的租约：被合法接手后的迟到 done 不许抹掉新持有者", () => {
    const d = dir();
    const key = taskLeaseKey("https://s", "tok", "king", 7);
    claim(d, "runner:claude:aaa");
    claim(d, "session:claude:harness-1", 7, NOW + TTL + 1); // 过期接手
    expect(releaseTaskLease(key, "runner:claude:aaa", d)).toBe(false);
    expect(readTaskLease(key, d, NOW + TTL + 2)?.executor_id).toBe("session:claude:harness-1");
    expect(releaseTaskLease(key, "session:claude:harness-1", d)).toBe(true);
    expect(readTaskLease(key, d, NOW + TTL + 3)).toBeNull();
  });

  test("损坏的租约文件不锁死任务", () => {
    const d = dir();
    const key = taskLeaseKey("https://s", "tok", "king", 7);
    writeFileSync(join(d, `${key}.json`), "{ not json");
    expect(claim(d, "runner:claude:aaa").state).toBe("acquired");
  });

  test("过期租约会被清理，目录不会无限增长", () => {
    const d = dir();
    claim(d, "runner:claude:aaa", 7);
    claim(d, "runner:claude:bbb", 8, NOW + TTL * 5);
    expect(pruneExpiredTaskLeases(d, NOW + TTL + 1)).toBe(1);
    expect(readdirSync(d).length).toBe(1);
  });
});

describe("执行体身份识别", () => {
  test("serve 内建 runner 与 harness 会话解析出不同的执行体 id", () => {
    const runner = resolveExecutorId({ AP_RUNNER_WORKDIR: "/home/u/.agentparty/runners/king", AP_RUNNER_HARNESS: "claude" });
    const harness = resolveExecutorId({ CLAUDE_SESSION_ID: "sess-42" });
    expect(runner).not.toBeNull();
    expect(harness).toBe("session:claude:sess-42");
    expect(runner).not.toBe(harness);
  });

  test("同一个 serve runner 换 session（resume）后执行体 id 不变", () => {
    const a = resolveExecutorId({ AP_RUNNER_WORKDIR: "/w", AP_RUNNER_HARNESS: "claude", AP_RUNNER_SESSION_ID: "s1" });
    const b = resolveExecutorId({ AP_RUNNER_WORKDIR: "/w", AP_RUNNER_HARNESS: "claude", AP_RUNNER_SESSION_ID: "s2" });
    expect(a).toBe(b!);
  });

  test("显式覆盖优先于环境推断", () => {
    expect(resolveExecutorId({ AP_RUNNER_WORKDIR: "/w" }, { executorId: "op:manual" })).toBe("op:manual");
  });

  test("识别不出执行体时不做判定，而不是假装放行", () => {
    expect(resolveExecutorId({})).toBeNull();
    expect(claim(dir(), null).state).toBe("unenforced");
  });

  test("长驻进程（MCP）用 pid 兜底，但显式声明优先", () => {
    expect(processScopedExecutorId({}, 4242)).toBe("mcp:4242");
    expect(processScopedExecutorId({}, 4243)).not.toBe(processScopedExecutorId({}, 4242));
    expect(processScopedExecutorId({ AGENTPARTY_EXECUTOR_ID: "op:manual" }, 4242)).toBe("op:manual");
  });

  test("非法的执行体 id 不被采信", () => {
    expect(resolveExecutorId({ AGENTPARTY_EXECUTOR_ID: "bad id with spaces" })).toBeNull();
    expect(resolveExecutorId({ AGENTPARTY_EXECUTOR_ID: "../../escape" })).toBeNull();
  });
});

describe("拒绝文案必须说清任务没丢", () => {
  test("包含 refused / 任务未被改动 / 合法接手方式", () => {
    const d = dir();
    claim(d, "runner:claude:aaa");
    const denied = claim(d, "session:claude:harness-1");
    const text = describeDeniedLease(denied.holder!, "king", 7, NOW);
    expect(text).toMatch(/refused/);
    expect(text).toMatch(/task is untouched/);
    expect(text).toMatch(/--force-lease/);
    expect(text).toMatch(/runner:claude:aaa/);
  });
});

describe("落盘内容", () => {
  test("租约文件不含 token", () => {
    const d = dir();
    claim(d, "runner:claude:aaa");
    const file = readdirSync(d)[0]!;
    const body = readFileSync(join(d, file), "utf8");
    expect(body).not.toMatch(/tok/);
    expect(file).not.toMatch(/tok/);
  });
});
