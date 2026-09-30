// #1130：回执 → 频道的上报器，以及「回执对唤醒记账意味着什么」这张表。
import { describe, expect, test } from "bun:test";
import { INBOX_RECEIPT_STATES, inboxReceiptTransition, normalizeInboxReceipts, inboxReceiptFor } from "@agentparty/shared";
import type { InboxReceiptEvent, InboxReceiptStatus } from "../src/claude-inbox-receipt";
import {
  createInboxReceiptReporter,
  inboxReceiptReportState,
  inboxReceiptRouteMissing,
  inboxReceiptWakeEffect,
} from "../src/claude-inbox-receipt-report";
import { RestError } from "../src/rest";

const ALL: InboxReceiptStatus[] = ["accepted", "held", "delivered", "expired", "refused", "dropped", "denied", "unknown"];
const ref = { channel: "dev", seq: 42, target: "bot" };

function recorder(impl?: () => Promise<never>) {
  const posts: { slug: string; seq: number; body: { target: string; state: string; reason?: string } }[] = [];
  const lines: string[] = [];
  const report = createInboxReceiptReporter({
    server: "https://a.example.com",
    token: "tok",
    log: (line) => lines.push(line),
    post: (async (_server: string, _token: string, slug: string, seq: number, body: { target: string; state: string }) => {
      posts.push({ slug, seq, body });
      if (impl !== undefined) return await impl();
      return { message: {} };
    }) as never,
  });
  return { report, posts, lines };
}

describe("inboxReceiptWakeEffect：回执对本机唤醒记账的效果", () => {
  test("每个状态逐一：只有证明没送达的四个终态让出认领，其余一律保留", () => {
    const effects = Object.fromEntries(ALL.map((status) => [status, inboxReceiptWakeEffect({ status })]));
    expect(effects).toEqual({
      accepted: "keep", // 没有回执：不是已读回执，也不证明没送达——与没有回执功能时一样
      held: "keep", // 还扣着：不算消费，但绝不再投一次
      delivered: "keep", // 进了对话；仍不是 ack
      expired: "release",
      refused: "release",
      dropped: "release",
      denied: "release",
      unknown: "keep", // 结局不明：绝不重放
    });
  });

  test("accepted 没有可上报的状态；其余原样", () => {
    expect(inboxReceiptReportState({ status: "accepted" })).toBeNull();
    for (const state of INBOX_RECEIPT_STATES) expect(inboxReceiptReportState({ status: state })).toBe(state);
  });
});

describe("inboxReceiptTransition：服务端裁决用的状态机", () => {
  test("无 → 任意：apply；held → 终态：apply；held → held：noop；终态 → 同：noop；终态 → 其它：reject", () => {
    for (const next of INBOX_RECEIPT_STATES) {
      expect(inboxReceiptTransition(null, next)).toBe("apply");
      expect(inboxReceiptTransition("held", next)).toBe(next === "held" ? "noop" : "apply");
      for (const previous of INBOX_RECEIPT_STATES.filter((state) => state !== "held")) {
        expect(inboxReceiptTransition(previous, next)).toBe(previous === next ? "noop" : "reject");
      }
    }
  });
});

