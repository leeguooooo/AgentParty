// #118 + #198：唤醒失败不得静默推进游标。
// 游标只表达「已了结」＝ 送达成功，或有界重试耗尽后**响亮地**放弃。
// 「欠账」（送达失败、从没进过模型）由 stuck 表达，落盘，且永不被当作积压跳过。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, type MsgFrame } from "@agentparty/shared";
import { createBuiltinRunner, runServe, type BuiltinRunnerOptions, type RunnerProcess, type ServeOptions } from "../src/commands/serve";
import type { StuckWake } from "../src/config";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const tempDirs: string[] = [];

afterEach(() => {
  server?.stop();
  server = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ap-serve-ack-"));
  tempDirs.push(dir);
  return dir;
}

function triggerFrame(seq = 7): MsgFrame {
  return msgFrame(seq, "wake up", { mentions: ["me"] }) as unknown as MsgFrame;
}

function runnerCtx() {
  return { cmd: "", channel: "dev", self: "me", recent: [] as MsgFrame[] };
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
    wakeRetryDelayMs: 0,
    ...over,
  };
}

function closeAfterOneMention() {
  server = startMockServer((frame, sock) => {
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send(msgFrame(1, "wake up", { mentions: ["me"] })), 20);
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 200);
  });
  return server;
}

describe("serve wake delivery (#118 / #198)", () => {
  test("a transient runner failure is retried, and the cursor advances only once it lands", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const posts: string[] = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      onCursor: (c) => cursors.push(c),
      post: async (_s, _t, _c, body) => {
        posts.push(JSON.stringify(body));
        return { seq: 1 };
      },
      runCommand: async () => {
        calls++;
        if (calls < 3) throw new Error("runner exploded");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(3);
    expect(cursors).toEqual([1]);
    // 送达了就不该有 blocked 噪音
    expect(posts.some((p) => p.includes("blocked"))).toBe(false);
  });

  test("each failed attempt persists stuck, and the cursor stays put until the wake is resolved", async () => {
    const s = closeAfterOneMention();
    const events: string[] = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      onCursor: (c) => events.push(`cursor=${c}`),
      onStuck: (st: StuckWake | null) => events.push(st ? `stuck=${st.seq}/${st.attempts}` : "stuck=cleared"),
      post: async () => ({ seq: 1 }),
      runCommand: async () => {
        calls++;
        if (calls < 3) throw new Error("runner exploded");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 欠账在每次失败后落盘（进程此刻崩掉也记得重试了几次），游标绝不先于送达推进
    expect(events).toEqual(["stuck=1/1", "stuck=1/2", "stuck=cleared", "cursor=1"]);
  });

  test("after the retry budget is exhausted it gives up loudly: blocked status naming the seq, then advances", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 2,
      onCursor: (c) => cursors.push(c),
      post: async (_s, _t, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: async () => {
        calls++;
        throw new Error("runner binary missing");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(2); // 有界：绝不无限重放
    const blocked = posts.find((p) => p.state === "blocked");
    expect(blocked).toBeDefined();
    const note = String(blocked!.note);
    expect(note).toContain("seq=1");
    expect(note).toContain("runner binary missing");
    // 常数不许只活在源码里：放弃了几次、退避多久，频道上直接可见（无 CLI flag 的代价）
    expect(note).toContain("attempts=2/2");
    expect(note).toContain("retry_delay_ms=0");
    // 放弃是一次「了结」——响亮留痕之后才允许推进游标
    expect(cursors).toEqual([1]);
  });

  test("retry budget resumes from the persisted count: a crash mid-retry does not reset it", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      // 上个进程已经在这条 seq 上烧掉 2 次，崩了。重启后只剩 1 次，不是重新 3 次。
      stuck: { seq: 1, attempts: 2, last_error: "died mid-retry" },
      onCursor: () => {},
      post: async (_s, _t, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: 1 };
      },
      runCommand: async () => {
        calls++;
        throw new Error("still broken");
      },
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(1); // 不是 3——否则一个反复崩溃的 runner 每次重启都换来一整轮新预算
    expect(posts.some((p) => p.state === "blocked")).toBe(true);
  });

  test("a blocked builtin runner signals failure to the caller instead of returning normally", async () => {
    const posts: Array<Record<string, unknown>> = [];
    const run = createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir: tempDir(),
      runProcess: async () => ({ code: 3, stdout: "", stderr: "boom" }),
      post: async (_s, _t, _c, body) => {
        posts.push(body as Record<string, unknown>);
        return { seq: posts.length };
      },
    });

    // 它必须告诉 runServe「这条没送达」，否则调用方以为送达了、直接 ack 掉。
    await expect(run(triggerFrame(1), runnerCtx())).rejects.toThrow(/blocked|exit code 3/);
    // 但它**不该自己发** blocked：外层还要重试，瞬态失败不该污染频道状态（#206 门禁 P1②）
    expect(posts.some((p) => p.state === "blocked")).toBe(false);
  });

  test("a succeeding runner advances the cursor and leaves no debt", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const stucks: unknown[] = [];
    const o = opts({
      server: s.url,
      onCursor: (c) => cursors.push(c),
      onStuck: (st) => stucks.push(st),
      runCommand: async () => {},
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(cursors).toEqual([1]);
    expect(stucks).toEqual([]);
  });
});

