#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ACCEPTANCE_SCHEMA = "agentparty.plugin-install-acceptance.v1";
const PLUGIN_ID = "agentparty@agentparty";
const COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

export type PluginInstallAcceptanceErrorCode =
  | "invalid_arguments"
  | "claude_unavailable"
  | "claude_version_mismatch"
  | "marketplace_add_failed"
  | "plugin_install_failed"
  | "plugin_list_failed"
  | "plugin_enable_failed"
  | "plugin_state_invalid"
  | "cached_bundle_mismatch"
  | "internal_error";

export class PluginInstallAcceptanceError extends Error {
  constructor(readonly code: PluginInstallAcceptanceErrorCode, message: string) {
    super(message);
    this.name = "PluginInstallAcceptanceError";
  }
}

interface InstalledPluginEntry {
  id: string;
  version: string;
  scope: string;
  enabled: boolean;
  installPath: string;
  mcpServers?: unknown;
}

export interface PluginInstallAcceptanceEvidence {
  plugin_version: string;
  marketplace_added: true;
  installed_disabled_by_default: true;
  enabled_after_explicit_enable: true;
  cached_bundle_exact: true;
  generic_mcp_exact: true;
  channel_mcp_exact: true;
  channel_declared: true;
  lifecycle_hooks_present: true;
  standard_hooks_autoload_safe: true;
  claude_mcp_manifest_visible: true;
  runtime_launcher_executable: true;
  runtime_path_resolution_verified: true;
  model_calls_started: false;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentPartyPluginInstallCommandPlan(
  marketplaceRoot: string,
  claudeCommand: readonly string[] = ["claude"],
): string[][] {
  if (claudeCommand.length === 0 || claudeCommand.some((arg) => arg === "")) {
    throw new PluginInstallAcceptanceError("invalid_arguments", "Claude command prefix was empty");
  }
  const command = (...args: string[]): string[] => [...claudeCommand, ...args];
  return [
    command("--version"),
    command("plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"),
    command("plugin", "install", PLUGIN_ID, "--scope", "user"),
    command("plugin", "list", "--json"),
    command("plugin", "enable", PLUGIN_ID, "--scope", "user"),
    command("plugin", "list", "--json"),
  ];
}

export function parsePluginInstallAcceptanceArguments(argv: readonly string[]): {
  claudeCommand: string[];
  requestedVersion?: string;
} {
  if (argv.length === 0) return { claudeCommand: ["claude"] };
  if (argv.length !== 2 || argv[0] !== "--claude-package-version") {
    throw new PluginInstallAcceptanceError("invalid_arguments", "invalid Plugin install acceptance arguments");
  }
  const version = argv[1]!;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new PluginInstallAcceptanceError("invalid_arguments", "Claude package version must be an exact stable semver");
  }
  return {
    claudeCommand: ["bunx", `@anthropic-ai/claude-code@${version}`],
    requestedVersion: version,
  };
}

export function assertRequestedClaudeVersion(actual: string, requested?: string): void {
  if (requested === undefined) return;
  const match = actual.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$|\()/);
  if (match?.[1] !== requested) {
    throw new PluginInstallAcceptanceError(
      "claude_version_mismatch",
      "resolved Claude package version did not match the exact request",
    );
  }
}

export function parseAgentPartyPluginList(source: string): InstalledPluginEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "plugin list was not JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "plugin list was not an array");
  }
  return parsed.flatMap((value) => {
    if (
      !record(value) || typeof value.id !== "string" || typeof value.version !== "string" ||
      typeof value.scope !== "string" || typeof value.enabled !== "boolean" ||
      typeof value.installPath !== "string"
    ) {
      throw new PluginInstallAcceptanceError("plugin_state_invalid", "plugin list entry was malformed");
    }
    return [{
      id: value.id,
      version: value.version,
      scope: value.scope,
      enabled: value.enabled,
      installPath: value.installPath,
      mcpServers: value.mcpServers,
    }];
  });
}

function onlyAgentPartyPlugin(entries: readonly InstalledPluginEntry[]): InstalledPluginEntry {
  const matches = entries.filter((entry) => entry.id === PLUGIN_ID);
  if (matches.length !== 1) {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "expected one AgentParty plugin");
  }
  return matches[0]!;
}

