// #1103 剩余项（serve 端到端）：真 runServe + 真 builtin runner / sdk runner / custom runner，
// 只替换进程或 SDK 边界；断言对象是 mock 服务端收到的线上 session_output 帧。
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, type SessionOutputClientFrame } from "@agentparty/shared";
import { runServe, type CodexLike, type RunnerProcess, type ServeOptions, type ThreadLike } from "../src/commands/serve";
import type { MessagePayload } from "../src/rest";
import { appendToolEvent, toolEventsFile } from "../src/tool-events";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;
const dirs: string[] = [];
afterEach(() => {
  server?.stop();
  server = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const SECRET = "ap_" + "LiveRestSecret123456";

function start(archiveAfterMs = 600): { frames: SessionOutputClientFrame[]; url: string } {
  const frames: SessionOutputClientFrame[] = [];
  server = startMockServer((frame, sock) => {
    if (frame.type === "session_output") {
      frames.push(frame as unknown as SessionOutputClientFrame);
      return;
    }
    if (frame.type !== "hello") return;
    sock.send(welcomeFrame(0, "me"));
    setTimeout(() => sock.send(msgFrame(1, "do the thing", { mentions: ["me"] })), 20);
    setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), archiveAfterMs);
  });
  return { frames, url: server.url };
}

function baseOptions(url: string, posted: MessagePayload[]): ServeOptions {
  const post = async (_s: string, _t: string, _c: string, b: MessagePayload) => {
    posted.push(b);
    return { seq: 50 };
  };
  return {
    server: url,
    token: "ap_tok",
    channel: "dev",
    since: 0,
    cmd: "true",
    mentionsOnly: true,
    out: () => undefined,
    lockDir: tmp("ap-lock-"),
    maxWakeAttempts: 1,
    wakeRetryDelayMs: 0,
    toolEventPollMs: 20,
    post,
  };
}

function streamEvent(inner: Record<string, unknown>): string {
  return JSON.stringify({ type: "stream_event", event: inner, session_id: "s" }) + "\n";
}

const kindText = (frames: SessionOutputClientFrame[]) => frames.flatMap((f) => f.lines).map((l) => `${l.kind}:${l.text}`);

describe("claude stream-json + 逐条工具事件（#1103 item 2/3）", () => {
  test("正文按 text_delta 增量流出、交付取 result 行；同名工具连续调用各记一行", async () => {
    const { frames, url } = start();
    const posted: MessagePayload[] = [];
    let argv: string[] = [];
    const runProcess: RunnerProcess = async (args, o2) => {
      argv = args;
      const activity = o2.env.AP_ACTIVITY_FILE!;
      o2.onOutput?.("stdout", streamEvent({ type: "message_start", message: { id: "m1" } }));
      o2.onOutput?.("stdout", streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: "hello " } }));
      // 一个事件行被切成两块到达
      const split = streamEvent({ type: "content_block_delta", delta: { type: "text_delta", text: `wor ${SECRET} ld\nsecond` } });
      o2.onOutput?.("stdout", split.slice(0, 20));
      o2.onOutput?.("stdout", split.slice(20));
      // hook 在两次心跳之间连着调了两次 Bash
      appendToolEvent(toolEventsFile(activity), { tool: "Bash", status: "start", ts: 1 });
      appendToolEvent(toolEventsFile(activity), { tool: "Bash", status: "start", ts: 2 });
      await new Promise((r) => setTimeout(r, 80));
      appendToolEvent(toolEventsFile(activity), { tool: "Edit", status: "failed", ts: 3 });
      o2.onOutput?.("stdout", streamEvent({ type: "content_block_stop" }));
      // 整条 assistant 消息：已经流过的不重复
      o2.onOutput?.("stdout", JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "dup" }] } }) + "\n");
      const result = JSON.stringify({ type: "result", is_error: false, result: "final body", session_id: "s" });
      o2.onOutput?.("stdout", result + "\n");
      return { code: 0, stdout: `${streamEvent({ type: "message_start", message: { id: "m1" } })}${result}\n`, stderr: "" };
    };
    const opts = baseOptions(url, posted);
    opts.builtinRunner = {
      server: url, token: "ap_tok", channel: "dev", harness: "claude", workdir: tmp("ap-live-"), runProcess, post: opts.post,
    };
    expect(await runServe(opts)).toBe(EXIT_ARCHIVED);
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--include-partial-messages");
    const lines = kindText(frames);
    expect(JSON.stringify(frames)).not.toContain(SECRET);
    expect(lines).toContain("text:hello wor [redacted] ld");
    expect(lines.filter((l) => l === "text:second")).toHaveLength(1);
    expect(lines).not.toContain("text:dup");
    expect(lines.filter((l) => l === "tool:▸ Bash")).toHaveLength(2);
    expect(lines).toContain("tool:✗ Edit failed");
    expect(frames.at(-1)!.state).toBe("done");
    const reply = posted.find((b) => b.kind === "message");
    expect(reply?.body?.endsWith("final body")).toBe(true);
    expect(reply?.body).not.toContain("stream_event");
  });
});

