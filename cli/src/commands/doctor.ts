// party doctor — release version checks plus a no-model Claude plugin readiness audit.
import type { PresenceEntry, RuntimePeerDiscovery, RuntimeTopology } from "@agentparty/shared";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { configResolutionLabel, localAgentConfigsForChannel, readConfigWithSource, resolveChannel } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, fetchPresence, fetchRuntimePeers, RestError, type Identity } from "../rest";
import { stripTerminalControls } from "../format";
import { shellQuote } from "../codex-trust-gate";
import { buildRuntimeTopology } from "../runtime-topology";
import { INSTALL_LINE, OWNER_REPO, RUNNING_VERSION, compareVersions, pendingUpgrade } from "../upgrade";
import { diagnoseCodexWake, formatCodexWakeDiagnosis } from "../wake-diagnosis";
import {
  diagnoseTaskLeaseEnforcement,
  formatTaskLeaseEnforcement,
  localExecutorEvidence,
  shouldSurfaceTaskLeaseEnforcement,
  type LocalExecutorEvidence,
  type TaskLeaseEnforcement,
} from "../task-lease-diagnosis";

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
/**
 * `identity_unavailable` 的分档（#1013）。以前 `deps.identity(...)` 抛任何异常都只记一个词，
 * 而这三种的处置完全相反：超时该重试、401 该重新 join、网络不通该查 server / 代理。
 * 分不出来的才落 `unknown`——它是兜底，不是默认。
 */
export type ClaudeIdentityErrorKind = "timeout" | "unauthorized" | "network" | "unknown";

/**
 * 本机同频道、**已验活**的另一份身份（#1015）。
 *
 * token 被服务端拒了不等于这台机器没得用：`~/.agentparty/agents/` 里常有同频道的好几份 config
 * （换过名字、重发过 token、project-agent 与自建各一份）。真机上三份 ludo 身份里两份 401、
 * 一份 200——只报「有候选」会把人推向那两份死的，所以这里只收**真打过 `/api/me` 且回 200** 的。
 */
export interface ClaudeAlternateIdentity {
  /** /api/me 回的名字（权威），不是 config 里缓存的那个。 */
  name: string;
  /** config 路径，直接拼进 AGENTPARTY_CONFIG=… 用。 */
  path: string;
  server: string;
}

/** 至多探几份、每份多久——诊断不该把终端卡住。 */
const ALTERNATE_IDENTITY_PROBE_LIMIT = 5;
const ALTERNATE_IDENTITY_PROBE_TIMEOUT_MS = 5_000;

/**
 * config 文件里读 token 只发生在这里：`localAgentConfigsForChannel` 按设计不返 token，
 * 读出来的 token 只进 fetch 的 Authorization 头，绝不进 argv / 日志 / 报告字段。
 *
 * server 与 token **一次读出**：分两次读会在文件正被改写时把旧 server 配上新 token，
 * 等于把新凭据发给上一个地址。
 */
function credentialsAt(path: string): { server: string; token: string } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { server?: unknown; token?: unknown };
    if (typeof parsed.server !== "string" || parsed.server === "") return null;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    return { server: parsed.server.replace(/\/+$/, ""), token: parsed.token };
  } catch {
    return null;
  }
}

/**
 * 探活会把**别的 config 的 token** 主动发出去——这是本机诊断顺手扩大的凭据面，所以只发给 https。
 * 明文 http 只放行 loopback（本地起 worker 调试的常规姿势）。
 */
export function safeProbeTarget(server: string): boolean {
  try {
    const url = new URL(server);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1");
  } catch {
    return false;
  }
}

