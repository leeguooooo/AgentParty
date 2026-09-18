// #1103：live session 输出流的 CLI 侧。三块：
//  1. shared 契约（脱敏 / 清洗 / 校验）——期望值写的是「秘密原文不在输出里」，不是抄一份实现的正则；
//  2. SessionOutputReporter（行切分、限速、终态帧、有界）——用假时钟，断言发出的真实帧；
//  3. client.ts 白名单逐字镜像 protocol——删掉 case "session_output" 或漏一个 state/kind 本文件必须红。
import { afterEach, describe, expect, test } from "bun:test";
import {
  SESSION_OUTPUT_LINE_MAX_CHARS,
  SESSION_OUTPUT_LINES_PER_FRAME,
  SESSION_OUTPUT_KINDS,
  SESSION_OUTPUT_STATES,
  parseSessionOutputClientFrame,
  sanitizeSessionOutputText,
  type ServerFrame,
  type SessionOutputClientFrame,
} from "@agentparty/shared";
import { SessionOutputReporter } from "../src/session-output";
import { readRunnerStream } from "../src/commands/serve";
import { connect, type Connection } from "../src/client";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

const ESC = String.fromCharCode(27);

describe("sanitizeSessionOutputText 脱敏（#1103）", () => {
  const secrets = [
    "ap_" + "a1B2c3D4e5F6g7H8i9",
    "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz",
    "ghp_" + "0123456789abcdefghijABCDEFGHIJ",
    "xoxb-" + "1234567890-abcdefghij",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  ];
  for (const secret of secrets) {
    test(`抹掉 ${secret.slice(0, 6)}…`, () => {
      const out = sanitizeSessionOutputText(`running with ${secret} now`);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted]");
      expect(out).toContain("running with");
    });
  }

  test("key=value / Bearer / URL userinfo 的值被抹，键名保留", () => {
    const pw = "hunter2hunter2";
    const out = sanitizeSessionOutputText(
      `export API_KEY=${pw}\nAuthorization: Bearer ${pw}xyz\n{"password": "${pw}"}\ngit clone https://bob:${pw}@example.com/r.git`,
    );
    expect(out).not.toContain(pw);
    expect(out).toContain("API_KEY=");
    expect(out).toContain("https://[redacted]@example.com");
  });

  test("去掉 ANSI 与控制字符，保留换行与制表", () => {
    const out = sanitizeSessionOutputText(`${ESC}[31mred${ESC}[0m\tok\r\nnext${String.fromCharCode(7)}`);
    expect(out).toBe("red\tok\nnext");
  });

  test("超长截断到上限", () => {
    const out = sanitizeSessionOutputText("x".repeat(SESSION_OUTPUT_LINE_MAX_CHARS * 3));
    expect(out.length).toBe(SESSION_OUTPUT_LINE_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  test("普通文本不被误伤", () => {
    const text = "Read src/tokenizer.ts and ran bun test (42 pass)";
    expect(sanitizeSessionOutputText(text)).toBe(text);
  });
});

describe("parseSessionOutputClientFrame（#1103）", () => {
  const base = { type: "session_output", session_id: "run-1", task_seq: 7, state: "running", lines: [] };

  test("合法帧被接受且逐行再清洗（服务端不信任客户端脱敏）", () => {
    const parsed = parseSessionOutputClientFrame({
      ...base,
      lines: [{ kind: "stdout", text: "token ap_abcdefghijklmnop", ts: 1 }],
    });
    expect(parsed?.lines[0]?.text).not.toContain("ap_abcdefghijklmnop");
  });

  test("runner 不能自报 disconnected；未知 state/kind、坏 session id 被拒", () => {
    expect(parseSessionOutputClientFrame({ ...base, state: "disconnected" })).toBeNull();
    expect(parseSessionOutputClientFrame({ ...base, state: "zzz" })).toBeNull();
    expect(parseSessionOutputClientFrame({ ...base, session_id: "has space" })).toBeNull();
    expect(parseSessionOutputClientFrame({ ...base, task_seq: 0 })).toBeNull();
    const parsed = parseSessionOutputClientFrame({ ...base, lines: [{ kind: "nope", text: "a", ts: 1 }, { kind: "text", text: "b", ts: 1 }] });
    expect(parsed?.lines.map((l) => l.text)).toEqual(["b"]);
  });

  test("行数超上限只留最后一批", () => {
    const lines = Array.from({ length: SESSION_OUTPUT_LINES_PER_FRAME + 10 }, (_, i) => ({ kind: "stdout", text: `l${i}`, ts: 1 }));
    const parsed = parseSessionOutputClientFrame({ ...base, lines });
    expect(parsed?.lines.length).toBe(SESSION_OUTPUT_LINES_PER_FRAME);
    expect(parsed?.lines.at(-1)?.text).toBe(`l${SESSION_OUTPUT_LINES_PER_FRAME + 9}`);
  });
});

function fakeClock() {
  let now = 1_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let id = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const handle = ++id;
      timers.push({ fn, at: now + ms, id: handle });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
    pending: () => timers.length,
  };
}

describe("SessionOutputReporter（#1103）", () => {
  function make() {
    const sent: SessionOutputClientFrame[] = [];
    const clock = fakeClock();
    const reporter = new SessionOutputReporter({
      send: (f) => sent.push(f),
      now: clock.now,
      flushIntervalMs: 500,
      newSessionId: (() => {
        let n = 0;
        return () => `run-${++n}`;
      })(),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { sent, clock, reporter };
  }

  test("begin 立即发 running 帧；chunk 按行切、残行等下一块；end 冲残行并发终态", () => {
    const { sent, clock, reporter } = make();
    reporter.begin(42, "runner started for seq 42");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ session_id: "run-1", task_seq: 42, state: "running" });
    expect(sent[0]!.lines.map((l) => l.kind)).toEqual(["system"]);

    reporter.chunk("stdout", "hello wo");
    reporter.chunk("stdout", "rld\nsecond");
    reporter.chunk("stderr", "warn: ap_secretsecretsecret\n");
    clock.advance(500);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "stdout:hello world",
      "stderr:warn: [redacted]",
    ]);

    reporter.end("done", "run finished");
    const last = sent.at(-1)!;
    expect(last.state).toBe("done");
    expect(last.lines.map((l) => l.text)).toEqual(["second", "run finished"]);
    expect(reporter.activeSessionId).toBeNull();
    expect(clock.pending()).toBe(0);
    // 结束后的迟到输出不再上报
    reporter.chunk("stdout", "late\n");
    clock.advance(1000);
    expect(sent.at(-1)).toBe(last);
  });

  test("限速：一拍只发一帧，积压留到下一拍；终态把积压全部分帧发完", () => {
    const { sent, clock, reporter } = make();
    reporter.begin(1, "start");
    const before = sent.length;
    reporter.chunk("stdout", Array.from({ length: SESSION_OUTPUT_LINES_PER_FRAME * 3 }, (_, i) => `l${i}`).join("\n") + "\n");
    // 同步喷出 150 行，不能同步发 3 帧
    expect(sent.length).toBe(before);
    clock.advance(500);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.lines).toHaveLength(SESSION_OUTPUT_LINES_PER_FRAME);
    reporter.end("blocked");
    const terminalFrames = sent.slice(before + 1);
    expect(terminalFrames.at(-1)!.state).toBe("blocked");
    expect(terminalFrames.slice(0, -1).every((f) => f.state === "running")).toBe(true);
    const all = sent.flatMap((f) => f.lines).filter((l) => l.kind === "stdout").map((l) => l.text);
    expect(all).toHaveLength(SESSION_OUTPUT_LINES_PER_FRAME * 3);
  });

  test("tool 只在名字变化时记一行", () => {
    const { sent, clock, reporter } = make();
    reporter.begin(1, "start");
    reporter.tool("Bash");
    reporter.tool("Bash");
    reporter.tool(null);
    reporter.tool("Edit");
    clock.advance(500);
    expect(sent.at(-1)!.lines.map((l) => l.text)).toEqual(["▸ Bash", "▸ Edit"]);
  });

  test("新一轮 begin 前未结束的旧轮被标 failed，session id 更换", () => {
    const { sent, reporter } = make();
    reporter.begin(1, "a");
    reporter.begin(2, "b");
    expect(sent.map((f) => `${f.session_id}:${f.state}`)).toEqual(["run-1:running", "run-1:failed", "run-2:running"]);
  });

  test("send 抛错不冒泡（观测流不能让 runner 失败）", () => {
    const reporter = new SessionOutputReporter({ send: () => { throw new Error("ws closed"); } });
    expect(() => {
      reporter.begin(1, "x");
      reporter.end("done");
    }).not.toThrow();
  });
});

