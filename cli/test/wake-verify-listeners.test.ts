// #990：验证帧是「自发消息」过滤的唯一例外——serve / watch / claude-channel bridge 三个本机监听都要认。
//
// #963 起监听一律忽略发信人是自己的帧（对话里提到自己不是召唤）。验证帧（`[wake-verify]` + 只 @ 自己）
// 正是要让本身份不借别人的手走一遍真实唤醒链，所以它必须穿过这道过滤；而普通自 @（哪怕正文里有前缀
// 但还 @ 了别人）继续被忽略——这里每个监听都配一条对照。
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_ARCHIVED, WAKE_VERIFY_PREFIX, type ClientFrame, type MsgFrame, type ServerFrame } from "@agentparty/shared";
import { ClaudeChannelDeliveryBridge, type ChannelNotification } from "../src/commands/claude-channel";
import { runServe, type ServeOptions } from "../src/commands/serve";
import { runWatch, type WatchOptions } from "../src/commands/watch";
import { deliveryFrame, msgFrame, startMockServer, welcomeDirectedFrame, welcomeFrame, type MockServer } from "./mock-server";

const VERIFY = `${WAKE_VERIFY_PREFIX} @me ping · 接入验证`;
const self = { name: "me", kind: "agent" };

let server: MockServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

describe("serve：自发验证帧触发 runner，普通自 @ 不触发（#990）", () => {
  test("mentions-only 下：自 @ 忽略；验证帧唤醒；前缀对了但还 @ 了别人的自发帧仍忽略", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(0, "me"));
      setTimeout(() => sock.send(msgFrame(1, "@me 这次醒了", { sender: self, mentions: ["me"] })), 10);
      setTimeout(() => sock.send(msgFrame(2, `${WAKE_VERIFY_PREFIX} @bob 看 @me`, { sender: self, mentions: ["bob", "me"] })), 25);
      setTimeout(() => sock.send(msgFrame(3, VERIFY, { sender: self, mentions: ["me"] })), 40);
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 90);
    });
    const woke: number[] = [];
    const lines: string[] = [];
    const o: ServeOptions = {
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      since: 0,
      cmd: "true",
      mentionsOnly: true,
      out: (line) => lines.push(line),
      lockDir: mkdtempSync(join(tmpdir(), "ap-lock-")),
      runCommand: async (frame: MsgFrame) => {
        woke.push(frame.seq);
      },
    };
    expect(await runServe(o)).toBe(EXIT_ARCHIVED);
    expect(woke).toEqual([3]);
  });
});

describe("watch：自发验证帧算数，普通自发帧照旧跳过（#990）", () => {
  test("--mentions-only --once：自 @ 跳过、验证帧打印并退出", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type === "hello") {
        sock.send(welcomeFrame(0, "me"));
        setTimeout(() => sock.send(msgFrame(1, "@me echo", { sender: self, mentions: ["me"] })), 20);
        setTimeout(() => sock.send(msgFrame(2, VERIFY, { sender: self, mentions: ["me"] })), 60);
      }
    });
    const lines: string[] = [];
    const o: WatchOptions = {
      server: server.url,
      token: "ap_tok",
      channel: "dev",
      since: 0,
      once: true,
      follow: false,
      mentionsOnly: true,
      timeoutSec: 2,
      out: (line) => lines.push(line),
      lockDir: mkdtempSync(join(tmpdir(), "ap-lock-")),
    };
    expect(await runWatch(o)).toBe(0);
    expect(lines[0]).toBe(`[2] me(agent): ${VERIFY}`);
    // seq 1 的自 @ 没有被打印（--once 在第一条匹配帧后就退出，匹配的是 2 不是 1）。
    expect(lines.some((line) => line.startsWith("[1]"))).toBe(false);
  });
});

describe("claude-channel bridge：自发验证帧的 directed delivery 被认领并注入，普通自发 delivery 仍不处理（#990）", () => {
  function streaming() {
    let cursor = 0;
    const sent: ClientFrame[] = [];
    const queued: ServerFrame[] = [];
    let ended = false;
    let wake: (() => void) | null = null;
    const signal = () => {
      const resolve = wake;
      wake = null;
      resolve?.();
    };
    const frames = (async function* (): AsyncGenerator<ServerFrame> {
      for (;;) {
        const frame = queued.shift();
        if (frame) {
          yield frame;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })();
    return {
      sent,
      push(frame: ServerFrame) {
        queued.push(frame);
        signal();
      },
      connection: {
        frames,
        send(frame: ClientFrame) {
          sent.push(frame);
          return true;
        },
        ack(seq: number) {
          cursor = Math.max(cursor, seq);
        },
        close() {
          ended = true;
          signal();
        },
        get cursor() {
          return cursor;
        },
      },
    };
  }

  async function settle(ms = 60): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  test("自发普通 delivery：不发 delivery_update；自发验证帧 delivery：发 running 更新（认领链启动）", async () => {
    const stream = streaming();
    const notifications: ChannelNotification[] = [];
    const bridge = new ClaudeChannelDeliveryBridge({
      channel: "dev",
      connection: stream.connection,
      notify: async (notification) => {
        notifications.push(notification);
      },
      postReply: async () => ({ seq: 1 }),
      deliveryAckTimeoutMs: 1_000,
      out: () => {},
    });
    const run = bridge.run();
    stream.push(welcomeDirectedFrame(0, "me") as ServerFrame);
    // 对照：#963 的自 @——哪怕服务端（老版本）发来了 delivery，bridge 也不处理。
    stream.push(deliveryFrame(5, "@me 这次醒了", { id: "del-5", target_name: "me", sender: self, mentions: ["me"] }) as ServerFrame);
    await settle();
    expect(stream.sent.filter((f) => f.type === "delivery_update")).toHaveLength(0);
    // 验证帧：与别人 @ 我完全同一条路径——先向 Worker 报 running。
    stream.push(deliveryFrame(6, VERIFY, { id: "del-6", target_name: "me", sender: self, mentions: ["me"] }) as ServerFrame);
    await settle();
    const updates = stream.sent.filter((f) => f.type === "delivery_update") as Array<Extract<ClientFrame, { type: "delivery_update" }>>;
    expect(updates).toHaveLength(1);
    expect(updates[0]!.delivery_id).toBe("del-6");
    expect(updates[0]!.state).toBe("running");
    bridge.close();
    await expect(run).resolves.toBe(0);
  });
});
