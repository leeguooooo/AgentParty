// #1005 接入引导四步的判据（纯函数）。每条都钉「服务端真实数据 → 结论」，
// 不测渲染；组件测在 AgentJoin.test.tsx 里做端到端。
import { describe, expect, test } from "bun:test";
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import {
  checkinEvidence,
  findProbeSeq,
  maxSeq,
  replyEvidence,
  stepStatuses,
  verifyTimeoutTier,
  wakeableEvidence,
} from "./joinStepper";

const NOW = 1_800_000_000_000;
const NAME = "aaa";

function msg(over: Partial<MsgFrame> & { seq: number; ts: number }): MsgFrame {
  return {
    type: "msg",
    channel: "ludo",
    kind: "message",
    sender: { name: NAME, kind: "agent" },
    body: "hi",
    mentions: [],
    reply_to: null,
    ...over,
  } as unknown as MsgFrame;
}

function presence(over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    name: NAME,
    kind: "agent",
    state: "online",
    note: null,
    ts: NOW,
    last_seen: NOW,
    live: true,
    wake: { kind: "serve" },
    ...over,
  } as unknown as PresenceEntry;
}

describe("② 报到证据（#1005）", () => {
  test("引导开始之后该身份发过消息 ⇒ 报到，带 seq 与时间", () => {
    const ev = checkinEvidence([msg({ seq: 88, ts: NOW })], [], NAME, NOW - 1000);
    expect(ev).toEqual({ seq: 88, ts: NOW });
  });

  test("只有引导开始之前的旧消息 ⇒ 不算报到（铸了 token 但没接入过）", () => {
    expect(checkinEvidence([msg({ seq: 12, ts: NOW - 60_000 })], [], NAME, NOW - 1000)).toBeNull();
  });

  test("别人的消息不算它报到", () => {
    const other = msg({ seq: 90, ts: NOW, sender: { name: "leo", kind: "human" } as MsgFrame["sender"] });
    expect(checkinEvidence([other], [], NAME, NOW - 1000)).toBeNull();
  });

  test("没看到消息但 presence 里在线 ⇒ 认报到，seq 为 null", () => {
    const ev = checkinEvidence([], [presence()], NAME, NOW - 1000);
    expect(ev).toEqual({ seq: null, ts: NOW });
  });

  test("presence 里只有引导开始之前的离线旧行 ⇒ 不算", () => {
    const stale = presence({ state: "offline", live: false, last_seen: NOW - 60_000, ts: NOW - 60_000 });
    expect(checkinEvidence([], [stale], NAME, NOW - 1000)).toBeNull();
  });
});

describe("③ 可唤醒证据（#1005）", () => {
  test("live + 有 serve 唤醒层 ⇒ 可唤醒", () => {
    expect(wakeableEvidence([presence()], NAME, NOW)).toMatchObject({ kind: "serve", live: true });
  });

  test("在线但没有唤醒层（wake.kind=none）⇒ 不算——这正是裸 claude 蛰伏档", () => {
    expect(wakeableEvidence([presence({ wake: { kind: "none" } as PresenceEntry["wake"] })], NAME, NOW)).toBeNull();
  });

  test("human_driven 常驻 ⇒ 不算（靠人接续，不承诺自动响应）", () => {
    expect(wakeableEvidence([presence({ residency: "human_driven" as PresenceEntry["residency"] })], NAME, NOW)).toBeNull();
  });

  test("离线且无活连接 ⇒ 不算", () => {
    expect(wakeableEvidence([presence({ state: "offline", live: false })], NAME, NOW)).toBeNull();
  });

  test("presence 里根本没有它 ⇒ 不算", () => {
    expect(wakeableEvidence([], NAME, NOW)).toBeNull();
  });

  test("服务端盖过 verified_at ⇒ verified=true（展示「服务端已确认」）", () => {
    const verified = presence({ wake: { kind: "serve", verified_at: NOW - 1000 } as PresenceEntry["wake"] });
    expect(wakeableEvidence([verified], NAME, NOW)?.verified).toBe(true);
  });
});

