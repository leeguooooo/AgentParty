// party bridge — attach AgentParty to an already-open interactive harness session.
//
// The Claude lane uses Claude Code's dedicated experimental `claude/channel`
// capability. This is intentionally different from ordinary MCP notifications:
// a channel notification is a harness-supported input path that queues a new
// turn in the current session, while logging/resource/tool-list notifications
// remain diagnostics and must never be treated as delivery.
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { delimiter as pathDelimiter, dirname, extname, isAbsolute, resolve } from "node:path";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { sanitizeSingleLine } from "../format";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, fetchPresence, fetchRuntimePeers, RestError, type Identity } from "../rest";
import { buildRuntimeTopology } from "../runtime-topology";
import {
  AGENTPARTY_CLAUDE_MCP_SERVER_NAME,
  CLAUDE_CROSS_SESSION_GATE_DIR_ENV,
  isAgentPartyClaudeSessionAddress,
  readClaudeCrossSessionGateArm,
} from "../claude-cross-session-gate";
import { isPartyBinaryPath, RUNNING_VERSION } from "../upgrade";
import { isName, isSlug } from "../validation";
import {
  CLAUDE_CHANNEL_OPT_IN_ENV,
  CLAUDE_LIFECYCLE_OPT_IN_ENV,
  claudeChannelLoadArgs,
} from "./claude-launch";
import {
  defaultClaudePluginDoctorDependencies,
  inspectClaudePluginShell,
  type ClaudePluginShellBlocker,
  type ClaudePluginShellInspection,
} from "./doctor";
import { runCodexSessionBridge, type CodexBridgeRuntimeOptions } from "./codex-bridge";
import {
  runCodexNativeBridge,
  type CodexNativeBridgeRuntimeOptions,
} from "./codex-native-bridge";
import {
  codexSessionsRoot,
  formatCodexSessionLine,
  isCodexThreadId,
  latestCodexSession,
  listCodexSessions,
  type CodexSessionSummary,
} from "../codex-sessions";

const CLAUDE_CHANNEL_MIN_VERSION = [2, 1, 80] as const;
const CLAUDE_CROSS_SESSION_MIN_VERSION = [2, 1, 224] as const;
const CODEX_BRIDGE_MIN_VERSION = [0, 144, 0] as const;
const CHANNEL_SERVER_NAME = AGENTPARTY_CLAUDE_MCP_SERVER_NAME;
const CLAUDE_SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLAUDE_CROSS_SESSION_PREFLIGHT_TIMEOUT_MS = 5_000;
const CLAUDE_SESSION_START_ARM_POLL_MS = 25;
export const claudeBridgeProbeRetryDelays = [150, 500] as const;
export const CLAUDE_SESSION_START_ARM_RECEIPT_SCHEMA = "agentparty.claude-session-start-armed.v1";
export const CLAUDE_SESSION_START_ARM_RECEIPT_FILE_ENV = "AGENTPARTY_CLAUDE_ARM_RECEIPT_FILE";

export type ClaudeCrossSessionMode = "auto" | "off" | "required";
export type ClaudeCrossSessionInbound = "accept" | "hold" | "refuse";

type ClaudeCrossSessionLaunchReason =
  | "ready"
  | "disabled_by_operator"
  | "unsupported_platform_or_version"
  | "unsupported_provider"
  | "feature_flag_evaluation_disabled"
  | "claude_bare"
  | "tool_policy"
  | "local_hook_settings_conflict"
  | "explicit_stable_name"
  | "runtime_comparison_unavailable"
  | "local_gate_unavailable";

function bridgeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeSingleLine(raw).trim().slice(0, 240) || "unknown error";
}

export class ClaudeBridgeEndpointProbeError extends Error {
  constructor(
    readonly attempts: number,
    readonly endpointError: unknown,
  ) {
    super(bridgeDiagnostic(endpointError));
    this.name = "ClaudeBridgeEndpointProbeError";
  }
}

function retryableClaudeBridgeProbeError(error: unknown): boolean {
  return error instanceof RestError && (error.status === 429 || error.status >= 500);
}

async function waitForClaudeBridgeProbeRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason ?? new Error("Claude bridge preflight aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function retryClaudeBridgeEndpoint<T>(
  probe: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  retryDelays: readonly number[] = claudeBridgeProbeRetryDelays,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    if (attempts === 0) {
      signal.throwIfAborted();
    } else if (signal.aborted) {
      throw new ClaudeBridgeEndpointProbeError(
        attempts,
        signal.reason ?? new Error("Claude bridge preflight aborted"),
      );
    }
    attempts += 1;
    try {
      return await probe(signal);
    } catch (error) {
      const retryDelay = retryDelays[attempts - 1];
      if (
        retryDelay === undefined ||
        signal.aborted ||
        !retryableClaudeBridgeProbeError(error)
      ) {
        throw new ClaudeBridgeEndpointProbeError(attempts, error);
      }
      try {
        await waitForClaudeBridgeProbeRetry(retryDelay, signal);
      } catch (waitError) {
        throw new ClaudeBridgeEndpointProbeError(attempts, waitError);
      }
    }
  }
}

const HELP = `usage: party bridge <claude|codex|codex-app> [channel] [options]

forms:
  party bridge claude [channel|--channel C] [--cross-session auto|off|required] [--cross-session-inbound accept|hold|refuse] [--check [--json]] [-- <claude args...>]
  party bridge claude --verify --channel C --receiver-config PATH --sender-config PATH [--receiver-cwd DIR] [--sender-cwd DIR] [--preflight-only] [--keep-artifacts]
  party bridge codex  [channel|--channel C] [--codex-bin PATH] [--resume THREAD_ID|--resume-last] [-- <codex args...>]
  party bridge codex  --list-sessions
  party bridge codex-app [channel|--channel C] --target-thread THREAD_ID --source-thread THREAD_ID

Attach AgentParty to the same interactive harness session:
  claude  native Claude Channel input and linked reply tool
  codex   one app-server writer shared by the Unix-remote TUI and AgentParty
  codex-app  ChatGPT Desktop's native cross-task send_message_to_thread path

requirements:
  Claude Code >= 2.1.80 with development Channels enabled by the local/org policy.
  The matching AgentParty Marketplace plugin must be installed, enabled, and bundle-valid;
  it supplies the lifecycle visibility and conditional Stop guard for this bridge session.
  Claude Code >= 2.1.224 adds local Cross-session discovery and messaging.
  Cross-session needs a supported first-party provider and feature-flag evaluation.
  Codex CLI >= 0.144.0 with app-server --stdio and TUI --remote unix:// support.

examples:
  party bridge claude
  party bridge claude dev
  party bridge claude dev --cross-session required
  party bridge claude dev --cross-session required --cross-session-inbound accept
  party bridge claude dev --cross-session off
  party bridge claude dev --check --json
  party bridge claude --verify --channel dev --receiver-config /path/to/receiver.json --sender-config /path/to/sender.json --receiver-cwd /path/to/receiver-worktree --sender-cwd /path/to/sender-worktree --preflight-only
  party bridge claude --channel dev -- --model opus
  party bridge codex dev
  party bridge codex --channel dev -- --model gpt-5.4
  party bridge codex dev --codex-bin /opt/homebrew/bin/codex
  party bridge codex --list-sessions
  party bridge codex dev --resume-last
  party bridge codex dev --resume 01a01e72-8187-7d63-8e4d-9a1a9daa5451
  party bridge codex-app dev --target-thread 01a01e72-8187-7d63-8e4d-9a1a9daa5451 --source-thread 01a01e72-8187-7d63-8e4d-9a1a9daa5452

Without --resume/--resume-last the bridge opens a NEW Codex thread, so a session
you are already watching will not receive the wake. --resume-last re-enters the
most recent rollout under $CODEX_HOME/sessions (default ~/.codex/sessions);
--list-sessions prints thread ids with their start time, cwd, branch, and first
user turn. Codex allows one writer per thread, so a session still open in the
Codex desktop app cannot be resumed until it is closed there; the resumed turn
then runs in this terminal's Codex TUI.

Tokens after -- are passed to the selected interactive CLI. The bridge never
uses PTY input injection and never starts a second writer against a live turn.
Claude Cross-session defaults to auto. "off" disables AgentParty's peer hints
and automatic unique session naming; it does not disable Claude's built-in feature.
Cross-session inbound is left to Claude unless explicitly selected; managed,
project, or local policy may still enforce a stricter hold/refuse value.
At launch, auto prints cross_session=enabled_for_launch or channel_only plus a stable reason.
When the top-level SessionStart hook arms, the bridge emits its structured receipt while Claude is
still running. Required mode returns nonzero if Claude exits without arming the local send gate.
Use --check to run the same Marketplace lifecycle, local, auth, and runtime preflight without launching Claude.
The check cannot prove SessionStart hook arming, peer presence, or message delivery.`;

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface ClaudeBridgeLaunch {
  command: string;
  args: string[];
  settings?: {
    hooks: Record<string, unknown>;
    isolatePeerMachines: true;
    crossSessionInbound?: ClaudeCrossSessionInbound;
  };
  mcpConfig: {
    mcpServers: Record<string, {
      type: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }>;
  };
}

export function formatClaudeSessionStartArmReceipt(
  address: string,
  arm: { session_id: string; armed_at: number },
): string {
  return `party bridge receipt: ${JSON.stringify({
    schema: CLAUDE_SESSION_START_ARM_RECEIPT_SCHEMA,
    address,
    session_id: arm.session_id,
    armed_at: arm.armed_at,
  })}`;
}

function openClaudeSessionStartArmReceiptFile(path: string): number {
  if (!isAbsolute(path)) throw new Error("arm receipt file path must be absolute");
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && parent.uid !== process.getuid())
  ) {
    throw new Error("arm receipt parent must be an owned, non-symlink private directory");
  }
  // The verifier supplies a path that does not exist inside its private 0700
  // directory. Exclusive creation after the SessionStart hook arms prevents
  // truncation, symlink following, and descriptor inheritance by Claude or
  // its plugins.
  const fd = openSync(path, "wx", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new Error("arm receipt file must be an owned, non-symlink regular file with mode 0600");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function observeClaudeSessionStartArm(
  gateDirectory: string,
  launchSettled: () => boolean,
): Promise<ReturnType<typeof readClaudeCrossSessionGateArm>> {
  const gateEnv = { [CLAUDE_CROSS_SESSION_GATE_DIR_ENV]: gateDirectory };
  for (;;) {
    const arm = readClaudeCrossSessionGateArm(gateEnv);
    if (arm !== null) return arm;
    if (launchSettled()) return null;
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, CLAUDE_SESSION_START_ARM_POLL_MS)
    );
  }
}

