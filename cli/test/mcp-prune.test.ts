// #898 方案 C 第 2、3 件：party mcp prune 的判据/保守策略 + MCP 进程可辨认。
//
// 这些测试的核心不是「能删」，而是「不该删的一条都没碰」——本机同时装着 discord-use /
// iphone-use-mcp 等别人的 MCP server，误删是灾难。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMcpProcessTitle,
  classifyPartyRegistration,
  identityLabelFromConfigPath,
  isPartyMcpRegistration,
  parseClaudeMcpRegistrations,
  parseMcpServerArgv,
  probeFromConfigJson,
  registrationChannel,
  type McpRegistration,
} from "../src/mcp-registry";
import { planMcpPrune, runMcpPrune, type RemoveFn } from "../src/commands/mcp-prune";

function reg(over: Partial<McpRegistration> = {}): McpRegistration {
  return {
    scope: "user",
    name: "party-bot",
    command: "party",
    args: ["mcp", "--channel", "dev"],
    env: { AGENTPARTY_CONFIG: "/nope/agentparty-bot-dev.json" },
    ...over,
  };
}

describe("party 注册的识别（只认命令本体，#898）", () => {
  test("认得出 party mcp：裸命令、绝对路径、插件 runtime、Windows 后缀", () => {
    expect(isPartyMcpRegistration(reg())).toBe(true);
    expect(isPartyMcpRegistration(reg({ command: "/Users/leo/.local/bin/party" }))).toBe(true);
    expect(isPartyMcpRegistration(reg({ command: "/x/agentparty-runtime" }))).toBe(true);
    expect(isPartyMcpRegistration(reg({ command: "C:\\bin\\party.exe" }))).toBe(false); // 反斜杠路径在 posix basename 下不拆，等价于整体不认＝保守
    expect(isPartyMcpRegistration(reg({ command: "party.exe" }))).toBe(true);
    // 没有 --channel 的裸 `party mcp` 也是我们的（owner 机器上有 18 个这种）
    expect(isPartyMcpRegistration(reg({ args: ["mcp"] }))).toBe(true);
  });

  test("绝不把别人的 server 认成 party：discord-use / iphone-use / 名字像 party 的第三方", () => {
    const others: McpRegistration[] = [
      reg({ name: "discord", command: "/Users/leo/.local/bin/discord-use", args: ["mcp"], env: {} }),
      reg({ name: "iphone-use", command: "iphone-use-mcp", args: ["mcp"], env: {} }),
      // 名字叫 party-*、甚至带 AGENTPARTY_CONFIG，但命令不是 party 二进制 → 不认
      reg({ name: "party-fake", command: "npx", args: ["party", "mcp"] }),
      reg({ name: "party-sh", command: "sh", args: ["-c", "party mcp --channel dev"] }),
      // 是 party 二进制但不是 mcp 子命令（serve / claude-channel 等）→ 不认
      reg({ name: "party-serve", command: "party", args: ["serve", "--channel", "dev"] }),
      reg({ name: "ann", command: "party", args: ["claude-channel", "--require-launch-opt-in"], env: {} }),
      reg({ name: "third-party-thing", command: "third-party", args: ["mcp"] }),
      reg({ name: "empty", command: "", args: ["mcp"] }),
    ];
    for (const r of others) expect(isPartyMcpRegistration(r)).toBe(false);
  });

  test("非 party 注册即使被硬塞进判定也只会拿到 keep（双保险）", () => {
    const v = classifyPartyRegistration({
      reg: reg({ name: "discord", command: "discord-use", args: ["mcp"], env: {} }),
      config: { kind: "missing", path: "/gone.json" },
      scopeExists: true,
    });
    expect(v.action).toBe("keep");
  });

  test("解析 ~/.claude.json 的 user scope 与每个项目的 local scope", () => {
    const rows = parseClaudeMcpRegistrations({
      mcpServers: { a: { command: "party", args: ["mcp"] } },
      projects: {
        "/p1": { mcpServers: { b: { command: "party", args: ["mcp", "--channel", "x"], env: { K: "v" } } } },
        "/p2": { mcpServers: {} },
        "/p3": null,
      },
    });
    expect(rows.map((r) => `${r.scope}:${r.name}`)).toEqual(["user:a", "/p1:b"]);
    expect(rows[1]?.env).toEqual({ K: "v" });
    expect(registrationChannel(rows[1] as McpRegistration)).toBe("x");
    expect(registrationChannel(rows[0] as McpRegistration)).toBe(null);
  });

  test("畸形输入不炸也不臆造条目", () => {
    expect(parseClaudeMcpRegistrations(null)).toEqual([]);
    expect(parseClaudeMcpRegistrations("nope")).toEqual([]);
    expect(parseClaudeMcpRegistrations({ mcpServers: [1, 2] })).toEqual([]);
    expect(parseClaudeMcpRegistrations({ mcpServers: { a: 5 } })).toEqual([]);
  });
});