function treeSnapshot(root: string): [string, string][] {
  const visit = (directory: string): [string, string][] => readdirSync(directory, { withFileTypes: true })
    .flatMap((entry): [string, string][] => {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new PluginInstallAcceptanceError("cached_bundle_mismatch", "plugin bundle contains a symlink");
      }
      if (stat.isDirectory()) return visit(path);
      if (!stat.isFile()) {
        throw new PluginInstallAcceptanceError("cached_bundle_mismatch", "plugin bundle contains a special file");
      }
      return [[
        relative(root, path),
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]];
    });
  return visit(root).sort(([left], [right]) => left.localeCompare(right));
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export function inspectAgentPartyPluginInstall(
  marketplaceRoot: string,
  configDirectory: string,
  beforeEntries: readonly InstalledPluginEntry[],
  afterEntries: readonly InstalledPluginEntry[],
): PluginInstallAcceptanceEvidence {
  const pluginRoot = realpathSync(resolve(marketplaceRoot, "plugins/agentparty"));
  const expectedVersion = JSON.parse(
    readFileSync(resolve(marketplaceRoot, "cli/package.json"), "utf8"),
  ).version as unknown;
  if (typeof expectedVersion !== "string" || expectedVersion === "") {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "CLI version was unavailable");
  }

  const before = onlyAgentPartyPlugin(beforeEntries);
  const after = onlyAgentPartyPlugin(afterEntries);
  if (
    before.scope !== "user" || after.scope !== "user" || before.version !== expectedVersion ||
    after.version !== expectedVersion || before.installPath !== after.installPath || before.enabled !== false ||
    after.enabled !== true
  ) {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "plugin enablement or version did not match");
  }

  const installPath = realpathSync(before.installPath);
  const cacheRoot = realpathSync(resolve(configDirectory, "plugins/cache"));
  if (!isInside(cacheRoot, installPath)) {
    throw new PluginInstallAcceptanceError("cached_bundle_mismatch", "plugin was not installed inside the isolated cache");
  }
  if (JSON.stringify(treeSnapshot(pluginRoot)) !== JSON.stringify(treeSnapshot(installPath))) {
    throw new PluginInstallAcceptanceError("cached_bundle_mismatch", "cached plugin differed from the source bundle");
  }
  const runtimeLauncher = resolve(installPath, "bin/agentparty-runtime");
  if ((lstatSync(runtimeLauncher).mode & 0o111) === 0) {
    throw new PluginInstallAcceptanceError("cached_bundle_mismatch", "cached runtime launcher was not executable");
  }
  const runtimeProbe = resolve(configDirectory, "runtime-probe");
  writeFileSync(runtimeProbe, "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", { mode: 0o700 });
  const runtimeResult = spawnSync(runtimeLauncher, ["hook", "report"], {
    env: {
      HOME: configDirectory,
      PATH: "/usr/bin:/bin",
      AGENTPARTY_RUNTIME_BIN: runtimeProbe,
      // #1025 起，未被 AgentParty 启动器武装过的会话里 hook 会在 spawn 之前退出。
      // 这里要验的是「缓存副本里的 launcher 能解析到配置的 party」，所以必须走到 exec，
      // 带上 launcher 自己会设的 opt-in。
      AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "1",
    },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  rmSync(runtimeProbe, { force: true });
  if (runtimeResult.error !== undefined || runtimeResult.status !== 0 ||
      runtimeResult.stdout !== "hook report\n" || runtimeResult.stderr !== "") {
    throw new PluginInstallAcceptanceError("cached_bundle_mismatch", "cached runtime launcher did not resolve the configured party binary");
  }

  const expectedMcp = {
    agentparty: {
      command: "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime",
      args: ["mcp"],
    },
    "agentparty-channel": {
      command: "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime",
      args: ["claude-channel", "--require-launch-opt-in"],
    },
  };
  if (JSON.stringify(before.mcpServers) !== JSON.stringify(expectedMcp) ||
      JSON.stringify(after.mcpServers) !== JSON.stringify(expectedMcp)) {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "AgentParty plugin MCP entries did not match");
  }

  const manifest = JSON.parse(
    readFileSync(resolve(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  if (JSON.stringify(manifest.channels) !== JSON.stringify([{ server: "agentparty-channel" }])) {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "AgentParty channel declaration did not match");
  }
  if (manifest.hooks !== undefined) {
    throw new PluginInstallAcceptanceError(
      "plugin_state_invalid",
      "standard hooks/hooks.json must not be declared twice in plugin.json",
    );
  }
  if (manifest.mcpServers !== "./claude-mcp.json") {
    throw new PluginInstallAcceptanceError(
      "plugin_state_invalid",
      "Claude MCP manifest must use the visible claude-mcp.json path",
    );
  }
  const hookConfig = JSON.parse(
    readFileSync(resolve(pluginRoot, "hooks/hooks.json"), "utf8"),
  ) as { hooks?: Record<string, unknown> };
  const requiredHookEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Notification",
    "PreCompact",
    "PostCompact",
    "Elicitation",
    "ElicitationResult",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ];
  if (hookConfig.hooks === undefined ||
      requiredHookEvents.some((event) => !(event in hookConfig.hooks!))) {
    throw new PluginInstallAcceptanceError("plugin_state_invalid", "AgentParty lifecycle hooks were incomplete");
  }

  return {
    plugin_version: expectedVersion,
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
  };
}

function runClaudeCommand(
  command: readonly string[],
  configDirectory: string,
  cwd: string,
  failureCode: PluginInstallAcceptanceErrorCode,
): string {
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory },
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new PluginInstallAcceptanceError(
      failureCode === "claude_unavailable" ? failureCode : "internal_error",
      "Claude plugin command could not start",
    );
  }
  if (result.status !== 0) {
    throw new PluginInstallAcceptanceError(failureCode, "Claude plugin command failed");
  }
  return result.stdout;
}

