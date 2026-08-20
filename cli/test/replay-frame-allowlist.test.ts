// #861 + #622：服务端给 hello 补拉帧加了 MsgFrame.replay。cli/src/client.ts 的 isMessageFrame
// 是一份**手抄**的字段校验表——protocol.ts 加了字段而这里没跟上，CLI 不会报错，而是把整帧
// 静默丢掉（#622 的教训，回执 #828 就走这条通道）。这里两头都守：
//   ① 行为：带 replay:true 的补拉帧必须被投递给消费方，且字段保留；
//   ② 镜像：protocol.ts 的 MsgFrame 每个字段名都必须在 client.ts 的校验器里出现。
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    if (f.type === "msg") c.ack(f.seq);
    if (frames.length >= n) break;
  }
  clearTimeout(timer);
  return frames;
}

describe("#861 replay 字段 wire 兼容", () => {
  test("带 replay:true 的补拉帧不被静默丢弃，字段原样透出", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(2));
      sock.send({ ...msgFrame(1, "老的 @ 重放"), replay: true });
      sock.send(msgFrame(2, "真的新消息"));
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 3);
    const msgs = frames.filter((f) => f.type === "msg") as Array<{ seq: number; body: string; replay?: true }>;
    expect(msgs.map((m) => m.seq)).toEqual([1, 2]);
    expect(msgs[0]!.replay).toBe(true);
    expect(msgs[1]!.replay).toBeUndefined();
  });

  test("replay 只接受 true —— 任意其它取值判为非法帧", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(2));
      sock.send({ ...msgFrame(1, "坏帧"), replay: "yes" });
      sock.send(msgFrame(2, "好帧"));
    });
    conn = connect(server.url, "ap_tok", "dev", 0, { backoffBaseMs: 20 });
    const frames = await collect(conn, 2);
    const msgs = frames.filter((f) => f.type === "msg") as Array<{ seq: number }>;
    expect(msgs.map((m) => m.seq)).toEqual([2]);
  });
});

describe("#622 allow-list 逐字镜像守卫", () => {
  test("protocol.ts 的 MsgFrame 每个字段名都出现在 cli 的 isMessageFrame 校验器里", () => {
    const protocolSrc = readFileSync(new URL("../../shared/src/protocol.ts", import.meta.url), "utf8");
    const clientSrc = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");

    const start = protocolSrc.indexOf("export interface MsgFrame {");
    expect(start).toBeGreaterThan(-1);
    const end = protocolSrc.indexOf("\n}", start);
    const block = protocolSrc.slice(start, end);
    const fields = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    expect(fields).toContain("replay");
    expect(fields).toContain("rev_seq");

    const validatorStart = clientSrc.indexOf("function isMessageFrame(");
    expect(validatorStart).toBeGreaterThan(-1);
    const validator = clientSrc.slice(validatorStart, clientSrc.indexOf("\n}", validatorStart));

    // 已知的「结构化子对象」字段：校验器不逐字段展开它们（与现状一致），豁免但显式列出，
    // 新增字段默认必须被镜像，逼着改 protocol.ts 的人一起改 client.ts。
    const structured = new Set([
      "workflow_ref", "role", "role_source", "completion_artifact", "completion_review",
      "decision_request", "decision_resolution", "decision_response", "attachments",
      "response_source", "receipts", "revision",
    ]);
    const missing = fields.filter((f) => !structured.has(f) && !validator.includes(`value.${f}`));
    expect(missing).toEqual([]);
  });
});
