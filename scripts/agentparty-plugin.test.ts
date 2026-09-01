import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  agentPartyPluginDrift,
  expectedAgentPartyPluginVersion,
} from "./sync-agentparty-plugin";

const root = resolve(import.meta.dir, "..");
const pluginRoot = resolve(root, "plugins/agentparty");
const runtimeLauncher = resolve(pluginRoot, "bin/agentparty-runtime");
const claudeRuntimeCommand = "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime";
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

function pluginFiles(directory = pluginRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return [path];
    return entry.isDirectory() ? pluginFiles(path) : [path];
  });
}

describe("AgentParty marketplace plugin", () => {
  test("mirrors the canonical skill and CLI release version", () => {
    expect(agentPartyPluginDrift()).toEqual([]);
    const version = expectedAgentPartyPluginVersion();
    expect(readJson("plugins/agentparty/.claude-plugin/plugin.json").version).toBe(version);
    expect(readJson("plugins/agentparty/.codex-plugin/plugin.json").version).toBe(version);
  });

  test("publishes one self-contained plugin from the repository marketplace", () => {
    const marketplace = readJson(".claude-plugin/marketplace.json");
    expect(marketplace.name).toBe("agentparty");
    expect(marketplace.plugins).toEqual([
      { name: "agentparty", source: "./plugins/agentparty" },
    ]);

    for (const path of pluginFiles()) {
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      const relativePath = path.slice(pluginRoot.length + 1);
      expect(relativePath.split("/")).not.toContain("..");
      const content = readFileSync(path, "utf8");
      expect(content).not.toMatch(/(?:^|["'\s])\.\.\//m);
    }
  });

  test("keeps Codex generic MCP separate from Claude's channel-enabled MCP", () => {
    const codexMcp = readJson("plugins/agentparty/.mcp.json");
    expect(codexMcp).toEqual({
      mcpServers: {
        agentparty: {
          command: "./bin/agentparty-runtime",
          cwd: ".",
          args: ["mcp"],
        },
      },
    });
    expect(JSON.stringify(codexMcp)).not.toContain("agentparty-channel");

    const claudeMcp = readJson("plugins/agentparty/claude-mcp.json");
    expect(claudeMcp).toEqual({
      mcpServers: {
        agentparty: {
          command: claudeRuntimeCommand,
          args: ["mcp"],
        },
        "agentparty-channel": {
          command: claudeRuntimeCommand,
          args: ["claude-channel", "--require-launch-opt-in"],
        },
      },
    });
    expect(JSON.stringify(claudeMcp)).not.toContain("claude-cross-session-hook");
  });

  test("declares the durable Claude channel and lifecycle visibility hooks", () => {
    const claude = readJson("plugins/agentparty/.claude-plugin/plugin.json");
    expect(claude.channels).toEqual([{ server: "agentparty-channel" }]);
    // Claude automatically loads the standard hooks/hooks.json path. Declaring
    // it again in plugin.json makes the plugin fail with hook-load-failed.
    expect(claude.hooks).toBeUndefined();
    expect(claude.mcpServers).toBe("./claude-mcp.json");
    expect(claude.mcpServers.split("/").at(-1)).not.toStartWith(".");

    const hookConfig = readJson("plugins/agentparty/hooks/hooks.json");
    expect(Object.keys(hookConfig.hooks).sort()).toEqual([
      "Elicitation",
      "ElicitationResult",
      "Notification",
      "PermissionRequest",
      "PostCompact",
      "PostToolUse",
      "PostToolUseFailure",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    for (const [event, entries] of Object.entries(hookConfig.hooks as Record<string, unknown[]>)) {
      const hooks = (entries[0] as { hooks: Array<Record<string, unknown>> }).hooks;
      expect(hooks).toEqual([{
        type: "command",
        command: claudeRuntimeCommand,
        args: ["hook", event === "Stop" ? "stop-guard" : "report"],
        timeout: 10,
      }]);
    }
  });

  test("requires explicit Claude opt-in for the external AgentParty connection", () => {
    const claude = readJson("plugins/agentparty/.claude-plugin/plugin.json");
    expect(claude.defaultEnabled).toBe(false);
    expect(claude.skills).toBe("./skills/");
    expect(claude.mcpServers).toBe("./claude-mcp.json");
  });

  test("exposes the same skill and MCP entry to Codex", () => {
    const codex = readJson("plugins/agentparty/.codex-plugin/plugin.json");
    expect(codex.skills).toBe("./skills/");
    expect(codex.mcpServers).toBe("./.mcp.json");
    expect(codex.interface.displayName).toBe("AgentParty");
  });

  test("resolves the release runtime without relying on the inherited PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "agentparty-plugin-runtime-"));
    const installed = resolve(home, ".local/bin/party");
    mkdirSync(resolve(home, ".local/bin"), { recursive: true });
    writeFileSync(installed, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n");
    chmodSync(installed, 0o755);
    try {
      // #1025 起 hook 在未接入的会话里会在 spawn 之前退出，所以这条「不靠 PATH 也能找到
      // party」的用例带上 launcher 武装过的 opt-in，才真的会走到 exec。
      const result = spawnSync(runtimeLauncher, ["hook", "report"], {
        env: { HOME: home, PATH: "/usr/bin:/bin", AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "1" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("hook report\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // #1025：插件一旦启用就被加载进**每一个** Claude 会话，于是每个生命周期事件都要启动一次
  // 完整的 party——实测每次恒定 ~130ms CPU（与它接下来干什么无关，`party --version` 同样如此）。
  // 而这些会话在 #1018 之后连 MCP 工具面都用不了。这里钉住：没被 AgentParty 启动器武装过的
  // 会话，hook 必须在 spawn 之前就结束，且仍然遵守 #602 铁律（stdout 空、exit 0）。
  describe("hook fast exit for sessions that never joined (#1025)", () => {
    /** 一个会「留下痕迹」的假 party：被 exec 到就写文件，用来证明到底有没有 spawn。 */
    function stubHome(): { home: string; marker: string } {
      const home = mkdtempSync(join(tmpdir(), "agentparty-hook-fastexit-"));
      const marker = join(home, "spawned.txt");
      const installed = resolve(home, ".local/bin/party");
      mkdirSync(resolve(home, ".local/bin"), { recursive: true });
      writeFileSync(installed, `#!/bin/sh\nprintf '%s' spawned > ${marker}\nprintf '%s\\n' "$*"\n`);
      chmodSync(installed, 0o755);
      return { home, marker };
    }

    test("未接入的会话：不启动 party，stdout 为空，exit 0", () => {
      const { home, marker } = stubHome();
      try {
        const result = spawnSync(runtimeLauncher, ["hook", "report"], {
          env: { HOME: home, PATH: "/usr/bin:/bin" },
          input: '{"hook_event_name":"PreToolUse","tool_name":"Bash"}',
          encoding: "utf8",
        });
        expect(existsSync(marker)).toBe(false);   // 真正要证的：进程根本没起
        expect(result.status).toBe(0);            // #602：永远 exit 0
        expect(result.stdout).toBe("");           // #602：stdout 会进模型上下文，必须为空
        expect(result.stderr).toBe("");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("launcher 武装过的会话（AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN=1）：照常启动", () => {
      const { home, marker } = stubHome();
      try {
        const result = spawnSync(runtimeLauncher, ["hook", "report"], {
          env: { HOME: home, PATH: "/usr/bin:/bin", AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "1" },
          encoding: "utf8",
        });
        expect(existsSync(marker)).toBe(true);
        expect(result.stdout).toBe("hook report\n");
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("serve 托管 lane（AP_ACTIVITY_FILE）：照常启动", () => {
      const { home, marker } = stubHome();
      try {
        spawnSync(runtimeLauncher, ["hook", "report"], {
          env: { HOME: home, PATH: "/usr/bin:/bin", AP_ACTIVITY_FILE: join(home, "activity.json") },
          encoding: "utf8",
        });
        expect(existsSync(marker)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("opt-in 只认 \"1\"，且早退只作用于 hook——别的子命令一律照常", () => {
      for (const env of [{ AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "0" }, { AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "" }]) {
        const { home, marker } = stubHome();
        try {
          spawnSync(runtimeLauncher, ["hook", "report"], {
            env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
            encoding: "utf8",
          });
          expect(existsSync(marker)).toBe(false);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
      // mcp / claude-channel 这些常驻入口不受影响：它们本来就只在被显式启动时才跑。
      for (const argv of [["mcp"], ["claude-channel", "--require-launch-opt-in"], ["--version"]]) {
        const { home, marker } = stubHome();
        try {
          spawnSync(runtimeLauncher, argv, { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
          expect(existsSync(marker)).toBe(true);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    });
  });

  test("fails explicitly instead of downloading when a configured runtime is missing", () => {
    const result = spawnSync(runtimeLauncher, ["mcp"], {
      env: {
        HOME: "/nonexistent-agentparty-home",
        PATH: "/usr/bin:/bin",
        AGENTPARTY_RUNTIME_BIN: "/nonexistent-agentparty-runtime/party",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("AGENTPARTY_RUNTIME_BIN is not executable");
    expect(result.stderr).not.toContain("download failed");

    const source = readFileSync(runtimeLauncher, "utf8");
    expect(source).toContain("party runtime not found");
    expect(source).toContain("/reload-plugins");
  });
});
