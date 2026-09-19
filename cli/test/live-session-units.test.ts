// #1103 剩余项的单元层：claude stream-json 解析、工具事件文件、reporter 的 toolCall 与本机 tap。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_OUTPUT_RING_LINES } from "@agentparty/shared";
import { ClaudeStreamJsonParser, claudeResultBody } from "../src/claude-stream-json";
import { claudeJsonEnvFailure, runnerDiagnosticExcerpt, teeRunnerStream } from "../src/commands/serve";
import { SessionOutputReporter, type LocalSessionOutputSnapshot } from "../src/session-output";
import {
  TOOL_EVENTS_MAX_BYTES,
  ToolEventTail,
  appendToolEvent,
  toolEventFromHook,
  toolEventsFile,
} from "../src/tool-events";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-live-unit-"));
  dirs.push(d);
  return d;
}

describe("claudeResultBody / stream-json 终态解析", () => {
  test("取最后一个 result 行；旧单 JSON 形态照旧", () => {
    const stream = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", result: "first" }),
      JSON.stringify({ type: "result", result: "last", is_error: false }),
      "",
    ].join("\n");
    expect(claudeResultBody(stream)?.result).toBe("last");
    expect(claudeResultBody(JSON.stringify({ result: "single" }))?.result).toBe("single");
    expect(claudeResultBody("plain text")).toBeNull();
  });

  test("env failure 与诊断摘要在 stream-json 下仍识别 result 行", () => {
    const stream = [
      JSON.stringify({ type: "system" }),
      JSON.stringify({ type: "result", is_error: true, terminal_reason: "api_error", result: "OAuth session expired, please run /login" }),
    ].join("\n");
    expect(claudeJsonEnvFailure(stream)).toBe(true);
    const excerpt = runnerDiagnosticExcerpt({ stdout: stream, stderr: "" }, "claude");
    expect(excerpt).toContain("OAuth session expired");
    expect(excerpt).not.toContain("terminal_reason");
  });
});

describe("ClaudeStreamJsonParser", () => {
  const collect = () => {
    const lines: string[] = [];
    return { lines, parser: new ClaudeStreamJsonParser({ line: (_k, t) => lines.push(t) }) };
  };
  const ev = (inner: Record<string, unknown>) => JSON.stringify({ type: "stream_event", event: inner }) + "\n";

  test("text_delta 跨块拼接，按换行增量输出；完整行立即出，不等结束", () => {
    const { lines, parser } = collect();
    parser.feed(ev({ type: "message_start", message: { id: "m" } }));
    parser.feed(ev({ type: "content_block_delta", delta: { type: "text_delta", text: "ab" } }));
    const chunk = ev({ type: "content_block_delta", delta: { type: "text_delta", text: "c\nde" } });
    parser.feed(chunk.slice(0, 7));
    expect(lines).toEqual([]);
    parser.feed(chunk.slice(7));
    expect(lines).toEqual(["abc"]);
    parser.feed(ev({ type: "content_block_stop" }));
    expect(lines).toEqual(["abc", "de"]);
    // 已流过的消息，整条 assistant 不再重复
    parser.feed(JSON.stringify({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "abc\nde" }] } }) + "\n");
    parser.end();
    expect(lines).toEqual(["abc", "de"]);
  });

  test("没有 partial 事件时回退到整条 assistant 正文；忽略 thinking/tool_use 块与脏行", () => {
    const { lines, parser } = collect();
    parser.feed("not json\n{broken\n");
    parser.feed(JSON.stringify({
      type: "assistant",
      message: { id: "x", content: [{ type: "thinking", thinking: "secret plan" }, { type: "tool_use", name: "Bash" }, { type: "text", text: "one\ntwo" }] },
    }) + "\n");
    parser.end();
    expect(lines).toEqual(["one", "two"]);
  });
});

