// #191：presence 的「离线」其实分三种，一盏灯表达不了：真离线 / 可唤醒但未验证 / 可唤醒且服务端已验证。
// wakeableState 是那个纯判定——**只在 entry 非在线时消费**（在线与否由调用方按 live/新鲜度另判）。
import { describe, expect, test } from "bun:test";
import { WAKE_VERIFY_TTL_MS, wakeableState, type PresenceEntry } from "@agentparty/shared";

const NOW = 1_000_000_000;

function e(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "offline", note: null, ts: NOW, last_seen: NOW, kind: "agent", ...over };
}

describe("wakeableState (#191 可唤醒离线待命 + 服务端校验)", () => {
  test("有 wake layer（serve/watch）+ 服务端验证过 → wakeable_verified", () => {
    const r = wakeableState(e({ name: "bot", wake: { kind: "watch", verified_at: NOW - 1000 } }), NOW);
    expect(r).toBe("wakeable_verified");
    expect(wakeableState(e({ name: "b2", wake: { kind: "serve", verified_at: NOW - 1000 } }), NOW)).toBe("wakeable_verified");
  });

  test("有 wake layer（serve/watch）+ 从未验证 → wakeable_unverified（自报，不可信，如实标注）", () => {
    expect(wakeableState(e({ name: "bot", wake: { kind: "watch" } }), NOW)).toBe("wakeable_unverified");
    expect(wakeableState(e({ name: "b2", wake: { kind: "serve" } }), NOW)).toBe("wakeable_unverified");
  });

  test("daemon（#688）刻意与 serve/watch 同档，而非 webhook：只有服务端盖过 verified_at 才 verified", () => {
    // 声明了 daemon 但服务端从没观测到「被 @ 后回帖 resume」→ 未验证（honesty #665：不因声明就打包票）。
    expect(wakeableState(e({ name: "dbot", residency: "daemon", wake: { kind: "daemon" } }), NOW)).toBe("wakeable_unverified");
    // 服务端 markWakeVerified 盖过 verified_at → 升级为 verified（DO 观测到真回帖，非客户端自报）。
    expect(
      wakeableState(e({ name: "dbot2", residency: "daemon", wake: { kind: "daemon", verified_at: NOW - 1000 } }), NOW),
    ).toBe("wakeable_verified");
  });

  test("没有 wake layer（none / 缺失）→ offline（进程没了，@ 它落不了地）", () => {
    expect(wakeableState(e({ name: "bot", wake: { kind: "none" } }), NOW)).toBe("offline");
    expect(wakeableState(e({ name: "b2" }), NOW)).toBe("offline");
  });

  test("webhook → wakeable_verified：服务端控制投递，天然可服务端验证（离线也能唤醒）", () => {
    expect(wakeableState(e({ name: "hook", wake: { kind: "webhook" } }), NOW)).toBe("wakeable_verified");
    // webhook 不需要 verified_at 也算已验证
    expect(wakeableState(e({ name: "hook2", wake: { kind: "webhook" }, last_seen: NOW - 10 * 86_400_000 }), NOW)).toBe(
      "wakeable_verified",
    );
  });

  test("human_driven 的 wake layer → offline：靠人接续，不承诺自动唤醒", () => {
    expect(wakeableState(e({ name: "bot", residency: "human_driven", wake: { kind: "watch", verified_at: NOW - 1 } }), NOW)).toBe(
      "offline",
    );
  });

  test("验证过期（超 TTL）→ 回落 unverified，不再谎称 verified（避免「自称可唤醒实则叫不醒」）", () => {
    const stale = e({ name: "bot", wake: { kind: "watch", verified_at: NOW - WAKE_VERIFY_TTL_MS - 1 } });
    expect(wakeableState(stale, NOW)).toBe("wakeable_unverified");
    // 边界内仍算 verified
    const fresh = e({ name: "b2", wake: { kind: "watch", verified_at: NOW - WAKE_VERIFY_TTL_MS + 1 } });
    expect(wakeableState(fresh, NOW)).toBe("wakeable_verified");
  });

  test("verified_at=0 / 负值视为无验证记录（不被垃圾值误升为 verified）", () => {
    expect(wakeableState(e({ name: "bot", wake: { kind: "watch", verified_at: 0 } }), NOW)).toBe("wakeable_unverified");
  });
});
