// party doctor — release version checks plus a no-model Claude plugin readiness audit.
import type { PresenceEntry, RuntimePeerDiscovery, RuntimeTopology } from "@agentparty/shared";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, fetchPresence, fetchRuntimePeers, type Identity } from "../rest";
import { buildRuntimeTopology } from "../runtime-topology";
import { INSTALL_LINE, OWNER_REPO, RUNNING_VERSION, compareVersions, pendingUpgrade } from "../upgrade";

const CLAUDE_PLUGIN_ID = "agentparty@agentparty";
const CLAUDE_PLUGIN_SCHEMA = "agentparty.claude-plugin-doctor.v1";
const CLAUDE_RUNTIME_COMMAND = "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime";
export const CLAUDE_PLUGIN_MIN_VERSION = [2, 1, 154] as const;
const REQUIRED_HOOK_EVENTS = [
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
] as const;
const HELP = `usage: party doctor
       party doctor claude-plugin [--channel C] [--json]

Without a subcommand, compare the running, installed, and latest party version.
claude-plugin performs a read-only, no-model audit of the installed Marketplace
plugin, AgentParty auth/channel access, and an observable durable listener.`;

export type ClaudePluginDoctorBlocker =
  | "claude_unavailable"
  | "claude_version_unsupported"
  | "plugin_state_unavailable"
  | "plugin_missing"
  | "plugin_disabled"
  | "plugin_version_mismatch"
  | "plugin_bundle_invalid"
  | "auth_required"
  | "identity_unavailable"
  | "identity_not_agent"
  | "channel_unbound"
  | "channel_unavailable"
  | "listener_not_observed"
  | "listener_suspect"
  | "listener_deaf";
export type ClaudePluginDoctorWarning =
  | "activity_not_observed"
  | "topology_not_observed"
  | "topology_unavailable";
export type ClaudePluginShellBlocker = Extract<
  ClaudePluginDoctorBlocker,
  | "claude_unavailable"
  | "claude_version_unsupported"
  | "plugin_state_unavailable"
  | "plugin_missing"
  | "plugin_disabled"
  | "plugin_version_mismatch"
  | "plugin_bundle_invalid"
>;

interface InstalledClaudePlugin {
  id: string;
  version: string;
  enabled: boolean;
  installPath: string;
  mcpServers?: unknown;
}

export interface ClaudePluginBundleInspection {
  valid: boolean;
  launcherExecutable: boolean;
}

export interface ClaudePluginShellInspection {
  status: "ready" | ClaudePluginShellBlocker;
  blockers: ClaudePluginShellBlocker[];
  runtime_version: string;
  claude_version?: string;
  plugin: {
    installed: boolean;
    enabled: boolean;
    version?: string;
    bundle_valid: boolean;
    launcher_executable: boolean;
  };
  model_calls_started: false;
}

export interface ClaudePluginDoctorReport {
  schema: typeof CLAUDE_PLUGIN_SCHEMA;
  status: "ready" | ClaudePluginDoctorBlocker;
  blockers: ClaudePluginDoctorBlocker[];
  warnings: ClaudePluginDoctorWarning[];
  runtime_version: string;
  claude_version?: string;
  plugin: {
    installed: boolean;
    enabled: boolean;
    version?: string;
    bundle_valid: boolean;
    launcher_executable: boolean;
  };
  auth: {
    configured: boolean;
    source: "runtime_config" | "account_session" | "none";
    identity?: string;
  };
  channel: {
    slug?: string;
    access: "confirmed" | "not_checked" | "unavailable";
    listener: "healthy" | "suspect" | "deaf" | "not_observed" | "not_checked";
    activity_visibility: "observed" | "not_observed" | "not_checked";
    topology_visibility: "observed" | "not_observed" | "unavailable" | "not_checked";
    activity?: PresenceEntry["activity"];
  };
  model_calls_started: false;
}

export interface ClaudePluginDoctorDependencies {
  claudeVersion(): string | null;
  claudePlugins(): InstalledClaudePlugin[] | null;
  inspectBundle(plugin: InstalledClaudePlugin): ClaudePluginBundleInspection;
  resolveAuth(): ReturnType<typeof resolveAuthDetailed>;
  channel(explicit?: string): string | null;
  identity(server: string, token: string, signal: AbortSignal): Promise<Identity>;
  presence(server: string, token: string, channel: string, signal: AbortSignal): Promise<PresenceEntry[]>;
  runtimeTopology(server: string): RuntimeTopology | undefined;
  runtimePeers(
    server: string,
    token: string,
    channel: string,
    topology: RuntimeTopology,
    signal: AbortSignal,
  ): Promise<RuntimePeerDiscovery>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsAgentPartyClaudePlugin(raw: string): boolean {
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|\()/);
  if (match === null) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < CLAUDE_PLUGIN_MIN_VERSION.length; index += 1) {
    if (actual[index]! > CLAUDE_PLUGIN_MIN_VERSION[index]!) return true;
    if (actual[index]! < CLAUDE_PLUGIN_MIN_VERSION[index]!) return false;
  }
  return true;
}

