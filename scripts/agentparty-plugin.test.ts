import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      const result = spawnSync(runtimeLauncher, ["hook", "report"], {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("hook report\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
