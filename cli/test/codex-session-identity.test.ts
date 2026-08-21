// #917：codex hook 的会话身份解析——按 cwd 猜身份会猜到同目录下的另一个身份、还跨实例。
//
// 本文件的**钉子**是 `pins #917` 那一组：cwd 解析出的身份 ≠ 会话真实身份、且两者在不同
// 服务器上时，查询必须用会话真实身份。真机故障形态逐字照抄：
//   cwd → leeguooooo-codex2-agentparty @ https://agentparty.leeguoo.com
//   会话 → lark-ad72b3f9749e-agentparty-codex1 @ https://agentparty.pwtk-dev.work
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveCursorForConfig,
  writeState,
  writeWorkspaceConfigOnly,
  type Config,
} from "../src/config";
import { registerCodexSession } from "../src/claude-session-registry";
import {
  codexMcpConfigPaths,
  defaultCodexHookIdentityDeps,
  looksLikePartyMcpCommand,
  resolveCodexHookIdentity,
} from "../src/codex-session-identity";
import { codexAutoWakeAuth, codexAutoWakeTarget } from "../src/codex-auto-wake";
import { codexStopWakeSeenPath } from "../src/codex-stop-wake";
import { defaultCodexStopWakeDeps } from "../src/commands/hook";

const CHANNEL = "agentparty";
const CWD_SERVER = "https://agentparty.leeguoo.com";
const CWD_NAME = "leeguooooo-codex2-agentparty";
const SESSION_SERVER = "https://agentparty.pwtk-dev.work";
const SESSION_NAME = "lark-ad72b3f9749e-agentparty-codex1";
const SESSION_ID = "01a021f5-aed7-7802-bea3-6165e5dba553";

let home: string;
let cwd: string;
let savedEnv: Record<string, string | undefined>;

function agentConfig(name: string, server: string, token: string, channel: string | null = CHANNEL): Config {
  return {
    server,
    token,
    identity: {
      name,
      email: null,
      kind: "agent",
      role: "member",
      owner: null,
      channel_scope: channel,
      verified_at: 1_700_000_000_000,
    },
  };
}

/** 把一份身份写进 ~/.agentparty/agents（＝本机候选身份索引的唯一来源）。 */
function writeAgentConfig(filename: string, config: Config): string {
  const directory = join(home, "agents");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, filename);
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

function deps(overrides: Partial<ReturnType<typeof defaultCodexHookIdentityDeps>> = {}) {
  return { ...defaultCodexHookIdentityDeps(process.env, 4242), mcpConfigPaths: () => [], ...overrides };
}