describe("④ 探针与回帖（#1005）", () => {
  const probe = { baselineSeq: 100, sentAt: NOW, body: "@aaa ping" };

  test("探针进了历史 ⇒ 找得到自己的 seq（＝服务端已接受）", () => {
    const sent = msg({ seq: 101, ts: NOW, sender: { name: "leo", kind: "human" } as MsgFrame["sender"], body: "@aaa ping" });
    expect(findProbeSeq([sent], probe)).toBe(101);
  });

  test("基线之前的同文消息不会被误认成本次探针", () => {
    const old = msg({ seq: 99, ts: NOW - 5000, sender: { name: "leo", kind: "human" } as MsgFrame["sender"], body: "@aaa ping" });
    expect(findProbeSeq([old], probe)).toBeNull();
  });

  test("reply_to 指向探针 ⇒ 回帖，耗时按 ts 差", () => {
    const reply = msg({ seq: 102, ts: NOW + 3200, reply_to: 101 });
    expect(replyEvidence([reply], NAME, probe, 101)).toEqual({ seq: 102, ts: NOW + 3200, elapsedMs: 3200 });
  });

  test("没带 reply_to 但在探针之后由它发出 ⇒ 也算回帖", () => {
    const reply = msg({ seq: 103, ts: NOW + 1000 });
    expect(replyEvidence([reply], NAME, probe, 101)?.seq).toBe(103);
  });

  test("探针之前它自己的消息不算回帖", () => {
    const before = msg({ seq: 100, ts: NOW - 1 });
    expect(replyEvidence([before], NAME, probe, 101)).toBeNull();
  });
});

describe("④ 超时分层定位（#1005）", () => {
  test("探针没进历史 ⇒ 服务端没投出去", () => {
    expect(verifyTimeoutTier([presence()], NAME, null)).toBe("not_delivered");
  });

  test("current_task 就是探针 seq ⇒ 醒了还在干活", () => {
    expect(verifyTimeoutTier([presence({ current_task: 101 } as Partial<PresenceEntry>)], NAME, 101)).toBe("wake_pending");
  });

  test("runner_health 报连败 ⇒ runner 起不来", () => {
    const bad = presence({ runner_health: { ok: false } } as Partial<PresenceEntry>);
    expect(verifyTimeoutTier([bad], NAME, 101)).toBe("runner_failing");
  });

  test("listening=deaf ⇒ 本机没在收", () => {
    expect(verifyTimeoutTier([presence({ listening: "deaf" } as Partial<PresenceEntry>)], NAME, 101)).toBe("not_listening");
  });

  test("presence 里没有它 ⇒ 没在收", () => {
    expect(verifyTimeoutTier([], NAME, 101)).toBe("not_listening");
  });

  test("连接活着、也没别的毛病 ⇒ 模型没回", () => {
    expect(verifyTimeoutTier([presence()], NAME, 101)).toBe("no_reply");
  });
});

describe("四步展示状态（#1005）", () => {
  test("什么都没发生 ⇒ ①② 亮，③④ 等前面", () => {
    expect(stepStatuses({ checkin: false, wakeable: false, verified: false })).toEqual({ 1: "active", 2: "active", 3: "pending", 4: "pending" });
  });

  test("报到了 ⇒ ①② 打勾、③ 亮、④ 还等着", () => {
    expect(stepStatuses({ checkin: true, wakeable: false, verified: false })).toEqual({ 1: "done", 2: "done", 3: "active", 4: "pending" });
  });

  test("可唤醒了 ⇒ ③ 打勾、④ 亮", () => {
    expect(stepStatuses({ checkin: true, wakeable: true, verified: false })).toEqual({ 1: "done", 2: "done", 3: "done", 4: "active" });
  });

  test("验过了 ⇒ 四步全勾", () => {
    expect(stepStatuses({ checkin: true, wakeable: true, verified: true })).toEqual({ 1: "done", 2: "done", 3: "done", 4: "done" });
  });

  test("maxSeq 取历史里最大的 seq（探针基线）", () => {
    expect(maxSeq([msg({ seq: 3, ts: NOW }), msg({ seq: 91, ts: NOW }), msg({ seq: 12, ts: NOW })])).toBe(91);
    expect(maxSeq([])).toBe(0);
  });
});