describe("失效判据：只把确证失效的判成 stale（#898）", () => {
  test("config 文件不存在 → stale", () => {
    const v = classifyPartyRegistration({ reg: reg(), config: { kind: "missing", path: "/gone.json" }, scopeExists: true });
    expect(v.action).toBe("stale");
  });

  test("config 在但没有 token → stale（永远认证不了）", () => {
    const v = classifyPartyRegistration({ reg: reg(), config: { kind: "no-token", path: "/c.json" }, scopeExists: true });
    expect(v.action).toBe("stale");
  });

  test("config 读不动（可能是写到一半）→ review，不删", () => {
    const v = classifyPartyRegistration({ reg: reg(), config: { kind: "unparseable", path: "/c.json" }, scopeExists: true });
    expect(v.action).toBe("review");
  });

  test("没有 AGENTPARTY_CONFIG → review，不删（真机常态：字段缺席）", () => {
    const v = classifyPartyRegistration({
      reg: reg({ args: ["mcp"], env: {} }),
      config: { kind: "no-config-env" },
      scopeExists: true,
    });
    expect(v.action).toBe("review");
  });

  test("项目目录已不在 → review，不删（无法在原 scope 里安全执行删除）", () => {
    const v = classifyPartyRegistration({
      reg: reg({ scope: "/gone/project" }),
      config: { kind: "missing", path: "/gone.json" },
      scopeExists: false,
    });
    expect(v.action).toBe("review");
    expect(v.reason).toContain("/gone/project");
  });

  test("token 被服务器拒绝 → stale；服务器连不上 → 一律保留", () => {
    const ok = { kind: "ok", path: "/c.json", channelScope: "dev", server: "https://s" } as const;
    expect(classifyPartyRegistration({ reg: reg(), config: ok, scopeExists: true, remote: "revoked" }).action).toBe("stale");
    expect(classifyPartyRegistration({ reg: reg(), config: ok, scopeExists: true, remote: "unreachable" }).action).toBe("keep");
    expect(classifyPartyRegistration({ reg: reg(), config: ok, scopeExists: true, remote: "ok" }).action).toBe("keep");
  });

  test("--channel 与身份的 channel_scope 对不上 → review（可疑但不是死的）", () => {
    const v = classifyPartyRegistration({
      reg: reg(),
      config: { kind: "ok", path: "/c.json", channelScope: "other", server: "https://s" },
      scopeExists: true,
    });
    expect(v.action).toBe("review");
    expect(v.reason).toContain("other");
  });

  test("channel_scope 缺席（真机常见的全局身份）不该被误判", () => {
    const v = classifyPartyRegistration({
      reg: reg(),
      config: { kind: "ok", path: "/c.json", channelScope: null, server: "https://s" },
      scopeExists: true,
    });
    expect(v.action).toBe("keep");
  });

  test("probeFromConfigJson 认得出真机三种形态：有 token / 空 token / 非对象", () => {
    expect(probeFromConfigJson("/c", { token: "t", server: "https://s", identity: { channel_scope: "dev" } })).toEqual({
      kind: "ok",
      path: "/c",
      channelScope: "dev",
      server: "https://s",
    });
    expect(probeFromConfigJson("/c", { token: "  ", server: "https://s" }).kind).toBe("no-token");
    expect(probeFromConfigJson("/c", { server: "https://s" }).kind).toBe("no-token");
    expect(probeFromConfigJson("/c", [1]).kind).toBe("unparseable");
    // identity 整段缺席（旧配置）也不能炸
    expect(probeFromConfigJson("/c", { token: "t", server: "https://s" })).toEqual({
      kind: "ok",
      path: "/c",
      channelScope: null,
      server: "https://s",
    });
  });
});

