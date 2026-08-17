#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { MsgFrame, PresenceEntry, ServerFrame } from "../shared/src/protocol";
import { connect, type Connection } from "../cli/src/client";
import {
  defaultClaudePluginDoctorDependencies,
  inspectClaudePluginShell,
  type ClaudePluginShellInspection,
} from "../cli/src/commands/doctor";
import { parseClaudeAuthInfo, selfCommand, supportsClaudeChannels } from "../cli/src/commands/bridge";
import {
  fetchMe,
  fetchMessages,
  fetchPresence,
  fetchRecentMessages,
  postMessage,
  reviseMessage,
  type Identity,
} from "../cli/src/rest";
import { RUNNING_VERSION } from "../cli/src/upgrade";
import {
  directClaudeToolResultBlocks,
  directClaudeToolUseBlocks,
  sameSessionEventsAfterUniqueInit,
  uniqueClaudeStreamInit,
  uniqueSuccessfulClaudeToolResultIndex,
} from "./claude-cross-session-stream-evidence";
import {
  captureCrossSessionProbe,
  crossSessionOutputLimitReport,
  writeCrossSessionReleaseFile,
} from "./cross-session-process-lifecycle";
import {
  normalizeServer,
  readPrivateAgentConfig,
  redactIntegrationEvidence,
  resolveIntegrationWorkingDirectory,
  spawnCaptured,
  stopCaptured,
  type CapturedProcess,
  type IntegrationVerifierSelfCommand,
} from "./verify-agentparty-claude-cross-session";
import { parseClaudeVersion, parseJsonLines } from "./verify-claude-cross-session";

const PREFLIGHT_SCHEMA = "agentparty.claude-channel-busy-preflight.v1";
const ACCEPTANCE_SCHEMA = "agentparty.claude-channel-busy-acceptance.v1";
const MIN_VERSION = [2, 1, 80] as const;
const PROBE_TIMEOUT_MS = 10_000;
const BUSY_ACTIVITY_TIMEOUT_MS = 10_000;
const LINKED_REPLY_TIMEOUT_MS = 90_000;
const RELEASE_FILE_ENV = "AGENTPARTY_CLAUDE_CHANNEL_BUSY_RELEASE_FILE";
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface BusyChannelArguments {
  channel: string;
  receiverConfigPath: string;
  senderConfigPath: string;
  receiverCwd?: string;
  preflightOnly: boolean;
  live: boolean;
  keepArtifacts: boolean;
}

export interface BusyChannelEvidence {
  busy_activity_observed_before_send: boolean;
  source_message_persisted: boolean;
  linked_reply_persisted: boolean;
  claim_accept_reply_chain_observed: boolean;
  delivery_terminal_settled: boolean;
}

export type BusyChannelSourceCleanup =
  | "not_needed"
  | "retracted"
  | "not_found_or_unconfirmed"
  | "failed";

export function busyChannelCleanupRequired(status: BusyChannelSourceCleanup): boolean {
  return status === "not_found_or_unconfirmed" || status === "failed";
}

export interface BusyChannelRunOptions {
  selfCommand?: IntegrationVerifierSelfCommand;
  workspacePath?: string;
  usageCommand?: string;
  probePluginLifecycle?: (
    rawClaudeVersion: string,
  ) => ClaudePluginShellInspection | Promise<ClaudePluginShellInspection>;
  probeChannelProtocol?: (
    server: string,
    token: string,
    channel: string,
  ) => Promise<BusyChannelProtocolStatus>;
  probeClaudeVersion?: () => Promise<{ stdout: string; stderr: string; code: number } | null>;
  probeClaudeAuth?: () => Promise<{ stdout: string; stderr: string; code: number } | null>;
  loadIdentity?: (
    server: string,
    token: string,
    signal: AbortSignal,
  ) => Promise<Identity>;
  loadPresence?: (
    server: string,
    token: string,
    channel: string,
    signal: AbortSignal,
  ) => Promise<PresenceEntry[]>;
}

class BusyChannelAcceptanceError extends Error {
  constructor(readonly code: "busy_activity_not_observed") {
    super(code);
    this.name = "BusyChannelAcceptanceError";
  }
}

export interface BusyChannelPreflightInput {
  channel: string;
  serverOrigin: string;
  parsedVersion: [number, number, number] | null;
  rawClaudeVersion: string;
  claudeLoggedIn: boolean;
  lifecycle: ClaudePluginShellInspection;
  receiverAgent: string | null;
  senderAgent: string | null;
  receiverChannelAccess: boolean;
  senderChannelAccess: boolean;
  receiverListenerActive: boolean;
  channelProtocol: BusyChannelProtocolStatus;
}

