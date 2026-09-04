import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { activeChannelSlugs, buildGlobalWho, personKeyOf, reachOf } from "../src/commands/who-global";

const NOW = 1_700_000_000_000;

function p(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    type: "presence",
    name,
    kind: "agent",
    state: "waiting",
    ts: NOW - 1_000,
    last_seen: NOW - 1_000,
    ...over,
  } as PresenceEntry;
}

describe("全局 who 的可达性分档（#1074）", () => {
  test("在线 > 可唤醒 > 最近 > 离线", () => {
    expect(reachOf(p("a", { state: "working", last_seen: NOW - 1_000 }), NOW)).toBe("online");
    expect(reachOf(p("a", { state: "working", live: true, last_seen: NOW - 86_400_000 }), NOW)).toBe("online");
    // state 是自报的工作状态，不是连通性：久未露面的 working 不能算在线（实机踩到过）
    expect(reachOf(p("a", { state: "working", last_seen: NOW - 49 * 86_400_000 }), NOW)).toBe("offline");
    expect(reachOf(p("a", { state: "offline", last_seen: NOW - 10_000 }), NOW)).toBe("recent");
    expect(reachOf(p("a", { state: "offline", last_seen: NOW - 3_600_000 }), NOW)).toBe("offline");
  });
});

describe("全局 who 的按人聚合（#1074）", () => {
  test("同一个人在多个频道只占一行，并列出全部频道", () => {
    const rows = buildGlobalWho({
      now: NOW,
      channels: [
        { slug: "alpha", presence: [p("leo-web", { kind: "human", handle: "leo", state: "offline", last_seen: NOW - 5_000 })] },
        { slug: "beta", presence: [p("leo-cli", { kind: "human", handle: "leo", live: true })] },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channels).toEqual(["alpha", "beta"]);
    // 代表取可达性最好的那条会话
    expect(rows[0]!.name).toBe("leo-cli");
    expect(rows[0]!.reach).toBe("online");
    expect(rows[0]!.aka).toEqual(["leo-web"]);
  });

  test("agent 各自成行，不因同一 owner 被并到一起", () => {
    const rows = buildGlobalWho({
      now: NOW,
      channels: [{
        slug: "alpha",
        presence: [p("bot-a", { account: "leo@x.com" }), p("bot-b", { account: "leo@x.com" })],
      }],
    });
    expect(rows.map((r) => r.name).sort()).toEqual(["bot-a", "bot-b"]);
  });

  test("只差大小写的账号是两个人；不透明账号不当归属展示", () => {
    expect(personKeyOf(p("a", { kind: "human", account: "Acct" }))).not.toBe(
      personKeyOf(p("b", { kind: "human", account: "acct" })),
    );
    const rows = buildGlobalWho({
      now: NOW,
      channels: [{ slug: "alpha", presence: [p("x", { kind: "human", account: "lark:on_deadbeef" })] }],
    });
    expect(rows[0]!.owner).toBeUndefined();
  });

  test("排除自己与 system；暂停会话必须标出", () => {
    const rows = buildGlobalWho({
      now: NOW,
      self: "me",
      channels: [{
        slug: "alpha",
        presence: [p("me"), p("system"), p("paused-bot", { paused: true })],
      }],
    });
    expect(rows.map((r) => r.name)).toEqual(["paused-bot"]);
    expect(rows[0]!.paused).toBe(true);
  });

  test("排序：先按可达性，同档 agent 在前", () => {
    const rows = buildGlobalWho({
      now: NOW,
      channels: [{
        slug: "alpha",
        presence: [
          p("offline-bot", { state: "offline", last_seen: NOW - 86_400_000 }),
          p("human-live", { kind: "human", live: true, handle: "h1" }),
          p("agent-live", { live: true }),
        ],
      }],
    });
    expect(rows.map((r) => r.name)).toEqual(["agent-live", "human-live", "offline-bot"]);
  });

  test("归档频道不计入「我能到达谁」", () => {
    const slugs = activeChannelSlugs([
      { slug: "live", title: null, archived_at: null } as never,
      { slug: "dead", title: null, archived_at: NOW - 1 } as never,
    ]);
    expect(slugs).toEqual(["live"]);
  });
});
