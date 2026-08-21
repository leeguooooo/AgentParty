// #907：同 (server, channel, owner) 的身份判重。
//
// 本文件钉住的故障形态：**同 server + 同频道 + 同 owner、不同身份名**时检查必须命中。
// 旧行为只按注册名判重，换个名字必然放行——那正是同频道静默并存 14 个身份的成因。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findExistingIdentities,
  groupIdentities,
  identityRecordFromConfigJson,
  identityScopeKey,
  normalizeServerKey,
  readIdentityRecords,
  sameChannelIdentityWarningLines,
  type IdentityRecord,
} from "../src/identity-dedupe";
import { runMcpIdentities, registrationsForIdentity } from "../src/commands/mcp-identities";
import type { McpRegistration } from "../src/mcp-registry";
import type { RemoveFn } from "../src/commands/mcp-prune";

const SERVER = "https://agentparty.pwtk-dev.work";
const OTHER_SERVER = "https://agentparty.leeguoo.com";

function rec(over: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    path: `/agents/agentparty-${over.name ?? "a"}-agentparty.json`,
    server: SERVER,
    name: "a",
    owner: "leo",
    channelScope: "agentparty",
    ...over,
  };
}

function writeAgent(dir: string, file: string, body: unknown): string {
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify(body));
  return path;
}

function agentConfig(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: SERVER,
    token: "ap_secret",
    identity: { name, channel_scope: "agentparty", owner: "leo" },
    ...over,
  };
}

describe("判重三元组（#907）", () => {
  test("同 server + 同频道 + 同 owner、【不同身份名】必须命中——这条钉住本次故障形态", () => {
    const records = [
      rec({ name: "lark-ad72b3f9749e-agentparty" }),
      rec({ name: "claude-test" }),
    ];
    // 新身份 claude-test 接入时排除自己，仍然必须看见旧身份。
    const hit = findExistingIdentities(records, {
      server: SERVER,
      channel: "agentparty",
      owner: "leo",
      excludeName: "claude-test",
    });
    expect(hit.map((r) => r.name)).toEqual(["lark-ad72b3f9749e-agentparty"]);
  });

  test("只按名字判重的旧行为在这条上会漏：两个身份名不同，名字比较永远相等不了", () => {
    const records = [rec({ name: "old-name" }), rec({ name: "new-name" })];
    const byName = records.filter((r) => r.name === "new-name" && r.path !== records[1]?.path);
    expect(byName).toHaveLength(0); // 旧判据：放行
    expect(
      findExistingIdentities(records, { server: SERVER, channel: "agentparty", excludeName: "new-name" }),
    ).toHaveLength(1); // 新判据：命中
  });

  test("server 必须参与比较：两台实例都有 #agentparty（#865），绝不能只按频道名判重", () => {
    const records = [rec({ name: "here" }), rec({ name: "there", server: OTHER_SERVER })];
    const hit = findExistingIdentities(records, { server: SERVER, channel: "agentparty", excludeName: "here" });
    expect(hit).toHaveLength(0);
    expect(identityScopeKey({ server: SERVER, channel: "agentparty", owner: "leo" })).not.toBe(
      identityScopeKey({ server: OTHER_SERVER, channel: "agentparty", owner: "leo" }),
    );
  });

  test("server 末尾斜杠不影响判定", () => {
    expect(normalizeServerKey(`${SERVER}/`)).toBe(SERVER);
    const hit = findExistingIdentities([rec({ name: "x", server: `${SERVER}/` })], {
      server: SERVER,
      channel: "agentparty",
    });
    expect(hit).toHaveLength(1);
  });

  test("owner 不同则不算一组；owner 未知（null 传参）时不收窄——宁可多报", () => {
    const records = [rec({ name: "mine", owner: "leo" }), rec({ name: "theirs", owner: "someone-else" })];
    expect(
      findExistingIdentities(records, { server: SERVER, channel: "agentparty", owner: "leo" }).map((r) => r.name),
    ).toEqual(["mine"]);
    expect(
      findExistingIdentities(records, { server: SERVER, channel: "agentparty" }).map((r) => r.name),
    ).toEqual(["mine", "theirs"]);
  });

  test("别的频道不算", () => {
    const records = [rec({ name: "a", channelScope: "kyc" })];
    expect(findExistingIdentities(records, { server: SERVER, channel: "agentparty" })).toHaveLength(0);
  });
});