export async function runAgentPartyPluginInstallAcceptance(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`usage: bun scripts/verify-agentparty-plugin-install.ts [--claude-package-version X.Y.Z]

Uses a private temporary CLAUDE_CONFIG_DIR to add this checkout as a local
marketplace, install AgentParty disabled, enable it explicitly, and compare
Claude's cached copy with the source plugin. It starts no model session and
deletes the temporary configuration on every exit.`);
    return 0;
  }
  let parsedArgs: ReturnType<typeof parsePluginInstallAcceptanceArguments>;
  try {
    parsedArgs = parsePluginInstallAcceptanceArguments(argv);
  } catch {
    console.log(JSON.stringify({
      schema: ACCEPTANCE_SCHEMA,
      status: "failed",
      error_code: "invalid_arguments",
      model_calls_started: false,
    }, null, 2));
    return 9;
  }

  const marketplaceRoot = resolve(import.meta.dir, "..");
  const configDirectory = mkdtempSync(join(tmpdir(), "agentparty-plugin-install-"));
  chmodSync(configDirectory, 0o700);
  const commands = agentPartyPluginInstallCommandPlan(marketplaceRoot, parsedArgs.claudeCommand);
  try {
    const claudeVersion = runClaudeCommand(commands[0]!, configDirectory, marketplaceRoot, "claude_unavailable").trim();
    assertRequestedClaudeVersion(claudeVersion, parsedArgs.requestedVersion);
    runClaudeCommand(commands[1]!, configDirectory, marketplaceRoot, "marketplace_add_failed");
    runClaudeCommand(commands[2]!, configDirectory, marketplaceRoot, "plugin_install_failed");
    const before = parseAgentPartyPluginList(
      runClaudeCommand(commands[3]!, configDirectory, marketplaceRoot, "plugin_list_failed"),
    );
    runClaudeCommand(commands[4]!, configDirectory, marketplaceRoot, "plugin_enable_failed");
    const after = parseAgentPartyPluginList(
      runClaudeCommand(commands[5]!, configDirectory, marketplaceRoot, "plugin_list_failed"),
    );
    const evidence = inspectAgentPartyPluginInstall(marketplaceRoot, configDirectory, before, after);
    console.log(JSON.stringify({
      schema: ACCEPTANCE_SCHEMA,
      status: "passed",
      claude_version: claudeVersion,
      ...(parsedArgs.requestedVersion === undefined
        ? {}
        : {
            claude_package_version_requested: parsedArgs.requestedVersion,
            claude_version_matches_request: true,
          }),
      ...evidence,
    }, null, 2));
    return 0;
  } catch (error) {
    const code = error instanceof PluginInstallAcceptanceError ? error.code : "internal_error";
    console.log(JSON.stringify({
      schema: ACCEPTANCE_SCHEMA,
      status: "failed",
      error_code: code,
      model_calls_started: false,
    }, null, 2));
    return 1;
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runAgentPartyPluginInstallAcceptance(process.argv.slice(2)).then((code) => process.exit(code));
}
