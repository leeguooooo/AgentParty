import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { classify } from "../src/commands/who";

const NOW = 1_000_000_000;

function p(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, kind: "agent", ...over };
}

describe("who classify（#47：可唤醒判定按 wake.kind 分口径）", () => {
  test("连接中且新鲜 → online", () => {
    expect(classify(p({ name: "bob" }), NOW)?.tier).toBe("online");
  });

  test("fresh 的 serve/watch → wakeable（supervisor 还活着）", () => {
    const serve = classify(p({ name: "bot", state: "offline", wake: { kind: "serve" } }), NOW);
    expect(serve?.tier).toBe("wakeable");
    const watch = classify(p({ name: "bot", state: "offline", wake: { kind: "watch" } }), NOW);
    expect(watch?.tier).toBe("wakeable");
  });

  test("offline 13 分钟的 serve → recent，不再谎报 ◐ 可唤醒（issue #47 实测场景）", () => {
    const r = classify(p({ name: "computer-use-mini", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
  });

  test("offline 13 分钟的 watch 同样降级为 recent", () => {
    const r = classify(p({ name: "bot", state: "offline", wake: { kind: "watch" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("recent");
  });

  test("human_driven 的 watch 不算 wakeable（需要人工/外层 harness 接续）", () => {
    const r = classify(p({ name: "bot", state: "offline", residency: "human_driven", wake: { kind: "watch" } }), NOW);
    expect(r?.tier).toBe("recent");
  });

  test("offline 的 webhook 仍是 wakeable：服务端投递，不靠本地 supervisor", () => {
    const r = classify(p({ name: "hook-bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 780_000 }), NOW);
    expect(r?.tier).toBe("wakeable");
    expect(r?.wake).toBe("webhook");
  });

  test("超过 14 天的幽灵一律不列（webhook 也不豁免）", () => {
    const age = 15 * 24 * 60 * 60 * 1000;
    expect(classify(p({ name: "ghost", state: "offline", wake: { kind: "serve" }, last_seen: NOW - age }), NOW)).toBeNull();
    expect(classify(p({ name: "ghost", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - age }), NOW)).toBeNull();
  });

  test("不在线的人类不列", () => {
    expect(classify(p({ name: "leo", kind: "human", state: "offline", last_seen: NOW - 120_000 }), NOW)).toBeNull();
  });
});