// 端到端：造一个临时 HOME，里面混着 party 的死/活注册和别人的 server。
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ap-prune-"));
  const agents = join(home, ".agentparty", "agents");
  mkdirSync(agents, { recursive: true });
  const alive = join(agents, "agentparty-alive-dev.json");
  writeFileSync(alive, JSON.stringify({ server: "https://s", token: "t", identity: { channel_scope: "dev" } }));
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        "party-dead": {
          command: "party",
          args: ["mcp", "--channel", "dev"],
          env: { AGENTPARTY_CONFIG: join(agents, "agentparty-dead-dev.json") },
        },
        "party-alive": {
          command: "party",
          args: ["mcp", "--channel", "dev"],
          env: { AGENTPARTY_CONFIG: alive },
        },
        discord: { command: "/x/discord-use", args: ["mcp"] },
        "iphone-use": { command: "iphone-use-mcp", args: [] },
      },
      projects: {
        [proj]: {
          mcpServers: {
            "party-proj-dead": {
              command: "party",
              args: ["mcp", "--channel", "p"],
              env: { AGENTPARTY_CONFIG: join(agents, "agentparty-nope-p.json") },
            },
          },
        },
        "/definitely/gone": {
          mcpServers: {
            "party-orphan": {
              command: "party",
              args: ["mcp"],
              env: { AGENTPARTY_CONFIG: join(agents, "agentparty-nope-2.json") },
            },
          },
        },
      },
    }),
  );
  return home;
}