export function parseClaudePluginList(source: string): InstalledClaudePlugin[] | null {
  try {
    const value = JSON.parse(source) as unknown;
    if (!Array.isArray(value)) return null;
    return value.flatMap((entry): InstalledClaudePlugin[] => {
      if (!record(entry) || typeof entry.id !== "string" || typeof entry.version !== "string" ||
          typeof entry.enabled !== "boolean" || typeof entry.installPath !== "string") return [];
      return [{
        id: entry.id,
        version: entry.version,
        enabled: entry.enabled,
        installPath: entry.installPath,
        mcpServers: entry.mcpServers,
      }];
    });
  } catch {
    return null;
  }
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function inspectClaudePluginBundle(plugin: InstalledClaudePlugin): ClaudePluginBundleInspection {
  try {
    const root = realpathSync(plugin.installPath);
    const launcher = resolve(root, "bin/agentparty-runtime");
    const stat = lstatSync(launcher);
    const launcherExecutable = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
    const manifest = json(resolve(root, ".claude-plugin/plugin.json"));
    const hooks = json(resolve(root, "hooks/hooks.json"));
    const expectedMcp = {
      agentparty: { command: CLAUDE_RUNTIME_COMMAND, args: ["mcp"] },
      "agentparty-channel": {
        command: CLAUDE_RUNTIME_COMMAND,
        args: ["claude-channel", "--require-launch-opt-in"],
      },
    };
    if (!record(manifest) || manifest.version !== plugin.version || manifest.defaultEnabled !== false ||
        JSON.stringify(manifest.channels) !== JSON.stringify([{ server: "agentparty-channel" }]) ||
        JSON.stringify(plugin.mcpServers) !== JSON.stringify(expectedMcp) || !record(hooks) ||
        !record(hooks.hooks)) return { valid: false, launcherExecutable };
    for (const event of REQUIRED_HOOK_EVENTS) {
      const entries = hooks.hooks[event];
      if (!Array.isArray(entries) || entries.length !== 1 || !record(entries[0]) ||
          !Array.isArray(entries[0].hooks) || entries[0].hooks.length !== 1 ||
          !record(entries[0].hooks[0]) || entries[0].hooks[0].command !== CLAUDE_RUNTIME_COMMAND ||
          !Array.isArray(entries[0].hooks[0].args) ||
          entries[0].hooks[0].args[0] !== "hook" ||
          entries[0].hooks[0].args[1] !== (event === "Stop" ? "stop-guard" : "report")) {
        return { valid: false, launcherExecutable };
      }
    }
    return { valid: launcherExecutable, launcherExecutable };
  } catch {
    return { valid: false, launcherExecutable: false };
  }
}

function claude(args: string[]): string | null {
  const result = spawnSync("claude", args, {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.error === undefined && result.status === 0 ? result.stdout.trim() : null;
}

export const defaultClaudePluginDoctorDependencies: ClaudePluginDoctorDependencies = {
  claudeVersion: () => claude(["--version"]),
  claudePlugins: () => {
    const source = claude(["plugin", "list", "--json"]);
    return source === null ? null : parseClaudePluginList(source);
  },
  inspectBundle: inspectClaudePluginBundle,
  resolveAuth: resolveAuthDetailed,
  channel: resolveChannel,
  identity: fetchMe,
  presence: fetchPresence,
  // `doctor` remains read-only. A live party claude listener has already
  // created the private installation secret; absence is reported, not repaired.
  runtimeTopology: (server) => buildRuntimeTopology(server, process.cwd(), { createSecret: false }),
  runtimePeers: (server, token, channel, topology, signal) =>
    fetchRuntimePeers(server, token, channel, topology, "topology_advisory", signal),
};

/**
 * Inspect only the Marketplace shell that supplies Claude lifecycle hooks.
 * This deliberately performs no AgentParty auth, channel, presence, listener,
 * or model work so launchers can compose it with their own transport checks
 * without duplicating network probes or confusing a pre-launch listener miss
 * with a broken plugin.
 */
export function inspectClaudePluginShell(
  deps: Pick<
    ClaudePluginDoctorDependencies,
    "claudeVersion" | "claudePlugins" | "inspectBundle"
  > = defaultClaudePluginDoctorDependencies,
): ClaudePluginShellInspection {
  const blockers: ClaudePluginShellBlocker[] = [];
  const claudeVersion = deps.claudeVersion();
  const plugins = claudeVersion === null ? null : deps.claudePlugins();
  if (claudeVersion === null) blockers.push("claude_unavailable");
  else {
    if (!supportsAgentPartyClaudePlugin(claudeVersion)) blockers.push("claude_version_unsupported");
    if (plugins === null) blockers.push("plugin_state_unavailable");
  }

  const plugin = plugins?.find((entry) => entry.id === CLAUDE_PLUGIN_ID) ?? null;
  let bundle: ClaudePluginBundleInspection = { valid: false, launcherExecutable: false };
  if (plugin === null) {
    if (plugins !== null) blockers.push("plugin_missing");
  } else {
    if (!plugin.enabled) blockers.push("plugin_disabled");
    if (plugin.version !== RUNNING_VERSION) blockers.push("plugin_version_mismatch");
    bundle = deps.inspectBundle(plugin);
    if (!bundle.valid) blockers.push("plugin_bundle_invalid");
  }

  return {
    status: blockers[0] ?? "ready",
    blockers,
    runtime_version: RUNNING_VERSION,
    ...(claudeVersion === null ? {} : { claude_version: claudeVersion }),
    plugin: {
      installed: plugin !== null,
      enabled: plugin?.enabled ?? false,
      ...(plugin === null ? {} : { version: plugin.version }),
      bundle_valid: bundle.valid,
      launcher_executable: bundle.launcherExecutable,
    },
    model_calls_started: false,
  };
}

function listenerFor(entries: PresenceEntry[], identity: string): PresenceEntry | null {
  const candidates = entries.filter((entry) =>
    entry.name === identity && entry.live === true && entry.wake?.kind === "daemon" && entry.residency === "daemon"
  );
  return candidates.sort((left, right) => (right.last_seen ?? right.ts) - (left.last_seen ?? left.ts))[0] ?? null;
}

export async function inspectClaudePluginReadiness(
  explicitChannel: string | undefined,
  deps: ClaudePluginDoctorDependencies = defaultClaudePluginDoctorDependencies,
): Promise<ClaudePluginDoctorReport> {
  const blockers: ClaudePluginDoctorBlocker[] = [];
  const warnings: ClaudePluginDoctorWarning[] = [];
  const shell = inspectClaudePluginShell(deps);
  blockers.push(...shell.blockers);

  const auth = await deps.resolveAuth();
  if (!auth.server || !auth.token) blockers.push("auth_required");
  const channel = deps.channel(explicitChannel);
  if (channel === null) blockers.push("channel_unbound");

  let identity: Identity | null = null;
  let access: ClaudePluginDoctorReport["channel"]["access"] = "not_checked";
  let listener: ClaudePluginDoctorReport["channel"]["listener"] = "not_checked";
  let activityVisibility: ClaudePluginDoctorReport["channel"]["activity_visibility"] = "not_checked";
  let topologyVisibility: ClaudePluginDoctorReport["channel"]["topology_visibility"] = "not_checked";
  let activity: PresenceEntry["activity"];
  let active: PresenceEntry | null = null;
  if (auth.server && auth.token) {
    try {
      identity = await deps.identity(auth.server, auth.token, AbortSignal.timeout(5_000));
      if (identity.kind !== "agent") blockers.push("identity_not_agent");
    } catch {
      blockers.push("identity_unavailable");
    }
  }
  if (auth.server && auth.token && identity?.kind === "agent" && channel !== null) {
    try {
      const presence = await deps.presence(auth.server, auth.token, channel, AbortSignal.timeout(5_000));
      access = "confirmed";
      active = listenerFor(presence, identity.name);
      if (active === null) {
        listener = "not_observed";
        blockers.push("listener_not_observed");
      } else if (active.listening === "deaf") {
        listener = "deaf";
        blockers.push("listener_deaf");
        activity = active.activity;
      } else if (active.listening === "suspect") {
        listener = "suspect";
        blockers.push("listener_suspect");
        activity = active.activity;
      } else {
        listener = "healthy";
        activity = active.activity;
      }
      if (active !== null) {
        activityVisibility = active.activity === undefined ? "not_observed" : "observed";
        if (active.activity === undefined) warnings.push("activity_not_observed");
      }
    } catch {
      access = "unavailable";
      listener = "not_checked";
      blockers.push("channel_unavailable");
    }
  }
  if (auth.server && auth.token && identity?.kind === "agent" && channel !== null && active !== null) {
    const topology = deps.runtimeTopology(auth.server);
    if (topology === undefined) {
      topologyVisibility = "unavailable";
      warnings.push("topology_unavailable");
    } else {
      try {
        const discovery = await deps.runtimePeers(
          auth.server,
          auth.token,
          channel,
          topology,
          AbortSignal.timeout(5_000),
        );
        const observed = discovery.self === identity.name && discovery.peers.some((peer) =>
          peer.agent === identity.name &&
          peer.same_identity &&
          peer.relations.some((relation) => relation.runtime_count > 0)
        );
        topologyVisibility = observed ? "observed" : "not_observed";
        if (!observed) warnings.push("topology_not_observed");
      } catch {
        topologyVisibility = "unavailable";
        warnings.push("topology_unavailable");
      }
    }
  }

  return {
    schema: CLAUDE_PLUGIN_SCHEMA,
    status: blockers[0] ?? "ready",
    blockers,
    warnings,
    runtime_version: RUNNING_VERSION,
    ...(shell.claude_version === undefined ? {} : { claude_version: shell.claude_version }),
    plugin: shell.plugin,
    auth: {
      configured: auth.server !== null && auth.token !== null,
      source: auth.auth_source,
      ...(identity === null ? {} : { identity: identity.name }),
    },
    channel: {
      ...(channel === null ? {} : { slug: channel }),
      access,
      listener,
      activity_visibility: activityVisibility,
      topology_visibility: topologyVisibility,
      ...(activity === undefined ? {} : { activity }),
    },
    model_calls_started: false,
  };
}

async function runClaudePluginDoctor(
  argv: string[],
  deps: ClaudePluginDoctorDependencies = defaultClaudePluginDoctorDependencies,
): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
  const unknown = unknownFlagError(flags, ["channel", "json"]);
  const flagError = valueFlagError(flags, ["channel"]);
  if (unknown !== null || flagError !== null || positionals.length > 0) {
    console.error(unknown ?? flagError ?? "unexpected positional argument");
    return 1;
  }
  const report = await inspectClaudePluginReadiness(str(flags.channel), deps);
  if (flags.json === true) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`claude-plugin: ${report.status}`);
    console.log(`  runtime: ${report.runtime_version}`);
    console.log(`  plugin: ${report.plugin.installed ? (report.plugin.enabled ? "enabled" : "disabled") : "missing"}`);
    console.log(`  auth: ${report.auth.configured ? `configured (${report.auth.source})` : "required"}`);
    console.log(`  channel: ${report.channel.slug ?? "unbound"} (${report.channel.access})`);
    console.log(`  listener: ${report.channel.listener}`);
    console.log(`  activity: ${report.channel.activity_visibility}`);
    console.log(`  topology: ${report.channel.topology_visibility}`);
    if (report.blockers.length > 0) console.log(`  blockers: ${report.blockers.join(", ")}`);
    if (report.warnings.length > 0) console.log(`  warnings: ${report.warnings.join(", ")}`);
    if (report.blockers.includes("plugin_missing")) {
      console.log("  fix: claude plugin install agentparty@agentparty && claude plugin enable agentparty@agentparty");
    } else if (report.blockers.includes("plugin_disabled")) {
      console.log("  fix: claude plugin enable agentparty@agentparty");
    }
    if (report.blockers.includes("claude_version_unsupported")) {
      console.log(`  fix: update Claude Code to >= ${CLAUDE_PLUGIN_MIN_VERSION.join(".")}`);
    }
    if (report.blockers.includes("channel_unbound")) console.log("  fix: party init --channel <channel>");
    if (report.blockers.includes("identity_not_agent")) {
      console.log("  fix: bind an agent token with party init --token <agent-token> --channel <channel>");
    }
    if (report.blockers.includes("listener_not_observed")) {
      console.log("  fix: start a fresh channel session with party claude <channel>");
    }
  }
  return report.status === "ready" ? 0 : 1;
}