function publishClaudeSessionStartArmReceipt(
  address: string,
  arm: NonNullable<ReturnType<typeof readClaudeCrossSessionGateArm>>,
  receiptFile: string | undefined,
): void {
  const receipt = formatClaudeSessionStartArmReceipt(address, arm);
  if (receiptFile === undefined) {
    console.error(receipt);
    return;
  }
  let receiptFd: number | null = null;
  try {
    receiptFd = openClaudeSessionStartArmReceiptFile(receiptFile);
    writeSync(receiptFd, `${receipt.slice("party bridge receipt: ".length)}\n`);
    fsyncSync(receiptFd);
  } finally {
    if (receiptFd !== null) closeSync(receiptFd);
  }
}

export interface BridgeDeps {
  execPath?: string;
  processArgv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  codexBinary?: string;
  platform?: NodeJS.Platform;
  probeClaudeVersion?: (options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;
  probeClaudeAuth?: (
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<boolean | ClaudeAuthInfo>;
  probeClaudePluginLifecycle?: (
    rawClaudeVersion: string,
  ) => ClaudePluginShellInspection | Promise<ClaudePluginShellInspection>;
  probeClaudeChannel?: (channel: string) => Promise<string>;
  resolveClaudeAgentName?: (channel: string) => Promise<string | null>;
  createClaudeSessionName?: (base: string) => string;
  probeClaudeCrossSession?: (channel: string, cwd: string, expectedAgentName: string) => Promise<void>;
  probeClaudeGate?: () => void;
  probeCodexCapabilities?: (
    codexBinary: string,
    options: { cwd: string; env: NodeJS.ProcessEnv },
    codexArgsPrefix?: string[],
  ) => Promise<CodexCapabilityProbe>;
  launch?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;
  runCodexBridge?: (options: CodexBridgeRuntimeOptions) => Promise<number>;
  runCodexNativeBridge?: (options: CodexNativeBridgeRuntimeOptions) => Promise<number>;
}

export interface CodexCapabilityProbe {
  version: string;
  rootHelp: string;
  appServerHelp: string;
}

const CODEX_APP_DIRS = [
  "/Applications/Codex.app/Contents/Resources",
  "/Applications/ChatGPT.app/Contents/Resources",
] as const;

const CODEX_FALLBACK_PATH_DIRS = [
  resolve(homedir(), ".local/bin"),
  resolve(homedir(), ".npm-global/bin"),
  resolve(homedir(), ".bun/bin"),
  resolve(homedir(), ".deno/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  ...CODEX_APP_DIRS,
  "/usr/bin",
  "/bin",
] as const;

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(value: string | undefined): string[] {
  return value?.split(pathDelimiter).filter((entry) => entry !== "") ?? [];
}

/**
 * Windows does not resolve an extensionless command name without consulting
 * PATHEXT. Only return directly executable formats here: cmd/bat wrappers need
 * a shell and must not be selected for the bridge's single-writer subprocesses.
 */
export function executableCommandNames(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || extname(command) !== "") return [command];
  const configured = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry === ".exe" || entry === ".com");
  const extensions = [...new Set([".exe", ...configured, ".com"])];
  return extensions.map((extension) => `${command}${extension}`);
}

/**
 * Construct the exact PATH inherited by both Codex children. The fallback
 * directories are deliberately explicit: launchd GUI sessions commonly omit
 * Homebrew and application bundle paths even when the same command works in a
 * login shell.
 */
export function buildCodexChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  preferredPathDirs: string[] = [],
): NodeJS.ProcessEnv {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of [
    ...preferredPathDirs,
    ...pathEntries(env.PATH),
    ...CODEX_FALLBACK_PATH_DIRS,
  ]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return { ...env, PATH: entries.join(pathDelimiter) };
}

function executableOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (isAbsolute(command) || command.includes("/")) {
    const candidate = isAbsolute(command) ? command : resolve(cwd, command);
    return executable(candidate) ? candidate : null;
  }
  for (const entry of pathEntries(env.PATH)) {
    for (const name of executableCommandNames(command, env, platform)) {
      const candidate = resolve(cwd, entry, name);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve one absolute binary for both app-server and TUI. launchd often lacks
 * Homebrew's PATH, which caused the resident runner's
 * "Executable not found in $PATH: codex" failure.
 */
export function resolveCodexBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: { platform?: NodeJS.Platform } = {},
): string | null {
  const configured = explicit || env.AGENTPARTY_CODEX_BIN;
  if (configured) {
    const path = isAbsolute(configured) ? configured : resolve(cwd, configured);
    return executable(path) ? realpathSync(path) : null;
  }
  const fromPath = executableOnPath(
    "codex",
    buildCodexChildEnv(env),
    cwd,
    options.platform,
  );
  if (fromPath && executable(fromPath)) return realpathSync(fromPath);
  for (const appDir of CODEX_APP_DIRS) {
    const candidate = resolve(appDir, "codex");
    if (existsSync(candidate) && executable(candidate)) return realpathSync(candidate);
  }
  return null;
}

function shebangEnvCommand(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const prefix = Buffer.alloc(512);
    const bytes = readSync(fd, prefix, 0, prefix.length, 0);
    const firstLine = prefix.subarray(0, bytes).toString("utf8").split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) return null;
    const parts = firstLine.slice(2).trim().split(/\s+/);
    const interpreter = parts[0] ?? "";
    if (interpreter !== "/usr/bin/env" && interpreter !== "/bin/env") return null;
    let index = 1;
    if (parts[index] === "-S") index += 1;
    while (parts[index]?.includes("=")) index += 1;
    const command = parts[index];
    return command && !command.startsWith("-") ? command : null;
  } finally {
    closeSync(fd);
  }
}

export type CodexLaunchResolution =
  | {
    ok: true;
    /** The directly executable program shared by every Codex child. */
    codexBinary: string;
    /**
     * Fixed argv inserted before every Codex subcommand. This is empty for a
     * native CLI and contains the npm package entrypoint for a Windows npm
     * `codex.cmd` shim, so neither child needs a shell to invoke it.
     */
    codexArgsPrefix: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }
  | {
    ok: false;
    error: string;
  };

function isWindowsCmdShim(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && extname(path).toLowerCase() === ".cmd";
}

function isWindowsBatShim(path: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && extname(path).toLowerCase() === ".bat";
}

function windowsNpmCodexCmdOnPath(
  env: NodeJS.ProcessEnv,
  cwd: string,
): string | null {
  for (const entry of pathEntries(env.PATH)) {
    const candidate = resolve(cwd, entry, "codex.cmd");
    if (executable(candidate)) return candidate;
  }
  return null;
}

function resolveWindowsNpmCodexShim(
  shim: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): CodexLaunchResolution {
  const entrypoint = resolve(dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!existsSync(entrypoint)) {
    return {
      ok: false,
      error:
        `Windows Codex npm shim ${shim} does not have the expected @openai/codex entrypoint. ` +
        "Install Codex with the official Windows installer or pass --codex-bin pointing to codex.exe",
    };
  }
  const nodeBinary = executableOnPath("node", env, cwd, platform);
  if (nodeBinary === null) {
    return {
      ok: false,
      error:
        `Windows Codex npm shim ${shim} requires node.exe on PATH. ` +
        "Install Node with the npm package or pass --codex-bin pointing to codex.exe",
    };
  }
  const codexBinary = realpathSync(nodeBinary);
  const childEnv = buildCodexChildEnv(env, [dirname(shim), dirname(codexBinary)]);
  return {
    ok: true,
    codexBinary,
    codexArgsPrefix: [realpathSync(entrypoint)],
    cwd,
    env: childEnv,
  };
}

/**
 * Resolve binary, cwd, and environment as one unit. Probing with a different
 * PATH than the eventual app-server/TUI launch can produce a false-positive
 * preflight, especially for npm shims using `#!/usr/bin/env node`.
 */
