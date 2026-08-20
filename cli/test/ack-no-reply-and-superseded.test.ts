// #875：`party ack` 从纯本地升级为可真正结清服务端账本（--no-reply → acknowledged_no_reply）。
// #881：superseded 标记必须逐字镜像进 client.ts 的帧校验（#622：漏字段会静默丢整帧），
//       并且在消费侧看得见——扫 header 的 agent 不能等展开全文才发现「这条已过期」。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MsgFrame, ServerFrame } from "@agentparty/shared";
import { NO_REPLY_REQUIRES_SEQ_ERROR, run as runAck } from "../src/commands/ack";
import { loadStuck, saveWatchStuck } from "../src/config";
import { connect, type Connection } from "../src/client";
import { formatMsg, msgHeader } from "../src/format";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let home: string;
let cwd: string;
let originalCwd: string;
const oldEnv: Record<string, string | undefined> = {};

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  return {
    lines,
    restore: () => {
      console.log = log;
      console.error = err;
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-ack-noreply-home-"));
  cwd = mkdtempSync(join(tmpdir(), "ap-ack-noreply-cwd-"));
  for (const key of ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_CHANNEL"]) {
    oldEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AGENTPARTY_HOME = home;
  writeFileSync(join(home, "config.json"), JSON.stringify({ server: "http://ap.test", token: "ap_t" }));
  originalCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const watchDebt = (seq: number) => ({ seq, wake_ts: 1, attempts: 1, source: "watch" as const });

describe("#875 party ack --no-reply 结清服务端账本", () => {
  test("POST 到 deliveries/:id/ack，本地债一并清掉", async () => {
    expect(saveWatchStuck("dev", watchDebt(1841))).toBe(true);
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    const methods: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      urls.push(String((input as { url?: string })?.url ?? input));
      methods.push(init?.method ?? "GET");
      return new Response(
        JSON.stringify({ ok: true, delivery: { id: "d1", state: "replied", reply_seq: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    let lines: string[];
    try {
      const cap = capture();
      expect(await runAck(["--channel", "dev", "--seq", "1841", "--no-reply"])).toBe(0);
      cap.restore();
      lines = cap.lines;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls.some((u) => u.includes("/api/channels/dev/deliveries/1841/ack"))).toBe(true);
    expect(methods).toContain("POST");
    expect(lines.join("\n")).toContain("acknowledged_no_reply");
    expect(loadStuck("dev")).toBeNull();
  });

  test("服务端失败时不清本地债：不能让人以为两本账都平了", async () => {
    expect(saveWatchStuck("dev", watchDebt(1841))).toBe(true);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "conflict", message: "already terminal" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const cap = capture();
      expect(await runAck(["--channel", "dev", "--seq", "1841", "--no-reply"])).not.toBe(0);
      cap.restore();
    } finally {
      globalThis.fetch = realFetch;
    }
    // 服务端那条 @ 还欠着，本地债就必须留着——它是用户下一次还看得见这条 @ 的唯一凭据。
    expect(loadStuck("dev")?.seq).toBe(1841);
  });

  test("--no-reply 必须指名道姓：没有 --seq 直接报错，且一次网络请求都不发", async () => {
    expect(saveWatchStuck("dev", watchDebt(1841))).toBe(true);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("must not talk to the server");
    }) as unknown as typeof fetch;
    let lines: string[];
    try {
      const cap = capture();
      expect(await runAck(["--channel", "dev", "--no-reply"])).toBe(1);
      cap.restore();
      lines = cap.lines;
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(lines.join("\n")).toBe(NO_REPLY_REQUIRES_SEQ_ERROR);
    expect(calls).toBe(0);
    expect(loadStuck("dev")?.seq).toBe(1841);
  });

  test("不带 --no-reply 仍然全程零网络：默认行为没被 #875 改变", async () => {
    expect(saveWatchStuck("dev", watchDebt(7))).toBe(true);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("party ack must not talk to the server");
    }) as unknown as typeof fetch;
    try {
      const cap = capture();
      expect(await runAck(["--channel", "dev", "--seq", "7"])).toBe(0);
      cap.restore();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toBe(0);
  });
});

async function collect(c: Connection, n: number, timeoutMs = 3000): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  const timer = setTimeout(() => c.close(), timeoutMs);
  for await (const f of c.frames) {
    frames.push(f);
    if (f.type === "msg") c.ack(f.seq);
    if (frames.length >= n) break;
  }
  clearTimeout(timer);
  return frames;
}

describe("#881 superseded 的 wire 兼容与可见性", () => {
  let server: MockServer | null = null;
  let conn: Connection | null = null;

  afterEach(() => {
    conn?.close();
    conn = null;
    server?.stop();
    server = null;
  });

  test("带 superseded 的帧不被静默丢弃；与 replay 可同时为真", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(2));
      sock.send({
        ...msgFrame(1, "部署到 prod"),
        replay: true,
        superseded: { by_seq: 2, reason: "reply_correction" },
      });
      sock.send(msgFrame(2, "改口：先别部署"));
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 3);
    const msgs = frames.filter((f) => f.type === "msg") as MsgFrame[];
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);
    // 两个标记正交：一条帧同时是「补拉的历史帧」和「内容已过期」。
    expect(msgs[0]!.replay).toBe(true);
    expect(msgs[0]!.superseded).toEqual({ by_seq: 2, reason: "reply_correction" });
    expect(msgs[1]!.superseded).toBeUndefined();
  });

  test("形状不对的 superseded 判为非法帧（by_seq 必须是正整数、reason 必须在词表里）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(3));
      sock.send({ ...msgFrame(1, "坏帧"), superseded: { by_seq: 0, reason: "reply_correction" } });
      sock.send({ ...msgFrame(2, "坏帧"), superseded: { by_seq: 3, reason: "whatever" } });
      sock.send(msgFrame(3, "好帧"));
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 2);
    const msgs = frames.filter((f) => f.type === "msg") as MsgFrame[];
    expect(msgs.map((m) => m.seq)).toEqual([3]);
  });

  test("消费侧看得见：header 摘要与全文渲染都报「这条不是最新指令」", () => {
    const frame = {
      ...(msgFrame(1, "部署到 prod") as unknown as MsgFrame),
      superseded: { by_seq: 9, reason: "reply_correction" as const },
    };
    expect(msgHeader(frame).superseded).toEqual({ by_seq: 9, reason: "reply_correction" });
    const rendered = formatMsg(frame);
    expect(rendered).toContain("SUPERSEDED by #9");
    expect(rendered).toContain("not the latest instruction");
  });
});