describe("codex-sdk 事件流（#1103 item 4）", () => {
  test("工具 / 命令输出 / 正文随 SDK 事件实时上报，交付正文不变", async () => {
    const { frames, url } = start();
    const posted: MessagePayload[] = [];
    let runCalled = false;
    const thread: ThreadLike = {
      id: "thread-1",
      async run() {
        runCalled = true;
        return { finalResponse: "should not be used", items: [] };
      },
      async runStreamed() {
        async function* events() {
          yield { type: "thread.started", thread_id: "thread-1" };
          yield { type: "item.started", item: { id: "c1", type: "command_execution", command: "bun test", status: "in_progress" } };
          yield { type: "item.completed", item: { id: "c1", type: "command_execution", command: "bun test", aggregated_output: `ok 1\nkey=${SECRET}\n`, exit_code: 2, status: "failed" } };
          yield { type: "item.started", item: { id: "t1", type: "mcp_tool_call", server: "party", tool: "send", status: "in_progress" } };
          yield { type: "item.completed", item: { id: "a1", type: "agent_message", text: "sdk final" } };
          yield { type: "turn.completed", usage: { input_tokens: 1 } };
        }
        return { events: events() };
      },
    };
    const codex: CodexLike = { startThread: () => thread, resumeThread: () => thread };
    const opts = baseOptions(url, posted);
    opts.sdkRunner = {
      server: url, token: "ap_tok", channel: "dev", workdir: tmp("ap-sdk-"), codexFactory: () => codex, post: opts.post,
    };
    expect(await runServe(opts)).toBe(EXIT_ARCHIVED);
    expect(runCalled).toBe(false);
    const lines = kindText(frames);
    expect(JSON.stringify(frames)).not.toContain(SECRET);
    expect(lines).toContain("tool:▸ shell: bun test");
    expect(lines).toContain("stdout:ok 1");
    expect(lines).toContain("stdout:key=[redacted]");
    expect(lines).toContain("stderr:exit 2: bun test");
    expect(lines).toContain("tool:▸ party.send");
    expect(lines).toContain("text:sdk final");
    expect(frames.at(-1)!.state).toBe("done");
    expect(posted.find((b) => b.kind === "message")?.body).toBe("sdk final");
  });
});

describe("custom --cmd runner（#1103 item 4）", () => {
  test("stdout/stderr 按行实时上报且脱敏", async () => {
    const { frames, url } = start(1_500);
    const opts = baseOptions(url, []);
    opts.cmd = `echo "building"; echo "token=${SECRET}"; echo "warn: slow" 1>&2`;
    expect(await runServe(opts)).toBe(EXIT_ARCHIVED);
    const lines = kindText(frames);
    expect(JSON.stringify(frames)).not.toContain(SECRET);
    expect(lines).toContain("stdout:building");
    expect(lines).toContain("stdout:token=[redacted]");
    expect(lines).toContain("stderr:warn: slow");
    expect(frames.at(-1)!.state).toBe("done");
  });

  test("本机 tap（AGENTPARTY_SESSION_OUTPUT_FILE）落一份有界、脱敏的快照", async () => {
    const { url } = start(1_500);
    const tapFile = join(tmp("ap-tap-"), "live.json");
    const prev = process.env.AGENTPARTY_SESSION_OUTPUT_FILE;
    process.env.AGENTPARTY_SESSION_OUTPUT_FILE = tapFile;
    try {
      const opts = baseOptions(url, []);
      opts.cmd = `echo "hi ${SECRET}"`;
      expect(await runServe(opts)).toBe(EXIT_ARCHIVED);
    } finally {
      if (prev === undefined) delete process.env.AGENTPARTY_SESSION_OUTPUT_FILE;
      else process.env.AGENTPARTY_SESSION_OUTPUT_FILE = prev;
    }
    expect(existsSync(tapFile)).toBe(true);
    const raw = readFileSync(tapFile, "utf8");
    expect(raw).not.toContain(SECRET);
    const snap = JSON.parse(raw) as { state: string; lines: Array<{ kind: string; text: string }>; task_seq: number };
    expect(snap.state).toBe("done");
    expect(snap.task_seq).toBe(1);
    expect(snap.lines.map((l) => `${l.kind}:${l.text}`)).toContain("stdout:hi [redacted]");
  });
});