export type BusyChannelProtocolStatus = "confirmed" | "worker_upgrade_required" | "unavailable";

export function classifyBusyChannelWelcome(frame: ServerFrame): BusyChannelProtocolStatus {
  if (frame.type !== "welcome") return "unavailable";
  return frame.directed_delivery === "v1" && frame.delivery_recovery === "v1"
    ? "confirmed"
    : "worker_upgrade_required";
}

export async function probeBusyChannelProtocol(
  server: string,
  token: string,
  channel: string,
  openConnection: (
    server: string,
    token: string,
    channel: string,
  ) => Connection = (resolvedServer, resolvedToken, resolvedChannel) => connect(
    resolvedServer,
    resolvedToken,
    resolvedChannel,
    0,
    {
      directedDelivery: "v1",
      deliveryRecovery: "v1",
      pingIntervalMs: 2_000,
      inboundIdleTimeoutMs: 5_000,
    },
  ),
): Promise<BusyChannelProtocolStatus> {
  const connection = openConnection(server, token, channel);
  try {
    return await Promise.race([
      (async () => {
        for await (const frame of connection.frames) {
          if (frame.type === "welcome") return classifyBusyChannelWelcome(frame);
          if (frame.type === "error") return "unavailable" as const;
          // Do not ack, register a delivery adapter, or send any actionable
          // frame. Without adapter registration the Worker cannot assign work.
        }
        return "unavailable" as const;
      })(),
      new Promise<BusyChannelProtocolStatus>((resolveTimeout) => {
        const timer = setTimeout(() => resolveTimeout("unavailable"), 5_000);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    connection.close();
  }
}

export function inspectBusyChannelPreflight(input: BusyChannelPreflightInput): {
  report: Record<string, unknown>;
  exitCode: number;
} {
  const blockers = [
    ...(input.parsedVersion === null || !supportsClaudeChannels(input.rawClaudeVersion) ||
        !atLeast(input.parsedVersion, MIN_VERSION)
      ? ["claude_version_unsupported"]
      : []),
    ...(input.claudeLoggedIn ? [] : ["claude_auth_required"]),
    ...input.lifecycle.blockers,
    ...(input.receiverAgent === null ? ["receiver_identity_invalid"] : []),
    ...(input.senderAgent === null ? ["sender_identity_invalid"] : []),
    ...(input.receiverChannelAccess ? [] : ["receiver_channel_unavailable"]),
    ...(input.senderChannelAccess ? [] : ["sender_channel_unavailable"]),
    ...(input.receiverAgent !== null && input.receiverAgent === input.senderAgent
      ? ["agent_identity_conflict"]
      : []),
    ...(input.receiverListenerActive ? ["receiver_listener_already_active"] : []),
    ...(input.channelProtocol === "worker_upgrade_required" ? ["worker_upgrade_required"] : []),
    ...(input.channelProtocol === "unavailable" ? ["channel_protocol_unavailable"] : []),
  ];
  const status = blockers.length === 0
    ? "ready"
    : input.lifecycle.blockers.length > 0
      ? "plugin_lifecycle_unavailable"
      : blockers.includes("worker_upgrade_required")
        ? "worker_upgrade_required"
      : blockers.includes("claude_version_unsupported")
        ? "environment_unavailable"
        : blockers.includes("claude_auth_required")
          ? "claude_auth_required"
          : "agentparty_unavailable";
  const exitCode = status === "ready" ? 0 :
    status === "plugin_lifecycle_unavailable" ? 11 :
      status === "worker_upgrade_required" ? 3 :
      status === "agentparty_unavailable" ? 8 :
        status === "claude_auth_required" ? 2 : 10;
  return {
    exitCode,
    report: {
      schema: PREFLIGHT_SCHEMA,
      status,
      blockers,
      claude_version: input.parsedVersion?.join(".") ?? "unknown",
      claude_logged_in: input.claudeLoggedIn,
      lifecycle: lifecycleProjection(input.lifecycle),
      server: input.serverOrigin,
      channel: input.channel,
      receiver_identity: input.receiverAgent === null ? "invalid_or_unavailable" : "confirmed",
      sender_identity: input.senderAgent === null ? "invalid_or_unavailable" : "confirmed",
      receiver_channel_access: input.receiverChannelAccess ? "confirmed" : "unavailable",
      sender_channel_access: input.senderChannelAccess ? "confirmed" : "unavailable",
      channel_protocol: input.channelProtocol,
      ...(input.receiverAgent === null ? {} : { receiver_agent: input.receiverAgent }),
      ...(input.senderAgent === null ? {} : { sender_agent: input.senderAgent }),
      model_calls_started: false,
      channel_writes_started: false,
      delivery_verified: false,
    },
  };
}

function usage(command = "bun scripts/verify-agentparty-claude-channel.ts"): void {
  console.log(`usage: ${command} --channel SLUG \\
  --receiver-config PATH --sender-config PATH [--receiver-cwd DIR] \\
  (--preflight-only | --live) [--keep-artifacts]

The two owned 0600 configs must contain different AgentParty agent tokens for
the same server and channel. --preflight-only performs no model call or Channel
write. --live explicitly authorizes one real model session and durable test
messages that remain in Channel history and audit.

Full mode starts one real Claude session through party claude. While its first
Bash tool is still running, the verifier persists one durable @mention from the
sender, then releases the Bash boundary. Passing requires fresh busy lifecycle
presence, one source message, the exact plugin-scoped party_channel_claim ->
party_channel_accept -> party_channel_reply tool chain, and one exact linked
reply persisted by the receiver. This is durable Channel proof, not native
Cross-session SendMessage proof. If cleanup_required=true, search the reported
cleanup_search_marker, then retract the exact source seq with the sender config.`);
}

export function parseBusyChannelArguments(argv: readonly string[]): BusyChannelArguments {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  const valueFlags = new Set(["--channel", "--receiver-config", "--sender-config", "--receiver-cwd"]);
  const booleanFlags = new Set(["--preflight-only", "--live", "--keep-artifacts"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if ((!valueFlags.has(arg) && !booleanFlags.has(arg)) || seen.has(arg)) {
      throw new Error("invalid_arguments");
    }
    seen.add(arg);
    if (booleanFlags.has(arg)) continue;
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("invalid_arguments");
    values.set(arg, value);
  }
  const channel = values.get("--channel");
  const receiverConfigPath = values.get("--receiver-config");
  const senderConfigPath = values.get("--sender-config");
  if (!channel || !receiverConfigPath || !senderConfigPath) throw new Error("invalid_arguments");
  if (!CHANNEL_RE.test(channel)) throw new Error("invalid_channel");
  const preflightOnly = seen.has("--preflight-only");
  const live = seen.has("--live");
  if (preflightOnly === live) throw new Error("invalid_arguments");
  return {
    channel,
    receiverConfigPath,
    senderConfigPath,
    ...(values.get("--receiver-cwd") === undefined
      ? {}
      : { receiverCwd: values.get("--receiver-cwd")! }),
    preflightOnly,
    live,
    keepArtifacts: seen.has("--keep-artifacts"),
  };
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index]! > minimum[index]!) return true;
    if (version[index]! < minimum[index]!) return false;
  }
  return true;
}

function validAgent(identity: Identity, channel: string): string | null {
  return identity.kind === "agent" && identity.name !== "" &&
      (identity.channel_scope == null || identity.channel_scope === channel)
    ? identity.name
    : null;
}

function defaultPluginLifecycle(rawVersion: string): ClaudePluginShellInspection {
  return inspectClaudePluginShell({
    claudeVersion: () => rawVersion,
    claudePlugins: defaultClaudePluginDoctorDependencies.claudePlugins,
    inspectBundle: defaultClaudePluginDoctorDependencies.inspectBundle,
  });
}

function lifecycleProjection(inspection: ClaudePluginShellInspection) {
  return {
    source: "marketplace_plugin" as const,
    status: inspection.status === "ready" ? "ready" as const : "unavailable" as const,
    blockers: inspection.blockers,
    runtime_version: inspection.runtime_version,
    plugin: inspection.plugin,
  };
}

function listenerActive(presence: readonly PresenceEntry[], name: string): boolean {
  return presence.some((entry) =>
    entry.name === name && entry.live === true && entry.wake?.kind === "daemon" && entry.residency === "daemon"
  );
}

function toolName(value: unknown, suffix: string): value is string {
  return typeof value === "string" && value.startsWith("mcp__plugin_") &&
    value.includes("agentparty") && value.endsWith(`__${suffix}`);
}

function nestedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(nestedStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(nestedStrings);
}

function toolResultText(event: Record<string, unknown>, toolUseId: string): string | null {
  const results = directClaudeToolResultBlocks(event);
  if (results.length !== 1 || results[0]!.tool_use_id !== toolUseId || results[0]!.is_error === true) return null;
  return nestedStrings(results[0]!.content).join("\n");
}

export function busyChannelModelCallState(
  captured: Pick<CapturedProcess, "stdout"> | null,
): false | true | "unknown" {
  if (captured === null) return false;
  return uniqueClaudeStreamInit(parseJsonLines(captured.stdout)) === null ? "unknown" : true;
}

export function inspectBusyChannelToolChain(
  lines: readonly string[],
  sourceSeq: number,
  expectedReplySeq: number,
  expectedReply: string,
  sourceMarker: string,
): boolean {
  const allEvents = parseJsonLines(lines);
  const events = sameSessionEventsAfterUniqueInit(allEvents);
  if (events === null) return false;
  const everyToolUse = allEvents.flatMap((event) => directClaudeToolUseBlocks(event, false));
  if (everyToolUse.length !== 4) return false;
  const indexed = events.flatMap((event, index) =>
    directClaudeToolUseBlocks(event).map((use) => ({ event, index, use })))
    .filter((item) => directClaudeToolUseBlocks(item.event).length === 1);
  if (indexed.length !== 4 || indexed[0]!.use.name !== "Bash") return false;
  const [claim, accept, reply] = indexed.slice(1);
  if (
    !toolName(claim?.use.name, "party_channel_claim") ||
    !toolName(accept?.use.name, "party_channel_accept") ||
    !toolName(reply?.use.name, "party_channel_reply")
  ) return false;
  const claimPrefix = claim.use.name.slice(0, -"party_channel_claim".length);
  if (
    accept.use.name.slice(0, -"party_channel_accept".length) !== claimPrefix ||
    reply.use.name.slice(0, -"party_channel_reply".length) !== claimPrefix
  ) return false;
  const executionId = (claim.use.input as { execution_id?: unknown } | undefined)?.execution_id;
  const claimId = claim.use.id;
  const acceptId = accept.use.id;
  const replyId = reply.use.id;
  if (
    typeof executionId !== "string" || executionId === "" ||
    typeof claimId !== "string" || claimId === "" ||
    typeof acceptId !== "string" || acceptId === "" ||
    typeof replyId !== "string" || replyId === ""
  ) return false;
  const claimResultIndex = uniqueSuccessfulClaudeToolResultIndex(allEvents, claimId, claim.index);
  if (claimResultIndex === null) return false;
  const claimText = toolResultText(events[claimResultIndex]!, claimId);
  const receiptMatch = claimText?.match(/claim_receipt=([0-9a-f-]{36})/i) ?? null;
  if (receiptMatch === null || !claimText!.includes(sourceMarker)) return false;
  const acceptInput = accept.use.input as { execution_id?: unknown; claim_receipt?: unknown } | undefined;
  if (
    accept.index <= claimResultIndex || acceptInput?.execution_id !== executionId ||
    acceptInput.claim_receipt !== receiptMatch[1]
  ) return false;
  const acceptResultIndex = uniqueSuccessfulClaudeToolResultIndex(allEvents, acceptId, accept.index);
  if (acceptResultIndex === null || acceptResultIndex >= reply.index) return false;
  const replyInput = reply.use.input as { seq?: unknown; text?: unknown } | undefined;
  if (replyInput?.seq !== sourceSeq || replyInput.text !== expectedReply) return false;
  const replyResultIndex = uniqueSuccessfulClaudeToolResultIndex(allEvents, replyId, reply.index);
  if (replyResultIndex === null || replyResultIndex <= reply.index) return false;
  const replyResult = toolResultText(events[replyResultIndex]!, replyId);
  return replyResult?.includes(
    `AgentParty reply persisted as seq=${expectedReplySeq} (reply_to=${sourceSeq}).`,
  ) === true;
}

async function waitForBusyBash(
  server: string,
  token: string,
  channel: string,
  agent: string,
  launchedAt: number,
  captured: CapturedProcess,
): Promise<boolean> {
  const deadline = Date.now() + BUSY_ACTIVITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const rows = await fetchPresence(server, token, channel, AbortSignal.timeout(2_000));
      if (rows.some((entry) =>
        entry.name === agent && entry.live === true && entry.wake?.kind === "daemon" &&
        entry.residency === "daemon" && entry.activity?.phase === "tool" &&
        entry.activity.tool === "Bash" && entry.activity.ts >= launchedAt
      )) return true;
    } catch {
      // Retry inside the bounded busy-observation window.
    }
    if (captured.process.exitCode !== null) return false;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function waitForLinkedReply(
  server: string,
  token: string,
  channel: string,
  receiver: string,
  sourceSeq: number,
  body: string,
  captured: CapturedProcess,
): Promise<MsgFrame | null> {
  const deadline = Date.now() + LINKED_REPLY_TIMEOUT_MS;
  for (;;) {
    try {
      const messages = await fetchMessages(
        server,
        token,
        channel,
        Math.max(0, sourceSeq - 1),
        100,
        {},
        AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      );
      const replies = messages.filter((message) =>
        message.sender.name === receiver && message.reply_to === sourceSeq && message.body === body);
      if (replies.length === 1) return replies[0]!;
      if (replies.length > 1) return null;
    } catch {
      // A transient history read is retried while the model process is alive.
    }
    if (Date.now() >= deadline || captured.process.exitCode !== null) return null;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

function retractedSourceFrame(message: MsgFrame | undefined, sourceSeq: number): boolean {
  return message?.seq === sourceSeq && message.retracted === true &&
    message.body === "[retracted]" && message.mentions.length === 0;
}

export async function recoverBusyChannelSourceSeq(
  server: string,
  token: string,
  channel: string,
  senderAgent: string,
  exactBody: string,
  loadRecent: typeof fetchRecentMessages = fetchRecentMessages,
  timeoutMs = 5_000,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)),
): Promise<number | null> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      const messages = await loadRecent(
        server,
        token,
        channel,
        200,
        {},
        AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      );
      const matches = messages.filter((message) =>
        message.sender.name === senderAgent && message.body === exactBody && message.retracted !== true);
      if (matches.length === 1) return matches[0]!.seq;
      if (matches.length > 1) return null;
    } catch {
      // The POST and history read can cross during a lost-response window.
      // Retry only inside this bounded recovery interval.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    await wait(Math.min(100, remaining));
  }
}

