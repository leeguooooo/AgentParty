// #1052 #5：`idle_notice` 帧必须通过 parseServerFrame 的白名单（client.ts 逐字镜像 protocol.ts 的
// IdleNoticeFrame / IdleNoticeReason）。把 `case "idle_notice"` 删掉或漏一个 reason，本文件必须红——
// 那正是 #622 那种「服务端上线新帧、老 CLI 静默丢帧」的形状：订阅方永远等不到「对方忙完了」。
import { afterEach, describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import { connect, type Connection } from "../src/client";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

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

describe("idle_notice 帧过客户端校验（#1052）", () => {
  test("三种 reason 都原样递给消费方（busy_ms 可选），且不影响后续 msg", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.send({ type: "idle_notice", target: "text-to-voice", reason: "idle", busy_ms: 192_000, ts: 1 });
        sock.send({ type: "idle_notice", target: "text-to-voice", reason: "exited", ts: 2 });
        sock.send({ type: "idle_notice", target: "text-to-voice", reason: "expired", ts: 3 });
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, 5);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "idle_notice", "idle_notice", "idle_notice", "msg"]);
    expect(frames[1]).toEqual({ type: "idle_notice", target: "text-to-voice", reason: "idle", busy_ms: 192_000, ts: 1 });
    expect(frames[2]).toEqual({ type: "idle_notice", target: "text-to-voice", reason: "exited", ts: 2 });
    expect(frames[3]).toEqual({ type: "idle_notice", target: "text-to-voice", reason: "expired", ts: 3 });
  });

  test("畸形 idle_notice（未知 reason / 空 target / 负 busy_ms）被丢弃，后续帧照收", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.send({ type: "idle_notice", target: "x", reason: "nap", ts: 1 });
        sock.send({ type: "idle_notice", target: "", reason: "idle", ts: 1 });
        sock.send({ type: "idle_notice", target: "x", reason: "idle", busy_ms: -1, ts: 1 });
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, 2);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "msg"]);
  });

  test("presence 里的 idle_watches（订阅方视角）通过校验，形状错则整帧丢", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0));
        sock.send({ type: "presence", name: "me", state: "online", note: null, ts: 1, idle_watches: [{ target: "bob", expires_at: 99 }] });
        sock.send({ type: "presence", name: "me", state: "online", note: null, ts: 2, idle_watches: [{ target: 1 }] });
        sock.send(msgFrame(1, "after"));
      }
    });
    conn = connect(server.url, "ap_tok", "dev", 0, {});
    const frames = await collect(conn, 3);
    expect(frames.map((f) => f.type)).toEqual(["welcome", "presence", "msg"]);
    expect(frames[1]).toMatchObject({ idle_watches: [{ target: "bob", expires_at: 99 }] });
  });
});