// Latest release: follow the releases/latest redirect, matching install.sh.
async function latestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://github.com/${OWNER_REPO}/releases/latest`, {
      method: "HEAD",
      redirect: "follow",
    });
    const m = res.url.match(/\/tag\/v?(\d+\.\d+\.\d+)/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

async function runVersionDoctor(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(HELP);
    return 1;
  }
  console.log(`running:   ${RUNNING_VERSION}`);
  const pending = pendingUpgrade();
  if (pending) {
    console.log(`installed: ${pending}  ← 磁盘已是更新版；正在跑的 serve 需要【重启】才能用上`);
    console.log("  重启在跑的 serve（或加 --auto-upgrade 让它唤醒间隙自动 re-exec）");
  }
  const latest = await latestVersion();
  if (latest === null) {
    console.log("latest:    (查不到，网络问题？可手动看 github releases)");
    return 0;
  }
  console.log(`latest:    ${latest}`);
  if (compareVersions(latest, RUNNING_VERSION) > 0) {
    console.log(`\n有新版可升 → 升级：\n  party upgrade\n  ${INSTALL_LINE}\n升级后【重启在跑的 serve/watch】才生效；serve --auto-upgrade 会在安全点自动 re-exec。`);
  } else {
    console.log("\n已是最新。");
  }
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  if (argv[0] === "claude-plugin") return runClaudePluginDoctor(argv.slice(1));
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  return runVersionDoctor(argv);
}