/** 默认实现：同频道兄弟 config 逐个真问 `/api/me`，只留答 200 的。任何异常都当「这份不活」。 */
export async function probeLiveAlternateIdentities(
  channel: string,
  currentConfigPath: string | null,
  fetchIdentity: (server: string, token: string, signal: AbortSignal) => Promise<Identity> = fetchMe,
  home?: string,
): Promise<ClaudeAlternateIdentity[]> {
  const hints = (home === undefined
    ? localAgentConfigsForChannel(channel, currentConfigPath)
    : localAgentConfigsForChannel(channel, currentConfigPath, home)
  ).slice(0, ALTERNATE_IDENTITY_PROBE_LIMIT);
  const probed = await Promise.all(hints.map(async (hint): Promise<ClaudeAlternateIdentity[]> => {
    const credentials = credentialsAt(hint.path);
    if (credentials === null || !safeProbeTarget(credentials.server)) return [];
    try {
      const identity = await fetchIdentity(
        credentials.server,
        credentials.token,
        AbortSignal.timeout(ALTERNATE_IDENTITY_PROBE_TIMEOUT_MS),
      );
      if (identity.kind !== "agent") return [];
      // 频道以 /api/me 的权威答复为准，不认本地 config 里那份缓存（#997 同一教训）：token 还活着
      // 不代表它还属于这个频道——被改过 scope / 重新绑到别的频道，缓存都不会变。报错频道的身份
      // 等于给一条注定失败的命令，比不报更坏。
      //
      // scope 为 null（不限频道的 agent）也不收：/api/me 证明不了它是这个频道的成员，
      // 而这里的断言正是「这是一份能用在 #<channel> 的身份」。漏报只损失一条提示，退回今天的行为。
      if (identity.channel_scope !== channel) return [];
      return [{ name: identity.name, path: hint.path, server: credentials.server }];
    } catch {
      return [];
    }
  }));
  return probed.flat();
}

/** 网络层失败的指纹：fetch 自己只抛一句 "fetch failed"，真正的原因在 cause.code 里。 */
const NETWORK_ERROR_CODES = [
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * 把 `/api/me` 的异常分档，并给出一句可进终端的短说明。
 *
 * 服务端返回的文字**绝不**原样进终端：先 stripTerminalControls（它可能含 ANSI / 控制字符），
 * 再截断——诊断要的是「哪一类」，不是把响应体倒出来。
 */
export function classifyIdentityError(err: unknown): { kind: ClaudeIdentityErrorKind; message: string } {
  const kind = ((): ClaudeIdentityErrorKind => {
    if (err instanceof RestError) {
      if (err.status === 401 || err.status === 403) return "unauthorized";
      // 5xx / 502 之类不是「你的 token 不对」，也不是本机的事：按可达性问题处置（重试 + 查 server）。
      if (err.status >= 500) return "network";
      return "unknown";
    }
    const name = typeof err === "object" && err !== null ? String((err as { name?: unknown }).name ?? "") : "";
    // AbortSignal.timeout() 抛 DOMException("TimeoutError")；老运行时 / 手动 abort 是 AbortError。
    if (name === "TimeoutError" || name === "AbortError") return "timeout";
    const code = errorCode(err);
    if (code !== undefined && NETWORK_ERROR_CODES.includes(code)) return code === "ETIMEDOUT" ? "timeout" : "network";
    const causeCode = errorCode(typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined);
    if (causeCode !== undefined && NETWORK_ERROR_CODES.includes(causeCode)) {
      return causeCode === "ETIMEDOUT" ? "timeout" : "network";
    }
    if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return "network";
    return "unknown";
  })();
  const raw = err instanceof Error ? err.message : String(err);
  const message = stripTerminalControls(raw).replace(/\s+/g, " ").trim().slice(0, 200);
  return { kind, message: message === "" ? kind : message };
}

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
    /** #1013：identity_unavailable 的分档；没有该 blocker 时缺席（旧字段语义不动，只新增）。 */
    identity_error?: ClaudeIdentityErrorKind;
    /** 同上，一句已清洗（stripTerminalControls + 截断）的短说明。 */
    identity_error_message?: string;
    /**
     * #1015：token 被拒时，本机同频道**验活过**的其它身份。只在 identity_error==="unauthorized"
     * 时出现；一份都没验活就是空数组（与「没查」区分不开也无所谓——两种情况修法相同）。
     */
    live_alternate_identities?: ClaudeAlternateIdentity[];
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
  /**
   * #1015：token 被拒时找本机同频道还活着的身份。可选——省略即「不查」（返回空），
   * 这样既有的测试 deps 不必联网，也不会去碰用户真实的 ~/.agentparty。
   */
  liveAlternateIdentities?(channel: string, currentConfigPath: string | null): Promise<ClaudeAlternateIdentity[]>;
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
  liveAlternateIdentities: (channel, currentConfigPath) =>
    probeLiveAlternateIdentities(channel, currentConfigPath),
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
  let identityError: { kind: ClaudeIdentityErrorKind; message: string } | null = null;
  let liveAlternates: ClaudeAlternateIdentity[] = [];
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
    } catch (err) {
      identityError = classifyIdentityError(err);
      blockers.push("identity_unavailable");
    }
  }
  // #1015：token 被拒时，先看这台机器上同频道有没有还活着的身份——有的话修法是「切过去」，
  // 而不是让人去要一个新 token。只收真打过 /api/me 的，未验证的候选一律不报。
  if (identityError?.kind === "unauthorized" && channel !== null && deps.liveAlternateIdentities !== undefined) {
    try {
      liveAlternates = await deps.liveAlternateIdentities(channel, auth.config.path ?? null);
    } catch {
      liveAlternates = [];
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
      ...(identityError === null
        ? {}
        : { identity_error: identityError.kind, identity_error_message: identityError.message }),
      ...(liveAlternates.length === 0 ? {} : { live_alternate_identities: liveAlternates }),
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
    for (const line of claudePluginDoctorFixLines(report)) console.log(line);
  }
  return report.status === "ready" ? 0 : 1;
}

