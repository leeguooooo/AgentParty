// #923：治理命令必须看得见 codex 侧的 MCP 注册（全局 + 项目级），且**绝不删正在被活进程
// 使用的注册**。
//
// 真机形态逐字照抄（owner 那台 v0.2.205）：一个 codex 桌面端下挂着三条 #agentparty 的注册，
// 其中两条在 codex 的注册表里，`party mcp identities` 却对它们说「没有注册可删」——而收敛
// codex 侧注册恰恰是那台机器上唯一可行的修复路径。看不见就治不了。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexRegistryScopes,
  parseCodexMcpRegistrations,
  readCodexMcpRegistrations,
  type CodexRegistryScope,
} from "../src/codex-mcp-registry";
import {
  isPartyMcpRegistration,
  listLivePartyMcpProcesses,
  liveConfigPathUsers,
  registrationChannel,
  registrationHarness,
  type McpRegistration,
} from "../src/mcp-registry";
import { runMcpIdentities } from "../src/commands/mcp-identities";
import { planMcpPrune, runMcpPrune } from "../src/commands/mcp-prune";
import type { Config } from "../src/config";

const SERVER = "https://agentparty.pwtk-dev.work";
const CHANNEL = "agentparty";
const OWNER = "lark:on_owner";

let home: string;
let agentsDir: string;
let savedHome: string | undefined;

function scope(dir: string, kind: CodexRegistryScope["kind"] = "global"): CodexRegistryScope {
  return { codexHome: dir, configPath: join(dir, "config.toml"), kind };
}

function agentConfig(name: string): Config {
  return {
    server: SERVER,
    token: `tok-${name}`,
    identity: {
      name,
      email: null,
      kind: "agent",
      role: "member",
      owner: OWNER,
      channel_scope: CHANNEL,
      verified_at: 1_700_000_000_000,
    },
  };
}

function writeAgent(name: string): string {
  mkdirSync(agentsDir, { recursive: true });
  const path = join(agentsDir, `agentparty-${name}-${CHANNEL}.json`);
  writeFileSync(path, JSON.stringify(agentConfig(name)));
  return path;
}

