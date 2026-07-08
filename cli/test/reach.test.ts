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

  test("wakeable window matches `party who`: serve/watch/webhook stay wakeable up to 14d", () => {
    // 2 分钟没露面但声明了 webhook → 仍可唤醒（与 who 一致，webhook 由服务端 POST，不看连接）
    const recent = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 120_000 })], NOW);
    expect(recent.reach).toBe("wakeable");
    // 超过 14 天 = 幽灵 → offline
    const ghost = reachOf("bot", [p({ name: "bot", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 15 * 24 * 60 * 60 * 1000 })], NOW);
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
