import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  agentPartyPluginInstallCommandPlan,
  assertRequestedClaudeVersion,
  inspectAgentPartyPluginInstall,
  parseAgentPartyPluginList,
  parsePluginInstallAcceptanceArguments,
} from "./verify-agentparty-plugin-install";

const root = resolve(import.meta.dir, "..");
const cleanup: string[] = [];

function installedEntry(installPath: string, enabled: boolean) {
  return {
    id: "agentparty@agentparty",
    version: JSON.parse(readFileSync(resolve(root, "cli/package.json"), "utf8")).version,
    scope: "user",
    enabled,
    installPath,
    mcpServers: {
      agentparty: {
        command: "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime",
        args: ["mcp", "--all-channels"],
      },
      "agentparty-channel": {
        command: "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime",
        args: ["claude-channel", "--require-launch-opt-in"],
      },
    },
  };
}

function fixture() {
  const configDirectory = mkdtempSync(join(tmpdir(), "agentparty-plugin-install-test-"));
  cleanup.push(configDirectory);
  const installPath = join(configDirectory, "plugins/cache/agentparty/agentparty/fixture");
  mkdirSync(installPath, { recursive: true });
  cpSync(resolve(root, "plugins/agentparty"), installPath, { recursive: true });
  return { configDirectory, installPath };
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("AgentParty plugin install acceptance", () => {
  test("uses only plugin-management commands and never starts a model session", () => {
    const plan = agentPartyPluginInstallCommandPlan(root);
    expect(plan).toEqual([
      ["claude", "--version"],
      ["claude", "plugin", "marketplace", "add", root, "--scope", "user"],
      ["claude", "plugin", "install", "agentparty@agentparty", "--scope", "user"],
      ["claude", "plugin", "list", "--json"],
      ["claude", "plugin", "enable", "agentparty@agentparty", "--scope", "user"],
      ["claude", "plugin", "list", "--json"],
    ]);
    const flattened = plan.flat();
    expect(flattened).not.toContain("-p");
    expect(flattened).not.toContain("--print");
    expect(flattened).not.toContain("--plugin-dir");
  });

  test("pins a requested Claude package as a safe bunx prefix without opening arbitrary argv", () => {
    expect(parsePluginInstallAcceptanceArguments([])).toEqual({ claudeCommand: ["claude"] });
    expect(parsePluginInstallAcceptanceArguments([
      "--claude-package-version",
      "2.1.154",
    ])).toEqual({
      claudeCommand: ["bunx", "@anthropic-ai/claude-code@2.1.154"],
      requestedVersion: "2.1.154",
    });
    for (const argv of [
      ["--claude-package-version"],
      ["--claude-package-version", "latest"],
      ["--claude-package-version", "2.1.154", "--print"],
      ["--claude-command", "claude"],
    ]) {
      expect(() => parsePluginInstallAcceptanceArguments(argv)).toThrow();
    }

    const plan = agentPartyPluginInstallCommandPlan(root, [
      "bunx",
      "@anthropic-ai/claude-code@2.1.154",
    ]);
    expect(plan[0]).toEqual(["bunx", "@anthropic-ai/claude-code@2.1.154", "--version"]);
    expect(plan[1]?.slice(0, 5)).toEqual([
      "bunx",
      "@anthropic-ai/claude-code@2.1.154",
      "plugin",
      "marketplace",
      "add",
    ]);
    expect(plan.flat()).not.toContain("-p");
    expect(plan.flat()).not.toContain("--print");
  });

  test("binds the requested package version to the executable that actually ran", () => {
    expect(() => assertRequestedClaudeVersion("2.1.154 (Claude Code)", "2.1.154")).not.toThrow();
    expect(() => assertRequestedClaudeVersion("2.1.232 (Claude Code)", "2.1.154")).toThrow(
      "resolved Claude package version did not match",
    );
    expect(() => assertRequestedClaudeVersion("wrapper 2.1.154", "2.1.154")).toThrow();
    expect(() => assertRequestedClaudeVersion("anything", undefined)).not.toThrow();
  });

  test("proves disabled-by-default install, channel/hooks, exact MCP, and exact cached copy", () => {
    const { configDirectory, installPath } = fixture();
    expect(inspectAgentPartyPluginInstall(
      root,
      configDirectory,
      [installedEntry(installPath, false)],
      [installedEntry(installPath, true)],
    )).toEqual({
      plugin_version: JSON.parse(readFileSync(resolve(root, "cli/package.json"), "utf8")).version,
      marketplace_added: true,
      installed_disabled_by_default: true,
      enabled_after_explicit_enable: true,
      cached_bundle_exact: true,
      generic_mcp_exact: true,
      channel_mcp_exact: true,
      channel_declared: true,
      lifecycle_hooks_present: true,
      standard_hooks_autoload_safe: true,
      claude_mcp_manifest_visible: true,
      runtime_launcher_executable: true,
      runtime_path_resolution_verified: true,
      model_calls_started: false,
    });
  });

  test("fails closed when the cached plugin changes or enablement skips the opt-in", () => {
    const changed = fixture();
    writeFileSync(join(changed.installPath, ".mcp.json"), '{"mcpServers":{}}\n');
    expect(() => inspectAgentPartyPluginInstall(
      root,
      changed.configDirectory,
      [installedEntry(changed.installPath, false)],
      [installedEntry(changed.installPath, true)],
    )).toThrow("cached plugin differed");

    const enabledEarly = fixture();
    expect(() => inspectAgentPartyPluginInstall(
      root,
      enabledEarly.configDirectory,
      [installedEntry(enabledEarly.installPath, true)],
      [installedEntry(enabledEarly.installPath, true)],
    )).toThrow("plugin enablement or version did not match");
  });

  test("parses only complete plugin list entries", () => {
    const { installPath } = fixture();
    expect(parseAgentPartyPluginList(JSON.stringify([installedEntry(installPath, false)]))).toHaveLength(1);
    expect(() => parseAgentPartyPluginList("not-json")).toThrow("plugin list was not JSON");
    expect(() => parseAgentPartyPluginList(JSON.stringify([{ id: "agentparty@agentparty" }]))).toThrow(
      "plugin list entry was malformed",
    );
  });
});