function codexReg(name: string, configPath: string, codexHome: string): McpRegistration {
  return {
    scope: join(codexHome, "config.toml"),
    name,
    command: "party",
    args: ["mcp", "--channel", CHANNEL],
    env: { AGENTPARTY_CONFIG: configPath },
    harness: "codex",
    codexHome,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-923-"));
  agentsDir = join(home, ".agentparty", "agents");
  savedHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = join(home, ".agentparty");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("解析 codex 的 config.toml", () => {
  test("认出 party mcp 注册，带上 harness / CODEX_HOME / 频道 / env", () => {
    const dir = join(home, ".codex");
    const regs = parseCodexMcpRegistrations(
      scope(dir),
      [
        "[mcp_servers.party-a]",
        'command = "party"',
        'args = ["mcp", "--channel", "agentparty"]',
        "[mcp_servers.party-a.env]",
        'AGENTPARTY_CONFIG = "/tmp/a.json"',
      ].join("\n"),
    );
    expect(regs).toHaveLength(1);
    const reg = regs[0]!;
    expect(isPartyMcpRegistration(reg)).toBe(true);
    expect(registrationHarness(reg)).toBe("codex");
    expect(reg.codexHome).toBe(dir);
    expect(registrationChannel(reg)).toBe(CHANNEL);
    expect(reg.env.AGENTPARTY_CONFIG).toBe("/tmp/a.json");
  });

  test("别人的 MCP server 一律不认（删除面绝不能因为名字像就放行）", () => {
    const regs = parseCodexMcpRegistrations(
      scope(join(home, ".codex")),
      [
        "[mcp_servers.discord]",
        'command = "/Users/x/.local/bin/discord-use"',
        'args = ["mcp"]',
        "[mcp_servers.zego]",
        'url = "https://doc-ai.example/mcp/"',
        // 名字里带 party，但命令不是我们的二进制。
        "[mcp_servers.party-lookalike]",
        'command = "npx"',
        'args = ["party", "mcp"]',
      ].join("\n"),
    );
    expect(regs.filter(isPartyMcpRegistration)).toEqual([]);
  });

  test("TOML 坏了 → 空数组，绝不抛也绝不猜", () => {
    expect(parseCodexMcpRegistrations(scope(join(home, ".codex")), "[[[not toml")).toEqual([]);
    expect(parseCodexMcpRegistrations(scope(join(home, ".codex")), "")).toEqual([]);
    expect(parseCodexMcpRegistrations(scope(join(home, ".codex")), 'mcp_servers = "x"')).toEqual([]);
  });

  test("全局 + 项目级两份注册表都读得到（owner 那台正是两处各一条）", () => {
    const globalDir = join(home, ".codex");
    const projectDir = join(home, "repo", ".codex");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(globalDir, "config.toml"),
      '[mcp_servers.party-global]\ncommand = "party"\nargs = ["mcp", "--channel", "agentparty"]\n',
    );
    writeFileSync(
      join(projectDir, "config.toml"),
      '[mcp_servers.party-project]\ncommand = "party"\nargs = ["mcp", "--channel", "agentparty"]\n',
    );
    const scopes = codexRegistryScopes({}, join(home, "repo"), home);
    expect(scopes.map((s) => s.kind)).toEqual(["global", "project"]);
    const regs = readCodexMcpRegistrations(scopes).filter(isPartyMcpRegistration);
    expect(regs.map((r) => r.name).sort()).toEqual(["party-global", "party-project"]);
  });

  test("项目级只在用户 home 之内往上找——给一个临时 home 就必须完全离线", () => {
    // cwd 不在这个 home 之下 ⇒ 一条项目级都不该冒出来（否则单测会读到真机配置）。
    const scopes = codexRegistryScopes({}, "/", home);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]!.kind).toBe("global");
    expect(scopes[0]!.configPath).toBe(join(home, ".codex", "config.toml"));
  });
});

describe("活进程扫描：ps 的输出必须只按命令部分判定", () => {
  test("env 里出现 party mcp 字样的无关进程不算数", () => {
    const table = [
      "  100 /usr/bin/vim notes.md SOME_ENV=party mcp --channel x",
      "  200 party mcp --channel agentparty AGENTPARTY_CONFIG=/tmp/a.json",
      "  300 party send hi --channel mcp AGENTPARTY_CONFIG=/tmp/b.json",
    ].join("\n");
    const spawn = ((_cmd: string, _args: string[]) => ({ status: 0, stdout: table })) as never;
    const live = listLivePartyMcpProcesses(spawn);
    expect(live.map((p) => p.pid)).toEqual([200]);
    expect(liveConfigPathUsers(live).get("/tmp/a.json")).toEqual([200]);
    // `party send … --channel mcp` 绝不能被当成 MCP 注册进程（#918 的同款判据）。
    expect(liveConfigPathUsers(live).has("/tmp/b.json")).toBe(false);
  });

  test("ps 挂了 → 空数组；调用方必须把「不知道」当成「可能有人在用」", () => {
    const spawn = (() => {
      throw new Error("no ps");
    }) as never;
    expect(listLivePartyMcpProcesses(spawn)).toEqual([]);
  });
});