export function resolveCodexLaunch(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  options: { platform?: NodeJS.Platform } = {},
): CodexLaunchResolution {
  const platform = options.platform ?? process.platform;
  const configured = explicit || env.AGENTPARTY_CODEX_BIN;
  const configuredPath = configured
    ? (isAbsolute(configured) ? configured : resolve(cwd, configured))
    : null;
  const lookupEnv = buildCodexChildEnv(
    env,
    configuredPath === null ? [] : [dirname(configuredPath)],
  );
  if (configuredPath !== null && isWindowsBatShim(configuredPath, platform)) {
    return {
      ok: false,
      error:
        `Windows batch wrapper ${configuredPath} cannot be launched safely without a shell. ` +
        "Pass --codex-bin pointing to codex.exe or the official npm codex.cmd shim",
    };
  }
  if (
    configuredPath !== null &&
    isWindowsCmdShim(configuredPath, platform) &&
    executable(configuredPath)
  ) {
    return resolveWindowsNpmCodexShim(configuredPath, lookupEnv, cwd, platform);
  }
  const codexBinary = resolveCodexBinary(explicit, lookupEnv, cwd, options);
  const npmShim = codexBinary === null && configuredPath === null && platform === "win32"
    ? windowsNpmCodexCmdOnPath(lookupEnv, cwd)
    : null;
  if (npmShim !== null) {
    return resolveWindowsNpmCodexShim(npmShim, lookupEnv, cwd, platform);
  }
  if (codexBinary === null) {
    return {
      ok: false,
      error:
        "could not find an executable Codex CLI. Pass --codex-bin PATH or set AGENTPARTY_CODEX_BIN",
    };
  }
  const childEnv = buildCodexChildEnv(lookupEnv, [
    ...(configuredPath === null ? [] : [dirname(configuredPath)]),
    dirname(codexBinary),
  ]);
  let envCommand: string | null;
  try {
    envCommand = shebangEnvCommand(codexBinary);
  } catch (error) {
    return {
      ok: false,
      error: `could not inspect Codex CLI ${codexBinary}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    envCommand &&
    executableOnPath(envCommand, childEnv, cwd, options.platform) === null
  ) {
    return {
      ok: false,
      error:
        `Codex CLI ${codexBinary} uses /usr/bin/env ${envCommand}, but ${envCommand} is not executable ` +
        "on the child PATH. Install its runtime or pass a standalone Codex binary",
    };
  }
  return { ok: true, codexBinary, codexArgsPrefix: [], cwd, env: childEnv };
}

/** Extract the first semver-looking tuple from `claude --version`. */
export function parseClaudeVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:\s|$|\()/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsClaudeChannels(raw: string): boolean {
  const parsed = parseClaudeVersion(raw);
  if (!parsed) return false;
  for (let index = 0; index < CLAUDE_CHANNEL_MIN_VERSION.length; index += 1) {
    if (parsed[index]! > CLAUDE_CHANNEL_MIN_VERSION[index]!) return true;
    if (parsed[index]! < CLAUDE_CHANNEL_MIN_VERSION[index]!) return false;
  }
  return true;
}

export function supportsClaudeCrossSession(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const parsed = parseClaudeVersion(raw);
  if (!parsed || (platform !== "darwin" && platform !== "linux")) return false;
  return atLeast(parsed, CLAUDE_CROSS_SESSION_MIN_VERSION);
}

export interface ClaudeAuthInfo {
  loggedIn: boolean;
  apiProvider?: string;
}

export interface ClaudeCrossSessionEnvironmentConflict {
  reason: "unsupported_provider" | "feature_flag_evaluation_disabled";
  variables: string[];
  apiProvider?: string;
}

const CLAUDE_CROSS_SESSION_UNSUPPORTED_PROVIDER_ENV = [
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

const CLAUDE_CROSS_SESSION_ANY_NONEMPTY_DISABLE_ENV = [
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_TELEMETRY",
] as const;

const CLAUDE_CROSS_SESSION_BOOLEAN_DISABLE_ENV = [
  "DO_NOT_TRACK",
  "DISABLE_GROWTHBOOK",
] as const;

function claudeStandardBooleanEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function isKnownUnsupportedClaudeProvider(apiProvider: string | undefined): boolean {
  if (apiProvider === undefined) return false;
  const normalized = apiProvider.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.includes("bedrock") ||
    normalized.includes("mantle") ||
    normalized.includes("vertex") ||
    normalized.includes("agentplatform") ||
    normalized.includes("foundry") ||
    normalized === "anthropicaws" ||
    normalized === "claudeplatformonaws";
}

/**
 * Detect documented provider and feature-flag conflicts visible to the bridge.
 * `apiProvider` comes from `claude auth status`, so it can reflect provider
 * selection applied by Claude settings even when the parent shell cannot.
 */
export function claudeCrossSessionEnvironmentConflict(
  env: NodeJS.ProcessEnv,
  apiProvider?: string,
): ClaudeCrossSessionEnvironmentConflict | null {
  // A resolved auth provider has already applied Claude's settings precedence.
  // Only fall back to parent-process provider flags when auth returned no
  // provider field; a settings `env` entry may legitimately clear a shell flag.
  const providerVariables = apiProvider === undefined
    ? CLAUDE_CROSS_SESSION_UNSUPPORTED_PROVIDER_ENV.filter(
        (name) => claudeStandardBooleanEnabled(env[name]),
      )
    : [];
  if (providerVariables.length > 0 || isKnownUnsupportedClaudeProvider(apiProvider)) {
    return {
      reason: "unsupported_provider",
      variables: providerVariables,
      ...(apiProvider === undefined ? {} : { apiProvider }),
    };
  }

  const disableVariables = [
    ...CLAUDE_CROSS_SESSION_ANY_NONEMPTY_DISABLE_ENV.filter((name) => (env[name] ?? "") !== ""),
    ...CLAUDE_CROSS_SESSION_BOOLEAN_DISABLE_ENV.filter((name) =>
      claudeStandardBooleanEnabled(env[name])
    ),
  ];
  return disableVariables.length === 0
    ? null
    : {
        reason: "feature_flag_evaluation_disabled",
        variables: disableVariables,
      };
}

function claudeCrossSessionEnvironmentDiagnostic(
  conflict: ClaudeCrossSessionEnvironmentConflict,
): string {
  if (conflict.reason === "unsupported_provider") {
    const safeProvider = conflict.apiProvider === undefined
      ? null
      : sanitizeSingleLine(conflict.apiProvider).trim().slice(0, 80);
    const evidence = [
      safeProvider ? `apiProvider=${safeProvider}` : null,
      conflict.variables.length === 0 ? null : `variables=${conflict.variables.join(",")}`,
    ].filter(Boolean).join("; ");
    return `Claude Cross-session is unavailable on the selected provider${evidence ? ` (${evidence})` : ""}`;
  }
  return `Claude feature-flag evaluation is disabled by ${conflict.variables.join(",")}`;
}

export function parseCodexVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$|\()/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(
  version: readonly number[],
  minimum: readonly number[],
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! > minimum[index]!) return true;
    if (version[index]! < minimum[index]!) return false;
  }
  return true;
}

export function supportsCodexSessionBridge(probe: CodexCapabilityProbe): boolean {
  const version = parseCodexVersion(probe.version);
  return version !== null &&
    atLeast(version, CODEX_BRIDGE_MIN_VERSION) &&
    probe.rootHelp.includes("--remote") &&
    probe.rootHelp.includes("unix://") &&
    probe.appServerHelp.includes("--stdio");
}

/**
 * Resolve the command Claude should spawn for the channel MCP subprocess.
 * Compiled installs point directly at `party`; source/dev runs preserve
 * `bun <entry.ts>` so tests and contributors do not need a global binary.
 */
export function selfCommand(
  execPath: string = process.execPath,
  processArgv: string[] = process.argv,
): CommandSpec {
  if (isPartyBinaryPath(execPath) || processArgv[1] === undefined) {
    return { command: execPath, args: [] };
  }
  return { command: execPath, args: [processArgv[1]] };
}

export function buildClaudeBridgeLaunch(options: {
  channel: string;
  claudeArgs?: string[];
  crossSession?: boolean;
  sessionName?: string;
  execPath?: string;
  processArgv?: string[];
  gateDirectory?: string;
  crossSessionInbound?: ClaudeCrossSessionInbound;
}): ClaudeBridgeLaunch {
  const self = selfCommand(options.execPath, options.processArgv);
  const claudeArgs = options.claudeArgs ?? [];
  const explicitClaudeName = claudeNameArg(claudeArgs);
  // Only a bridge-generated, per-launch random name is safe to publish as a
  // topology hint. A user-chosen stable --name can be reused by an unrelated
  // Claude session after the hinted socket closes; a fresh ListAgents lookup
  // would then find one exact name but still address the wrong session.
  const topologyClaudeName = options.crossSession === true &&
    options.gateDirectory !== undefined &&
    isAbsolute(options.gateDirectory) &&
    explicitClaudeName === undefined &&
    options.sessionName !== undefined &&
    isAgentPartyClaudeSessionAddress(options.sessionName)
    ? options.sessionName
    : undefined;
  const crossSessionReady = topologyClaudeName !== undefined;
  const hookCommand = options.gateDirectory === undefined
    ? undefined
    : {
        type: "command",
        command: self.command,
        args: [
          ...self.args,
          "claude-cross-session-hook",
          "--gate-directory",
          options.gateDirectory,
        ],
        timeout: 5,
      };
  const settings = crossSessionReady && hookCommand !== undefined
      ? {
        hooks: {
          SessionStart: [{ hooks: [hookCommand] }],
          PreToolUse: [{ matcher: "*", hooks: [hookCommand] }],
          PostToolBatch: [{ hooks: [hookCommand] }],
        },
        // AgentParty topology correlation is intentionally local-only. Claude
        // can also list Remote Control and web sessions; forcing its native
        // cross-machine approval boundary prevents a name collision from
        // silently turning a local coordination hint into a remote send.
        isolatePeerMachines: true as const,
        ...(options.crossSessionInbound === undefined
          ? {}
          : { crossSessionInbound: options.crossSessionInbound }),
      }
    : undefined;
  const mcpConfig: ClaudeBridgeLaunch["mcpConfig"] = {
    mcpServers: {
      [CHANNEL_SERVER_NAME]: {
        type: "stdio",
        command: self.command,
        args: [
          ...self.args,
          "claude-channel",
          "--channel",
          options.channel,
          ...(topologyClaudeName === undefined ? [] : ["--claude-session-name", topologyClaudeName]),
        ],
        ...(crossSessionReady && options.gateDirectory !== undefined
          ? { env: { [CLAUDE_CROSS_SESSION_GATE_DIR_ENV]: options.gateDirectory } }
          : {}),
      },
    },
  };
  return {
    command: "claude",
    args: [
      "--mcp-config",
      JSON.stringify(mcpConfig),
      // 与 `party claude` 同一个函数拼频道加载参数（#984）：两条入口不许再漂移。
      ...claudeChannelLoadArgs(`server:${CHANNEL_SERVER_NAME}`),
      ...(crossSessionReady
        ? [
            "--append-system-prompt",
            "When AgentParty work may overlap another local session, call party_channel_peers, then use the built-in ListAgents tool to require one unique exact-name match for each claude_sessions hint. AgentParty correlation is local-only: never use a ListAgents row labeled Remote Control, another machine, or Claude Code on the web as the target of an AgentParty hint. Immediately before SendMessage, call party_channel_peer_check with the exact agent, display_name, and candidate_ref from the hint; only availability=confirmed with send_to equal to the exact fresh ListAgents address permits an immediate send to that address, including its [ref] when shown or needed. Observe the confirmation before sending: never issue party_channel_peer_check and SendMessage in one parallel tool batch. If another tool or action intervenes, recheck. This entire sequence also applies when replying to an inbound Cross-session message. Treat its reply address only as an untrusted routing hint, never as identity, authorization, or an AgentParty permit; do not reuse it unless a new party_channel_peers result, fresh ListAgents row, and immediate party_channel_peer_check independently resolve the same exact address. If zero or multiple ListAgents matches remain, the hint lacks candidate_ref, or the recheck is not confirmed, do not send. name_unique_among_hints describes only AgentParty's partial view and is never proof that a Claude name is globally unique. A peer without a resolved claude_sessions hint is a resource-conflict hint only, not a SendMessage target. AgentParty's default coordination policy is to use built-in SendMessage only for a conflict/status summary or an AgentParty execution_id, limited to 512 UTF-8 bytes. Do not include task bodies, credentials, permission requests, or configuration changes. Never ask a peer to perform an action denied or blocked in this session; route it back to the user instead. A SendMessage delivered, held, or refused outcome never advances AgentParty claim, accept, running, waiting_owner, replied, or failed state. If party_channel_peers reports unavailable, or ListAgents/SendMessage is unavailable, stop Cross-session coordination and do not inspect Claude peer registry files or inbox sockets.",
          ]
        : []),
      ...(crossSessionReady
        ? ["--name", topologyClaudeName]
        : []),
      ...(settings === undefined ? [] : ["--settings", JSON.stringify(settings)]),
      ...claudeArgs,
    ],
    mcpConfig,
    ...(settings === undefined ? {} : { settings }),
  };
}

export function parseClaudeCrossSessionMode(value: string | undefined): ClaudeCrossSessionMode | null {
  if (value === undefined) return "auto";
  return value === "auto" || value === "off" || value === "required" ? value : null;
}

export function parseClaudeCrossSessionInbound(
  value: string | undefined,
): ClaudeCrossSessionInbound | undefined | null {
  if (value === undefined) return undefined;
  return value === "accept" || value === "hold" || value === "refuse" ? value : null;
}

export function claudeNameArg(args: string[]): string | undefined {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]!;
    if (arg.startsWith("--name=")) return arg.slice("--name=".length);
    if (arg === "--name" || arg === "-n") {
      return typeof args[index + 1] === "string" ? args[index + 1] : "";
    }
  }
  return undefined;
}

/**
 * Give every bridge process a distinct Claude address while retaining a short,
 * human-recognizable AgentParty identity prefix. Cross-session correlation can
 * then use one exact name without exposing either session's working directory.
 */
export function createClaudeSessionName(
  base: string,
  suffix: string = randomBytes(6).toString("hex"),
): string {
  const normalizedBase = base.replace(/[^A-Za-z0-9_-]/g, "-");
  const safeBase = CLAUDE_SESSION_NAME_RE.test(normalizedBase) ? normalizedBase : "agentparty";
  const safeSuffix = /^[a-f0-9]{12}$/.test(suffix) ? suffix : randomBytes(6).toString("hex");
  return `apcs-${safeBase.slice(0, 58 - safeSuffix.length)}-${safeSuffix}`;
}

function hasClaudeBareArg(args: string[]): boolean {
  return args.includes("--bare") || args.includes("--bare=true");
}

function hasClaudeSafeModeArg(args: string[]): boolean {
  return args.includes("--safe-mode") || args.includes("--safe-mode=true");
}

function hasClaudeSettingsArg(args: string[]): boolean {
  return args.some((arg) => arg === "--settings" || arg.startsWith("--settings="));
}

function claudeFlagValues(args: string[], names: readonly string[]): { present: boolean; values: string[] } {
  const accepted = new Set(names);
  const values: string[] = [];
  let present = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equal = arg.indexOf("=");
    const name = equal === -1 ? arg : arg.slice(0, equal);
    if (!accepted.has(name)) continue;
    present = true;
    if (equal !== -1) {
      values.push(arg.slice(equal + 1));
      continue;
    }
    while (index + 1 < args.length && !args[index + 1]!.startsWith("-")) {
      values.push(args[index + 1]!);
      index += 1;
    }
  }
  return { present, values };
}

function claudeToolNames(values: readonly string[]): Set<string> {
  return new Set(values
    .flatMap((value) => value.split(/[\s,]+/))
    .map((value) => value.replace(/\(.*/, ""))
    .filter((value) => value !== ""));
}

/** Explain an explicit Claude tool policy that removes Cross-session tools. */
export function claudeCrossSessionToolConflict(args: string[]): string | null {
  const selected = claudeFlagValues(args, ["--tools"]);
  if (selected.present) {
    const tools = claudeToolNames(selected.values);
    if (!tools.has("default") && (!tools.has("ListAgents") || !tools.has("SendMessage"))) {
      return "Claude --tools must include both ListAgents and SendMessage";
    }
  }
  const denied = claudeToolNames(
    claudeFlagValues(args, ["--disallowedTools", "--disallowed-tools"]).values,
  );
  const deniedRequired = ["ListAgents", "SendMessage"].filter((tool) => denied.has(tool));
  return deniedRequired.length === 0
    ? null
    : `Claude --disallowedTools denies ${deniedRequired.join(" and ")}`;
}

async function defaultProbeClaudeVersion(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const proc = Bun.spawn(["claude", "--version"], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const detail = stderr.trim() || `exit ${code}`;
    throw new Error(`could not run claude --version (${detail})`);
  }
  return stdout.trim();
}

export function parseClaudeAuthStatus(raw: string): boolean | null {
  return parseClaudeAuthInfo(raw)?.loggedIn ?? null;
}

function normalizeClaudeApiProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = sanitizeSingleLine(value).trim().slice(0, 80);
  return normalized === "" ? undefined : normalized;
}

export function parseClaudeAuthInfo(raw: string): ClaudeAuthInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null &&
      typeof (parsed as { loggedIn?: unknown }).loggedIn === "boolean") {
      const apiProvider = normalizeClaudeApiProvider(
        (parsed as { apiProvider?: unknown }).apiProvider,
      );
      return {
        loggedIn: (parsed as { loggedIn: boolean }).loggedIn,
        ...(apiProvider === undefined ? {} : { apiProvider }),
      };
    }
  } catch {
    // Invalid JSON is an unavailable probe, not proof of a logged-out account.
  }
  return null;
}

async function defaultProbeClaudeAuth(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ClaudeAuthInfo> {
  const proc = Bun.spawn(["claude", "auth", "status"], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // Current Claude exits nonzero when logged out but still emits the canonical
  // JSON object. Parse that object before treating the command as unavailable.
  const auth = parseClaudeAuthInfo(stdout);
  if (auth !== null) return auth;
  throw new Error(
    `claude auth status did not return a valid loggedIn result (${bridgeDiagnostic(stderr) || `exit ${code}`})`,
  );
}

function probeClaudeGateDirectory(): void {
  const directory = mkdtempSync(resolve(tmpdir(), "agentparty-claude-cross-session-check-"));
  try {
    chmodSync(directory, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export type ClaudeBridgeCheckStatus =
  | "ready_for_launch"
  | "channel_only"
  | "claude_auth_required"
  | "claude_auth_unavailable"
  | "channel_unavailable"
  | "runtime_comparison_unavailable"
  | "local_gate_unavailable"
  | "unsupported_provider"
  | "feature_flag_evaluation_disabled"
  | "unsupported_claude"
  | ClaudePluginShellBlocker;

export type ClaudeBridgeCheckBlocker = Exclude<
  ClaudeBridgeCheckStatus,
  "ready_for_launch" | "channel_only"
> | "worker_upgrade_required";

export type ClaudeChannelProbePhase =
  | "authentication"
  | "identity"
  | "presence"
  | "identity_binding";

export const CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL =
  "explicit_approval_required" as const;

export class ClaudeChannelProbeError extends Error {
  constructor(
    readonly phase: ClaudeChannelProbePhase,
    message: string,
    readonly attempts?: number,
  ) {
    super(message);
    this.name = "ClaudeChannelProbeError";
  }
}

export interface ClaudeBridgeCheckResult {
  schema: "agentparty.claude-bridge-check.v1";
  status: ClaudeBridgeCheckStatus;
  blockers: ClaudeBridgeCheckBlocker[];
  channel: string;
  mode: ClaudeCrossSessionMode;
  claude_version: string;
  claude_logged_in: boolean;
  channel_access: "confirmed" | "unavailable";
  cross_session: "ready_for_launch" | "channel_only" | "unavailable";
  reason:
    | ClaudeCrossSessionLaunchReason
    | "claude_auth_required"
    | "claude_auth_unavailable"
    | "channel_unavailable"
    | "plugin_lifecycle_unavailable";
  lifecycle: {
    source: "marketplace_plugin";
    status: "ready" | "unavailable";
    blockers: ClaudePluginShellBlocker[];
    runtime_version: string;
    plugin: ClaudePluginShellInspection["plugin"];
  };
  runtime_comparison: "confirmed" | "not_checked" | "unavailable";
  local_gate: "creatable" | "not_checked" | "unavailable";
  cross_machine_policy_on_launch:
    | typeof CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL
    | "not_applicable";
  session_start_armed: false;
  peer_presence_checked: false;
  model_calls_started: false;
  delivery_verified: false;
  agent?: string;
  claude_api_provider?: string;
  cross_session_conflict_variables?: string[];
  channel_probe_phase?: ClaudeChannelProbePhase;
  channel_probe_attempts?: number;
  runtime_probe_attempts?: number;
  diagnostic?: string;
}

function printClaudeBridgeCheck(result: ClaudeBridgeCheckResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `party bridge claude check: status=${result.status} channel=#${result.channel} ` +
      `channel_access=${result.channel_access} cross_session=${result.cross_session} ` +
      `lifecycle=${result.lifecycle.status} ` +
      `reason=${result.reason} claude_logged_in=${result.claude_logged_in} ` +
      `cross_machine_policy_on_launch=${result.cross_machine_policy_on_launch}.`,
  );
  if (result.lifecycle.blockers.length > 0) {
    console.log(`lifecycle blockers: ${result.lifecycle.blockers.join(", ")}`);
  }
  if (result.diagnostic) console.log(`diagnostic: ${result.diagnostic}`);
  console.log(
    "This is a launch preflight only: SessionStart is not armed, peer presence is not checked, and delivery is not verified.",
  );
}

function runtimeComparisonDiagnostic(error: unknown): string {
  const endpointError = error instanceof ClaudeBridgeEndpointProbeError
    ? error.endpointError
    : error;
  if (endpointError instanceof RestError && endpointError.status === 404) {
    return "runtime-peers returned HTTP 404; deploy a Worker version that supports runtime topology v3";
  }
  return bridgeDiagnostic(error);
}

function runtimeComparisonBlocker(
  error: unknown,
): "worker_upgrade_required" | "runtime_comparison_unavailable" {
  const endpointError = error instanceof ClaudeBridgeEndpointProbeError
    ? error.endpointError
    : error;
  return endpointError instanceof RestError && endpointError.status === 404
    ? "worker_upgrade_required"
    : "runtime_comparison_unavailable";
}

type ClaudeAuthProbeResult =
  | { status: "logged_in"; loggedIn: true; apiProvider?: string }
  | { status: "logged_out"; loggedIn: false; apiProvider?: string; diagnostic: string }
  | { status: "unavailable"; loggedIn: false; diagnostic: string };

async function probeClaudeAuthState(
  deps: BridgeDeps,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ClaudeAuthProbeResult> {
  try {
    const probed = await (deps.probeClaudeAuth ?? defaultProbeClaudeAuth)(options);
    const auth = typeof probed === "boolean" ? { loggedIn: probed } : probed;
    const apiProvider = normalizeClaudeApiProvider(auth.apiProvider);
    return auth.loggedIn
      ? {
          status: "logged_in",
          loggedIn: true,
          ...(apiProvider === undefined ? {} : { apiProvider }),
        }
      : {
          status: "logged_out",
          loggedIn: false,
          ...(apiProvider === undefined ? {} : { apiProvider }),
          diagnostic: "Claude Code is not logged in; run `claude auth login`",
        };
  } catch (error) {
    return {
      status: "unavailable",
      loggedIn: false,
      diagnostic: `Claude authentication status is unavailable: ${bridgeDiagnostic(error)}`,
    };
  }
}

function defaultProbeClaudePluginLifecycle(rawClaudeVersion: string): ClaudePluginShellInspection {
  return inspectClaudePluginShell({
    claudeVersion: () => rawClaudeVersion,
    claudePlugins: defaultClaudePluginDoctorDependencies.claudePlugins,
    inspectBundle: defaultClaudePluginDoctorDependencies.inspectBundle,
  });
}

async function probeClaudePluginLifecycleState(
  deps: BridgeDeps,
  rawClaudeVersion: string,
): Promise<{ inspection: ClaudePluginShellInspection; diagnostic: string | null }> {
  try {
    const inspection = await (deps.probeClaudePluginLifecycle ?? defaultProbeClaudePluginLifecycle)(
      rawClaudeVersion,
    );
    return { inspection, diagnostic: null };
  } catch (error) {
    return {
      inspection: {
        status: "plugin_state_unavailable",
        blockers: ["plugin_state_unavailable"],
        runtime_version: RUNNING_VERSION,
        plugin: {
          installed: false,
          enabled: false,
          bundle_valid: false,
          launcher_executable: false,
        },
        model_calls_started: false,
      },
      diagnostic: `Marketplace lifecycle inspection failed: ${bridgeDiagnostic(error)}`,
    };
  }
}

function claudeBridgeLifecycle(
  inspection: ClaudePluginShellInspection,
): ClaudeBridgeCheckResult["lifecycle"] {
  return {
    source: "marketplace_plugin",
    status: inspection.status === "ready" ? "ready" : "unavailable",
    blockers: inspection.blockers,
    runtime_version: inspection.runtime_version,
    plugin: inspection.plugin,
  };
}

async function runClaudeBridgeCheck(options: {
  channel: string;
  mode: ClaudeCrossSessionMode;
  rawVersion: string;
  platform: NodeJS.Platform;
  cwd: string;
  env: NodeJS.ProcessEnv;
  json: boolean;
  deps: BridgeDeps;
}): Promise<number> {
  const parsedVersion = parseClaudeVersion(options.rawVersion);
  const claudeVersion = parsedVersion?.join(".") ?? sanitizeSingleLine(options.rawVersion).trim();
  const base = {
    schema: "agentparty.claude-bridge-check.v1" as const,
    channel: options.channel,
    mode: options.mode,
    claude_version: claudeVersion || "unknown",
    cross_machine_policy_on_launch: options.mode === "off"
      ? "not_applicable" as const
      : CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL,
    session_start_armed: false as const,
    peer_presence_checked: false as const,
    model_calls_started: false as const,
    delivery_verified: false as const,
  };
  const [auth, lifecycleProbe] = await Promise.all([
    probeClaudeAuthState(options.deps, { cwd: options.cwd, env: options.env }),
    probeClaudePluginLifecycleState(options.deps, options.rawVersion),
  ]);
  const lifecycle = claudeBridgeLifecycle(lifecycleProbe.inspection);
  const lifecycleReady = lifecycle.status === "ready";
  const checkBase = {
    ...base,
    lifecycle,
    ...("apiProvider" in auth && auth.apiProvider !== undefined
      ? { claude_api_provider: auth.apiProvider }
      : {}),
  };
  const loggedIn = auth.loggedIn;
  const authDiagnostic = auth.status === "logged_in" ? null : auth.diagnostic;
  const authFailureStatus = auth.status === "unavailable"
    ? "claude_auth_unavailable" as const
    : "claude_auth_required" as const;
  const authFailureReason = auth.status === "unavailable"
    ? "claude_auth_unavailable" as const
    : "claude_auth_required" as const;
  const authBlockers: ClaudeBridgeCheckBlocker[] = loggedIn ? [] : [authFailureStatus];
  const bridgeBlockers = (...items: ClaudeBridgeCheckBlocker[]): ClaudeBridgeCheckBlocker[] =>
    [...new Set([
      ...authBlockers,
      ...lifecycle.blockers,
      ...items,
    ])];
  const statusWithLifecycle = (status: ClaudeBridgeCheckStatus): ClaudeBridgeCheckStatus =>
    (status === "ready_for_launch" || status === "channel_only") && !lifecycleReady
      ? lifecycle.blockers[0] ?? "plugin_state_unavailable"
      : status;
  const lifecycleOutcome = (
    status: ClaudeBridgeCheckStatus,
    reason: ClaudeBridgeCheckResult["reason"],
  ): Pick<ClaudeBridgeCheckResult, "status" | "reason"> => {
    const resolvedStatus = statusWithLifecycle(status);
    return {
      status: resolvedStatus,
      reason: resolvedStatus === status ? reason : "plugin_lifecycle_unavailable",
    };
  };
  const diagnosticField = (
    ...items: Array<string | null | undefined>
  ): Pick<ClaudeBridgeCheckResult, "diagnostic"> => {
    const value = [lifecycleProbe.diagnostic, ...items].filter(Boolean).join("; ");
    return value === "" ? {} : { diagnostic: value };
  };
  if (!supportsClaudeChannels(options.rawVersion)) {
    printClaudeBridgeCheck({
      ...checkBase,
      status: "unsupported_claude",
      blockers: bridgeBlockers("unsupported_claude"),
      claude_logged_in: loggedIn,
      channel_access: "unavailable",
      cross_session: "unavailable",
      reason: "unsupported_platform_or_version",
      runtime_comparison: "not_checked",
      local_gate: "not_checked",
      ...diagnosticField(`Claude Code >= ${CLAUDE_CHANNEL_MIN_VERSION.join(".")} is required for Channels`),
    }, options.json);
    return 1;
  }
  let agent: string;
  try {
    const channelProbe = options.deps.probeClaudeChannel ??
      (options.deps.resolveClaudeAgentName === undefined
        ? defaultProbeClaudeChannel
        : async (resolvedChannel: string) => {
            const name = await options.deps.resolveClaudeAgentName!(resolvedChannel);
            if (name === null) throw new Error("AgentParty identity is not a valid agent for this channel");
            return name;
          });
    agent = await channelProbe(options.channel);
  } catch (error) {
    printClaudeBridgeCheck({
      ...checkBase,
      status: "channel_unavailable",
      blockers: bridgeBlockers("channel_unavailable"),
      claude_logged_in: loggedIn,
      channel_access: "unavailable",
      cross_session: "unavailable",
      reason: "channel_unavailable",
      runtime_comparison: "not_checked",
      local_gate: "not_checked",
      ...(error instanceof ClaudeChannelProbeError
        ? { channel_probe_phase: error.phase }
        : {}),
      ...(error instanceof ClaudeChannelProbeError && error.attempts !== undefined
        ? { channel_probe_attempts: error.attempts }
        : {}),
      ...diagnosticField(authDiagnostic, bridgeDiagnostic(error)),
    }, options.json);
    return 1;
  }

  if (options.mode === "off") {
    printClaudeBridgeCheck({
      ...checkBase,
      ...lifecycleOutcome(
        loggedIn ? "channel_only" : authFailureStatus,
        loggedIn ? "disabled_by_operator" : authFailureReason,
      ),
      blockers: bridgeBlockers(),
      claude_logged_in: loggedIn,
      channel_access: "confirmed",
      cross_session: "channel_only",
      runtime_comparison: "not_checked",
      local_gate: "not_checked",
      agent,
      ...diagnosticField(authDiagnostic),
    }, options.json);
    return loggedIn && lifecycleReady ? 0 : 1;
  }
  if (!supportsClaudeCrossSession(options.rawVersion, options.platform)) {
    printClaudeBridgeCheck({
      ...checkBase,
      ...lifecycleOutcome(
        !loggedIn
          ? authFailureStatus
          : options.mode === "required" ? "unsupported_claude" : "channel_only",
        loggedIn ? "unsupported_platform_or_version" : authFailureReason,
      ),
      blockers: bridgeBlockers("unsupported_claude"),
      claude_logged_in: loggedIn,
      channel_access: "confirmed",
      cross_session: options.mode === "required" ? "unavailable" : "channel_only",
      runtime_comparison: "not_checked",
      local_gate: "not_checked",
      agent,
      ...diagnosticField(
        authDiagnostic,
        `Cross-session needs macOS or Linux and Claude Code >= ${CLAUDE_CROSS_SESSION_MIN_VERSION.join(".")}`,
      ),
    }, options.json);
    return !loggedIn || !lifecycleReady || options.mode === "required" ? 1 : 0;
  }

  const environmentConflict = claudeCrossSessionEnvironmentConflict(
    options.env,
    "apiProvider" in auth ? auth.apiProvider : undefined,
  );
  if (environmentConflict !== null) {
    printClaudeBridgeCheck({
      ...checkBase,
      ...lifecycleOutcome(
        !loggedIn
          ? authFailureStatus
          : options.mode === "required" ? environmentConflict.reason : "channel_only",
        loggedIn ? environmentConflict.reason : authFailureReason,
      ),
      blockers: bridgeBlockers(environmentConflict.reason),
      claude_logged_in: loggedIn,
      channel_access: "confirmed",
      cross_session: loggedIn && options.mode !== "required" ? "channel_only" : "unavailable",
      runtime_comparison: "not_checked",
      local_gate: "not_checked",
      agent,
      ...(environmentConflict.variables.length === 0
        ? {}
        : { cross_session_conflict_variables: environmentConflict.variables }),
      ...diagnosticField(
        authDiagnostic,
        claudeCrossSessionEnvironmentDiagnostic(environmentConflict),
      ),
    }, options.json);
    return !loggedIn || !lifecycleReady || options.mode === "required" ? 1 : 0;
  }

  let gateError: unknown = null;
  try {
    (options.deps.probeClaudeGate ?? probeClaudeGateDirectory)();
  } catch (error) {
    gateError = error;
  }

  try {
    await (options.deps.probeClaudeCrossSession ?? defaultProbeClaudeCrossSession)(
      options.channel,
      options.cwd,
      agent,
    );
  } catch (error) {
    printClaudeBridgeCheck({
      ...checkBase,
      ...lifecycleOutcome(
        !loggedIn
          ? authFailureStatus
          : options.mode === "required" ? "runtime_comparison_unavailable" : "channel_only",
        loggedIn ? "runtime_comparison_unavailable" : authFailureReason,
      ),
      blockers: bridgeBlockers(
        runtimeComparisonBlocker(error),
        ...(gateError === null ? [] : ["local_gate_unavailable" as const]),
      ),
      claude_logged_in: loggedIn,
      channel_access: "confirmed",
      cross_session: loggedIn && options.mode !== "required" ? "channel_only" : "unavailable",
      runtime_comparison: "unavailable",
      local_gate: gateError === null ? "creatable" : "unavailable",
      agent,
      ...(error instanceof ClaudeBridgeEndpointProbeError
        ? { runtime_probe_attempts: error.attempts }
        : {}),
      ...diagnosticField(
        authDiagnostic,
        runtimeComparisonDiagnostic(error),
        gateError === null ? null : `local gate: ${bridgeDiagnostic(gateError)}`,
      ),
    }, options.json);
    return !loggedIn || !lifecycleReady || options.mode === "required" ? 1 : 0;
  }

  if (gateError !== null) {
    printClaudeBridgeCheck({
      ...checkBase,
      ...lifecycleOutcome(
        !loggedIn
          ? authFailureStatus
          : options.mode === "required" ? "local_gate_unavailable" : "channel_only",
        loggedIn ? "local_gate_unavailable" : authFailureReason,
      ),
      blockers: bridgeBlockers("local_gate_unavailable"),
      claude_logged_in: loggedIn,
      channel_access: "confirmed",
      cross_session: loggedIn && options.mode !== "required" ? "channel_only" : "unavailable",
      runtime_comparison: "confirmed",
      local_gate: "unavailable",
      agent,
      ...diagnosticField(authDiagnostic, bridgeDiagnostic(gateError)),
    }, options.json);
    return !loggedIn || !lifecycleReady || options.mode === "required" ? 1 : 0;
  }

  printClaudeBridgeCheck({
    ...checkBase,
    ...lifecycleOutcome(
      loggedIn ? "ready_for_launch" : authFailureStatus,
      loggedIn ? "ready" : authFailureReason,
    ),
    blockers: bridgeBlockers(),
    claude_logged_in: loggedIn,
    channel_access: "confirmed",
    cross_session: loggedIn ? "ready_for_launch" : "unavailable",
    runtime_comparison: "confirmed",
    local_gate: "creatable",
    agent,
    ...diagnosticField(authDiagnostic),
  }, options.json);
  return loggedIn && lifecycleReady ? 0 : 1;
}

async function defaultResolveClaudeAgentName(channel: string): Promise<string | null> {
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) return null;
  try {
    const identity = await fetchMe(auth.server, auth.token);
    return claudeAgentNameForChannel(identity, channel);
  } catch {
    // Naming is a correlation aid, not a prerequisite for the durable Channel.
    return null;
  }
}

async function defaultProbeClaudeChannel(channel: string): Promise<string> {
  const auth = await resolveAuthDetailed();
  const server = auth.server;
  const token = auth.token;
  if (!server || !token) {
    throw new ClaudeChannelProbeError(
      "authentication",
      "AgentParty authentication is unavailable",
    );
  }
  const signal = AbortSignal.timeout(CLAUDE_CROSS_SESSION_PREFLIGHT_TIMEOUT_MS);
  const [identityResult, presenceResult] = await Promise.allSettled([
    retryClaudeBridgeEndpoint(
      (attemptSignal) => fetchMe(server, token, attemptSignal),
      signal,
    ),
    retryClaudeBridgeEndpoint(
      (attemptSignal) => fetchPresence(server, token, channel, attemptSignal),
      signal,
    ),
  ]);
  if (identityResult.status === "rejected") {
    const endpointFailure = identityResult.reason instanceof ClaudeBridgeEndpointProbeError
      ? identityResult.reason
      : null;
    throw new ClaudeChannelProbeError(
      "identity",
      `AgentParty identity check failed: ${bridgeDiagnostic(identityResult.reason)}`,
      endpointFailure?.attempts,
    );
  }
  if (presenceResult.status === "rejected") {
    const endpointFailure = presenceResult.reason instanceof ClaudeBridgeEndpointProbeError
      ? presenceResult.reason
      : null;
    throw new ClaudeChannelProbeError(
      "presence",
      `AgentParty presence check failed: ${bridgeDiagnostic(presenceResult.reason)}`,
      endpointFailure?.attempts,
    );
  }
  const agentName = claudeAgentNameForChannel(identityResult.value, channel);
  if (agentName === null) {
    throw new ClaudeChannelProbeError(
      "identity_binding",
      "authenticated AgentParty identity is not a valid agent for this channel",
    );
  }
  return agentName;
}

async function defaultProbeClaudeCrossSession(
  channel: string,
  cwd: string,
  expectedAgentName: string,
): Promise<void> {
  const auth = await resolveAuthDetailed();
  const server = auth.server;
  const token = auth.token;
  if (!server || !token) {
    throw new Error("AgentParty authentication became unavailable after Channel preflight");
  }
  const topology = buildRuntimeTopology(server, cwd);
  if (topology === undefined) {
    throw new Error("local runtime topology could not be created");
  }
  const signal = AbortSignal.timeout(CLAUDE_CROSS_SESSION_PREFLIGHT_TIMEOUT_MS);
  const discovery = await retryClaudeBridgeEndpoint(
    (attemptSignal) => fetchRuntimePeers(
      server,
      token,
      channel,
      topology,
      "capability_probe",
      attemptSignal,
    ),
    signal,
  );
  if (discovery.self !== expectedAgentName || discovery.caller_binding !== "capability_probe") {
    throw new Error("runtime comparison returned a mismatched authenticated identity");
  }
}

export function claudeAgentNameForChannel(
  identity: Pick<Identity, "kind" | "name" | "channel_scope">,
  channel: string,
): string | null {
  if (identity.kind !== "agent" || !isName(identity.name)) return null;
  // channel_scope is an ACL ceiling: null/undefined means the token is not
  // channel-limited, while a concrete slug must match the bridge channel.
  return identity.channel_scope == null || identity.channel_scope === channel
    ? identity.name
    : null;
}

async function capture(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed (${stderr.trim() || `exit ${code}`})`);
  }
  return stdout;
}

async function defaultProbeCodexCapabilities(
  codexBinary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
  codexArgsPrefix: string[] = [],
): Promise<CodexCapabilityProbe> {
  const [version, rootHelp, appServerHelp] = await Promise.all([
    capture([codexBinary, ...codexArgsPrefix, "--version"], options),
    capture([codexBinary, ...codexArgsPrefix, "--help"], options),
    capture([codexBinary, ...codexArgsPrefix, "app-server", "--help"], options),
  ]);
  return { version: version.trim(), rootHelp, appServerHelp };
}

async function defaultLaunch(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

/**
 * Measured on Codex CLI 0.148.0-alpha.15 against the Codex desktop app: while
 * the GUI has a thread open it holds that thread's only writer, and
 * `thread/resume` on it fails with `already has an active writer`. The same
 * thread resumes normally once the owning process releases it, and the resumed
 * turn then runs in the bridge's own Codex TUI.
 */
export const CODEX_RESUME_VISIBILITY_NOTICE =
  "Codex allows one writer per thread: a session still open in the Codex desktop app " +
  "cannot be resumed — close it there first. The resumed turn runs in this terminal's Codex TUI.";

export function printCodexSessions(
  env: NodeJS.ProcessEnv,
  list: typeof listCodexSessions = listCodexSessions,
): number {
  const root = codexSessionsRoot(env);
  const sessions = list(root, { limit: 20 });
  if (sessions.length === 0) {
    console.error(`no Codex sessions found under ${root}`);
    return 1;
  }
  console.log(`Codex sessions under ${root} (newest first):`);
  for (const session of sessions) console.log(formatCodexSessionLine(session));
  console.log("");
  console.log("Resume one with: party bridge codex <channel> --resume <thread-id>");
  console.log(CODEX_RESUME_VISIBILITY_NOTICE);
  return 0;
}

export type CodexResumeSelection =
  | { ok: true; threadId: string | null; session?: CodexSessionSummary }
  | { ok: false; error: string };

/** Turn `--resume`/`--resume-last` into one concrete Codex thread id. */
export function selectCodexResumeThread(
  options: { resume?: string; resumeLast?: boolean; env: NodeJS.ProcessEnv },
  latest: typeof latestCodexSession = latestCodexSession,
): CodexResumeSelection {
  if (options.resume !== undefined) {
    if (!isCodexThreadId(options.resume)) {
      return {
        ok: false,
        error:
          `--resume expects a Codex thread id (the UUID in rollout-<ts>-<uuid>.jsonl), got ${
            sanitizeSingleLine(options.resume).slice(0, 80)
          }. List them with: party bridge codex --list-sessions`,
      };
    }
    return { ok: true, threadId: options.resume.toLowerCase() };
  }
  if (options.resumeLast !== true) return { ok: true, threadId: null };
  const root = codexSessionsRoot(options.env);
  const session = latest(root, {});
  if (session === null) {
    return { ok: false, error: `--resume-last found no Codex sessions under ${root}` };
  }
  return { ok: true, threadId: session.threadId, session };
}

export async function run(argv: string[], deps: BridgeDeps = {}): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }

  // `--` is a hard ownership boundary: flags after it belong to the selected
  // harness, not AgentParty.
  const delimiter = argv.indexOf("--");
  const bridgeArgs = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const harnessArgs = delimiter < 0 ? [] : argv.slice(delimiter + 1);
  const { positionals, flags } = parseArgs(bridgeArgs, {
    booleans: ["check", "json", "resume-last", "list-sessions"],
  });
  const unknown = unknownFlagError(flags, [
    "channel", "codex-bin", "cross-session", "cross-session-inbound", "check", "json",
    "resume", "resume-last", "list-sessions", "target-thread", "source-thread",
  ]);
  if (unknown !== null) {
    console.error(`${unknown}; put harness flags after --`);
    return 1;
  }
  const flagError = valueFlagError(flags, [
    "channel", "codex-bin", "cross-session", "cross-session-inbound", "resume",
    "target-thread", "source-thread",
  ]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const harness = positionals[0];
  if (harness !== "claude" && harness !== "codex" && harness !== "codex-app") {
    console.error("bridge supports: party bridge claude|codex|codex-app [channel|--channel C] [-- <harness args...>]");
    return 1;
  }
  if (positionals.length > 2) {
    console.error("too many bridge arguments; put harness arguments after --");
    return 1;
  }
  if (harness !== "codex" && flags["codex-bin"] !== undefined) {
    console.error("--codex-bin is only valid with party bridge codex");
    return 1;
  }
  for (const codexOnly of ["resume", "resume-last", "list-sessions"] as const) {
    if (harness !== "codex" && flags[codexOnly] !== undefined) {
      console.error(`--${codexOnly} is only valid with party bridge codex`);
      return 1;
    }
  }
  if (flags.resume !== undefined && flags["resume-last"] === true) {
    console.error("--resume and --resume-last select different threads; pass only one");
    return 1;
  }
  if (
    flags["list-sessions"] === true &&
    (flags.resume !== undefined || flags["resume-last"] === true)
  ) {
    console.error("--list-sessions only prints sessions; it cannot be combined with --resume/--resume-last");
    return 1;
  }
  if (flags["list-sessions"] === true && harnessArgs.length > 0) {
    console.error("--list-sessions does not launch Codex, so it does not accept Codex arguments after --");
    return 1;
  }
  if (harness === "codex" && flags["list-sessions"] === true) {
    return printCodexSessions(deps.env ?? process.env);
  }
  if (harness !== "codex-app" && (flags["target-thread"] !== undefined || flags["source-thread"] !== undefined)) {
    console.error("--target-thread and --source-thread are only valid with party bridge codex-app");
    return 1;
  }
  if (harness === "codex-app" && harnessArgs.length > 0) {
    console.error("party bridge codex-app does not launch a harness and accepts nothing after --");
    return 1;
  }
  if (harness !== "claude" && flags["cross-session"] !== undefined) {
    console.error("--cross-session is only valid with party bridge claude");
    return 1;
  }
  if (harness !== "claude" && flags["cross-session-inbound"] !== undefined) {
    console.error("--cross-session-inbound is only valid with party bridge claude");
    return 1;
  }
  const checkOnly = flags.check === true;
  const json = flags.json === true;
  if (harness !== "claude" && (checkOnly || json)) {
    console.error("--check and --json are only valid with party bridge claude");
    return 1;
  }
  if (json && !checkOnly) {
    console.error("--json requires --check");
    return 1;
  }
  if (checkOnly && harnessArgs.length > 0) {
    console.error("party bridge claude --check does not accept Claude arguments after -- because it does not launch Claude");
    return 1;
  }
  const crossSessionMode = parseClaudeCrossSessionMode(str(flags["cross-session"]));
  if (crossSessionMode === null) {
    console.error("--cross-session must be auto|off|required");
    return 1;
  }
  const crossSessionInbound = parseClaudeCrossSessionInbound(str(flags["cross-session-inbound"]));
  if (crossSessionInbound === null) {
    console.error("--cross-session-inbound must be accept|hold|refuse");
    return 1;
  }
  if (checkOnly && crossSessionInbound !== undefined) {
    console.error("--cross-session-inbound applies only to a Claude launch and cannot be used with --check");
    return 1;
  }
  if (crossSessionInbound !== undefined && crossSessionMode !== "required") {
    console.error("--cross-session-inbound requires --cross-session required so it cannot be silently degraded");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[1]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  if (harness === "codex-app") {
    const targetThreadId = str(flags["target-thread"]) ?? (deps.env ?? process.env).CODEX_THREAD_ID;
    const sourceThreadId = str(flags["source-thread"]);
    if (targetThreadId === undefined || !isCodexThreadId(targetThreadId)) {
      console.error("party bridge codex-app requires --target-thread THREAD_ID (or CODEX_THREAD_ID in the target task)");
      return 1;
    }
    if (sourceThreadId === undefined || !isCodexThreadId(sourceThreadId)) {
      console.error("party bridge codex-app requires --source-thread THREAD_ID for the native delegation label/link");
      return 1;
    }
    if (sourceThreadId.toLowerCase() === targetThreadId.toLowerCase()) {
      console.error("party bridge codex-app source and target must be different tasks");
      return 1;
    }
    return await (deps.runCodexNativeBridge ?? runCodexNativeBridge)({
      channel,
      targetThreadId,
      sourceThreadId,
      hostId: "local",
      cwd: deps.cwd ?? process.cwd(),
      env: deps.env ?? process.env,
    });
  }

  if (harness === "codex") {
    const ownedFlag = harnessArgs.find((arg) =>
      arg === "--remote" ||
      arg.startsWith("--remote=") ||
      arg === "--remote-auth-token-env" ||
      arg.startsWith("--remote-auth-token-env=")
    );
    if (ownedFlag) {
      console.error(
        `party bridge codex owns ${ownedFlag}; remove it so all TUI and AgentParty writes stay on the single bridge endpoint`,
      );
      return 1;
    }
    const resumeSelection = selectCodexResumeThread({
      ...(str(flags.resume) === undefined ? {} : { resume: str(flags.resume)! }),
      resumeLast: flags["resume-last"] === true,
      env: deps.env ?? process.env,
    });
    if (!resumeSelection.ok) {
      console.error(`party bridge codex ${resumeSelection.error}`);
      return 1;
    }
    const cwd = deps.cwd ?? process.cwd();
    const launch = resolveCodexLaunch(
      str(flags["codex-bin"]) ?? deps.codexBinary,
      deps.env ?? process.env,
      cwd,
    );
    if (!launch.ok) {
      console.error(
        `party bridge codex ${launch.error}. ` +
          "The bridge will not rely on launchd's often-incomplete PATH.",
      );
      return 1;
    }
    let probe: CodexCapabilityProbe;
    try {
      probe = await (deps.probeCodexCapabilities ?? defaultProbeCodexCapabilities)(
        launch.codexBinary,
        { cwd: launch.cwd, env: launch.env },
        launch.codexArgsPrefix,
      );
    } catch (error) {
      console.error(`party bridge codex: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    if (!supportsCodexSessionBridge(probe)) {
      console.error(
        `party bridge codex requires Codex CLI >= ${CODEX_BRIDGE_MIN_VERSION.join(".")} with ` +
          `app-server --stdio and --remote unix:// support; found ${probe.version || "unknown"}. ` +
          "Update Codex before attaching a live session. AgentParty will not fall back to PTY injection.",
      );
      return 1;
    }
    if (resumeSelection.threadId !== null) {
      const chosen = resumeSelection.session;
      console.error(
        `party bridge codex: resuming Codex thread ${resumeSelection.threadId}` +
          (chosen === undefined
            ? ""
            : ` (started ${chosen.startedAtLabel}, cwd ${chosen.cwd ?? "unknown"})`) +
          `. ${CODEX_RESUME_VISIBILITY_NOTICE}`,
      );
    }
    return await (deps.runCodexBridge ?? ((options) => runCodexSessionBridge(options)))({
      channel,
      codexBinary: launch.codexBinary,
      codexArgsPrefix: launch.codexArgsPrefix,
      codexArgs: harnessArgs,
      initialThreadId: resumeSelection.threadId,
      cwd: launch.cwd,
      env: launch.env,
    });
  }

  const cwd = deps.cwd ?? process.cwd();
  const inheritedEnv = deps.env ?? process.env;
  const armReceiptFile = inheritedEnv[CLAUDE_SESSION_START_ARM_RECEIPT_FILE_ENV];
  const env = { ...inheritedEnv };
  delete env[CLAUDE_SESSION_START_ARM_RECEIPT_FILE_ENV];
  // The gate path is a per-launch local capability. Route it only to the
  // generated Hook command and AgentParty MCP subprocess; ordinary Claude
  // Bash children must not inherit it through their ambient environment.
  delete env[CLAUDE_CROSS_SESSION_GATE_DIR_ENV];
  // A nested or reused shell must not accidentally activate the Marketplace
  // Channel MCP alongside this bridge-owned Channel MCP. Lifecycle hooks have
  // a separate opt-in and are armed only for the final Claude child below.
  delete env[CLAUDE_CHANNEL_OPT_IN_ENV];
  delete env[CLAUDE_LIFECYCLE_OPT_IN_ENV];
  let rawVersion: string;
  try {
    rawVersion = await (deps.probeClaudeVersion ?? defaultProbeClaudeVersion)({ cwd, env });
  } catch (error) {
    console.error(`party bridge claude: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const platform = deps.platform ?? process.platform;
  if (checkOnly) {
    return await runClaudeBridgeCheck({
      channel,
      mode: crossSessionMode,
      rawVersion,
      platform,
      cwd,
      env,
      json,
      deps,
    });
  }
  if (!supportsClaudeChannels(rawVersion)) {
    console.error(
      `party bridge claude requires Claude Code >= ${CLAUDE_CHANNEL_MIN_VERSION.join(".")}; found ${rawVersion || "unknown"}. ` +
        "Update Claude Code before attaching a live session. AgentParty will not fall back to PTY injection or concurrently resume it.",
    );
    return 1;
  }

  const lifecycleProbe = await probeClaudePluginLifecycleState(deps, rawVersion);
  if (lifecycleProbe.inspection.status !== "ready") {
    console.error(
      `party bridge claude requires a ready Marketplace lifecycle shell ` +
        `(${lifecycleProbe.inspection.blockers.join(", ") || "plugin_state_unavailable"}). ` +
        "The Channel was not launched. Run: party doctor claude-plugin --json",
    );
    return 1;
  }

  if (hasClaudeSafeModeArg(harnessArgs)) {
    console.error(
      "party bridge claude cannot be combined with Claude --safe-mode because safe mode disables custom MCP servers, including the AgentParty Channel.",
    );
    return 1;
  }

  const crossSessionSupported = supportsClaudeCrossSession(rawVersion, platform);
  if (crossSessionMode === "required" && !crossSessionSupported) {
    console.error(
      `party bridge claude --cross-session required needs macOS or Linux and Claude Code >= ` +
        `${CLAUDE_CROSS_SESSION_MIN_VERSION.join(".")}; found platform=${platform}, ` +
        `version=${rawVersion || "unknown"}. The Channel was not launched.`,
    );
    return 1;
  }
  const inheritedConflict = crossSessionMode === "off"
    ? null
    : claudeCrossSessionEnvironmentConflict(env);
  // Provider settings can override inherited provider flags. Defer that decision
  // until `claude auth status` returns Claude's resolved apiProvider.
  const inheritedEnvironmentConflict = inheritedConflict?.reason ===
      "feature_flag_evaluation_disabled"
    ? inheritedConflict
    : null;
  if (crossSessionMode === "required" && inheritedEnvironmentConflict !== null) {
    console.error(
      "party bridge claude --cross-session required cannot start: " +
        `${claudeCrossSessionEnvironmentDiagnostic(inheritedEnvironmentConflict)}. ` +
        "The Channel was not launched.",
    );
    return 1;
  }
  const bareClaude = hasClaudeBareArg(harnessArgs);
  if (crossSessionMode === "required" && bareClaude) {
    console.error(
      "party bridge claude --cross-session required cannot be combined with Claude --bare because bare mode does not bind an inbox socket.",
    );
    return 1;
  }
  const toolConflict = claudeCrossSessionToolConflict(harnessArgs);
  if (crossSessionMode === "required" && toolConflict !== null) {
    console.error(
      `party bridge claude --cross-session required cannot use this Claude tool policy: ${toolConflict}.`,
    );
    return 1;
  }
  const hookSettingsConflict = hasClaudeSettingsArg(harnessArgs);
  if (crossSessionMode === "required" && hookSettingsConflict) {
    console.error(
      "party bridge claude --cross-session required cannot use an explicit Claude --settings. " +
        "It could replace or disable the per-launch Cross-session send gate.",
    );
    return 1;
  }
  let crossSessionEnabled = crossSessionMode !== "off" &&
    crossSessionSupported &&
    inheritedEnvironmentConflict === null &&
    !bareClaude &&
    toolConflict === null &&
    !hookSettingsConflict;
  let crossSessionReason: ClaudeCrossSessionLaunchReason = crossSessionMode === "off"
    ? "disabled_by_operator"
    : !crossSessionSupported
      ? "unsupported_platform_or_version"
      : inheritedEnvironmentConflict !== null
        ? inheritedEnvironmentConflict.reason
        : bareClaude
          ? "claude_bare"
          : toolConflict !== null
            ? "tool_policy"
            : hookSettingsConflict
              ? "local_hook_settings_conflict"
              : "ready";
  if (crossSessionMode === "auto" && inheritedEnvironmentConflict !== null) {
    console.error(
      `party bridge claude: ${claudeCrossSessionEnvironmentDiagnostic(inheritedEnvironmentConflict)}; ` +
        "continuing with the AgentParty Channel and no Cross-session peer hints.",
    );
  }
  if (crossSessionMode === "auto" && crossSessionSupported && bareClaude) {
    console.error(
      "party bridge claude: Claude --bare disables inbox sockets; continuing with the AgentParty Channel and no Cross-session peer hints.",
    );
  }
  if (crossSessionMode === "auto" && crossSessionSupported && !bareClaude && toolConflict !== null) {
    console.error(
      `party bridge claude: ${toolConflict}; continuing with the AgentParty Channel and no Cross-session peer hints.`,
    );
  }
  if (
    crossSessionMode === "auto" && crossSessionSupported && !bareClaude &&
    toolConflict === null && hookSettingsConflict
  ) {
    console.error(
      "party bridge claude: explicit Claude --settings could replace or disable the local Cross-session send gate; " +
        "continuing with the AgentParty Channel and no Cross-session peer hints.",
    );
  }

  const explicitClaudeName = claudeNameArg(harnessArgs);
  if (explicitClaudeName === "") {
    console.error(
      "party bridge claude: explicit --name requires a non-empty value. The Channel was not launched.",
    );
    return 1;
  }
  if (crossSessionEnabled && explicitClaudeName !== undefined) {
    if (crossSessionMode === "required") {
      console.error(
        "party bridge claude --cross-session required cannot use an explicit Claude --name. " +
          "AgentParty must generate a fresh unique address for this bridge launch.",
      );
      return 1;
    }
    console.error(
      "party bridge claude: explicit Claude --name disables AgentParty Cross-session correlation " +
        "because a stable name can later refer to another session; continuing with the Channel only.",
    );
    crossSessionEnabled = false;
    crossSessionReason = "explicit_stable_name";
  }
  const claudeAuth = await probeClaudeAuthState(deps, { cwd, env });
  if (claudeAuth.status !== "logged_in") {
    console.error(
      claudeAuth.status === "logged_out"
        ? "party bridge claude: Claude Code is not logged in; run `claude auth login`. Claude was not launched."
        : `party bridge claude could not verify Claude authentication: ${claudeAuth.diagnostic}. ` +
          "Claude was not launched.",
    );
    return 1;
  }
  const resolvedProviderConflict = crossSessionEnabled
    ? claudeCrossSessionEnvironmentConflict(env, claudeAuth.apiProvider)
    : null;
  if (resolvedProviderConflict !== null) {
    if (crossSessionMode === "required") {
      console.error(
        "party bridge claude --cross-session required cannot start: " +
          `${claudeCrossSessionEnvironmentDiagnostic(resolvedProviderConflict)}. ` +
          "The Channel was not launched.",
      );
      return 1;
    }
    console.error(
      `party bridge claude: ${claudeCrossSessionEnvironmentDiagnostic(resolvedProviderConflict)}; ` +
        "continuing with the AgentParty Channel and no Cross-session peer hints.",
    );
    crossSessionEnabled = false;
    crossSessionReason = resolvedProviderConflict.reason;
  }
  let channelAgentName: string;
  try {
    const channelProbe = deps.probeClaudeChannel ?? (deps.resolveClaudeAgentName === undefined
      ? defaultProbeClaudeChannel
      : async (resolvedChannel: string) => {
          const name = await deps.resolveClaudeAgentName!(resolvedChannel);
          if (name === null) throw new Error("AgentParty identity is not a valid agent for this channel");
          return name;
        });
    channelAgentName = await channelProbe(channel);
  } catch (error) {
    console.error(
      `party bridge claude could not verify AgentParty Channel access: ${bridgeDiagnostic(error)}. ` +
        "Claude was not launched.",
    );
    return 1;
  }
  if (crossSessionEnabled) {
    try {
      await (deps.probeClaudeCrossSession ?? defaultProbeClaudeCrossSession)(channel, cwd, channelAgentName);
    } catch (error) {
      const detail = bridgeDiagnostic(error);
      if (crossSessionMode === "required") {
        console.error(
          "party bridge claude --cross-session required could not verify AgentParty runtime comparison: " +
            `${detail}. The Channel was not launched.`,
        );
        return 1;
      }
      console.error(
        `party bridge claude: AgentParty runtime comparison is unavailable (${detail}); ` +
          "continuing with the Channel only.",
      );
      crossSessionEnabled = false;
      crossSessionReason = "runtime_comparison_unavailable";
    }
  }
  const sessionName = crossSessionEnabled && explicitClaudeName === undefined
    ? (deps.createClaudeSessionName ?? createClaudeSessionName)(channelAgentName)
    : undefined;
  if (sessionName !== undefined && !isAgentPartyClaudeSessionAddress(sessionName)) {
    console.error("party bridge claude: could not create a safe unique Cross-session name; the Channel was not launched.");
    return 1;
  }
  let gateDirectory: string | undefined;
  if (crossSessionEnabled) {
    try {
      gateDirectory = mkdtempSync(resolve(tmpdir(), "agentparty-claude-cross-session-"));
      chmodSync(gateDirectory, 0o700);
    } catch (error) {
      if (crossSessionMode === "required") {
        console.error(
          `party bridge claude --cross-session required could not create its local send gate: ` +
            `${bridgeDiagnostic(error)}. The Channel was not launched.`,
        );
        return 1;
      }
      console.error(
        `party bridge claude: local Cross-session send gate is unavailable (${bridgeDiagnostic(error)}); ` +
          "continuing with the Channel only.",
      );
      crossSessionEnabled = false;
      crossSessionReason = "local_gate_unavailable";
    }
  }
  const effectiveSessionName = crossSessionEnabled ? sessionName : undefined;
  const launch = buildClaudeBridgeLaunch({
    channel,
    claudeArgs: harnessArgs,
    crossSession: crossSessionEnabled,
    ...(effectiveSessionName === undefined ? {} : { sessionName: effectiveSessionName }),
    ...(gateDirectory === undefined ? {} : { gateDirectory }),
    ...(crossSessionEnabled && crossSessionInbound !== undefined ? { crossSessionInbound } : {}),
    execPath: deps.execPath,
    processArgv: deps.processArgv,
  });
  const launchEnv: NodeJS.ProcessEnv = {
    ...env,
    AGENTPARTY_CHANNEL: channel,
    [CLAUDE_LIFECYCLE_OPT_IN_ENV]: "1",
  };
  console.error(
    `party bridge: launching Claude Code for #${channel}; channel=launching ` +
      `cross_session=${crossSessionEnabled ? "enabled_for_launch" : "channel_only"} ` +
      `mode=${crossSessionMode} reason=${crossSessionReason} ` +
      `cross_machine=${crossSessionEnabled ? "approval_required" : "not_applicable"}` +
      `${effectiveSessionName === undefined ? "" : ` address=${effectiveSessionName}`}. ` +
      "If organization policy disables development Channels, Claude will reject the channel explicitly; no unsafe resume fallback is attempted.",
  );
  try {
    const receiptAddress = effectiveSessionName;
    let launchSettled = false;
    const launchOutcome = Promise.resolve()
      .then(() => (deps.launch ?? defaultLaunch)(launch.command, launch.args, { cwd, env: launchEnv }))
      .then(
        (exitCode) => {
          launchSettled = true;
          return { ok: true as const, exitCode };
        },
        (error: unknown) => {
          launchSettled = true;
          return { ok: false as const, error };
        },
      );
    const armOutcome = gateDirectory === undefined || receiptAddress === undefined
      ? Promise.resolve({ ok: true as const, arm: null })
      : observeClaudeSessionStartArm(gateDirectory, () => launchSettled)
          .then((arm) => {
            if (arm !== null) {
              publishClaudeSessionStartArmReceipt(receiptAddress, arm, armReceiptFile);
            }
            return { ok: true as const, arm };
          })
          .catch((error: unknown) => ({ ok: false as const, error }));
    const [completedLaunch, observedArm] = await Promise.all([launchOutcome, armOutcome]);
    if (!completedLaunch.ok) throw completedLaunch.error;
    if (!observedArm.ok) {
      console.error(`party bridge claude: could not write its private arm receipt (${bridgeDiagnostic(observedArm.error)}).`);
      return 1;
    }
    if (crossSessionEnabled && observedArm.arm === null) {
      console.error(
        "party bridge claude: cross_session=session_start_unarmed; Claude exited before the top-level " +
          "SessionStart hook armed the local send gate. No Cross-session delivery is proven.",
      );
      if (crossSessionMode === "required" && completedLaunch.exitCode === 0) return 1;
    }
    return completedLaunch.exitCode;
  } finally {
    if (gateDirectory !== undefined) {
      try {
        rmSync(gateDirectory, { recursive: true, force: true });
      } catch {
        // Bridge-owned temporary state is best-effort cleanup after Claude exits.
      }
    }
  }
}
