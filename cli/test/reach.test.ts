import { describe, expect, test } from "bun:test";
import { applyLiveConnection, type PresenceEntry } from "@agentparty/shared";
import { formatReach, formatReachLine, reachOf } from "../src/reach";

const NOW = 1_000_000_000;

function p(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

describe("reachOf", () => {
  test("connected + fresh → online", () => {
    expect(reachOf("bob", [p({ name: "bob" })], NOW).reach).toBe("online");
  });

  test("not online but wakeable (serve/watch/webhook) + fresh → wakeable, carries wake kind", () => {
    const r = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "serve" } })], NOW);
    expect(r.reach).toBe("wakeable");
    expect(r.wake).toBe("serve");
  });

  test("stale serve/watch → offline：supervisor 死了叫不醒，不再谎报可唤醒（#47）", () => {
    // 13 分钟没心跳的 serve：supervisor 已死，@ 它无人应答 → offline
    const deadServe = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 })], NOW);
    expect(deadServe.reach).toBe("offline");
    const deadWatch = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "watch" }, last_seen: NOW - 780_000 })], NOW);
    expect(deadWatch.reach).toBe("offline");
  });

  test("human_driven watch → offline for send reach（#55）", () => {
    const r = reachOf("bot", [p({ name: "bot", state: "offline", residency: "human_driven", wake: { kind: "watch" } })], NOW);
    expect(r.reach).toBe("offline");
  });

  test("stale webhook 仍 wakeable：服务端投递，agent 离线也真能唤醒（#47）", () => {
    // 2 分钟没露面但声明了 webhook → 仍可唤醒（webhook 由服务端 POST，不看连接）
    const recent = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 120_000 })], NOW);
    expect(recent.reach).toBe("wakeable");
    expect(recent.wake).toBe("webhook");
    // 但超过 14 天 = 幽灵 → offline（webhook 也不豁免幽灵清理）
    const ghost = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 15 * 24 * 60 * 60 * 1000 })], NOW);
    expect(ghost.reach).toBe("offline");
  });

  test("not in presence at all → offline", () => {
    expect(reachOf("ghost", [], NOW).reach).toBe("offline");
  });

  test("offline with no wake kind → offline", () => {
    expect(reachOf("x", [p({ name: "x", state: "offline", wake: { kind: "none" } })], NOW).reach).toBe("offline");
  });
});

// issue #97：修复在服务端（DO presence 序列化给有活连接的 name 打 live=true，不改写 last_seen）。
// reachOf 消费已带 live 的 presence：live 视同「在线」，与 web mentions（online.has＝participants＝活连接）
// 同源同判。这里守住 CLI/web 一致性回归。applyLiveConnection 是那道服务端修正的纯函数形态。
describe("consistency with server-side live-connection fix (#97)", () => {
  test("有活连接的 serve agent：陈旧甚至 offline 的行经 applyLiveConnection 打 live 后 → reachOf 判 online", () => {
    // 挂了 61s 没发帧的健康 serve：presence 陈旧、行内可能还是 offline（重连未自报）
    const raw = p({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: NOW - 61_000 });
    // 未打 live（服务端不知道有活连接）时：CLI 会误判 offline —— 这正是 #97 里 CLI 与 web 打架的根源
    expect(reachOf("bot", [raw], NOW).reach).toBe("offline");
    // 打 live 后（服务端知道 bot 有活 WS 连接）：reachOf 判 online，与 web mentions（online.has）一致
    const corrected = applyLiveConnection(raw, true);
    expect(corrected.live).toBe(true);
    expect(corrected.last_seen).toBe(NOW - 61_000); // 不改写 last_seen（host 租约不受污染）
    expect(reachOf("bot", [corrected], NOW).reach).toBe("online");
  });

  test("无活连接：修正是恒等，陈旧 serve 仍判 offline（离线判定不被破坏）", () => {
    const raw = p({ name: "bot", state: "offline", wake: { kind: "serve" }, residency: "supervised", last_seen: NOW - 61_000 });
    expect(reachOf("bot", [applyLiveConnection(raw, false)], NOW).reach).toBe("offline");
  });
});

describe("formatting", () => {
  test("per-target labels are honest and compact", () => {
    expect(formatReach({ name: "a", reach: "online" })).toBe("@a ● online");
    expect(formatReach({ name: "b", reach: "wakeable", wake: "serve" })).toBe("@b ◐ wakeable(serve)");
    expect(formatReach({ name: "c", reach: "offline" })).toBe("@c ○ offline — reconnect to reach");
  });

  test("line joins with a separator and a leading arrow", () => {
    const line = formatReachLine([
      { name: "a", reach: "online" },
      { name: "c", reach: "offline" },
    ]);
    expect(line).toBe("→ @a ● online  ·  @c ○ offline — reconnect to reach");
  });
});