describe("party mcp prune 端到端（临时 HOME）", () => {
  test("只把确证死掉的列成 dead，活着的和别人的都不在里面", async () => {
    const plan = await planMcpPrune({ home: makeHome() });
    expect(plan.totalRegistrations).toBe(6);
    expect(plan.untouched.sort()).toEqual(["discord", "iphone-use"]);
    const dead = plan.partyEntries.filter((e) => e.verdict.action === "stale").map((e) => e.reg.name).sort();
    expect(dead).toEqual(["party-dead", "party-proj-dead"]);
    const review = plan.partyEntries.filter((e) => e.verdict.action === "review").map((e) => e.reg.name);
    expect(review).toEqual(["party-orphan"]); // 项目目录没了 → 只列不删
    const keep = plan.partyEntries.filter((e) => e.verdict.action === "keep").map((e) => e.reg.name);
    expect(keep).toEqual(["party-alive"]);
  });

  test("dry-run（默认）一次都不调用删除", async () => {
    const calls: string[] = [];
    const remove: RemoveFn = (r) => {
      calls.push(r.name);
      return { ok: true, detail: "" };
    };
    const lines: string[] = [];
    const code = await runMcpPrune({ home: makeHome(), remove, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("dry run: nothing was removed");
    expect(text).toContain("party-dead");
  });

  test("--yes 只删 dead，绝不碰非 party 注册，也不碰 review/keep", async () => {
    const calls: string[] = [];
    const remove: RemoveFn = (r) => {
      calls.push(r.name);
      return { ok: true, detail: "" };
    };
    const code = await runMcpPrune({ home: makeHome(), yes: true, remove, log: () => {} });
    expect(code).toBe(0);
    expect(calls.sort()).toEqual(["party-dead", "party-proj-dead"]);
    // 硬约束：别人的 server 一次都没被送进删除路径。
    for (const other of ["discord", "iphone-use"]) expect(calls).not.toContain(other);
    expect(calls).not.toContain("party-alive");
    expect(calls).not.toContain("party-orphan");
  });

  test("删除失败要报出来并以非 0 退出，不能假装成功", async () => {
    const remove: RemoveFn = () => ({ ok: false, detail: "boom" });
    const lines: string[] = [];
    const code = await runMcpPrune({ home: makeHome(), yes: true, remove, log: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("boom");
  });

  test("--json 报告带上「没碰的别人家 server」清单", async () => {
    const lines: string[] = [];
    await runMcpPrune({ home: makeHome(), json: true, log: (l) => lines.push(l) });
    const out = JSON.parse(lines.join("\n")) as {
      dry_run: boolean;
      untouched_non_party: string[];
      stale: { name: string }[];
    };
    expect(out.dry_run).toBe(true);
    expect(out.untouched_non_party.sort()).toEqual(["discord", "iphone-use"]);
    expect(out.stale.map((s) => s.name).sort()).toEqual(["party-dead", "party-proj-dead"]);
  });

  test("HOME 里根本没有 .claude.json 时安静地返回空计划", async () => {
    const home = mkdtempSync(join(tmpdir(), "ap-prune-empty-"));
    const plan = await planMcpPrune({ home });
    expect(plan.totalRegistrations).toBe(0);
    expect(plan.partyEntries).toEqual([]);
  });
});

describe("MCP 进程可辨认（#898 第 3 件）", () => {
  test("标题带频道与身份，形状恒定", () => {
    expect(buildMcpProcessTitle({ channel: "dev", configPath: "/h/.agentparty/agents/agentparty-bot-dev.json" })).toBe(
      "party mcp #dev [bot-dev]",
    );
    expect(buildMcpProcessTitle({ channel: "dev", agentName: "bot" })).toBe("party mcp #dev [bot]");
  });

  test("频道/身份缺席（真机常态：裸 `party mcp`）退化成占位符而不是消失", () => {
    expect(buildMcpProcessTitle({})).toBe("party mcp #* [?]");
    expect(buildMcpProcessTitle({ channel: null, configPath: null })).toBe("party mcp #* [?]");
    expect(buildMcpProcessTitle({ configPath: "/h/agentparty-x-y.json" })).toBe("party mcp #* [x-y]");
  });

  test("managed lane 用自己的 mode 段，能和普通工具面区分开", () => {
    expect(buildMcpProcessTitle({ mode: "mcp --managed", configPath: "/h/agentparty-a-b.json" })).toBe(
      "party mcp --managed #* [a-b]",
    );
  });

  test("标题里绝不出现 token 或完整路径（同机任意用户 ps 可见）", () => {
    const title = buildMcpProcessTitle({
      channel: "dev",
      configPath: "/Users/leo/.agentparty/agents/agentparty-bot-dev.json",
    });
    expect(title).not.toContain("/Users/leo");
    expect(title).not.toContain(".agentparty");
  });

  test("identityLabelFromConfigPath 剥掉前缀与扩展名，空值老实返回 null", () => {
    expect(identityLabelFromConfigPath("/a/agentparty-bot-dev.json")).toBe("bot-dev");
    expect(identityLabelFromConfigPath("/a/config.json")).toBe("config");
    expect(identityLabelFromConfigPath("")).toBe(null);
    expect(identityLabelFromConfigPath(null)).toBe(null);
    expect(identityLabelFromConfigPath(undefined)).toBe(null);
  });
});

// #898 第 3 件的真正载体：argv 里的 --identity。实测 Bun 在 macOS 上不把 process.title
// 写回 OS 的 argv 区（`ps -axww` 看到的仍是原始命令行），所以「这个进程是谁的」必须由
// 注册命令自己带进 argv。这些用例守住解析与拒绝。
describe("party mcp 的 argv 解析（--identity，#898）", () => {
  test("同时接受 --channel 与 --identity，顺序无关", () => {
    expect(parseMcpServerArgv(["--channel", "dev", "--identity", "party-bot"])).toEqual({
      channel: "dev",
      identity: "party-bot",
      error: null,
    });
    expect(parseMcpServerArgv(["--identity", "party-bot", "--channel", "dev"])).toEqual({
      channel: "dev",
      identity: "party-bot",
      error: null,
    });
  });

  test("两者都缺席（真机常态：裸 `party mcp`）仍然合法", () => {
    expect(parseMcpServerArgv([])).toEqual({ channel: null, identity: null, error: null });
  });

  test("只给其中一个也合法（旧注册只有 --channel，绝不能被新解析器拒掉）", () => {
    expect(parseMcpServerArgv(["--channel", "dev"])).toEqual({ channel: "dev", identity: null, error: null });
    expect(parseMcpServerArgv(["--identity", "party-bot"])).toEqual({
      channel: null,
      identity: "party-bot",
      error: null,
    });
  });

  test("非法值一律报错而不是硬吞：坏 slug / 坏标签 / 缺值 / 未知参数", () => {
    expect(parseMcpServerArgv(["--channel", "Dev"]).error).toContain("channel must match");
    expect(parseMcpServerArgv(["--identity", "bad label"]).error).toContain("identity label must match");
    expect(parseMcpServerArgv(["--identity"]).error).toContain("needs a value");
    expect(parseMcpServerArgv(["--channel", "--identity"]).error).toContain("needs a value");
    expect(parseMcpServerArgv(["--nope"]).error).toContain("usage: party mcp");
    expect(parseMcpServerArgv(["dev"]).error).toContain("usage: party mcp");
  });

  test("标签只影响展示：解析结果里没有任何可以改写身份来源的字段", () => {
    const parsed = parseMcpServerArgv(["--identity", "party-someone-else"]);
    expect(Object.keys(parsed).sort()).toEqual(["channel", "error", "identity"]);
  });
});
