// #180：watch --once 必须尊重「暂停接待」。被暂停的 agent 用 `party watch --once`（给 Claude Code
// 的旗舰唤醒姿势）被 @ 时不能退出——进程退出就是唤醒信号，退出=被唤醒=暂停形同虚设。
// 镜像 serve 的 self-paused 跟踪：从 welcome 的 presence 快照认出初始暂停态、靠 presence 帧增量翻转；
// 暂停期被 @ 不作为 --once 唤醒退出，但消息照常打印进历史、游标照推进；恢复后 @ 重新唤醒。
import { afterEach, describe, expect, test } from "bun:test";
import { EXIT_TIMEOUT } from "@agentparty/shared";
import { runWatch, type WatchOptions } from "../src/commands/watch";
import { msgFrame, startMockServer, type MockServer } from "./mock-server";

let server: MockServer | null = null;

function pausedWelcome(lastSeq: number, self = "me", over: Record<string, unknown> = {}) {
  return {
    type: "welcome",
    channel: "dev",
    self,
    last_seq: lastSeq,
    presence: [
      { name: self, state: "online", note: null, ts: Date.now(), paused: true, resume_at: Date.now() + 3_600_000 },
    ],
    ...over,
  };
}

function plainWelcome(lastSeq: number, self = "me") {
  return { type: "welcome", channel: "dev", self, last_seq: lastSeq, presence: [] };
}

function presenceFrame(name: string, over: Record<string, unknown> = {}) {
  return { type: "presence", name, state: "online", note: null, ts: Date.now(), ...over };
}

function opts(over: Partial<WatchOptions> & { server: string }): WatchOptions & { lines: string[]; cursors: number[] } {
  const lines: string[] = [];
  const cursors: number[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 3,
    timeoutSec: 1,
    follow: false,
    mentionsOnly: true,
    once: true,
    allowMultiple: true,
    out: (l) => lines.push(l),
    onCursor: (c) => cursors.push(c),
    backoffBaseMs: 20,
    lines,
    cursors,
    ...over,
  };
}

afterEach(() => {
  server?.stop();
  server = null;
});

describe("watch --once 尊重暂停接待 (#180)", () => {
  test("welcome 快照里已暂停：被 @ 不退出（超时而非唤醒），但消息照进历史、游标照推进", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(pausedWelcome(3, "me"));
      sock.send(msgFrame(4, "暂停期 @ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url });
    // 没被唤醒——一直等到超时（若尊重失败会 return 0 提前退出=假唤醒）
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines).toContain("TIMEOUT");
    // 消息照常入历史：打印出来 + 游标推进到该 seq（服务端据此标记已读）
    expect(o.lines.some((l) => l.includes("暂停期 @ 你"))).toBe(true);
    expect(o.cursors).toContain(4);
    // 但绝不发 --once 唤醒摘要（channel_last_seq=... lag=... 是唤醒回执）
    expect(o.lines.some((l) => l.includes("channel_last_seq"))).toBe(false);
  });

  test("运行中收到 presence 暂停帧：随后被 @ 也不退出", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(plainWelcome(3, "me"));
      sock.send(presenceFrame("me", { paused: true, resume_at: Date.now() + 60_000 }));
      sock.send(msgFrame(4, "刚被暂停后 @ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url });
    expect(await runWatch(o)).toBe(EXIT_TIMEOUT);
    expect(o.lines.some((l) => l.includes("刚被暂停后 @ 你"))).toBe(true);
    expect(o.cursors).toContain(4);
    expect(o.lines.some((l) => l.includes("channel_last_seq"))).toBe(false);
  });

  test("恢复接待后：@ 重新作为唤醒信号，正常退出 0", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      // 起始已暂停 → seq 4 的 @ 不唤醒；收到恢复 presence 帧后，seq 5 的 @ 才唤醒退出。
      sock.send(pausedWelcome(3, "me"));
      sock.send(msgFrame(4, "暂停期 @ 你（不该醒）", { mentions: ["me"] }));
      sock.send(presenceFrame("me")); // paused 省略 = 恢复接待
      sock.send(msgFrame(5, "恢复后 @ 你（该醒）", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url });
    // 醒在 seq 5，正常退出 0（若停在 seq 4 唤醒，就读不到 seq 5 了）
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("恢复后 @ 你"))).toBe(true);
    expect(o.lines).toContain("watch: channel_last_seq=5 lag=0 skipped_mention_seqs=[]");
    expect(o.cursors).toContain(5);
  });

  test("别人被暂停不影响我：presence 帧 name 不是自己时照常唤醒", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(plainWelcome(3, "me"));
      sock.send(presenceFrame("bob", { paused: true })); // 是 bob 被暂停，不是我
      sock.send(msgFrame(4, "@ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("@ 你"))).toBe(true);
    expect(o.cursors).toContain(4);
  });
});