describe("createInboxReceiptReporter", () => {
  test("accepted 绝不上报", async () => {
    const { report, posts } = recorder();
    await report(ref, { phase: "first", status: "accepted" });
    expect(posts).toHaveLength(0);
  });

  test("held 一次、终态一次；重复的 held、终态之后的任何事件都丢", async () => {
    const { report, posts } = recorder();
    await report(ref, { phase: "first", status: "held", reason: "parked" });
    await report(ref, { phase: "first", status: "held" });
    await report(ref, { phase: "terminal", status: "expired" });
    await report(ref, { phase: "terminal", status: "delivered" });
    await report(ref, { phase: "first", status: "held" });
    expect(posts.map((post) => post.body)).toEqual([
      { target: "bot", state: "held", reason: "parked" },
      { target: "bot", state: "expired" },
    ]);
    expect(posts.every((post) => post.slug === "dev" && post.seq === 42)).toBe(true);
  });

  test("每个非 accepted 状态都原样上报；不同 (seq, target) 互不影响", async () => {
    for (const status of INBOX_RECEIPT_STATES) {
      const { report, posts } = recorder();
      const event: InboxReceiptEvent = { phase: status === "held" ? "first" : "terminal", status };
      await report(ref, event);
      await report({ ...ref, seq: 43 }, event);
      await report({ ...ref, target: "other" }, event);
      expect(posts.map((post) => `${post.seq}:${post.body.target}:${post.body.state}`)).toEqual([
        `42:bot:${status}`,
        `43:bot:${status}`,
        `42:other:${status}`,
      ]);
    }
  });

  test("旧服务端（路由不存在）⇒ 停报并只留一行痕；之后一个请求都不发", async () => {
    for (const error of [new RestError(404, null, "404 Not Found"), new RestError(405, null, "x"), new RestError(501, null, "x")]) {
      const { report, posts, lines } = recorder(async () => {
        throw error;
      });
      await report(ref, { phase: "first", status: "held" });
      await report({ ...ref, seq: 43 }, { phase: "first", status: "held" });
      await report(ref, { phase: "terminal", status: "expired" });
      expect(posts).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("不支持");
    }
  });

  test("消息不存在（新服务端的结构化 404）/ 409 / 网络错：留痕、不重试、不停报", async () => {
    for (const error of [
      new RestError(404, "not_found", "message seq 42 not found"),
      new RestError(409, "conflict", "already terminal"),
      new Error("fetch failed"),
    ]) {
      const { report, posts, lines } = recorder(async () => {
        throw error;
      });
      await report(ref, { phase: "first", status: "held" });
      await report({ ...ref, seq: 43 }, { phase: "first", status: "held" });
      expect(posts).toHaveLength(2); // 没停报：下一条 @ 照常上报；同一条没有重试
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("不重试");
    }
    expect(inboxReceiptRouteMissing(new RestError(404, "not_found", "x"))).toBe(false);
    expect(inboxReceiptRouteMissing(new RestError(403, "forbidden", "x"))).toBe(false);
  });

  test("上报器与留痕回调抛错都不外泄", async () => {
    const report = createInboxReceiptReporter({
      server: "s",
      token: "t",
      log: () => {
        throw new Error("log broke");
      },
      post: (async () => {
        throw new Error("boom");
      }) as never,
    });
    await report(ref, { phase: "first", status: "held" });
  });
});

describe("normalizeInboxReceipts / inboxReceiptFor：新旧版本混跑的读侧", () => {
  test("坏项、未知状态（含 accepted）、缺字段一律跳过；整体不是数组 ⇒ 空", () => {
    expect(normalizeInboxReceipts(undefined)).toEqual([]);
    expect(normalizeInboxReceipts("held")).toEqual([]);
    const out = normalizeInboxReceipts([
      null,
      { target: "bot", state: "accepted", reported_by: { name: "bot" }, ts: 1 },
      { target: "bot", state: "future_state", reported_by: { name: "bot" }, ts: 1 },
      { target: "", state: "held", reported_by: { name: "bot" }, ts: 1 },
      { target: "bot", state: "held", ts: 1 },
      { target: "bot", state: "held", reported_by: { name: "bot" }, ts: "nope" },
      { target: "bot", state: "held", reported_by: { name: "bot", kind: "agent" }, ts: 5, held_at: 5, reason: "a\nb", extra: 1 },
    ]);
    expect(out).toEqual([
      { target: "bot", state: "held", reported_by: { name: "bot", kind: "agent" }, reason: "a b", held_at: 5, ts: 5 },
    ]);
  });

  test("同一目标多个上报者：目标自己报的优先，否则取最新", () => {
    const receipts = normalizeInboxReceipts([
      { target: "bot", state: "expired", reported_by: { name: "relay" }, ts: 9 },
      { target: "bot", state: "held", reported_by: { name: "bot" }, ts: 1 },
      { target: "other", state: "held", reported_by: { name: "relay" }, ts: 1 },
      { target: "other", state: "refused", reported_by: { name: "relay2" }, ts: 2 },
    ]);
    expect(inboxReceiptFor(receipts, "bot")?.state).toBe("held");
    expect(inboxReceiptFor(receipts, "other")?.state).toBe("refused");
    expect(inboxReceiptFor(receipts, "nobody")).toBeNull();
    expect(inboxReceiptFor(undefined, "bot")).toBeNull();
  });
});