export async function cleanupBusyChannelSource(
  server: string,
  token: string,
  channel: string,
  sourceSeq: number | null,
  revise: typeof reviseMessage = reviseMessage,
  loadMessages: typeof fetchMessages = fetchMessages,
): Promise<BusyChannelSourceCleanup> {
  if (sourceSeq === null) return "not_found_or_unconfirmed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await revise(
        server,
        token,
        channel,
        sourceSeq,
        "retract",
        undefined,
        AbortSignal.timeout(5_000),
      );
      if (retractedSourceFrame(result.message, sourceSeq)) return "retracted";
    } catch {
      try {
        const messages = await loadMessages(
          server,
          token,
          channel,
          Math.max(0, sourceSeq - 1),
          2,
          {},
          AbortSignal.timeout(5_000),
        );
        if (retractedSourceFrame(messages.find((message) => message.seq === sourceSeq), sourceSeq)) {
          return "retracted";
        }
      } catch {
        // Retry the terminal cleanup inside the bounded attempt budget.
      }
    }
    if (attempt < 2) await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
  }
  return "failed";
}

async function waitForBusyToolChain(
  captured: CapturedProcess,
  sourceSeq: number,
  expectedReplySeq: number,
  expectedReply: string,
  sourceMarker: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (inspectBusyChannelToolChain(
      captured.stdout,
      sourceSeq,
      expectedReplySeq,
      expectedReply,
      sourceMarker,
    )) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

function childEnvironment(home: string, config: string, releaseFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTPARTY_HOME: home,
    AGENTPARTY_CONFIG: config,
    [RELEASE_FILE_ENV]: releaseFile,
  };
}

