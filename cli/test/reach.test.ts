import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
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
