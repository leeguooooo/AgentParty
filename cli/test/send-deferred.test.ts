// #958：`party send` @ 到一个「拉取式唤醒」的身份（本机装着 codex Stop hook，#905）时，发送方要看到
// 「在排队、排多深、怎么一次清掉」，而不是 #664 那句「no live wake channel」——那句结论本就是错的，
// 且让「杳无音信」和「坏了」无法区分。这里直接测发送后反馈的纯计算部分（reachReport）。
import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { reachReport } from "../src/commands/send";
import { buildPullWakeLookup } from "../src/pull-wake";
import { deferredOf, formatDeferred, unreachableOf } from "../src/reach";

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;
const CH = "agentparty";

function stale(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return {
    state: "offline",
    note: null,
    ts: NOW - 88 * HOUR,
    last_seen: NOW - 88 * HOUR,
    kind: "agent",
    wake: { kind: "none" },
    ...over,
  };
}

const lookup = (names: string[], hook: "ok" | "disabled" = "ok") =>
  buildPullWakeLookup(CH, "https://s", {
    hasHook: () => true,
    hookStatus: () => hook,
    names: () => new Set(names),
    // #1083：不注入就会去读这台机器真实的会话注册表，测试随机器状态摇摆。
    liveNames: () => new Set(names),
  });

function report(presence: PresenceEntry[], sentSeq: number, pullWake = lookup(["codex1"])) {
  return reachReport({ mentions: ["codex1"], presence, now: NOW, channel: CH, sentSeq, wantLine: false, wantWarn: true, pullWake });
}

describe("party send → deferred 目标的排队提示（#958）", () => {
  test("事故现场：账本欠 9 条、我这条是第 9 个 → 说清位置、轮数、排空命令", () => {
    const seqs = [1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930, 1935];
    const { lines, unreachable } = report([stale({ name: "codex1", unhandled_mention_count: 9, pending_mention_seqs: seqs })], 1935);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain("@codex1 ⇢ deferred");
    expect(line).toContain("ONE per turn");
    expect(line).toContain("9 unhandled @ queued, yours is #9 in line ≈ 9 turns");
    expect(line).toContain(`party ack --drain --channel ${CH}`);
    expect(line).toContain("local view");
    // 旧的错误结论一个字都不能留。
    expect(line).not.toContain("no live wake channel");
    expect(line).not.toContain("delivered to history only");
    // 它此刻确实叫不醒：--require-wakeable 的非零退出语义不松。
    expect(unreachable).toEqual(["codex1"]);
  });

  test("账本没列出我这条（还没入账）：按「N 条排在前面 ≈ N+1 turns」说", () => {
    const { lines } = report([stale({ name: "codex1", unhandled_mention_count: 8, pending_mention_seqs: [1923, 1924] })], 1935);
    expect(lines[0]).toContain("8 unhandled @ queued ahead of yours ≈ 9 turns");
  });

  test("账本上没有欠账：说「前面没别人」，不编造条数", () => {
    const { lines } = report([stale({ name: "codex1" })], 1935);
    expect(lines[0]).toContain("nothing else queued ahead of yours");
    expect(lines[0]).toContain("party ack --drain");
  });

  test("单数：1 turn", () => {
    const { lines } = report([stale({ name: "codex1", unhandled_mention_count: 1, pending_mention_seqs: [1935] })], 1935);
    expect(lines[0]).toContain("yours is #1 in line ≈ 1 turn —");
  });

  test("没装 Stop hook（本机无线索）：保持 #664 的 warn 行不变", () => {
    const { lines } = report([stale({ name: "codex1", unhandled_mention_count: 9 })], 1935, lookup([]));
    expect(lines[0]).toContain("warn: codex1 has no live wake channel");
    expect(lines[0]).not.toContain("deferred");
  });

  test("装了但信任闸没过（#926）：wake blocked 压过 deferred", () => {
    const blocked = stale({
      name: "codex1",
      unhandled_mention_count: 9,
      wake_block: { reason: "codex_hook_disabled", ts: NOW, detail: "codex marked our Stop hook enabled=false", fix: "party wake check" },
    });
    const { lines } = report([blocked], 1935, lookup(["codex1"], "disabled"));
    expect(lines[0]).toContain("叫不醒");
    expect(lines[0]).not.toContain("deferred");
  });

  test("paused 压过 deferred：暂停接待就是不接，拉取通道再健康也没用", () => {
    const { lines } = report([stale({ name: "codex1", paused: true, unhandled_mention_count: 2 })], 1935);
    expect(lines[0]).toContain("is paused");
    expect(lines[0]).not.toContain("deferred");
  });

  test("deferredOf 只改判 no_wake / stale_adapter 两档", () => {
    const e = stale({ name: "codex1", wake: { kind: "serve" } as PresenceEntry["wake"], unhandled_mention_count: 2 });
    const u = unreachableOf("codex1", [e], NOW);
    expect(u?.reason).toBe("stale_adapter");
    const d = deferredOf(u!, [e], lookup(["codex1"]).hintFor("codex1"), CH, 7);
    expect(d).toEqual({ name: "codex1", channel: CH, queued: 2, position: null });
    expect(formatDeferred(d!)).toContain("2 unhandled @ queued ahead of yours ≈ 3 turns");
    expect(deferredOf({ ...u!, reason: "paused" }, [e], lookup(["codex1"]).hintFor("codex1"), CH, 7)).toBeNull();
  });
});
