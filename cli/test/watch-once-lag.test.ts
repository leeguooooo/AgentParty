// #199：watch --once 醒在**最旧**的未读 mention。醒在最旧是对的（醒在最新会丢），
// 错的是它不说自己落后多少——被唤醒的 agent 以为手上这条就是最新的，
// 于是照着三小时前的上下文回话，而后面还压着 N 条没读。
import { afterEach, describe, expect, test } from "bun:test";
import { runWatch, type WatchOptions } from "../src/commands/watch";
import { msgFrame, startMockServer, welcomeFrame, type MockServer } from "./mock-server";

let server: MockServer | null = null;

afterEach(() => {
  server?.stop();
  server = null;
});

function opts(over: Partial<WatchOptions> & { server: string }): WatchOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    token: "ap_tok",
    channel: "dev",
    since: 0,
    timeoutSec: 3,
    follow: false,
    mentionsOnly: true,
    once: true,
    out: (l) => lines.push(l),
    backoffBaseMs: 20,
    lines,
    ...over,
  };
}

describe("watch --once 落后量告知 (#199)", () => {
  test("醒在最旧未读 @ 时，报出还落后多少条、频道 head 是多少", async () => {
    // 游标停在 3；频道已经到 20。seq 4 是最旧的未读 @，后面还压着 16 条。
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(20, "me"));
      sock.send(msgFrame(4, "三小时前 @ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 3 });
    expect(await runWatch(o)).toBe(0);

    // 唤醒发生在 seq 4（最旧未读），这不改
    expect(o.lines.some((l) => l.includes("三小时前 @ 你"))).toBe(true);
    // 但必须说清楚：这条不是最新的，后面还有 16 条
    const notice = o.lines.find((l) => l.includes("落后"));
    expect(notice).toBeDefined();
    expect(notice!).toContain("seq=4");
    expect(notice!).toContain("head=20");
    expect(notice!).toContain("16");
  });

  test("游标已追平频道 head 时不打落后告知（没落后就别吓唬人）", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(4, "me"));
      sock.send(msgFrame(4, "刚刚 @ 你", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 3 });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("落后"))).toBe(false);
  });

  test("非 --once（补拉排空）不打这条告知：它本来就会读到 head", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(5, "me"));
      sock.send(msgFrame(4, "@ 你 A", { mentions: ["me"] }));
      sock.send(msgFrame(5, "@ 你 B", { mentions: ["me"] }));
      setTimeout(() => sock.send({ type: "error", code: "archived", message: "done" }), 60);
    });

    const o = opts({ server: server.url, since: 3, once: false });
    expect(await runWatch(o)).toBe(0); // 补拉排空即退出 0，不会等到 archived
    expect(o.lines.some((l) => l.includes("落后"))).toBe(false);
  });
});

describe("watch --once 从服务端已读游标起步 (#172)", () => {
  test("本地游标为 0 时，采用服务端 read_seq 快进——不再每次唤醒烧掉一条历史", async () => {
    // 服务端知道我已经读到 10；频道 head 12。本地游标却是 0（新工作区）。
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(12, "me", [{ name: "me", last_seen_seq: 10, updated_at: 1 }]));
      sock.send(msgFrame(3, "远古 @ 你", { mentions: ["me"] }));   // 已读，不该唤醒
      sock.send(msgFrame(10, "也已读 @ 你", { mentions: ["me"] })); // 已读，不该唤醒
      setTimeout(() => sock.send(msgFrame(11, "真正的新 @", { mentions: ["me"] })), 40);
    });

    const cursors: number[] = [];
    const o = opts({ server: server.url, since: 0, onCursor: (c) => cursors.push(c) });
    expect(await runWatch(o)).toBe(0);

    // 唤醒发生在 11，不是 3
    expect(o.lines.some((l) => l.includes("真正的新 @"))).toBe(true);
    expect(cursors.at(-1)).toBe(11);
  });

  test("本地游标已经领先于服务端 read_seq 时，不倒退", async () => {
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(12, "me", [{ name: "me", last_seen_seq: 2, updated_at: 1 }]));
      setTimeout(() => sock.send(msgFrame(9, "新 @", { mentions: ["me"] })), 30);
    });
    const o = opts({ server: server.url, since: 8 });
    expect(await runWatch(o)).toBe(0);
    expect(o.lines.some((l) => l.includes("新 @"))).toBe(true);
  });
});