describe("配置解析：宁可少认，绝不因为一份坏文件炸掉", () => {
  test("形状不对一律 null", () => {
    expect(identityRecordFromConfigJson("/p", null)).toBeNull();
    expect(identityRecordFromConfigJson("/p", [])).toBeNull();
    expect(identityRecordFromConfigJson("/p", { server: SERVER })).toBeNull();
    expect(identityRecordFromConfigJson("/p", { server: SERVER, identity: {} })).toBeNull();
    expect(identityRecordFromConfigJson("/p", { server: SERVER, identity: { name: "a" } })).toBeNull();
    expect(identityRecordFromConfigJson("/p", { identity: { name: "a", channel_scope: "c" } })).toBeNull();
  });

  test("解析结果里没有 token", () => {
    const r = identityRecordFromConfigJson("/p", agentConfig("a"));
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain("ap_secret");
  });

  test("目录里混着坏 JSON 时，其余身份照样读得出来", () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-dedupe-"));
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeAgent(dir, "a.json", agentConfig("a"));
    writeAgent(dir, "b.json", agentConfig("b"));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    expect(readIdentityRecords(dir).map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("目录不存在返回空数组（不抛）", () => {
    expect(readIdentityRecords("/definitely/not/here")).toEqual([]);
  });
});

describe("重复组盘点", () => {
  test("按三元组分组，只返回 >1 的组；跨 server 的同名频道分成两组", () => {
    const records = [
      rec({ name: "a" }),
      rec({ name: "b" }),
      rec({ name: "solo", channelScope: "kyc" }),
      rec({ name: "c", server: OTHER_SERVER }),
      rec({ name: "d", server: OTHER_SERVER }),
    ];
    const groups = groupIdentities(records);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.records.length === 2)).toBe(true);
    expect(groups.map((g) => g.scope.server).sort()).toEqual([OTHER_SERVER, SERVER].sort());
    // solo 组（1 个身份）不在重复组里
    expect(groups.flatMap((g) => g.records.map((r) => r.name))).not.toContain("solo");
  });

  test("minSize=1 时列出全部组（--all）", () => {
    expect(groupIdentities([rec({ name: "solo" })], 1)).toHaveLength(1);
  });
});

describe("party init 的提示文案（只提示，不阻断、不删除）", () => {
  test("命中时给出既有身份 + 替换/并存两条路，且带 --keep 的 dry-run 指引", () => {
    const lines = sameChannelIdentityWarningLines([rec({ name: "old" })], {
      server: SERVER,
      channel: "agentparty",
      selfPath: "/agents/agentparty-new-agentparty.json",
    });
    expect(lines.join("\n")).toContain("old");
    expect(lines.join("\n")).toContain("party mcp identities --keep");
    expect(lines.join("\n")).toContain(SERVER);
  });

  test("排除自己：同一份配置重跑 init 不会自己报自己", () => {
    const self = rec({ name: "me" });
    expect(
      sameChannelIdentityWarningLines([self], { server: SERVER, channel: "agentparty", selfPath: self.path }),
    ).toEqual([]);
  });
});

// ── 命令层：检查模式 / 盘点 / 收敛 ────────────────────────────────────────────

describe("party mcp identities", () => {
  test("检查模式：同频道已有别的身份 → 退出码 3 并列出来", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-agents-"));
    writeAgent(dir, "old.json", agentConfig("lark-ad72b3f9749e-agentparty"));
    const out: string[] = [];
    const code = await runMcpIdentities({
      agentsDir: dir,
      server: SERVER,
      channel: "agentparty",
      exclude: "claude-test",
      log: (l) => out.push(l),
    });
    expect(code).toBe(3);
    expect(out.join("\n")).toContain("lark-ad72b3f9749e-agentparty");
    expect(out.join("\n")).toContain("replace");
    expect(out.join("\n")).toContain("coexist");
  });

  test("检查模式：没有既有身份 → 退出码 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-agents-"));
    const out: string[] = [];
    const code = await runMcpIdentities({
      agentsDir: dir,
      server: SERVER,
      channel: "agentparty",
      log: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("no identity is bound");
  });

  test("检查模式：另一台 server 的同名频道不算命中（#865）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-agents-"));
    writeAgent(dir, "other.json", agentConfig("elsewhere", { server: OTHER_SERVER }));
    const code = await runMcpIdentities({
      agentsDir: dir,
      server: SERVER,
      channel: "agentparty",
      log: () => {},
    });
    expect(code).toBe(0);
  });

  test("盘点模式：列出重复组", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-agents-"));
    writeAgent(dir, "a.json", agentConfig("a"));
    writeAgent(dir, "b.json", agentConfig("b"));
    writeAgent(dir, "solo.json", agentConfig("solo", { identity: { name: "solo", channel_scope: "kyc", owner: "leo" } }));
    const out: string[] = [];
    const code = await runMcpIdentities({ agentsDir: dir, log: (l) => out.push(l), json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as { agents_scanned: number; groups: { identities: { name: string }[] }[] };
    expect(parsed.agents_scanned).toBe(3);
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0]?.identities.map((i) => i.name)).toEqual(["a", "b"]);
  });
});

