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
  codexHookIdentityFix,
  codexMcpConfigPaths,
  defaultCodexHookIdentityDeps,
  looksLikePartyMcpCommand,
  resolveCodexHookIdentity,
} from "../src/codex-session-identity";
import {
  joinBindingsPath,
  writeJoinBinding,
  type BindingHarness,
} from "../src/join-binding";
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


// ── #924 的钉子 ─────────────────────────────────────────────────────────────
// 真机故障形态逐字照抄（owner 那台 v0.2.205 实测）：
//   · codex 是 ChatGPT.app 桌面端 ⇒ 不继承 shell 环境 ⇒ 第 ① 档（env）不适用；
//   · 入册要先解析出身份才写得进 ⇒ 第 ③ 档（session-registry）空着；
//   · 同一个 codex 进程下挂着**三条** #agentparty 的 MCP 注册 ⇒ 第 ④ 档判歧义；
//   · 本机该频道有 **14 个**身份 ⇒ 第 ⑤ 档（cwd 唯一）不唯一。
// 四档全灭 ⇒ 静默不叫。加入即绑定必须把这台机器救回来，且**必须解析到最近一次加入的那个身份**。
describe("pins #924：同 harness 同频道堆了一串历史身份，加入后仍能唯一解析出最新身份", () => {
  const OWNER = "lark:on_owner";
  const SERVER = SESSION_SERVER;

  /** 一台「用了很久」的机器：同频道 14 个身份，其中 3 个还挂在当前 codex 进程的 MCP 注册里。 */
  function stageWornMachine(): { paths: string[]; registered: string[] } {
    const paths: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const name = `lark-ad72b3f9749e-agentparty-codex${String(i)}`;
      paths.push(writeAgentConfig(`agentparty-${name}-agentparty.json`, agentConfig(name, SERVER, `tok-${String(i)}`)));
    }
    // cwd 绑着其中随便一个——按 cwd 猜必然猜错，这正是 #917/#924 要根除的。
    writeWorkspaceConfigOnly(agentConfig("lark-ad72b3f9749e-agentparty-codex0", SERVER, "tok-0"), cwd);
    writeState({ channel: CHANNEL, cursor: 1899 }, cwd);
    // 该 codex 进程下**看得见**三条注册（真机就是 3 条），历史堆积。
    const registered = [paths[0]!, paths[7]!, paths[13]!];
    return { paths, registered };
  }

  function bind(configPath: string, identity: string, harness: BindingHarness = "codex", overrides: Record<string, unknown> = {}) {
    return writeJoinBinding(joinBindingsPath(home), {
      harness,
      server: SERVER,
      channel: CHANNEL,
      owner: OWNER,
      identity,
      config_path: configPath,
      cwd,
      created_at: 1_700_000_000_000,
      ...overrides,
    } as never);
  }

  test("四档反推全灭时，加入即绑定解析出最近一次加入的身份（不是 cwd 猜的、不是最老的）", () => {
    const { paths, registered } = stageWornMachine();
    // 用户最近一次加入用的是第 14 个身份（codex13），且它确实在该进程的注册里。
    bind(paths[13]!, "lark-ad72b3f9749e-agentparty-codex13");
    const result = resolve({ mcpConfigPaths: () => registered }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.source).toBe("join-binding");
    expect(result.identity.name).toBe("lark-ad72b3f9749e-agentparty-codex13");
    expect(result.identity.server).toBe(SERVER);
    expect(result.identity.token).toBe("tok-13");
    // 游标/欠账必须落在解析出的那个身份的作用域里，不能回落到 cwd。
    expect(result.identity.configScopedState).toBe(true);
    expect(result.identity.configPath).toBe(paths[13]!);
  });

  // 变异自检：删掉加入即绑定这一档，本用例必须变红——否则它钉的不是本次修复。
  test("没有绑定时，同一台机器仍然是四档全灭（证明上面那条钉的是绑定本身）", () => {
    const { registered } = stageWornMachine();
    const result = resolve({ mcpConfigPaths: () => registered }, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
  });

  test("后加入替换先加入：同 harness+server+channel+owner 只留最新那条", () => {
    const { paths, registered } = stageWornMachine();
    bind(paths[0]!, "lark-ad72b3f9749e-agentparty-codex0");
    const replaced = bind(paths[13]!, "lark-ad72b3f9749e-agentparty-codex13");
    // 替换掉了谁必须报得出来。
    expect(replaced.map((r) => r.identity)).toEqual(["lark-ad72b3f9749e-agentparty-codex0"]);
    const result = resolve({ mcpConfigPaths: () => registered }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe("lark-ad72b3f9749e-agentparty-codex13");
  });

  test("不同 harness 的身份不被替换、也不互相污染（claude 的绑定 codex 永远看不见）", () => {
    const { paths, registered } = stageWornMachine();
    bind(paths[3]!, "claude-side", "claude");
    bind(paths[13]!, "lark-ad72b3f9749e-agentparty-codex13");
    const result = resolve({ mcpConfigPaths: () => registered }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe("lark-ad72b3f9749e-agentparty-codex13");
  });

  test("佐证不匹配 ⇒ 不硬用绑定（终端 codex 与桌面 codex 各自加入过同一频道）", () => {
    const { paths } = stageWornMachine();
    // 绑定记的是 codex13，但**这个** codex 进程下只看得见 codex7 ⇒ 绑定不属于本实例。
    bind(paths[13]!, "lark-ad72b3f9749e-agentparty-codex13");
    const result = resolve({ mcpConfigPaths: () => [paths[7]!] }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 落到就地取证的那一档，解析出的是本进程真正挂着的那个身份——绝不误投给 codex13。
    expect(result.identity.source).toBe("mcp-registration");
    expect(result.identity.name).toBe("lark-ad72b3f9749e-agentparty-codex7");
  });

  test("绑定指向的 config 已经没了 ⇒ 当没有绑定，绝不当成解析成功", () => {
    const { registered } = stageWornMachine();
    bind(join(home, "agents", "gone.json"), "ghost");
    const result = resolve({ mcpConfigPaths: () => registered }, null);
    expect(result.ok).toBe(false);
  });

  test("每一种放弃都给得出一条可执行命令——静默失败没有出口", () => {
    for (const reason of [
      "no-channel",
      "env-config-unusable",
      "ambiguous-binding",
      "harness-mismatch",
      "no-codex-binding",
      "registry-identity-unresolvable",
      "ambiguous",
      "no-identity",
    ] as const) {
      const fix = codexHookIdentityFix(reason, { channel: CHANNEL, server: SERVER });
      expect(fix.trim().length).toBeGreaterThan(0);
      // token 只许走环境变量前缀、不进 argv（#676），所以 `AGENTPARTY_TOKEN='…' party join …` 也算可执行。
      expect(/^(?:[A-Z_]+=\S+ )?party |^unset /.test(fix)).toBe(true);
    }
  });
});

// #960：codex hook 绝不认领绑给别的 harness 的身份。真机现场：`party join --harness claude --as leo-server`
// 之后，同 cwd 的每个 codex 都从 cwd 档反推出 leo-server，替它拉起 codex 唤醒层——用户明确绑给 claude
// 的接收路径被 codex 抢走。绑定文件里明明写着 harness: claude。
describe("pins #960：反推各档解析出的身份若绑给了别的 harness ⇒ harness-mismatch", () => {
  const SERVER = SESSION_SERVER;
  const NAME = "leo-server";

  function bindTo(harness: BindingHarness, configPath: string, identity = NAME) {
    writeJoinBinding(joinBindingsPath(home), {
      harness, server: SERVER, channel: CHANNEL, owner: "leo", identity, config_path: configPath, cwd, created_at: 1_700_000_000_000,
    });
  }

  test("cwd 档（单身份机器）：身份是 claude 加入的 ⇒ 拒绝，理由点名 --harness claude", () => {
    const path = writeAgentConfig("agentparty-leo-server.json", agentConfig(NAME, SERVER, "tok"));
    writeWorkspaceConfigOnly(agentConfig(NAME, SERVER, "tok"), cwd);
    bindTo("claude", path);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("harness-mismatch");
    expect(result.detail).toContain("--harness claude");
    expect(result.detail).toContain(NAME);
  });

  test("MCP 注册档：该 codex 进程下挂着的唯一身份是 claude 加入的 ⇒ 同样拒绝", () => {
    const path = writeAgentConfig("agentparty-leo-server.json", agentConfig(NAME, SERVER, "tok"));
    bindTo("claude", path);
    const result = resolve({ mcpConfigPaths: () => [path] }, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("harness-mismatch");
  });

  test("注册表档：条目记的身份是 claude 加入的 ⇒ 同样拒绝", () => {
    const path = writeAgentConfig("agentparty-leo-server.json", agentConfig(NAME, SERVER, "tok"));
    bindTo("claude", path);
    registerCodexSession({
      session_id: SESSION_ID, pid: process.pid, display_name: null, channel: CHANNEL, server: SERVER, identity: NAME, cwd,
    }, process.env);
    const result = resolve({}, SESSION_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("harness-mismatch");
  });

  test("同一身份也用 codex 加入过 ⇒ 不是 mismatch：走加入即绑定那一档正常解析", () => {
    const path = writeAgentConfig("agentparty-leo-server.json", agentConfig(NAME, SERVER, "tok"));
    writeWorkspaceConfigOnly(agentConfig(NAME, SERVER, "tok"), cwd);
    bindTo("claude", path);
    bindTo("codex", path);
    const result = resolve({}, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe(NAME);
    expect(result.identity.source).toBe("join-binding");
  });

  test("claude 绑的是另一个身份、cwd 绑的这个没人认领 ⇒ 与 claude 绑定无关，cwd 档照旧", () => {
    const claudePath = writeAgentConfig("agentparty-claude-side.json", agentConfig("claude-side", SERVER, "tok-c", null));
    bindTo("claude", claudePath, "claude-side");
    writeWorkspaceConfigOnly(agentConfig(NAME, SERVER, "tok"), cwd);
    writeAgentConfig("agentparty-leo-server.json", agentConfig(NAME, SERVER, "tok"));
    const result = resolve({}, null);
    // claude 绑的是别的身份（且不在本频道的候选索引里）：cwd 档解析出的这个身份没被任何 harness 认领，照旧可用。
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.source).toBe("cwd-unique");
    expect(result.identity.name).toBe(NAME);
  });

  test("会话自己带的 AGENTPARTY_CONFIG 仍然最硬：显式指向 claude 加入的身份也认（会话说了算）", () => {
    const path = writeAgentConfig("agentparty-leo-server.json", agentConfig(NAME, SERVER, "tok"));
    bindTo("claude", path);
    process.env.AGENTPARTY_CONFIG = path;
    const result = resolve({}, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.source).toBe("env");
  });

  test("harness-mismatch 的修复命令是 party join --harness codex，不是 party init 手搓（#955）", () => {
    const fix = codexHookIdentityFix("harness-mismatch", { channel: CHANNEL, server: SERVER });
    expect(fix).toMatch(/^AGENTPARTY_TOKEN=\S+ party join\b/);
    expect(fix).toContain("--harness codex");
    expect(fix).not.toMatch(/(^|\s)party init\b/);
  });
});

// #971：候选集必须**先按 harness 过滤**再谈唯一/歧义。piggo 真机：#ludo 上堆着一旧一新两个 claude
// 绑定（leo-server 已移出频道、token 已撤但 config 按设计保留；server 是新的 `--harness claude`），
// 零个 codex 绑定。此前 cwd 档把两个都算进候选 ⇒ 「ambiguous……放弃」每个 codex SessionStart 刷一遍，
// 修法还叫人「重跑 codex 接入包」——与这台机「codex 不接 #ludo」的意图正相反。
describe("pins #971：claude 绑定不是 codex 的候选——过滤后再判唯一/歧义", () => {
  const SERVER = SESSION_SERVER;
  const OLD = "leo-server";
  const NEW = "server";

  function bindTo(harness: BindingHarness, configPath: string, identity: string, owner: string | null = "leo") {
    writeJoinBinding(joinBindingsPath(home), {
      harness, server: SERVER, channel: CHANNEL, owner, identity, config_path: configPath, cwd, created_at: 1_700_000_000_000,
    }, { replace: false });
  }

  test("(a) piggo 现场：同 cwd 两个 claude 绑定 + 0 个 codex 绑定 ⇒ no-codex-binding，绝不是 ambiguous", () => {
    const oldPath = writeAgentConfig("agentparty-leo-server.json", agentConfig(OLD, SERVER, "tok-old"));
    const newPath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    bindTo("claude", oldPath, OLD, null);
    bindTo("claude", newPath, NEW);
    writeWorkspaceConfigOnly(agentConfig(NEW, SERVER, "tok-new"), cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-codex-binding");
    expect(result.detail).not.toContain("ambiguous");
    expect(result.detail).not.toContain("只能猜出其中一个");
    expect(result.detail).not.toContain("重新跑一遍");
    expect(result.detail).toContain(OLD);
    expect(result.detail).toContain(NEW);
    expect(result.detail).toContain("可选");
  });

  test("(a′) 老绑定已被替换、只剩 config 残留：cwd 指向 claude 的身份 ⇒ 仍拒绝，且绝不改猜那份残留 config", () => {
    // 同 owner 的 claude 绑定会被后加入的替换（join-binding 的默认语义），于是 leo-server 只剩 config、没有绑定。
    writeAgentConfig("agentparty-leo-server.json", agentConfig(OLD, SERVER, "tok-revoked"));
    const newPath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    bindTo("claude", newPath, NEW);
    writeWorkspaceConfigOnly(agentConfig(NEW, SERVER, "tok-new"), cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // cwd 指的那个是 claude 的——这是 mismatch；残留的 leo-server 不是 cwd 指的，绝不认领它。
    expect(result.reason).toBe("harness-mismatch");
    expect(result.detail).not.toContain("ambiguous");
    expect(result.detail).toContain(NEW);
  });

  test("(b) 一 claude 一 codex：认领 codex 那个，哪怕 claude 的更新、且绑在 cwd 上", () => {
    const codexPath = writeAgentConfig("agentparty-leo-codex.json", agentConfig("leo-codex", SERVER, "tok-codex"));
    const claudePath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    bindTo("codex", codexPath, "leo-codex");
    bindTo("claude", claudePath, NEW);
    writeWorkspaceConfigOnly(agentConfig(NEW, SERVER, "tok-new"), cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe("leo-codex");
    expect(result.identity.token).toBe("tok-codex");
    expect(result.identity.source).toBe("join-binding");
  });

  test("(b′) MCP 注册档：进程下挂着 claude 的与没人认领的两个身份 ⇒ 过滤掉 claude 的，认领剩下那一个", () => {
    const claudePath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    const freePath = writeAgentConfig("agentparty-free.json", agentConfig("free", SERVER, "tok-free"));
    bindTo("claude", claudePath, NEW);
    const result = resolve({ mcpConfigPaths: () => [claudePath, freePath] }, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe("free");
    expect(result.identity.source).toBe("mcp-registration");
  });

  test("(c) 两个 codex 绑定 ⇒ 才是 ambiguous（-binding），不因为旁边还有 claude 绑定而变味", () => {
    const one = writeAgentConfig("agentparty-codex-one.json", agentConfig("codex-one", SERVER, "tok-1"));
    const two = writeAgentConfig("agentparty-codex-two.json", agentConfig("codex-two", SERVER, "tok-2"));
    const claudePath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    bindTo("codex", one, "codex-one", "alice");
    bindTo("codex", two, "codex-two", "bob");
    bindTo("claude", claudePath, NEW);
    // 两条 codex 绑定都不是在本 cwd 加入的：cwd 收窄不出唯一。
    const result = resolveCodexHookIdentity({ cwd: join(cwd, "elsewhere"), channel: CHANNEL, sessionId: null, deps: deps() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous-binding");
    expect(result.detail).toContain("codex-one");
    expect(result.detail).toContain("codex-two");
    expect(result.detail).not.toContain(NEW);
  });

  test("(c′) cwd 档：没有绑定的老配置照旧是候选——两份没人认领的 + 一份 claude 的 ⇒ 歧义只在前两者之间", () => {
    writeAgentConfig("agentparty-old-a.json", agentConfig("old-a", SERVER, "tok-a"));
    writeAgentConfig("agentparty-old-b.json", agentConfig("old-b", SERVER, "tok-b"));
    const claudePath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    bindTo("claude", claudePath, NEW);
    writeWorkspaceConfigOnly(agentConfig("old-a", SERVER, "tok-a"), cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("ambiguous");
    expect(result.detail).toContain("身份有 2 个");
  });

  test("cwd 档：claude 的身份旁边只剩一份没人认领的老配置、且 cwd 指向它 ⇒ 过滤后唯一，正常认领（行为与单身份机器一致）", () => {
    writeAgentConfig("agentparty-old-a.json", agentConfig("old-a", SERVER, "tok-a"));
    const claudePath = writeAgentConfig("agentparty-server.json", agentConfig(NEW, SERVER, "tok-new"));
    bindTo("claude", claudePath, NEW);
    writeWorkspaceConfigOnly(agentConfig("old-a", SERVER, "tok-a"), cwd);
    const result = resolve({}, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe("old-a");
    expect(result.identity.source).toBe("cwd-unique");
  });

  test("cwd 没绑 config、本机该频道的身份全是 claude 的 ⇒ no-codex-binding（不是含糊的 no-identity）", () => {
    const oldPath = writeAgentConfig("agentparty-leo-server.json", agentConfig(OLD, SERVER, "tok-old"));
    bindTo("claude", oldPath, OLD);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-codex-binding");
  });

  test("现有 harness-mismatch 路径原样保留：单身份机器、cwd 指向 claude 的身份 ⇒ 仍是 harness-mismatch", () => {
    const path = writeAgentConfig("agentparty-leo-server.json", agentConfig(OLD, SERVER, "tok"));
    writeWorkspaceConfigOnly(agentConfig(OLD, SERVER, "tok"), cwd);
    bindTo("claude", path, OLD);
    const result = resolve({}, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("harness-mismatch");
  });

  test("(d) no-codex-binding 的修法：party join --harness codex（不是 party init，#955），且明说是可选的", () => {
    const fix = codexHookIdentityFix("no-codex-binding", { channel: CHANNEL, server: SERVER });
    expect(fix).toMatch(/^AGENTPARTY_TOKEN='<T>' party join\b/);
    expect(fix).toContain(`--channel ${CHANNEL}`);
    expect(fix).toContain(`--server ${SERVER}`);
    expect(fix).toContain("--harness codex");
    expect(fix).toContain("--yes");
    expect(fix).not.toMatch(/(^|\s)party init\b/);
    expect(fix).toContain("可选");
    expect(fix).toContain("claude");
    expect(fix).not.toContain("重跑");
  });
});