/**
 * Per-blocker fix lines. Pure so the wording is testable.
 *
 * `plugin_version_mismatch` must point at `plugin update` (#961): `claude plugin install` on an
 * already-installed plugin only prints "already installed" and never upgrades, so telling the
 * user to install again leaves them exactly where they are.
 */
export function claudePluginDoctorFixLines(
  report: Pick<ClaudePluginDoctorReport, "blockers" | "plugin" | "runtime_version"> & {
    /** #1013：identity_unavailable 的分档；旧调用方不传也照旧工作（落 unknown 那条兜底文案）。 */
    auth?: Partial<ClaudePluginDoctorReport["auth"]>;
    /** #1015：切身份的修法要把频道名写进命令里；旧调用方不传就退回 `<channel>` 占位。 */
    channel?: Partial<ClaudePluginDoctorReport["channel"]>;
  },
): string[] {
  const lines: string[] = [];
  if (report.blockers.includes("plugin_missing")) {
    lines.push("  fix: claude plugin install agentparty@agentparty && claude plugin enable agentparty@agentparty");
  } else if (report.blockers.includes("plugin_disabled")) {
    lines.push("  fix: claude plugin enable agentparty@agentparty");
  }
  if (report.blockers.includes("plugin_version_mismatch")) {
    const installed = report.plugin.version ?? "?";
    const pluginNewer = report.plugin.version !== undefined &&
      compareVersions(report.plugin.version, report.runtime_version) > 0;
    lines.push(
      pluginNewer
        ? `  fix: party upgrade (installed plugin ${installed} is newer than runtime ${report.runtime_version}; upgrade the CLI, do not downgrade the plugin)`
        : `  fix: claude plugin update agentparty@agentparty (installed ${installed}, runtime ${report.runtime_version}; \`plugin install\` only reports "already installed" and never upgrades), then restart Claude Code`,
    );
  } else if (report.blockers.includes("plugin_bundle_invalid")) {
    lines.push("  fix: claude plugin update agentparty@agentparty, then restart Claude Code");
  }
  if (report.blockers.includes("claude_version_unsupported")) {
    lines.push(`  fix: update Claude Code to >= ${CLAUDE_PLUGIN_MIN_VERSION.join(".")}`);
  }
  if (report.blockers.includes("channel_unbound")) lines.push("  fix: party init --channel <channel>");
  if (report.blockers.includes("identity_unavailable")) {
    // #1013：三种失败的处置完全不同，别再挤成一句「身份读不出来」。
    const detail = report.auth?.identity_error_message;
    const suffix = detail === undefined || detail === "" ? "" : ` (${detail})`;
    switch (report.auth?.identity_error) {
      case "timeout":
        lines.push(`  fix: /api/me did not answer within 5s${suffix}; retry, then check the server with party doctor`);
        break;
      case "unauthorized": {
        const alternates = report.auth?.live_alternate_identities ?? [];
        if (alternates.length === 0) {
          lines.push(
            `  fix: the server rejected this token${suffix}; re-bind an agent token with party init --token <agent-token> --channel <channel> (or party join <invite>)`,
          );
          break;
        }
        // 这台机器上已经有验活的同频道身份：先给「切过去」，那是零等待的修法。
        const channelSlug = report.channel?.slug ?? "<channel>";
        lines.push(`  fix: the server rejected this token${suffix}`);
        for (const alternate of alternates) {
          // name 是服务端给的字符串、path 来自 readdir：进终端前一律清洗，进命令一律 shell 引用，
          // 否则一条「可以直接粘」的修法就成了注入面。
          lines.push(
            `  fix: this machine still has a working #${channelSlug} identity ${stripTerminalControls(alternate.name)} — ` +
              `AGENTPARTY_CONFIG=${shellQuote(alternate.path)} party claude ${shellQuote(channelSlug)}`,
          );
        }
        lines.push("  fix: or re-bind a fresh token with party join <invite>");
        break;
      }
      case "network":
        lines.push(
          `  fix: could not reach the AgentParty server${suffix}; check network/VPN/proxy and the server URL (party whoami shows which server this config points at)`,
        );
        break;
      default:
        lines.push(
          `  fix: could not read this agent identity${suffix}; details: party doctor claude-plugin --json (auth.identity_error)`,
        );
    }
  }
  if (report.blockers.includes("identity_not_agent")) {
    lines.push("  fix: bind an agent token with party init --token <agent-token> --channel <channel>");
  }
  if (report.blockers.includes("plugin_state_unavailable")) {
    lines.push(
      "  fix: `claude plugin list --json` did not answer within 10s (Claude slow, self-updating, or logged out); retry, then check `claude plugin list`",
    );
  }
  if (report.blockers.includes("listener_not_observed")) {
    // #984：doctor 看不到 Claude 的频道 allowlist（它是 Anthropic 远端下发的 ledger，个人账号改不了），
    // 所以直接把「怎么加载、会弹什么」写进结论，而不是让人撞上 "not on the approved channels allowlist" 再回来。
    lines.push(
      "  fix: start a fresh channel session with party claude <channel> (it loads the plugin channel with --dangerously-load-development-channels because the allowedChannelPlugins allowlist is managed-only; Claude shows one \"Loading development channels\" confirmation at startup)",
    );
  }
  return lines;
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

/**
 * 任务租约那一段（#931）。**纯本地、不发网络**：doctor 在断网/没登录时也必须能跑。
 *
 * 「存在多执行体拓扑」的判据取本机可核实的证据（活着的 serve/watch 实例锁、别的执行体持着的
 * 未过期任务租约），而不是服务端的 topology_conflicts——后者要网络与鉴权，doctor 拿不到就
 * 只能沉默，那又回到了本 issue 要根除的静默。代价是：另一条腿在**另一台机器**上时本机看不见，
 * 那正是 #931 的跨机缺口，输出里的「边界」那行会把它说出来。
 */
export async function taskLeaseDoctorLines(
  deps: {
    auth?: () => Promise<{ server?: string; token?: string }>;
    channel?: () => string | null;
    enforcement?: TaskLeaseEnforcement;
    evidence?: LocalExecutorEvidence;
  } = {},
): Promise<string[]> {
  try {
    const enforcement = deps.enforcement ?? diagnoseTaskLeaseEnforcement();
    let evidence = deps.evidence;
    if (evidence === undefined) {
      const auth = await (deps.auth ?? resolveAuthDetailed)();
      const channel = (deps.channel ?? (() => resolveChannel(undefined)))();
      if (!auth.server || !auth.token || channel === null || channel === undefined || channel === "") return [];
      evidence = localExecutorEvidence({
        server: auth.server,
        token: auth.token,
        channel,
        executorId: enforcement.executor_id,
      });
    }
    if (!shouldSurfaceTaskLeaseEnforcement(enforcement, evidence.present)) return [];
    return formatTaskLeaseEnforcement(enforcement, { evidence });
  } catch {
    // 诊断是附赠信息，绝不能把 doctor 本身弄挂。
    return [];
  }
}

function configResolutionDoctorLines(): string[] {
  try {
    const { source } = readConfigWithSource();
    const path = source.path === null ? "none" : stripTerminalControls(source.path);
    return [`identity: config=${path} resolved-by=${configResolutionLabel(source)}`];
  } catch {
    return [];
  }
}

async function runVersionDoctor(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error(HELP);
    return 1;
  }
  // #924：先说「这台机器上被 @ 叫得醒吗」。版本信息永远查得到，而唤醒断了才是用户真正
  // 遇到的那个问题——此前它只在日志里留一行，等于静默。放最前面，一眼可见。
  for (const line of formatCodexWakeDiagnosis(diagnoseCodexWake())) console.log(line);
  // #931：同理，「同一身份的第二个执行体会不会被拦住」也曾只在 stderr 有一行 warn。
  // 只在**真有第二个执行体**时报（无冲突不报，避免每次 doctor 都多一条无关噪音）。
  for (const line of await taskLeaseDoctorLines()) console.log(line);
  // #1052 #2：身份是从哪一步解析出来的（explicit env / claude session registry / workspace /
  // breadcrumb / global）。在 Claude 会话里跑，认出宿主会话就会显示 claude session registry。
  for (const line of configResolutionDoctorLines()) console.log(line);
  console.log("");
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