describe("收敛：默认 dry-run，且绝不删身份配置、绝不碰非 party 注册", () => {
  function setup(): { agentsDir: string; home: string; paths: Record<string, string> } {
    const agentsDir = mkdtempSync(join(tmpdir(), "ap-agents-"));
    const keepPath = writeAgent(agentsDir, "keep.json", agentConfig("claude-test"));
    const dropPath = writeAgent(agentsDir, "drop.json", agentConfig("lark-old"));
    const home = mkdtempSync(join(tmpdir(), "ap-home-"));
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "party-claude-test": { command: "party", args: ["mcp", "--channel", "agentparty"], env: { AGENTPARTY_CONFIG: keepPath } },
          "party-lark-old": { command: "party", args: ["mcp", "--channel", "agentparty"], env: { AGENTPARTY_CONFIG: dropPath } },
          // 别人的 MCP server，且刻意指向要被丢弃的那份 config——命令本体不是 party，必须不碰。
          "discord": { command: "discord-use", args: ["mcp"], env: { AGENTPARTY_CONFIG: dropPath } },
        },
      }),
    );
    return { agentsDir, home, paths: { keepPath, dropPath } };
  }

  test("dry-run：列出要丢的注册，但 remove 一次都没被调用", async () => {
    const { agentsDir, home } = setup();
    const calls: string[] = [];
    const remove: RemoveFn = (r) => {
      calls.push(r.name);
      return { ok: true, detail: "" };
    };
    const out: string[] = [];
    const code = await runMcpIdentities({
      agentsDir,
      home,
      server: SERVER,
      channel: "agentparty",
      keep: "claude-test",
      remove,
      log: (l) => out.push(l),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(out.join("\n")).toContain("party-lark-old");
    expect(out.join("\n")).toContain("dry run");
  });

  test("--yes：只删同组其余身份的 party 注册；保留的那条和别人的 server 一条都没碰", async () => {
    const { agentsDir, home } = setup();
    const calls: string[] = [];
    const remove: RemoveFn = (r) => {
      calls.push(r.name);
      return { ok: true, detail: "" };
    };
    const code = await runMcpIdentities({
      agentsDir,
      home,
      server: SERVER,
      channel: "agentparty",
      keep: "claude-test",
      yes: true,
      remove,
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["party-lark-old"]);
    expect(calls).not.toContain("discord");
    expect(calls).not.toContain("party-claude-test");
  });

  test("--yes 之后身份配置文件仍然在（凭据不可被本命令删除）", async () => {
    const { agentsDir, home, paths } = setup();
    await runMcpIdentities({
      agentsDir,
      home,
      server: SERVER,
      channel: "agentparty",
      keep: "claude-test",
      yes: true,
      remove: () => ({ ok: true, detail: "" }),
      log: () => {},
    });
    expect(readIdentityRecords(agentsDir).map((r) => r.name).sort()).toEqual(["claude-test", "lark-old"]);
    expect(paths.dropPath).toContain("drop.json");
  });

  test("--keep 指向一个不在该频道的身份 → 拒绝动任何东西", async () => {
    const { agentsDir, home } = setup();
    const calls: string[] = [];
    const code = await runMcpIdentities({
      agentsDir,
      home,
      server: SERVER,
      channel: "agentparty",
      keep: "does-not-exist",
      yes: true,
      remove: (r) => {
        calls.push(r.name);
        return { ok: true, detail: "" };
      },
      log: () => {},
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  test("注册与身份的对应只认 AGENTPARTY_CONFIG 路径，且非 party 注册永不匹配", () => {
    const target = rec({ name: "x", path: "/agents/x.json" });
    const regs: McpRegistration[] = [
      { scope: "user", name: "party-x", command: "party", args: ["mcp"], env: { AGENTPARTY_CONFIG: "/agents/x.json" } },
      { scope: "user", name: "other", command: "discord-use", args: ["mcp"], env: { AGENTPARTY_CONFIG: "/agents/x.json" } },
      { scope: "user", name: "party-y", command: "party", args: ["mcp"], env: { AGENTPARTY_CONFIG: "/agents/y.json" } },
    ];
    expect(registrationsForIdentity(regs, target).map((r) => r.name)).toEqual(["party-x"]);
  });
});