describe("party mcp identities：覆盖 codex 注册 + 绝不删活着的", () => {
  test("check 模式把 codex 侧的注册也列出来（此前它说「没有注册可删」）", async () => {
    const pathA = writeAgent("codex-old");
    const lines: string[] = [];
    const code = await runMcpIdentities({
      home,
      agentsDir,
      server: SERVER,
      channel: CHANNEL,
      codexRegistrations: () => [codexReg("party-codex-old", pathA, join(home, ".codex"))],
      liveProcesses: () => [],
      log: (line) => lines.push(line),
    });
    expect(code).toBe(3);
    const text = lines.join("\n");
    expect(text).toContain("codex:party-codex-old");
  });

  test("--keep 会删 codex 侧的注册（走 codex 自己的 remove 路径）", async () => {
    const keepPath = writeAgent("codex-new");
    const dropPath = writeAgent("codex-old");
    expect(keepPath).toBeTruthy();
    const removed: McpRegistration[] = [];
    const lines: string[] = [];
    await runMcpIdentities({
      home,
      agentsDir,
      server: SERVER,
      channel: CHANNEL,
      keep: "codex-new",
      yes: true,
      codexRegistrations: () => [codexReg("party-codex-old", dropPath, join(home, ".codex"))],
      liveProcesses: () => [],
      remove: (reg) => {
        removed.push(reg);
        return { ok: true, detail: "" };
      },
      log: (line) => lines.push(line),
    });
    expect(removed.map((r) => r.name)).toEqual(["party-codex-old"]);
    expect(registrationHarness(removed[0]!)).toBe("codex");
    expect(removed[0]!.codexHome).toBe(join(home, ".codex"));
  });

  test("有活进程在用 → 只列不删，并说出是谁在用（#923 附带发现：差点删掉别的活会话）", async () => {
    const keepPath = writeAgent("codex-new");
    const livePath = writeAgent("claude-test");
    expect(keepPath).toBeTruthy();
    const removed: McpRegistration[] = [];
    const lines: string[] = [];
    await runMcpIdentities({
      home,
      agentsDir,
      server: SERVER,
      channel: CHANNEL,
      keep: "codex-new",
      yes: true,
      codexRegistrations: () => [codexReg("party-claude-test", livePath, join(home, ".codex"))],
      liveProcesses: () => [{ pid: 4242, configPath: livePath, command: "party mcp" }],
      remove: (reg) => {
        removed.push(reg);
        return { ok: true, detail: "" };
      },
      log: (line) => lines.push(line),
    });
    expect(removed).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("in use, kept");
    expect(text).toContain("4242");
  });

  test("--harness codex 只治理 codex 那一侧，claude 的注册连看都不看", async () => {
    const keepPath = writeAgent("codex-new");
    const dropPath = writeAgent("codex-old");
    expect(keepPath).toBeTruthy();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "party-codex-old": {
            command: "party",
            args: ["mcp", "--channel", CHANNEL],
            env: { AGENTPARTY_CONFIG: dropPath },
          },
        },
      }),
    );
    const removed: McpRegistration[] = [];
    await runMcpIdentities({
      home,
      agentsDir,
      server: SERVER,
      channel: CHANNEL,
      keep: "codex-new",
      harness: "codex",
      yes: true,
      codexRegistrations: () => [],
      liveProcesses: () => [],
      remove: (reg) => {
        removed.push(reg);
        return { ok: true, detail: "" };
      },
      log: () => {},
    });
    expect(removed).toEqual([]);
  });
});

describe("party mcp prune：codex 注册进计划，活着的降级为 review", () => {
  test("codex 侧指向已删身份的注册被判 dead", async () => {
    const plan = await planMcpPrune({
      home,
      codexRegistrations: () => [codexReg("party-gone", join(agentsDir, "gone.json"), join(home, ".codex"))],
      liveProcesses: () => [],
    });
    expect(plan.partyEntries).toHaveLength(1);
    expect(plan.partyEntries[0]!.verdict.action).toBe("stale");
  });

  test("同一条注册只要有活进程在用就变 review，绝不进删除路径", async () => {
    const gone = join(agentsDir, "gone.json");
    const removed: string[] = [];
    const code = await runMcpPrune({
      home,
      yes: true,
      codexRegistrations: () => [codexReg("party-gone", gone, join(home, ".codex"))],
      liveProcesses: () => [{ pid: 777, configPath: gone, command: "party mcp" }],
      remove: (reg) => {
        removed.push(reg.name);
        return { ok: true, detail: "" };
      },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(removed).toEqual([]);
  });
});