function resolve(overrides: Parameters<typeof deps>[0] = {}, sessionId: string | null = SESSION_ID) {
  return resolveCodexHookIdentity({ cwd, channel: CHANNEL, sessionId, deps: deps(overrides) });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentparty-codex-identity-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agentparty-codex-identity-cwd-"));
  savedEnv = {
    AGENTPARTY_HOME: process.env.AGENTPARTY_HOME,
    AGENTPARTY_CONFIG: process.env.AGENTPARTY_CONFIG,
    AGENTPARTY_CHANNEL: process.env.AGENTPARTY_CHANNEL,
  };
  process.env.AGENTPARTY_HOME = home;
  delete process.env.AGENTPARTY_CONFIG;
  process.env.AGENTPARTY_CHANNEL = CHANNEL;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("pins #917：cwd 猜出的身份 ≠ 会话真实身份（且跨实例）", () => {
  /** 真机故障现场：同一 cwd 上绑着 codex2@leeguoo，真实会话身份是 codex1@pwtk-dev。 */
  function stageRealWorldCollision(): { codex1: string; codex2: string } {
    const codex2 = agentConfig(CWD_NAME, CWD_SERVER, "token-codex2");
    const codex1 = agentConfig(SESSION_NAME, SESSION_SERVER, "token-codex1");
    const codex2Path = writeAgentConfig("agentparty-leeguooooo-codex2-agentparty.json", codex2);
    const codex1Path = writeAgentConfig("agentparty-lark-codex1-agentparty.json", codex1);
    // cwd 绑的是 codex2——`readConfig(cwd)` 只会解出它。
    writeWorkspaceConfigOnly(codex2, cwd);
    writeState({ channel: CHANNEL, cursor: 900 }, cwd);
    // 会话真实身份由 SessionStart 入册时记下（本进程 pid 保证条目存活）。
    registerCodexSession({
      session_id: SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: CHANNEL,
      server: SESSION_SERVER,
      identity: SESSION_NAME,
      cwd,
    }, process.env);
    return { codex1: codex1Path, codex2: codex2Path };
  }

  test("解析出的是会话真实身份，不是 cwd 猜出来的那个", () => {
    stageRealWorldCollision();
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe(SESSION_NAME);
    expect(result.identity.server).toBe(SESSION_SERVER);
    expect(result.identity.token).toBe("token-codex1");
    expect(result.identity.source).toBe("session-registry");
  });

  test("Stop hook 的真实接线（token / 实例 / seen 集合 / 游标）全部落在会话真实身份上", () => {
    const paths = stageRealWorldCollision();
    // 会话真实身份的游标（config 作用域）是 1921；cwd 那份是 900——用错就会把 since 搞错。
    saveCursorForConfig(CHANNEL, 1921, paths.codex1);
    const wake = defaultCodexStopWakeDeps(process.env, SESSION_ID, 4242);

    const expected = codexStopWakeSeenPath(
      home,
      codexAutoWakeTarget(codexAutoWakeAuth({ server: SESSION_SERVER, token: "token-codex1" })!, CHANNEL),
    );
    const wrong = codexStopWakeSeenPath(
      home,
      codexAutoWakeTarget(codexAutoWakeAuth({ server: CWD_SERVER, token: "token-codex2" })!, CHANNEL),
    );
    expect(wake.seenPath(CHANNEL, cwd)).toBe(expected);
    expect(wake.seenPath(CHANNEL, cwd)).not.toBe(wrong);
    expect(wake.cursor(CHANNEL, cwd)).toBe(1921);
  });

  test("注册表条目没记身份（#906 之前的旧条目）时宁可不叫，绝不回落到 cwd 猜", () => {
    stageRealWorldCollision();
    registerCodexSession({
      session_id: SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: CHANNEL,
      server: null,
      identity: null,
      cwd,
    }, process.env);
    const result = resolve();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
  });
});

describe("解析优先级", () => {
  test("会话自己带的 AGENTPARTY_CONFIG 最硬，压过 cwd 与注册表", () => {
    const path = writeAgentConfig("explicit.json", agentConfig(SESSION_NAME, SESSION_SERVER, "token-explicit"));
    writeWorkspaceConfigOnly(agentConfig(CWD_NAME, CWD_SERVER, "token-codex2"), cwd);
    process.env.AGENTPARTY_CONFIG = path;
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.source).toBe("env");
    expect(result.identity.token).toBe("token-explicit");
    // env 档的游标由 process.env 天然作用域化，不该再套一层 config 作用域。
    expect(result.identity.configScopedState).toBe(false);
  });

  test("显式 AGENTPARTY_CONFIG 指向另一个频道的身份 ⇒ 失败关闭，不换人顶上", () => {
    const path = writeAgentConfig("other.json", agentConfig("someone-else", SESSION_SERVER, "t", "another-channel"));
    writeAgentConfig("only.json", agentConfig(SESSION_NAME, SESSION_SERVER, "token-codex1"));
    process.env.AGENTPARTY_CONFIG = path;
    const result = resolve();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("env-config-unusable");
  });

  test("MCP 注册反查：该 codex 进程下唯一一个绑本频道的身份就是它", () => {
    const path = writeAgentConfig("mcp.json", agentConfig(SESSION_NAME, SESSION_SERVER, "token-codex1"));
    writeAgentConfig("elsewhere.json", agentConfig("someone-else", CWD_SERVER, "token-other"));
    writeWorkspaceConfigOnly(agentConfig(CWD_NAME, CWD_SERVER, "token-codex2"), cwd);
    const result = resolve({ mcpConfigPaths: () => [path] }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.source).toBe("mcp-registration");
    expect(result.identity.token).toBe("token-codex1");
    expect(result.identity.configScopedState).toBe(true);
  });

  test("MCP 注册反查：同一 codex 进程下挂着两个身份 ⇒ 歧义，放弃", () => {
    const a = writeAgentConfig("a.json", agentConfig(SESSION_NAME, SESSION_SERVER, "token-codex1"));
    const b = writeAgentConfig("b.json", agentConfig(CWD_NAME, CWD_SERVER, "token-codex2"));
    const result = resolve({ mcpConfigPaths: () => [a, b] }, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
    expect(result.detail).toContain(SESSION_NAME);
    expect(result.detail).toContain(CWD_NAME);
  });

  test("单身份机器：cwd 档照旧可用（行为不变）", () => {
    const config = agentConfig(SESSION_NAME, SESSION_SERVER, "token-codex1");
    writeAgentConfig("only.json", config);
    writeWorkspaceConfigOnly(config, cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.source).toBe("cwd-unique");
    expect(result.identity.configScopedState).toBe(false);
  });

  test("本机该频道有第二个身份 ⇒ cwd 档立刻失效", () => {
    const config = agentConfig(SESSION_NAME, SESSION_SERVER, "token-codex1");
    writeAgentConfig("one.json", config);
    writeAgentConfig("two.json", agentConfig(CWD_NAME, CWD_SERVER, "token-codex2"));
    writeWorkspaceConfigOnly(config, cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
  });

  test("同名身份分属两台实例也算两个身份（#865：server 必须参与判定）", () => {
    const config = agentConfig(SESSION_NAME, SESSION_SERVER, "token-a");
    writeAgentConfig("one.json", config);
    writeAgentConfig("two.json", agentConfig(SESSION_NAME, CWD_SERVER, "token-b"));
    writeWorkspaceConfigOnly(config, cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
  });

  test("没绑频道 ⇒ 直接放弃", () => {
    writeWorkspaceConfigOnly(agentConfig(SESSION_NAME, SESSION_SERVER, "t"), cwd);
    const result = resolveCodexHookIdentity({ cwd, channel: null, sessionId: null, deps: deps() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-channel");
  });

  test("一份身份都没有 ⇒ 放弃（不是崩，也不是猜）", () => {
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-identity");
  });
});

describe("MCP 子进程扫描", () => {
  test("只认真正的 `party … mcp` 命令行", () => {
    expect(looksLikePartyMcpCommand("party mcp --channel agentparty")).toBe(true);
    expect(looksLikePartyMcpCommand("/Users/leo/.local/bin/party mcp")).toBe(true);
    expect(looksLikePartyMcpCommand("bun /repo/cli/src/party.ts mcp --channel x")).toBe(true);
    expect(looksLikePartyMcpCommand("party serve agentparty --runner codex")).toBe(false);
    expect(looksLikePartyMcpCommand("mcp party")).toBe(false);
    expect(looksLikePartyMcpCommand("some-other-mcp mcp")).toBe(false);
    expect(looksLikePartyMcpCommand("")).toBe(false);
    // `mcp` 出现在参数值里不算数：这些是别的子命令，从它们身上读 AGENTPARTY_CONFIG
    // 会把 @ 判给毫不相干的身份——正是 #917 要根除的那类猜测。
    expect(looksLikePartyMcpCommand('party send "hi" --channel mcp')).toBe(false);
    expect(looksLikePartyMcpCommand("party serve x --on-mention mcp")).toBe(false);
    expect(looksLikePartyMcpCommand("party history mcp")).toBe(false);
    // flag 挡在子命令前面仍要认得出来。
    expect(looksLikePartyMcpCommand("party --verbose mcp --channel x")).toBe(true);
  });

  test("从 `ps eww` 里读出子进程注册时用的 AGENTPARTY_CONFIG（去重）", () => {
    const calls: string[][] = [];
    const spawn = ((_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "-axo") {
        return {
          status: 0,
          stdout: [
            " 3002 69445 party mcp --channel agentparty",
            " 3005 69445 party mcp --channel agentparty",
            " 3009 69445 party serve agentparty --runner codex",
            " 4001    12 party mcp --channel agentparty",
          ].join("\n"),
        };
      }
      expect(args).toEqual(["eww", "-o", "command=", "-p", "3002,3005"]);
      return {
        status: 0,
        stdout: [
          "party mcp --channel agentparty AGENTPARTY_CONFIG=/agents/codex.json TERM=xterm",
          "party mcp --channel agentparty AGENTPARTY_CONFIG=/agents/codex1.json",
          "party mcp --channel agentparty AGENTPARTY_CONFIG=/agents/codex1.json",
        ].join("\n"),
      };
    }) as unknown as typeof import("node:child_process").spawnSync;
    expect(codexMcpConfigPaths(69445, spawn)).toEqual(["/agents/codex.json", "/agents/codex1.json"]);
    expect(calls).toHaveLength(2);
  });

  test("ps 挂了 / pid 不合法 ⇒ 空数组（这条线索不可用，绝不抛）", () => {
    const dead = (() => {
      throw new Error("ps: command not found");
    }) as unknown as typeof import("node:child_process").spawnSync;
    expect(codexMcpConfigPaths(69445, dead)).toEqual([]);
    expect(codexMcpConfigPaths(1, dead)).toEqual([]);
    expect(codexMcpConfigPaths(-1, dead)).toEqual([]);
  });
});