function writePrivateConfig(path: string, server: string, token: string): void {
  writeFileSync(path, JSON.stringify({ server, token }), { mode: 0o600 });
}

function invalidReport(code: string) {
  return {
    schema: PREFLIGHT_SCHEMA,
    status: "invalid_request",
    blockers: [code],
    error_code: code,
    model_calls_started: false,
    channel_writes_started: false,
    delivery_verified: false,
  };
}

export async function runBusyClaudeChannelAcceptance(
  argv: string[],
  options: BusyChannelRunOptions = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage(options.usageCommand);
    return 0;
  }
  let args: BusyChannelArguments;
  try {
    args = parseBusyChannelArguments(argv);
  } catch (error) {
    console.log(JSON.stringify(invalidReport(error instanceof Error ? error.message : "invalid_arguments"), null, 2));
    return 9;
  }
  let receiverSource: ReturnType<typeof readPrivateAgentConfig>;
  let senderSource: ReturnType<typeof readPrivateAgentConfig>;
  try {
    receiverSource = readPrivateAgentConfig(args.receiverConfigPath, "receiver");
    senderSource = readPrivateAgentConfig(args.senderConfigPath, "sender");
  } catch {
    console.log(JSON.stringify(invalidReport("config_invalid"), null, 2));
    return 9;
  }
  let server: ReturnType<typeof normalizeServer>;
  try {
    server = normalizeServer(receiverSource.server);
    if (normalizeServer(senderSource.server).url !== server.url) throw new Error("server mismatch");
  } catch {
    console.log(JSON.stringify(invalidReport("server_mismatch"), null, 2));
    return 9;
  }
  if (receiverSource.token === senderSource.token) {
    console.log(JSON.stringify(invalidReport("agent_token_conflict"), null, 2));
    return 9;
  }
  let cwd: string;
  try {
    cwd = resolveIntegrationWorkingDirectory(
      args.receiverCwd ?? options.workspacePath ?? process.cwd(),
      "receiver",
    );
  } catch {
    console.log(JSON.stringify(invalidReport("receiver_cwd_invalid"), null, 2));
    return 9;
  }
  const [versionProbe, authProbe] = await Promise.all([
    (options.probeClaudeVersion ?? (() =>
      captureCrossSessionProbe(["claude", "--version"], PROBE_TIMEOUT_MS, "Claude version probe")
        .catch(() => null)))(),
    (options.probeClaudeAuth ?? (() =>
      captureCrossSessionProbe(["claude", "auth", "status"], PROBE_TIMEOUT_MS, "Claude auth probe")
        .catch(() => null)))(),
  ]);
  const parsedVersion = parseClaudeVersion(versionProbe?.stdout ?? "");
  const auth = parseClaudeAuthInfo(authProbe?.stdout ?? "");
  const rawVersion = versionProbe?.stdout.trim() ?? "";
  let plugin: ClaudePluginShellInspection;
  try {
    plugin = await (options.probePluginLifecycle ?? defaultPluginLifecycle)(rawVersion);
  } catch {
    plugin = {
      status: "plugin_state_unavailable",
      blockers: ["plugin_state_unavailable"],
      runtime_version: RUNNING_VERSION,
      plugin: { installed: false, enabled: false, bundle_valid: false, launcher_executable: false },
      model_calls_started: false,
    };
  }
  const [receiverIdentityResult, senderIdentityResult, receiverPresenceResult, senderPresenceResult] =
    await Promise.allSettled([
      (options.loadIdentity ?? fetchMe)(
        server.url,
        receiverSource.token,
        AbortSignal.timeout(5_000),
      ),
      (options.loadIdentity ?? fetchMe)(
        server.url,
        senderSource.token,
        AbortSignal.timeout(5_000),
      ),
      (options.loadPresence ?? fetchPresence)(
        server.url,
        receiverSource.token,
        args.channel,
        AbortSignal.timeout(5_000),
      ),
      (options.loadPresence ?? fetchPresence)(
        server.url,
        senderSource.token,
        args.channel,
        AbortSignal.timeout(5_000),
      ),
    ]);
  const receiverIdentity = receiverIdentityResult.status === "fulfilled"
    ? receiverIdentityResult.value
    : null;
  const senderIdentity = senderIdentityResult.status === "fulfilled"
    ? senderIdentityResult.value
    : null;
  const presence = receiverPresenceResult.status === "fulfilled"
    ? receiverPresenceResult.value
    : [];
  const receiverAgent = receiverIdentity === null ? null : validAgent(receiverIdentity, args.channel);
  const senderAgent = senderIdentity === null ? null : validAgent(senderIdentity, args.channel);
  let channelProtocol: BusyChannelProtocolStatus = "unavailable";
  if (receiverAgent !== null && receiverPresenceResult.status === "fulfilled") {
    try {
      channelProtocol = await (options.probeChannelProtocol ?? probeBusyChannelProtocol)(
        server.url,
        receiverSource.token,
        args.channel,
      );
    } catch {
      channelProtocol = "unavailable";
    }
  }
  const preflightResult = inspectBusyChannelPreflight({
    channel: args.channel,
    serverOrigin: server.origin,
    parsedVersion,
    rawClaudeVersion: rawVersion,
    claudeLoggedIn: auth?.loggedIn === true,
    lifecycle: plugin,
    receiverAgent,
    senderAgent,
    receiverChannelAccess: receiverPresenceResult.status === "fulfilled",
    senderChannelAccess: senderPresenceResult.status === "fulfilled",
    receiverListenerActive: receiverAgent !== null && listenerActive(presence, receiverAgent),
    channelProtocol,
  });
  const preflight = preflightResult.report;
  if (args.preflightOnly || preflightResult.exitCode !== 0 || receiverAgent === null || senderAgent === null) {
    console.log(JSON.stringify(preflight, null, 2));
    return preflightResult.exitCode;
  }

  const privateRoot = mkdtempSync(join(tmpdir(), "agentparty-claude-channel-busy-private-"));
  const artifacts = mkdtempSync(join(tmpdir(), "agentparty-claude-channel-busy-evidence-"));
  chmodSync(privateRoot, 0o700);
  chmodSync(artifacts, 0o700);
  const receiverConfig = join(privateRoot, "receiver.json");
  const releaseFile = join(privateRoot, "release-busy-bash");
  writePrivateConfig(receiverConfig, server.url, receiverSource.token);
  const exchangeId = randomUUID();
  const sourceMarker = `AGENTPARTY_BUSY_CHANNEL_${exchangeId}`;
  const replyMarker = `AGENTPARTY_BUSY_CHANNEL_REPLY_${exchangeId}`;
  const sourceBody =
    `@${receiverAgent} ${sourceMarker}. Claim and accept this durable execution, then reply exactly ${replyMarker}.`;
  const sourceIdempotencyKey = `busy-channel-${exchangeId}`;
  const self = options.selfCommand ?? selfCommand();
  let captured: CapturedProcess | null = null;
  let channelWritesStarted = false;
  let sourceMessageSeq: number | null = null;
  let deliveryTerminalSettled = false;
  let sourceCleanup: BusyChannelSourceCleanup = "not_needed";
  let preserveArtifacts = args.keepArtifacts;
  try {
    const prompt =
      `Use Bash exactly once to run while [ ! -f "$${RELEASE_FILE_ENV}" ]; do sleep 0.1; done. ` +
      `A durable AgentParty Channel message will be queued while Bash is running. After Bash completes, ` +
      `follow the AgentParty Channel notification exactly: call party_channel_claim once, ` +
      `party_channel_accept once with its exact receipt, then party_channel_reply once with the source seq ` +
      `and exact requested reply. Do not use party_send and do not call any other tool. Afterwards output CHANNEL_DONE.`;
    const command = [
      self.command,
      ...self.args,
      "claude",
      args.channel,
      "--",
      "-p",
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--verbose",
      prompt,
    ];
    const launchedAt = Date.now();
    captured = spawnCaptured(
      "receiver",
      command,
      childEnvironment(privateRoot, receiverConfig, releaseFile),
      cwd,
    );
    const busyObserved = await waitForBusyBash(
      server.url,
      receiverSource.token,
      args.channel,
      receiverAgent,
      launchedAt,
      captured,
    );
    if (!busyObserved) throw new BusyChannelAcceptanceError("busy_activity_not_observed");
    channelWritesStarted = true;
    const source = await postMessage(
      server.url,
      senderSource.token,
      args.channel,
      {
        kind: "message",
        body: sourceBody,
        mentions: [receiverAgent],
        reply_to: null,
        idempotency_key: sourceIdempotencyKey,
      },
      AbortSignal.timeout(10_000),
    );
    sourceMessageSeq = source.seq;
    writeCrossSessionReleaseFile(releaseFile);
    const reply = await Promise.race([
      waitForLinkedReply(
        server.url,
        senderSource.token,
        args.channel,
        receiverAgent,
        source.seq,
        replyMarker,
        captured,
      ),
      captured.captureFailure,
    ]);
    const toolChainObserved = reply === null
      ? false
      : await Promise.race([
          waitForBusyToolChain(captured, source.seq, reply.seq, replyMarker, sourceMarker),
          captured.captureFailure,
        ]);
    await stopCaptured(captured);
    await Promise.all([captured.stdoutDone, captured.stderrDone]);
    const evidence: BusyChannelEvidence = {
      busy_activity_observed_before_send: busyObserved,
      source_message_persisted: Number.isSafeInteger(source.seq) && source.seq > 0,
      linked_reply_persisted: reply !== null,
      claim_accept_reply_chain_observed: toolChainObserved,
      delivery_terminal_settled: toolChainObserved,
    };
    deliveryTerminalSettled = toolChainObserved;
    const passed = Object.values(evidence).every(Boolean);
    if (!passed && !deliveryTerminalSettled) {
      sourceCleanup = await cleanupBusyChannelSource(
        server.url,
        senderSource.token,
        args.channel,
        sourceMessageSeq,
      );
    }
    preserveArtifacts ||= !passed;
    const secrets: [string, string] = [receiverSource.token, senderSource.token];
    await Promise.all([
      Bun.write(join(artifacts, "receiver.jsonl"), `${redactIntegrationEvidence(captured.stdout, secrets, privateRoot, [cwd])}\n`),
      Bun.write(join(artifacts, "receiver.stderr.txt"), `${redactIntegrationEvidence(captured.stderr, secrets, privateRoot, [cwd])}\n`),
    ]);
    console.log(JSON.stringify({
      schema: ACCEPTANCE_SCHEMA,
      status: passed ? "passed" : "failed",
      preflight,
      server: server.origin,
      channel: args.channel,
      receiver_agent: receiverAgent,
      sender_agent: senderAgent,
      source_message_seq: source.seq,
      ...(reply === null ? {} : { linked_reply_seq: reply.seq }),
      evidence,
      source_cleanup: sourceCleanup,
      cleanup_required: busyChannelCleanupRequired(sourceCleanup),
      ...(busyChannelCleanupRequired(sourceCleanup) ? { cleanup_search_marker: sourceMarker } : {}),
      model_calls_started: true,
      channel_writes_started: true,
      delivery_verified: passed,
      ...(!passed ? { failure_phase: "evidence", error_code: "evidence_incomplete" } : {}),
      ...(preserveArtifacts ? { artifacts } : {}),
    }, null, 2));
    return passed ? 0 : 1;
  } catch (error) {
    preserveArtifacts = true;
    if (captured !== null) {
      await stopCaptured(captured).catch(() => undefined);
      await Promise.all([captured.stdoutDone, captured.stderrDone]).catch(() => undefined);
      const secrets: [string, string] = [receiverSource.token, senderSource.token];
      await Promise.all([
        Bun.write(
          join(artifacts, "receiver.partial.jsonl"),
          `${redactIntegrationEvidence(captured.stdout, secrets, privateRoot, [cwd])}\n`,
        ),
        Bun.write(
          join(artifacts, "receiver.partial.stderr.txt"),
          `${redactIntegrationEvidence(captured.stderr, secrets, privateRoot, [cwd])}\n`,
        ),
      ]).catch(() => undefined);
    }
    if (channelWritesStarted && !deliveryTerminalSettled) {
      if (sourceMessageSeq === null) {
        sourceMessageSeq = await recoverBusyChannelSourceSeq(
          server.url,
          senderSource.token,
          args.channel,
          senderAgent,
          sourceBody,
        );
      }
      sourceCleanup = await cleanupBusyChannelSource(
        server.url,
        senderSource.token,
        args.channel,
        sourceMessageSeq,
      );
    }
    const outputLimit = crossSessionOutputLimitReport(error);
    const stableErrorCode = error instanceof BusyChannelAcceptanceError
      ? error.code
      : outputLimit === undefined ? "session_execution_failed" : "session_output_limit_exceeded";
    console.log(JSON.stringify({
      schema: ACCEPTANCE_SCHEMA,
      status: "failed",
      failure_phase: "execution",
      error_code: stableErrorCode,
      preflight,
      model_calls_started: busyChannelModelCallState(captured),
      channel_writes_started: channelWritesStarted,
      ...(sourceMessageSeq === null ? {} : { source_message_seq: sourceMessageSeq }),
      source_cleanup: sourceCleanup,
      cleanup_required: busyChannelCleanupRequired(sourceCleanup),
      ...(busyChannelCleanupRequired(sourceCleanup) ? { cleanup_search_marker: sourceMarker } : {}),
      delivery_verified: false,
      ...(outputLimit === undefined ? {} : { session_output_limit: outputLimit }),
      artifacts,
    }, null, 2));
    return 1;
  } finally {
    if (captured !== null) await stopCaptured(captured).catch(() => undefined);
    rmSync(privateRoot, { recursive: true, force: true });
    if (!preserveArtifacts) rmSync(artifacts, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runBusyClaudeChannelAcceptance(process.argv.slice(2)).then((code) => process.exit(code));
}