describe("backlog vs debt (#193 + #198 约束②)", () => {
  // 游标停在 3，挂载水位 6（4/5/6 是离线积压），挂上后来一条真·新消息 7
  function backlogThenFresh() {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(6, "me"));
      sock.send(msgFrame(4, "overnight A", { mentions: ["me"] }));
      sock.send(msgFrame(5, "overnight B", { mentions: ["me"] }));
      sock.send(msgFrame(6, "overnight C", { mentions: ["me"] }));
      setTimeout(() => sock.send(msgFrame(7, "fresh", { mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 120);
    });
    return server;
  }

  test("默认跳过离线积压：只对挂载后到达的消息唤醒 runner", async () => {
    const s = backlogThenFresh();
    const seen: number[] = [];
    const o = opts({ server: s.url, since: 3, runCommand: async (f) => void seen.push(f.seq) });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([7]);
    expect(o.lines.some((l) => l.includes("跳过 3 条离线积压") && l.includes("seq 4..6"))).toBe(true);
  });

  test("--replay-backlog 恢复逐条重放", async () => {
    const s = backlogThenFresh();
    const seen: number[] = [];
    const o = opts({ server: s.url, since: 3, skipBacklog: false, runCommand: async (f) => void seen.push(f.seq) });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(seen).toEqual([4, 5, 6, 7]);
  });

  test("欠账落在积压区间里，也绝不被跳过——它不是积压，是我们欠着的", async () => {
    const s = backlogThenFresh();
    const seen: number[] = [];
    const o = opts({
      server: s.url,
      since: 3,
      // 上个进程在 seq 5 上送达失败、崩了。5 <= 挂载水位 6，长得跟积压一模一样。
      stuck: { seq: 5, attempts: 1, last_error: "died mid-retry" },
      runCommand: async (f) => void seen.push(f.seq),
    });
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 4/6 是积压，跳过；5 是欠账，必须重放；7 是新消息
    expect(seen).toEqual([5, 7]);
    expect(o.lines.some((l) => l.includes("欠账 seq=5"))).toBe(true);
  });
});

// 190-codex-dev 门禁（PR #206）指出的两条未覆盖分支
describe("放弃通告发不出去时不得静默丢 @ (#206 门禁 P1①)", () => {
  test("最终 blocked 发送失败 → 欠账保留、游标不动、非零退出", async () => {
    const s = closeAfterOneMention();
    const cursors: number[] = [];
    const stucks: Array<StuckWake | null> = [];
    const o = opts({
      server: s.url,
      maxWakeAttempts: 1,
      onCursor: (c) => cursors.push(c),
      onStuck: (st) => stucks.push(st),
      post: async () => {
        throw new Error("network down");
      },
      runCommand: async () => {
        throw new Error("runner exploded");
      },
    });

    // 喊不出救命的 supervisor 没有理由继续消费队列——响亮地死，让人发现
    expect(await runServe(o)).not.toBe(EXIT_ARCHIVED);
    expect(await runServe(o)).not.toBe(0);
    // 没宣告过 = 没了结：游标绝不前进，欠账绝不清
    expect(cursors).toEqual([]);
    expect(stucks.at(-1)).not.toBeNull();
    expect(stucks.at(-1)!.seq).toBe(1);
  });
});

describe("重试期间不得污染频道状态 (#206 门禁 P1②)", () => {
  const builtin = (runProcess: RunnerProcess, post: BuiltinRunnerOptions["post"]) =>
    createBuiltinRunner({
      server: "http://agentparty.test",
      token: "ap_tok",
      channel: "dev",
      harness: "codex",
      workdir: tempDir(),
      runProcess,
      post,
    });

  test("builtin runner 一次瞬态失败后成功 → 频道上不留 blocked", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    let calls = 0;
    const post = async (_s: string, _t: string, _c: string, body: Record<string, unknown>) => {
      posts.push(body);
      return { seq: posts.length };
    };
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: post as never,
      runCommand: builtin(async () => {
        calls++;
        return calls === 1
          ? { code: 7, stdout: "", stderr: "transient" }
          : { code: 0, stdout: `session id: 019f35d9-0000-7000-8000-000000000001\n`, stderr: "" };
      }, post as never),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(calls).toBe(2);
    // 第一次失败不该把频道标成 blocked——它只是「还在重试」
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(0);
  });

  test("builtin runner 持续失败 → 全程只发一条最终 blocked，不是每次尝试一条", async () => {
    const s = closeAfterOneMention();
    const posts: Array<Record<string, unknown>> = [];
    const post = async (_s: string, _t: string, _c: string, body: Record<string, unknown>) => {
      posts.push(body);
      return { seq: posts.length };
    };
    const o = opts({
      server: s.url,
      maxWakeAttempts: 3,
      post: post as never,
      runCommand: builtin(async () => ({ code: 7, stdout: "", stderr: "always broken" }), post as never),
    });

    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    // 每次尝试一条 blocked = 给 loop guard 上膛（worker/src/do.ts:2582 对 status 也计数）
    expect(posts.filter((p) => p.state === "blocked")).toHaveLength(1);
    expect(String(posts.find((p) => p.state === "blocked")!.note)).toContain("giving up");
  });
});
