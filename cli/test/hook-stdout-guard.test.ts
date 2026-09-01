// #1032：真机上一个交互式 codex 会话轮次结束时报
//   Stop hook (failed) — hook returned invalid stop hook JSON output
//
// 这些子命令的输出契约是「要么零字节，要么恰好一行 JSON」——codex 拿 stdout 当 Stop 决策、
// Claude 拿 stdout 当模型上下文。而路径上任何一处 console.log（我们自己的、或某个被 import
// 进来的模块的）都会直接落进那条信道。`party mcp` 早就为同一原因把 console.log 改道（#596）。
//
// 这里钉的是「契约与打印点解耦」：以后谁往这条路径上加日志都不该再破坏它。
import { describe, expect, test } from "bun:test";
import { emitHookLine, withHookStdoutGuard } from "../src/commands/hook";

describe("hook 的 stdout 闸（#1032）", () => {
  function capture(): { out: string[]; err: string[]; restore: () => void } {
    const out: string[] = [];
    const err: string[] = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
    return {
      out,
      err,
      restore: () => {
        console.log = realLog;
        console.error = realErr;
      },
    };
  }

  test("闸内的 console.log 一律改道 stderr，stdout 保持零字节", async () => {
    const c = capture();
    try {
      await withHookStdoutGuard(async () => {
        console.log("某个模块顺手打的日志");
        return 0;
      });
    } finally {
      c.restore();
    }
    expect(c.out).toEqual([]);
    expect(c.err).toContain("某个模块顺手打的日志");
  });

  test("决策行仍然写进真正的 stdout，且只此一条", async () => {
    const c = capture();
    try {
      await withHookStdoutGuard(async () => {
        console.log("噪声");
        emitHookLine('{"decision":"block","reason":"x"}');
        console.log("更多噪声");
        return 0;
      });
    } finally {
      c.restore();
    }
    expect(c.out).toEqual(['{"decision":"block","reason":"x"}']);
  });

  test("闸退出后 console.log 恢复原样（抛异常也要恢复）", async () => {
    const c = capture();
    try {
      await expect(
        withHookStdoutGuard(async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      console.log("闸外的日志照常走 stdout");
    } finally {
      c.restore();
    }
    expect(c.out).toEqual(["闸外的日志照常走 stdout"]);
  });

  test("闸外调用 emitHookLine 退回 console.log（不吞输出）", () => {
    const c = capture();
    try {
      emitHookLine("plain");
    } finally {
      c.restore();
    }
    expect(c.out).toEqual(["plain"]);
  });
});