describe("readRunnerStream（#1103）", () => {
  test("返回全文，同时逐块回调；回调抛错不影响读取", async () => {
    const chunks: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ab"));
        controller.enqueue(new TextEncoder().encode("c\n"));
        controller.close();
      },
    });
    const text = await readRunnerStream(stream, "stdout", (_s, t) => {
      chunks.push(t);
      throw new Error("observer bug");
    });
    expect(text).toBe("abc\n");
    expect(chunks.join("")).toBe("abc\n");
  });
});

let server: MockServer | null = null;
let conn: Connection | null = null;
afterEach(() => {
  conn?.close();
  conn = null;
  server?.stop();
  server = null;
});

async function collect(c: Connection, n: number, timeoutMs = 3000): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  const timer = setTimeout(() => c.close(), timeoutMs);
  for await (const f of c.frames) {
    frames.push(f);
    if (frames.length >= n) break;
  }
  clearTimeout(timer);
  return frames;
}

describe("client.ts 白名单镜像 session_output（#1103 / #622）", () => {
  test("每个 state 与 kind 都能过校验，原样递给消费方", async () => {
    const good = SESSION_OUTPUT_STATES.map((state, i) => ({
      type: "session_output",
      name: "worker",
      session_id: `run-${i}`,
      task_seq: i === 0 ? null : i,
      state,
      lines: SESSION_OUTPUT_KINDS.map((kind) => ({ kind, text: kind, ts: 1 })),
      ts: 5,
      ...(i === 1 ? { replay: true } : {}),
    }));
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        for (const f of good) sock.send(f);
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, good.length + 2);
    expect(frames.map((f) => f.type as string)).toEqual(["welcome", ...good.map(() => "session_output"), "msg"]);
    expect(frames.slice(1, -1)).toEqual(good as unknown as ServerFrame[]);
  });

  test("畸形 session_output 被丢弃，后续帧照收", async () => {
    const base = { type: "session_output", name: "w", session_id: "r", task_seq: null, state: "running", lines: [], ts: 1 };
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.send({ ...base, state: "nap" });
        sock.send({ ...base, name: "" });
        sock.send({ ...base, lines: [{ kind: "mystery", text: "x", ts: 1 }] });
        sock.send({ ...base, task_seq: -1 });
        sock.send({ ...base, replay: false });
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, 2);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "msg"]);
  });
});
