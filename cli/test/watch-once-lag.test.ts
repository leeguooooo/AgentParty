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

describe("watch --once 不得复用身份级已读游标 (#206 门禁 P1)", () => {
  test("welcome.read_cursors 领先本地游标时，绝不据此快进——它证明不了唤醒送达", async () => {
    // 服务端说这个身份已读到 10（可能是同身份的网页标签页读的）。
    // 但 watch --once 的送达由 wake 回执表达，不由 seen 表达（shared/src/protocol.ts:424-430）。
    // 拿 read_seq 快进会把 seq 4 这条从未送达的 @ 静默跳过。
    server = startMockServer((frame, sock) => {
      if (frame.type !== "hello") return;
      sock.send(welcomeFrame(12, "me", [{ name: "me", last_seen_seq: 10, updated_at: 1 }]));
      sock.send(msgFrame(4, "从未送达给 supervisor 的 @", { mentions: ["me"] }));
    });

    const o = opts({ server: server.url, since: 3 });
    expect(await runWatch(o)).toBe(0);
    // 仍然醒在 seq 4：这条 @ 从没唤醒过任何 runner，不能因为网页读过就算了结
    expect(o.lines.some((l) => l.includes("从未送达给 supervisor 的 @"))).toBe(true);
  });
});
