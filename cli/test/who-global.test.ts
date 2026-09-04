import { describe, expect, test } from "bun:test";
import type { PresenceEntry } from "@agentparty/shared";
import { activeChannelSlugs, buildGlobalWho, personKeyOf, reachOf, renderGlobalRow } from "../src/commands/who-global";

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
    // name 是可 @ 的 handle（不是会话名）；两条会话名都进 aka
    expect(rows[0]!.name).toBe("leo");
    expect(rows[0]!.reach).toBe("online");
    expect(rows[0]!.aka).toEqual(["leo-cli", "leo-web"]);
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
    // 人类那行的 name 取 handle（h1），不是会话名
    expect(rows.map((r) => r.name)).toEqual(["agent-live", "h1", "offline-bot"]);
  });

  test("人类行的 name 必须是可 @ 的 handle，而不是 UUID / lark:on_ 会话名", () => {
    const rows = buildGlobalWho({
      now: NOW,
      channels: [{
        slug: "alpha",
        presence: [p("lark:on_deadbeefdeadbeef", { kind: "human", handle: "leo", display_name: "Leo", live: true })],
      }],
    });
    expect(rows[0]!.name).toBe("leo");
    expect(rows[0]!.mentionable).toBeUndefined();
    expect(rows[0]!.aka).toEqual(["lark:on_deadbeefdeadbeef"]);
  });

  test("人类没有 handle 时如实标 mentionable:false，不谎称能 @", () => {
    const rows = buildGlobalWho({
      now: NOW,
      channels: [{ slug: "alpha", presence: [p("193af9b8-cb06-4efe-a0f5-f1284bb8303e", { kind: "human", live: true })] }],
    });
    expect(rows[0]!.mentionable).toBe(false);
    expect(rows[0]!.name).toBe("193af9b8-cb06-4efe-a0f5-f1284bb8303e");
  });

  test("handle 只出现在该人的某一条会话上时也要取到", () => {
    const rows = buildGlobalWho({
      now: NOW,
      channels: [
        { slug: "alpha", presence: [p("sess-1", { kind: "human", account: "leo@x.com", live: true })] },
        { slug: "beta", presence: [p("sess-2", { kind: "human", account: "leo@x.com", handle: "leo", state: "offline", last_seen: NOW - 5_000 })] },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("leo");
    expect(rows[0]!.mentionable).toBeUndefined();
  });

  test("agent 的 name 本身就是地址，恒可 @", () => {
    const rows = buildGlobalWho({ now: NOW, channels: [{ slug: "alpha", presence: [p("bot")] }] });
    expect(rows[0]!.name).toBe("bot");
    expect(rows[0]!.mentionable).toBeUndefined();
  });

  test("归档频道不计入「我能到达谁」", () => {
    const slugs = activeChannelSlugs([
      { slug: "live", title: null, archived_at: null } as never,
      { slug: "dead", title: null, archived_at: NOW - 1 } as never,
    ]);
    expect(slugs).toEqual(["live"]);
  });
});

describe("全局 who 的终端渲染（#1074）", () => {
  const sanitize = (v: string) => v.replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ").replace(/\s+/g, " ").trim();

  test("服务端可控字段必须过控制序列清洗（#629 同类注入）", () => {
    const row = {
      name: "evil",
      kind: "agent" as const,
      reach: "online" as const,
      owner: "own\u001b[31mer",
      channels: ["ch\u0007an"],
      last_seen: NOW - 1_000,
    };
    const line = renderGlobalRow(row, "dis\u001b[2Jplay", NOW, sanitize);
    // 清洗只剥不可见控制字符（ESC/BEL），可见残留如 "[2J" 保留原样——与 terminalIdentityText 同语义
    expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    expect(line).toContain("dis [2Jplay");
    expect(line).toContain("own [31mer");
    expect(line).toContain("#ch an");
  });

  test("折叠掉的会话名要在终端里露出来，不能只藏进 JSON", () => {
    const row = {
      name: "leo",
      kind: "human" as const,
      reach: "online" as const,
      channels: ["alpha"],
      aka: ["sess-1", "sess-2", "sess-3"],
      last_seen: NOW - 1_000,
    };
    const line = renderGlobalRow(row, "Leo", NOW, sanitize);
    expect(line).toContain("aka sess-1, sess-2 +1");
  });
});

// #1074 的入口可达性：绑定频道的目录里 `party who` 仍是频道视图（向后兼容），
// 全局视图靠 --all 显式进入；绑定频道已不存在（404）时自动退回全局并说明原因。
// 这两条在 who.ts 的命令层，属于源码守卫：只断言分支存在，不起真网络。
import { readFileSync } from "node:fs";
const whoSource = readFileSync(new URL("../src/commands/who.ts", import.meta.url), "utf8");

describe("全局 who 的入口（#1074 补）", () => {
  test("--all 是显式入口，且与频道参数互斥", () => {
    expect(whoSource).toContain('"all"');
    expect(whoSource).toContain("flags.all === true ? null : resolveChannel");
    expect(whoSource).toContain("--all lists everyone across your channels; drop the channel argument");
  });

  test("绑定频道 404 时退回全局视图，而不是死在「找不到频道」", () => {
    expect(whoSource).toContain("err instanceof RestError && err.status === 404");
    expect(whoSource).toContain("showing everyone across your channels instead");
  });

  test("帮助文本里写明 --all", () => {
    expect(whoSource).toContain("[--all]");
  });
});
