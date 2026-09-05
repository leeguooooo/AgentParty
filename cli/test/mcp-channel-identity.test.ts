// #1083：单进程多频道下的身份解析。这条路上解错身份**不会报错**，只会以别人的身份发言——
// 所以用例重点全在「什么时候必须拒绝」，而不是「什么时候能解出来」。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listAgentConfigs,
  readChannelDefaults,
  recordChannelDefault,
  resolveChannelIdentity,
  type AgentIdentityConfig,
} from "../src/mcp-channel-identity";

function cfg(over: Partial<AgentIdentityConfig>): AgentIdentityConfig {
  return {
    path: "/p/a.json",
    server: "https://s1",
    channel: "dev",
    name: "a",
    verifiedAt: null,
    ...over,
  };
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "ap-mcp-ident-"));
}

function writeAgentConfig(h: string, file: string, body: unknown): string {
  mkdirSync(join(h, "agents"), { recursive: true });
  const p = join(h, "agents", file);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

describe("列出本机身份", () => {
  test("频道取自 identity.channel_scope，不靠文件名猜", () => {
    const h = home();
    // 文件名故意与频道不符：真相在 channel_scope 里。
    writeAgentConfig(h, "agentparty-bot-WRONGNAME.json", {
      server: "https://s1",
      token: "t",
      identity: { name: "bot", channel_scope: "real-channel", verified_at: 5 },
    });
    const got = listAgentConfigs(h);
    expect(got).toHaveLength(1);
    expect(got[0]!.channel).toBe("real-channel");
    expect(got[0]!.name).toBe("bot");
    rmSync(h, { recursive: true, force: true });
  });

  test("坏 JSON / 缺 token / 缺 channel_scope 一律跳过，不让一份坏 config 弄挂整台机器", () => {
    const h = home();
    mkdirSync(join(h, "agents"), { recursive: true });
    writeFileSync(join(h, "agents", "broken.json"), "{ not json");
    writeAgentConfig(h, "no-token.json", { server: "https://s1", identity: { name: "x", channel_scope: "dev" } });
    writeAgentConfig(h, "no-scope.json", { server: "https://s1", token: "t", identity: { name: "y" } });
    writeAgentConfig(h, "good.json", {
      server: "https://s1",
      token: "t",
      identity: { name: "z", channel_scope: "dev" },
    });
    expect(listAgentConfigs(h).map((c) => c.name)).toEqual(["z"]);
    rmSync(h, { recursive: true, force: true });
  });

  test("agents 目录不存在时返回空，不抛", () => {
    const h = home();
    expect(listAgentConfigs(h)).toEqual([]);
    rmSync(h, { recursive: true, force: true });
  });
});

describe("解析顺序：显式 > 登记的默认 > 唯一 > 失败关闭", () => {
  const only = cfg({ path: "/p/only.json", channel: "solo", name: "solo-bot" });
  const a = cfg({ path: "/p/a.json", channel: "dev", name: "alice", verifiedAt: 100 });
  const b = cfg({ path: "/p/b.json", channel: "dev", name: "bob", verifiedAt: 999 });

  test("频道只有一份身份 ⇒ 用它", () => {
    const r = resolveChannelIdentity({ channel: "solo", configs: [only, a, b], defaults: {} });
    expect(r.ok && r.via).toBe("only");
    expect(r.ok && r.config.name).toBe("solo-bot");
  });

  test("多份 + 没登记默认 ⇒ 失败关闭，把候选都列出来", () => {
    const r = resolveChannelIdentity({ channel: "dev", configs: [a, b], defaults: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates.map((c) => c.name).sort()).toEqual(["alice", "bob"]);
    expect(r.message).toContain("alice");
    expect(r.message).toContain("bob");
  });

  // 这条是本文件存在的理由：任何「挑最近验证的 / 挑第一个」的启发式，都等价于随机挑一个
  // 身份替用户说话，而且不会有任何报错。
  test("绝不按 verified_at 或顺序挑一个了事", () => {
    const r = resolveChannelIdentity({ channel: "dev", configs: [a, b], defaults: {} });
    expect(r.ok).toBe(false);
    const reversed = resolveChannelIdentity({ channel: "dev", configs: [b, a], defaults: {} });
    expect(reversed.ok).toBe(false);
  });

  test("登记了默认 ⇒ 用登记的那个（而不是最近验证的那个）", () => {
    const r = resolveChannelIdentity({
      channel: "dev",
      configs: [a, b],
      defaults: { [JSON.stringify(["https://s1", "dev"])]: "/p/a.json" },
    });
    expect(r.ok && r.via).toBe("default");
    expect(r.ok && r.config.name).toBe("alice"); // b 的 verified_at 更新，但登记的是 a
  });

  test("登记的默认指向一份已经不存在的 config ⇒ 退回歧义判定，不静默换人", () => {
    const r = resolveChannelIdentity({
      channel: "dev",
      configs: [a, b],
      defaults: { [JSON.stringify(["https://s1", "dev"])]: "/p/deleted.json" },
    });
    expect(r.ok).toBe(false);
  });

  test("显式指定身份 ⇒ 只认它", () => {
    const r = resolveChannelIdentity({ channel: "dev", identity: "bob", configs: [a, b], defaults: {} });
    expect(r.ok && r.via).toBe("explicit");
    expect(r.ok && r.config.name).toBe("bob");
  });

  test("显式指定了一个不存在的身份 ⇒ 报错，绝不退回登记的默认", () => {
    const r = resolveChannelIdentity({
      channel: "dev",
      identity: "carol",
      configs: [a, b],
      defaults: { [JSON.stringify(["https://s1", "dev"])]: "/p/a.json" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.message).toContain("carol");
  });

  test("本机没有这个频道的身份 ⇒ 报错并给出 party join 的原话", () => {
    const r = resolveChannelIdentity({ channel: "nope", configs: [a], defaults: {} });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("none");
    expect(r.message).toContain("party join");
    expect(r.message).toContain("nope");
  });

  // 一台机器可能同时连 prod 和自建实例，两边可以有同名频道——那是两个不同的地方。
  test("同名频道分属两个 server ⇒ 不给 server 时算歧义，给了就解得出", () => {
    const p = cfg({ path: "/p/p.json", server: "https://prod", channel: "shared", name: "prod-bot" });
    const x = cfg({ path: "/p/x.json", server: "https://xdream", channel: "shared", name: "x-bot" });
    expect(resolveChannelIdentity({ channel: "shared", configs: [p, x], defaults: {} }).ok).toBe(false);
    const r = resolveChannelIdentity({ channel: "shared", server: "https://xdream", configs: [p, x], defaults: {} });
    expect(r.ok && r.config.name).toBe("x-bot");
  });
});

describe("默认身份登记表", () => {
  test("写了能读回来，同频道再写是替换而不是叠加", () => {
    const h = home();
    recordChannelDefault("https://s1", "dev", "/p/a.json", h);
    expect(readChannelDefaults(h)).toEqual({ [JSON.stringify(["https://s1", "dev"])]: "/p/a.json" });
    recordChannelDefault("https://s1", "dev", "/p/b.json", h);
    recordChannelDefault("https://s1", "other", "/p/c.json", h);
    expect(readChannelDefaults(h)).toEqual({ [JSON.stringify(["https://s1", "dev"])]: "/p/b.json", [JSON.stringify(["https://s1", "other"])]: "/p/c.json" });
    rmSync(h, { recursive: true, force: true });
  });

  test("登记表坏了 ⇒ 当作没有登记（退回失败关闭），而不是让 MCP 起不来", () => {
    const h = home();
    mkdirSync(h, { recursive: true });
    writeFileSync(join(h, "mcp-channel-defaults.json"), "{ broken");
    expect(readChannelDefaults(h)).toEqual({});
    rmSync(h, { recursive: true, force: true });
  });
});