describe("工具事件文件（hook → serve）", () => {
  test("只认 PreToolUse / PostToolUseFailure，只取工具名", () => {
    expect(toolEventFromHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "secret" } }, 5))
      .toEqual({ tool: "Bash", status: "start", ts: 5 });
    expect(toolEventFromHook({ hook_event_name: "PostToolUseFailure", tool_name: "Edit" }, 6)?.status).toBe("failed");
    expect(toolEventFromHook({ hook_event_name: "PostToolUse", tool_name: "Bash" }, 7)).toBeNull();
    expect(toolEventFromHook({ hook_event_name: "PreToolUse" }, 7)).toBeNull();
  });

  test("tail 增量读取：只返回新行、半行等下一次、文件被截短从头读", () => {
    const file = toolEventsFile(join(tmp(), "activity.json"));
    const tail = new ToolEventTail(file);
    expect(tail.read()).toEqual([]);
    appendToolEvent(file, { tool: "A", status: "start", ts: 1 });
    appendToolEvent(file, { tool: "A", status: "start", ts: 2 });
    expect(tail.read().map((e) => e.ts)).toEqual([1, 2]);
    expect(tail.read()).toEqual([]);
    writeFileSync(file, JSON.stringify({ tool: "B", status: "start", ts: 3 }) + "\n" + '{"tool":"C","sta', { flag: "w" });
    expect(tail.read().map((e) => e.tool)).toEqual(["B"]);
  });

  test("文件到上限后不再追加", () => {
    const file = toolEventsFile(join(tmp(), "activity.json"));
    writeFileSync(file, "x".repeat(TOOL_EVENTS_MAX_BYTES));
    appendToolEvent(file, { tool: "A", status: "start", ts: 1 });
    expect(Bun.file(file).size).toBe(TOOL_EVENTS_MAX_BYTES);
  });
});

describe("SessionOutputReporter.toolCall 与本机 tap", () => {
  const manual = () => {
    const timers: Array<() => void> = [];
    return {
      timers,
      setTimer: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    };
  };

  test("同名工具连续调用各记一行（tool() 采样会去重，toolCall 不会）", () => {
    const sent: string[] = [];
    const clock = manual();
    const r = new SessionOutputReporter({
      send: (f) => {
        for (const l of f.lines) sent.push(`${l.kind}:${l.text}`);
      },
      ...clock,
      newSessionId: () => "run-x",
    });
    r.begin(1, "start");
    r.toolCall("Bash");
    r.toolCall("Bash");
    r.toolCall("Edit", "failed");
    r.end("done");
    expect(sent.filter((l) => l === "tool:▸ Bash")).toHaveLength(2);
    expect(sent).toContain("tool:✗ Edit failed");
  });

  test("tap 快照有界（≤300 行）、已脱敏、带终态", () => {
    const snaps: LocalSessionOutputSnapshot[] = [];
    const clock = manual();
    const r = new SessionOutputReporter({ send: () => true, ...clock, newSessionId: () => "run-t", tap: (s) => snaps.push(s) });
    r.begin(9, "start");
    for (let i = 0; i < SESSION_OUTPUT_RING_LINES + 50; i++) r.line("stdout", `line ${i} ap_${"Z".repeat(20)}`);
    r.end("done");
    const last = snaps.at(-1)!;
    expect(last.state).toBe("done");
    expect(last.task_seq).toBe(9);
    expect(last.lines.length).toBeLessThanOrEqual(SESSION_OUTPUT_RING_LINES);
    expect(JSON.stringify(last)).not.toContain("Z".repeat(20));
  });

  test("tap 抛错不影响线上发送", () => {
    let frames = 0;
    const r = new SessionOutputReporter({ send: () => { frames++; }, ...manual(), tap: () => { throw new Error("disk full"); } });
    r.begin(1, "start");
    r.end("done");
    expect(frames).toBeGreaterThanOrEqual(2);
  });
});

describe("teeRunnerStream（custom runner）", () => {
  test("原样回显字节并按块交给汇", async () => {
    const written: string[] = [];
    const chunks: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("a\nb"));
        c.enqueue(new TextEncoder().encode("c\n"));
        c.close();
      },
    });
    await teeRunnerStream(stream, "stdout", (b) => written.push(new TextDecoder().decode(b)), {
      chunk: (_s, t) => chunks.push(t),
      line: () => undefined,
    });
    expect(written.join("")).toBe("a\nbc\n");
    expect(chunks.join("")).toBe("a\nbc\n");
  });
});
