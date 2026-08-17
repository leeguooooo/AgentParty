#!/usr/bin/env bun

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  PresenceEntry,
  RuntimePeerDiscovery,
  RuntimeTopology,
  RuntimeTopologyRelation,
} from "../shared/src/protocol";
import { AGENT_ACTIVITY_TTL_MS } from "../shared/src/protocol";
import {
  CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL,
  CLAUDE_SESSION_START_ARM_RECEIPT_FILE_ENV,
  CLAUDE_SESSION_START_ARM_RECEIPT_SCHEMA,
  claudeCrossSessionEnvironmentConflict,
  parseClaudeAuthInfo,
  type ClaudeCrossSessionInbound,
} from "../cli/src/commands/bridge";
import {
  defaultClaudePluginDoctorDependencies,
  inspectClaudePluginShell,
  type ClaudePluginShellBlocker,
  type ClaudePluginShellInspection,
} from "../cli/src/commands/doctor";
import { RUNNING_VERSION } from "../cli/src/upgrade";
import {
  AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX,
  isAgentPartyClaudeSessionAddress,
  uniqueClaudeListAgentsAddress,
} from "../cli/src/claude-cross-session-gate";
import {
  fetchMe,
  fetchPresence,
  fetchRuntimePeers,
  RestError,
  RuntimePeerProtocolError,
  type Identity,
} from "../cli/src/rest";
import { buildRuntimeTopology } from "../cli/src/runtime-topology";
import {
  completedClaudeToolBoundaryBeforeMarker,
  createClaudeSendMessageResultBarrier,
  directClaudeToolResultBlocks,
  directClaudeToolUseBlocks,
  sameSessionEventsAfterUniqueInit,
  uniqueInboundTextMarkerIndex,
  uniqueClaudeStreamInit,
  uniqueSuccessfulClaudeToolResultIndex,
} from "./claude-cross-session-stream-evidence";
import {
  captureBoundedCrossSessionLines,
  captureCrossSessionProbe,
  crossSessionOutputLimitReport,
  waitForCrossSessionProcessPair,
  waitForCrossSessionReadiness,
  writeCrossSessionReleaseFile,
  type CrossSessionOutputLimitReport,
} from "./cross-session-process-lifecycle";
import { parseClaudeVersion, parseJsonLines } from "./verify-claude-cross-session";
import {
  readDeploymentMetadata,
  type DeploymentFetch,
  type DeploymentMetadata,
} from "../worker/scripts/deployment-metadata.mjs";

const MIN_VERSION = [2, 1, 224] as const;
const ACCEPTANCE_TIMEOUT_MS = 180_000;
const READINESS_TIMEOUT_MS = 20_000;
const CLAUDE_PROBE_TIMEOUT_MS = 10_000;
const DEPLOYMENT_METADATA_TIMEOUT_MS = 5_000;
const LIFECYCLE_ACTIVITY_TIMEOUT_MS = 10_000;
const LIFECYCLE_ACTIVITY_POLL_MS = 100;
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MCP_PEERS_TOOL = "party_channel_peers";
const MCP_PEER_CHECK_TOOL = "party_channel_peer_check";
const ACCEPTANCE_RELEASE_FILE_ENV = "AGENTPARTY_CROSS_SESSION_ACCEPTANCE_RELEASE_FILE";
const INTEGRATION_PREFLIGHT_SCHEMA = "agentparty.claude-cross-session-integration-preflight.v1";
const INTEGRATION_ACCEPTANCE_SCHEMA = "agentparty.claude-cross-session-integration-acceptance.v2";

export interface CapturedProcess {
  process: ReturnType<typeof Bun.spawn>;
  stdout: string[];
  stderr: string[];
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
  captureFailure: Promise<never>;
  stopPromise?: Promise<void>;
}

interface AgentConfig {
  server: string;
  token: string;
}

export interface AgentPartyCrossSessionEvidence {
  receiver_session_start_armed: boolean;
  sender_session_start_armed: boolean;
  distinct_claude_session_ids: boolean;
  distinct_bridge_addresses: boolean;
  receiver_initialized_with_agentparty_mcp: boolean;
  sender_used_party_channel_peers: boolean;
  sender_received_expected_ready_hint: boolean;
  sender_used_list_agents_after_hint: boolean;
  sender_rechecked_exact_candidate_before_send: boolean;
  sender_used_send_message_to_hint_with_marker: boolean;
  sender_send_message_result_observed: boolean;
  receiver_observed_marker: boolean;
  receiver_wait_boundary_before_marker: boolean;
  receiver_used_party_channel_peers_for_reply: boolean;
  receiver_received_expected_sender_hint: boolean;
  receiver_used_list_agents_after_hint_for_reply: boolean;
  receiver_rechecked_exact_candidate_before_reply: boolean;
  receiver_used_send_message_to_sender_with_reply_marker: boolean;
  receiver_reply_send_message_result_observed: boolean;
  sender_observed_reply_marker: boolean;
  sender_wait_boundary_before_reply_marker: boolean;
}

export type IntegrationPreflightStatus =
  | "ready"
  | "plugin_lifecycle_unavailable"
  | "claude_auth_required"
  | "claude_auth_unavailable"
  | "unsupported_provider"
  | "feature_flag_evaluation_disabled"
  | "agentparty_unavailable"
  | "worker_upgrade_required"
  | "runtime_peer_unavailable"
  | "invalid_request"
  | "environment_unavailable"
  | "internal_error";

export type IntegrationPreflightFailureCode =
  | "invalid_arguments"
  | "invalid_channel"
  | "receiver_config_invalid"
  | "sender_config_invalid"
  | "receiver_cwd_invalid"
  | "sender_cwd_invalid"
  | "server_configuration_invalid"
  | "server_mismatch"
  | "agent_token_conflict"
  | "unsupported_platform"
  | "claude_unavailable"
  | "claude_version_unsupported"
  | "runtime_topology_unavailable"
  | "internal_error";

export type IntegrationAgentPartyBlocker =
  | "receiver_agentparty_auth_required"
  | "sender_agentparty_auth_required"
  | "receiver_identity_unavailable"
  | "sender_identity_unavailable"
  | "receiver_identity_invalid"
  | "sender_identity_invalid"
  | "receiver_channel_unavailable"
  | "sender_channel_unavailable"
  | "agent_identity_conflict";
export type IntegrationPreflightBlocker =
  | Exclude<
    IntegrationPreflightStatus,
    "ready" | "agentparty_unavailable" | "invalid_request" | "environment_unavailable" | "internal_error"
  >
  | IntegrationAgentPartyBlocker
  | IntegrationPreflightFailureCode
  | ClaudePluginShellBlocker
  | "worker_deployment_unavailable";
export type IntegrationClaudeAuthStatus = "logged_in" | "logged_out" | "unavailable";
export type IntegrationIdentityStatus = "confirmed" | "unauthorized" | "unavailable" | "invalid";
export type IntegrationChannelAccessStatus = "confirmed" | "not_checked" | "unauthorized" | "unavailable";

export interface IntegrationIdentityCheck {
  status: IntegrationIdentityStatus;
  agent?: string;
  invalid_reason?: "not_named_agent" | "channel_scope_mismatch";
  http_status?: number;
}

export interface IntegrationChannelAccessCheck {
  status: IntegrationChannelAccessStatus;
  http_status?: number;
}

export interface IntegrationClaudeAuthState {
  status: IntegrationClaudeAuthStatus;
  loggedIn: boolean;
  apiProvider?: string;
}

export class IntegrationPreflightFailure extends Error {
  constructor(
    readonly code: IntegrationPreflightFailureCode,
    readonly status: Extract<IntegrationPreflightStatus, "invalid_request" | "environment_unavailable" | "internal_error">,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationPreflightFailure";
  }
}

function invalidIntegrationRequest(code: IntegrationPreflightFailureCode, message: string): IntegrationPreflightFailure {
  return new IntegrationPreflightFailure(code, "invalid_request", 9, message);
}

function unavailableIntegrationEnvironment(
  code: IntegrationPreflightFailureCode,
  message: string,
): IntegrationPreflightFailure {
  return new IntegrationPreflightFailure(code, "environment_unavailable", 10, message);
}

export function integrationPreflightFailureResult(error: unknown): {
  status: Extract<IntegrationPreflightStatus, "invalid_request" | "environment_unavailable" | "internal_error">;
  blockers: IntegrationPreflightFailureCode[];
  error_code: IntegrationPreflightFailureCode;
  cross_machine_policy_on_launch: typeof CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL;
  model_calls_started: false;
  delivery_verified: false;
  exitCode: number;
} {
  const failure = error instanceof IntegrationPreflightFailure
    ? error
    : new IntegrationPreflightFailure("internal_error", "internal_error", 1, "unexpected preflight failure");
  return {
    status: failure.status,
    blockers: [failure.code],
    error_code: failure.code,
    cross_machine_policy_on_launch: CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL,
    model_calls_started: false,
    delivery_verified: false,
    exitCode: failure.exitCode,
  };
}

export type IntegrationAcceptanceFailurePhase =
  | "request"
  | "preflight"
  | "receiver_startup"
  | "execution"
  | "evidence"
  | "internal";
export type IntegrationAcceptanceFailureCode =
  | IntegrationPreflightFailureCode
  | Exclude<IntegrationPreflightStatus, "ready">
  | "receiver_startup_failed"
  | "session_execution_failed"
  | "session_output_limit_exceeded"
  | "evidence_incomplete";

export interface IntegrationAcceptanceFailureInput {
  phase: IntegrationAcceptanceFailurePhase;
  code: IntegrationAcceptanceFailureCode;
  exitCode: number;
  modelCallsStarted: boolean | "unknown";
  claudeVersion?: string;
  server?: string;
  channel?: string;
  workerDeploymentStatus?: "confirmed" | "unavailable" | "development_unversioned";
  workerDeployment?: DeploymentMetadata;
  receiverAgent?: string;
  senderAgent?: string;
  expectedTopologyRelation?: RuntimeTopologyRelation;
  preflight?: Record<string, unknown>;
  artifacts?: string;
  sessionOutputLimit?: CrossSessionOutputLimitReport;
}

export function buildIntegrationAcceptanceFailure(
  input: IntegrationAcceptanceFailureInput,
): { report: Record<string, unknown>; exitCode: number } {
  return {
    exitCode: input.exitCode,
    report: {
      schema: INTEGRATION_ACCEPTANCE_SCHEMA,
      status: "failed",
      failure_phase: input.phase,
      error_code: input.code,
      cross_machine_policy_on_launch: CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL,
      model_calls_started: input.modelCallsStarted,
      delivery_verified: false,
      ...(input.claudeVersion === undefined ? {} : { claude_version: input.claudeVersion }),
      ...(input.server === undefined ? {} : { server: input.server }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.workerDeploymentStatus === undefined
        ? {}
        : { worker_deployment_status: input.workerDeploymentStatus }),
      ...(input.workerDeployment === undefined ? {} : { worker_deployment: input.workerDeployment }),
      ...(input.receiverAgent === undefined ? {} : { receiver_agent: input.receiverAgent }),
      ...(input.senderAgent === undefined ? {} : { sender_agent: input.senderAgent }),
      ...(input.expectedTopologyRelation === undefined
        ? {}
        : { expected_topology_relation: input.expectedTopologyRelation }),
      ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
      ...(input.sessionOutputLimit === undefined
        ? {}
        : { session_output_limit: input.sessionOutputLimit }),
    },
  };
}

export function unexpectedIntegrationAcceptanceFailure(error: unknown): {
  report: Record<string, unknown>;
  exitCode: number;
} {
  if (error instanceof IntegrationPreflightFailure) {
    return buildIntegrationAcceptanceFailure({
      phase: error.status === "invalid_request" ? "request" :
        error.status === "environment_unavailable" ? "preflight" : "internal",
      code: error.code,
      exitCode: error.exitCode,
      modelCallsStarted: error.status === "internal_error" ? "unknown" : false,
    });
  }
  return buildIntegrationAcceptanceFailure({
    phase: "internal",
    code: "internal_error",
    exitCode: 1,
    modelCallsStarted: "unknown",
  });
}

export function integrationClaudeAuthState(raw: string): IntegrationClaudeAuthState {
  const auth = parseClaudeAuthInfo(raw);
  if (auth === null) return { status: "unavailable", loggedIn: false };
  return {
    status: auth.loggedIn ? "logged_in" : "logged_out",
    loggedIn: auth.loggedIn,
    ...(auth.apiProvider === undefined ? {} : { apiProvider: auth.apiProvider }),
  };
}

function normalizedIntegrationClaudeAuthStatus(
  auth: boolean | IntegrationClaudeAuthStatus,
): IntegrationClaudeAuthStatus {
  return typeof auth === "boolean" ? (auth ? "logged_in" : "logged_out") : auth;
}

export function classifyIntegrationIdentity(
  identity: Identity | null,
  error: unknown,
  channel: string,
): IntegrationIdentityCheck {
  if (identity === null) {
    if (error instanceof RestError && error.status === 401) {
      return { status: "unauthorized", http_status: 401 };
    }
    return {
      status: "unavailable",
      ...(error instanceof RestError ? { http_status: error.status } : {}),
    };
  }
  if (identity.kind !== "agent" || identity.name === "") {
    return { status: "invalid", invalid_reason: "not_named_agent" };
  }
  if (identity.channel_scope != null && identity.channel_scope !== channel) {
    return { status: "invalid", invalid_reason: "channel_scope_mismatch" };
  }
  return { status: "confirmed", agent: identity.name };
}

export function classifyIntegrationChannelAccess(error: unknown): IntegrationChannelAccessCheck {
  if (error === null) return { status: "confirmed" };
  if (error instanceof RestError && error.status === 401) {
    return { status: "unauthorized", http_status: 401 };
  }
  return {
    status: "unavailable",
    ...(error instanceof RestError ? { http_status: error.status } : {}),
  };
}

function integrationAgentPartyBlockers(
  receiverIdentity: IntegrationIdentityCheck,
  senderIdentity: IntegrationIdentityCheck,
  receiverChannel: IntegrationChannelAccessCheck,
  senderChannel: IntegrationChannelAccessCheck,
): IntegrationAgentPartyBlocker[] {
  const blockers = new Set<IntegrationAgentPartyBlocker>();
  for (const [role, identity, channel] of [
    ["receiver", receiverIdentity, receiverChannel],
    ["sender", senderIdentity, senderChannel],
  ] as const) {
    if (identity.status === "unauthorized" || channel.status === "unauthorized") {
      blockers.add(`${role}_agentparty_auth_required`);
    } else if (identity.status === "unavailable") {
      blockers.add(`${role}_identity_unavailable`);
    } else if (identity.status === "invalid") {
      blockers.add(`${role}_identity_invalid`);
    } else if (channel.status === "unavailable") {
      blockers.add(`${role}_channel_unavailable`);
    }
  }
  if (
    receiverIdentity.status === "confirmed" &&
    senderIdentity.status === "confirmed" &&
    receiverIdentity.agent === senderIdentity.agent
  ) {
    blockers.add("agent_identity_conflict");
  }
  return [...blockers];
}

export function integrationPreflightBlockers(
  runtimePeers: RuntimePeerDiscovery | null,
  runtimePeerError: unknown,
  auth: boolean | IntegrationClaudeAuthStatus,
  environmentConflict: ReturnType<typeof claudeCrossSessionEnvironmentConflict> = null,
  agentPartyBlockers: readonly IntegrationAgentPartyBlocker[] = [],
  runtimePeerChecked = true,
  workerDeploymentError: unknown = null,
  lifecycleBlockers: readonly ClaudePluginShellBlocker[] = [],
): IntegrationPreflightBlocker[] {
  const blockers: IntegrationPreflightBlocker[] = [];
  const authStatus = normalizedIntegrationClaudeAuthStatus(auth);
  if (authStatus === "logged_out") blockers.push("claude_auth_required");
  if (authStatus === "unavailable") blockers.push("claude_auth_unavailable");
  if (environmentConflict !== null) blockers.push(environmentConflict.reason);
  blockers.push(...lifecycleBlockers);
  blockers.push(...agentPartyBlockers);
  if (workerDeploymentError !== null) blockers.push("worker_deployment_unavailable");
  if (runtimePeerChecked && runtimePeers === null) {
    blockers.push(
      (runtimePeerError instanceof RestError && runtimePeerError.status === 404) ||
        runtimePeerError instanceof RuntimePeerProtocolError
        ? "worker_upgrade_required"
        : "runtime_peer_unavailable",
    );
  }
  return blockers;
}

export function classifyIntegrationPreflight(
  runtimePeers: RuntimePeerDiscovery | null,
  runtimePeerError: unknown,
  auth: boolean | IntegrationClaudeAuthStatus,
  environmentConflict: ReturnType<typeof claudeCrossSessionEnvironmentConflict> = null,
  agentPartyBlockers: readonly IntegrationAgentPartyBlocker[] = [],
  runtimePeerChecked = true,
  workerDeploymentError: unknown = null,
  lifecycleBlockers: readonly ClaudePluginShellBlocker[] = [],
): { status: IntegrationPreflightStatus; exitCode: number } {
  if (lifecycleBlockers.length > 0) {
    return { status: "plugin_lifecycle_unavailable", exitCode: 11 };
  }
  if (workerDeploymentError !== null) return { status: "worker_upgrade_required", exitCode: 3 };
  if (runtimePeerChecked && runtimePeers === null) {
    if (
      (runtimePeerError instanceof RestError && runtimePeerError.status === 404) ||
      runtimePeerError instanceof RuntimePeerProtocolError
    ) {
      return { status: "worker_upgrade_required", exitCode: 3 };
    }
  }
  if (agentPartyBlockers.length > 0) return { status: "agentparty_unavailable", exitCode: 8 };
  if (runtimePeerChecked && runtimePeers === null) {
    return { status: "runtime_peer_unavailable", exitCode: 4 };
  }
  const authStatus = normalizedIntegrationClaudeAuthStatus(auth);
  if (authStatus === "logged_out") return { status: "claude_auth_required", exitCode: 2 };
  if (authStatus === "unavailable") return { status: "claude_auth_unavailable", exitCode: 5 };
  if (environmentConflict?.reason === "unsupported_provider") {
    return { status: "unsupported_provider", exitCode: 6 };
  }
  if (environmentConflict?.reason === "feature_flag_evaluation_disabled") {
    return { status: "feature_flag_evaluation_disabled", exitCode: 7 };
  }
  return { status: "ready", exitCode: 0 };
}

export async function probeIntegrationDeploymentMetadata(
  server: string,
  fetchImpl: DeploymentFetch = fetch,
  timeoutMs = DEPLOYMENT_METADATA_TIMEOUT_MS,
): Promise<DeploymentMetadata> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("deployment metadata timeout must be a positive integer");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  return readDeploymentMetadata(server, (input, init) => fetchImpl(input, {
    ...init,
    signal: init?.signal ?? signal,
  }));
}

export function requiresVersionedWorkerDeployment(server: string): boolean {
  const hostname = new URL(server).hostname;
  return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(nestedValues);
  if (!record(value)) return [value];
  return [value, ...Object.values(value).flatMap(nestedValues)];
}

function toolUses(
  value: unknown,
  name: string,
  mainSessionOnly = true,
): Record<string, unknown>[] {
  const expectedName = name === MCP_PEERS_TOOL || name === MCP_PEER_CHECK_TOOL
    ? `${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${name}`
    : name;
  return record(value)
    ? directClaudeToolUseBlocks(value, mainSessionOnly).filter((item) => item.name === expectedName)
    : [];
}

function toolUse(value: unknown, name: string): Record<string, unknown> | null {
  return toolUses(value, name)[0] ?? null;
}

function toolUseCount(events: readonly Record<string, unknown>[], name: string): number {
  // Count the complete stream, including foreign and child sessions, so they
  // cannot hide a duplicate. Evidence lookup below remains top-level only.
  return events.reduce((count, event) => count + toolUses(event, name, false).length, 0);
}

function eventToolUseCount(value: unknown): number {
  return record(value) ? directClaudeToolUseBlocks(value).length : 0;
}

function listedAddress(value: unknown, toolUseId: string, displayName: string): string | null {
  if (!record(value)) return null;
  const results = directClaudeToolResultBlocks(value);
  if (results.length !== 1 || results[0]!.tool_use_id !== toolUseId) return null;
  return uniqueClaudeListAgentsAddress([results[0]!.content], displayName);
}

function exactPeerCheckInput(
  input: unknown,
  agent: string,
  displayName: string,
  candidateRef: string,
): boolean {
  return record(input) &&
    input.agent === agent &&
    input.display_name === displayName &&
    input.candidate_ref === candidateRef;
}

function exactSendMessageInput(input: unknown, recipient: string, message: string): boolean {
  if (!record(input) || input.message !== message) return false;
  const to = typeof input.to === "string" ? input.to : undefined;
  const alternate = typeof input.recipient === "string" ? input.recipient : undefined;
  if (to !== undefined && alternate !== undefined && to !== alternate) return false;
  return (to ?? alternate) === recipient;
}

/**
 * Release an acceptance wait only after Claude emits the direct singleton
 * tool_result for the one direct singleton SendMessage carrying this marker.
 * This coordinates the two real processes; the evidence verifier below still
 * independently proves the complete stream and rejects duplicates.
 */
export function createSendMessageResultBarrier(
  expectedMessage: string,
  release: () => void,
): (line: string) => void {
  return createClaudeSendMessageResultBarrier(expectedMessage, release);
}

function initializedAgentPartyMcpSessionId(
  events: readonly Record<string, unknown>[],
): string | null {
  const init = uniqueClaudeStreamInit(events);
  if (init === null) return null;
  const event = init.event;
  return typeof event.messaging_socket_path === "string" &&
    event.messaging_socket_path !== "" &&
    Array.isArray(event.tools) &&
    event.tools.includes(`${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${MCP_PEERS_TOOL}`) &&
    event.tools.includes(`${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${MCP_PEER_CHECK_TOOL}`) &&
    event.tools.includes("ListAgents") &&
    event.tools.includes("SendMessage")
    ? init.sessionId
    : null;
}

function initializedWithAgentPartyMcp(events: readonly Record<string, unknown>[]): boolean {
  return initializedAgentPartyMcpSessionId(events) !== null;
}

function streamSessionId(events: readonly Record<string, unknown>[]): string | null {
  return uniqueClaudeStreamInit(events)?.sessionId ?? null;
}

function armReceipts(lines: readonly string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return record(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export function hasPrivateArmReceiptForSession(
  path: string,
  address: string,
  sessionId: string,
): boolean {
  const receipts = armReceipts(readPrivateArmReceipt(path));
  const matching = receipts.filter((receipt) =>
    receipt.schema === CLAUDE_SESSION_START_ARM_RECEIPT_SCHEMA &&
    receipt.address === address &&
    receipt.session_id === sessionId &&
    typeof receipt.armed_at === "number" &&
    Number.isFinite(receipt.armed_at)
  );
  if (receipts.length > 0 && matching.length !== 1) {
    throw new Error("arm receipt does not match the receiver bridge address and Claude session");
  }
  return matching.length === 1;
}

async function waitForPrivateArmReceipt(
  path: string,
  address: string,
  sessionId: string,
): Promise<void> {
  for (;;) {
    if (hasPrivateArmReceiptForSession(path, address, sessionId)) return;
    await new Promise<void>((resolveDelay) => {
      const timer = setTimeout(resolveDelay, 20);
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

function sessionStartArmed(
  events: readonly Record<string, unknown>[],
  bridgeLines: readonly string[],
  receiptLines: readonly string[],
): boolean {
  const sessionId = streamSessionId(events);
  const address = bridgeLaunchAddress(bridgeLines);
  if (sessionId === null || address === null) return false;
  const matching = armReceipts(receiptLines).filter((receipt) =>
    receipt.schema === CLAUDE_SESSION_START_ARM_RECEIPT_SCHEMA &&
    receipt.address === address &&
    receipt.session_id === sessionId &&
    typeof receipt.armed_at === "number" &&
    Number.isFinite(receipt.armed_at)
  );
  return matching.length === 1;
}

interface ReadyHint {
  displayName: string;
  candidateRef: string;
}

const TOPOLOGY_COORDINATION_ACTION: Record<RuntimeTopologyRelation, string> = {
  same_worktree: "negotiate_single_writer",
  same_workspace: "exchange_change_summary",
  same_local_installation: "inspect_shared_resources",
};

export function integrationTopologyRelation(
  left: RuntimeTopology,
  right: RuntimeTopology,
): RuntimeTopologyRelation | null {
  return left.worktree_ref === right.worktree_ref
    ? "same_worktree"
    : left.workspace_ref === right.workspace_ref
      ? "same_workspace"
      : left.node_ref === right.node_ref
        ? "same_local_installation"
        : null;
}

function readyHint(
  value: unknown,
  toolUseId: string,
  expectedSenderAgent: string,
  expectedReceiverAgent: string,
  expectedChannel: string | null,
  expectedRelation: RuntimeTopologyRelation,
): ReadyHint | null {
  if (!record(value)) return null;
  const results = directClaudeToolResultBlocks(value);
  if (results.length !== 1 || results[0]!.tool_use_id !== toolUseId) return null;
  for (const result of results) {
    for (const item of nestedValues((result as Record<string, unknown>).content)) {
      if (typeof item !== "string" || !item.includes('"availability":"ready"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(item);
      } catch {
        continue;
      }
      if (
        !record(parsed) ||
        parsed.version !== 2 ||
        parsed.availability !== "ready" ||
        parsed.topology_evidence !== "client_asserted" ||
        parsed.self !== expectedSenderAgent ||
        (expectedChannel !== null && parsed.channel !== expectedChannel) ||
        !Array.isArray(parsed.peers)
      ) continue;
      const sessions = parsed.peers.flatMap((peer) => {
        if (
          !record(peer) ||
          peer.agent !== expectedReceiverAgent ||
          peer.same_identity !== false ||
          !Array.isArray(peer.claude_sessions)
        ) return [];
        return peer.claude_sessions.flatMap((session) => {
          if (
            !record(session) ||
            typeof session.display_name !== "string" ||
            typeof session.candidate_ref !== "string" ||
            !/^candidate_[A-Za-z0-9_-]{16,64}$/.test(session.candidate_ref) ||
            session.relation !== expectedRelation ||
            session.runtime_count !== 1 ||
            session.name_unique_among_hints !== true ||
            session.pre_send_check_required !== true ||
            !record(session.coordination) ||
            session.coordination.action !== TOPOLOGY_COORDINATION_ACTION[expectedRelation]
          ) return [];
          return [{ displayName: session.display_name, candidateRef: session.candidate_ref }];
        });
      });
      if (sessions.length === 1) return sessions[0]!;
    }
  }
  return null;
}

function confirmedCandidate(
  value: unknown,
  toolUseId: string,
  expectedSenderAgent: string,
  expectedReceiverAgent: string,
  expectedDisplayName: string,
  expectedCandidateRef: string,
  expectedSendTo: string,
  expectedChannel: string | null,
  expectedRelation: RuntimeTopologyRelation,
): boolean {
  if (!record(value)) return false;
  const results = directClaudeToolResultBlocks(value);
  if (results.length !== 1 || results[0]!.tool_use_id !== toolUseId) return false;
  return results.some((item) => {
    return nestedValues(item.content).some((content) => {
      if (typeof content !== "string") return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return false;
      }
      return record(parsed) &&
        parsed.version === 1 &&
        parsed.availability === "confirmed" &&
        parsed.topology_evidence === "client_asserted" &&
        parsed.comparison === "server_rechecked_live_topology" &&
        parsed.self === expectedSenderAgent &&
        (expectedChannel === null || parsed.channel === expectedChannel) &&
        parsed.agent === expectedReceiverAgent &&
        parsed.display_name === expectedDisplayName &&
        parsed.candidate_ref === expectedCandidateRef &&
        parsed.send_to === expectedSendTo &&
        parsed.relation === expectedRelation;
    });
  });
}

interface OutboundChainEvidence {
  usedPeers: boolean;
  receivedExpectedHint: boolean;
  usedListAgentsAfterHint: boolean;
  recheckedExactCandidateBeforeSend: boolean;
  usedSendMessageToHintWithMarker: boolean;
  sendMessageResultObserved: boolean;
  sendResultIndex: number;
}

function inspectOutboundChain(
  allEvents: readonly Record<string, unknown>[],
  message: string,
  expectedSelfAgent: string,
  expectedPeerAgent: string,
  expectedPeerDisplayName: string,
  expectedChannel: string | null,
  expectedRelation: RuntimeTopologyRelation,
  afterIndex: number = -1,
): OutboundChainEvidence {
  const events = sameSessionEventsAfterUniqueInit(allEvents) ?? allEvents.map(() => ({}));
  const exactlyOnePeersCall = toolUseCount(allEvents, MCP_PEERS_TOOL) === 1;
  const exactlyOneListCall = toolUseCount(allEvents, "ListAgents") === 1;
  const exactlyOneCheckCall = toolUseCount(allEvents, MCP_PEER_CHECK_TOOL) === 1;
  const exactlyOneSendCall = toolUseCount(allEvents, "SendMessage") === 1;
  const peersIndex = exactlyOnePeersCall
    ? events.findIndex((event, index) =>
      index > afterIndex &&
      eventToolUseCount(event) === 1 && toolUse(event, MCP_PEERS_TOOL) !== null
    )
    : -1;
  const peersUse = peersIndex < 0 ? null : toolUse(events[peersIndex]!, MCP_PEERS_TOOL);
  const peersUseId = typeof peersUse?.id === "string" && peersUse.id !== "" ? peersUse.id : null;
  const candidateHintIndex = uniqueSuccessfulClaudeToolResultIndex(
    allEvents,
    peersUseId,
    peersIndex,
  ) ?? -1;
  const candidateHint = candidateHintIndex < 0 || peersUseId === null
    ? null
    : readyHint(
      events[candidateHintIndex]!,
      peersUseId,
      expectedSelfAgent,
      expectedPeerAgent,
      expectedChannel,
      expectedRelation,
    );
  const hint = candidateHint?.displayName === expectedPeerDisplayName ? candidateHint : null;
  const hintIndex = hint === null ? -1 : candidateHintIndex;
  const listIndex = exactlyOneListCall ? events.findIndex((event, index) =>
    index > hintIndex && eventToolUseCount(event) === 1 && toolUse(event, "ListAgents") !== null
  ) : -1;
  const listUse = listIndex < 0 ? null : toolUse(events[listIndex]!, "ListAgents");
  const listUseId = typeof listUse?.id === "string" && listUse.id !== "" ? listUse.id : null;
  const candidateListResultIndex = uniqueSuccessfulClaudeToolResultIndex(
    allEvents,
    listUseId,
    listIndex,
  ) ?? -1;
  const candidateAddress = candidateListResultIndex < 0 || listUseId === null
    ? null
    : listedAddress(events[candidateListResultIndex]!, listUseId, expectedPeerDisplayName);
  const exactAddress = candidateAddress;
  const listResultIndex = exactAddress === null ? -1 : candidateListResultIndex;
  const checkIndex = exactlyOneCheckCall ? events.findIndex((event, index) => {
    if (listResultIndex < 0 || index <= listResultIndex || hint === null) return false;
    const use = toolUse(event, MCP_PEER_CHECK_TOOL);
    const input = use?.input ?? {};
    return use !== null && eventToolUseCount(event) === 1 &&
      exactPeerCheckInput(input, expectedPeerAgent, expectedPeerDisplayName, hint.candidateRef);
  }) : -1;
  const checkUse = checkIndex < 0 ? null : toolUse(events[checkIndex]!, MCP_PEER_CHECK_TOOL);
  const checkUseId = typeof checkUse?.id === "string" && checkUse.id !== "" ? checkUse.id : null;
  const candidateCheckResultIndex = uniqueSuccessfulClaudeToolResultIndex(
    allEvents,
    checkUseId,
    checkIndex,
  ) ?? -1;
  const checkResultIndex = candidateCheckResultIndex >= 0 && checkUseId !== null && hint !== null &&
      confirmedCandidate(
      events[candidateCheckResultIndex]!,
      checkUseId,
      expectedSelfAgent,
      expectedPeerAgent,
      expectedPeerDisplayName,
      hint.candidateRef,
      exactAddress ?? "",
      expectedChannel,
      expectedRelation,
    )
    ? candidateCheckResultIndex
    : -1;
  const sendIndex = exactlyOneSendCall ? events.findIndex((event, index) => {
    if (checkResultIndex < 0 || index <= checkResultIndex) return false;
    const use = toolUse(event, "SendMessage");
    if (use === null) return false;
    return eventToolUseCount(event) === 1 && exactAddress !== null &&
      exactSendMessageInput(use.input ?? {}, exactAddress, message);
  }) : -1;
  const sendUse = sendIndex < 0 ? null : toolUse(events[sendIndex]!, "SendMessage");
  const sendUseId = typeof sendUse?.id === "string" && sendUse.id !== "" ? sendUse.id : null;
  const sendResultIndex = uniqueSuccessfulClaudeToolResultIndex(allEvents, sendUseId, sendIndex) ?? -1;
  const noToolBetween = (start: number, end: number): boolean =>
    start >= -1 && end > start && events.slice(start + 1, end)
      .every((event) => directClaudeToolUseBlocks(event).length === 0);
  const uninterruptedChain =
    noToolBetween(afterIndex, peersIndex) &&
    noToolBetween(peersIndex, hintIndex) &&
    noToolBetween(hintIndex, listIndex) &&
    noToolBetween(listIndex, listResultIndex) &&
    noToolBetween(listResultIndex, checkIndex) &&
    noToolBetween(checkIndex, checkResultIndex) &&
    noToolBetween(checkResultIndex, sendIndex);
  const uninterruptedThroughSendResult = uninterruptedChain &&
    noToolBetween(sendIndex, sendResultIndex);
  return {
    usedPeers: exactlyOnePeersCall && peersIndex > afterIndex && noToolBetween(afterIndex, peersIndex),
    receivedExpectedHint:
      hintIndex >= 0 && noToolBetween(afterIndex, peersIndex) && noToolBetween(peersIndex, hintIndex),
    usedListAgentsAfterHint:
      exactlyOneListCall && listIndex >= 0 && listResultIndex > listIndex &&
      noToolBetween(afterIndex, peersIndex) && noToolBetween(peersIndex, hintIndex) &&
      noToolBetween(hintIndex, listIndex) &&
      noToolBetween(listIndex, listResultIndex),
    recheckedExactCandidateBeforeSend:
      exactlyOneCheckCall && checkIndex > listResultIndex && checkResultIndex > checkIndex && uninterruptedChain,
    usedSendMessageToHintWithMarker:
      exactlyOneSendCall && checkResultIndex >= 0 && sendIndex > checkResultIndex && uninterruptedChain,
    sendMessageResultObserved:
      exactlyOneSendCall && checkResultIndex >= 0 && sendIndex > checkResultIndex &&
      sendResultIndex > sendIndex && uninterruptedThroughSendResult,
    sendResultIndex,
  };
}

export function inspectAgentPartyCrossSessionEvidence(
  senderLines: readonly string[],
  receiverLines: readonly string[],
  marker: string,
  expectedSenderAgent: string,
  expectedReceiverAgent: string,
  expectedDisplayName: string,
  senderBridgeLines: readonly string[] = [],
  receiverBridgeLines: readonly string[] = [],
  senderReceiptLines: readonly string[] = [],
  receiverReceiptLines: readonly string[] = [],
  expectedChannel: string | null = null,
  expectedSenderDisplayName: string | null = null,
  replyMarker: string | null = null,
  expectedRelation: RuntimeTopologyRelation = "same_worktree",
): AgentPartyCrossSessionEvidence {
  const senderAll = parseJsonLines(senderLines);
  const receiver = parseJsonLines(receiverLines);
  const senderSessionId = streamSessionId(senderAll);
  const receiverSessionId = streamSessionId(receiver);
  const senderAddress = bridgeLaunchAddress(senderBridgeLines);
  const receiverAddress = bridgeLaunchAddress(receiverBridgeLines);
  const receiverMarkerIndex = uniqueInboundTextMarkerIndex(receiver, marker);
  const senderReplyMarkerIndex = replyMarker === null
    ? null
    : uniqueInboundTextMarkerIndex(senderAll, replyMarker);
  const outbound = inspectOutboundChain(
    senderAll,
    marker,
    expectedSenderAgent,
    expectedReceiverAgent,
    expectedDisplayName,
    expectedChannel,
    expectedRelation,
  );
  const reply = expectedSenderDisplayName === null || replyMarker === null
    ? null
    : inspectOutboundChain(
        receiver,
        replyMarker,
        expectedReceiverAgent,
        expectedSenderAgent,
        expectedSenderDisplayName,
        expectedChannel,
        expectedRelation,
        receiverMarkerIndex ?? Number.MAX_SAFE_INTEGER,
      );
  return {
    receiver_session_start_armed: sessionStartArmed(receiver, receiverBridgeLines, receiverReceiptLines),
    sender_session_start_armed: sessionStartArmed(senderAll, senderBridgeLines, senderReceiptLines),
    distinct_claude_session_ids:
      senderSessionId !== null && receiverSessionId !== null && senderSessionId !== receiverSessionId,
    distinct_bridge_addresses:
      senderAddress !== null && receiverAddress !== null && senderAddress !== receiverAddress,
    receiver_initialized_with_agentparty_mcp: initializedWithAgentPartyMcp(receiver),
    sender_used_party_channel_peers: outbound.usedPeers,
    sender_received_expected_ready_hint: outbound.receivedExpectedHint,
    sender_used_list_agents_after_hint: outbound.usedListAgentsAfterHint,
    sender_rechecked_exact_candidate_before_send: outbound.recheckedExactCandidateBeforeSend,
    sender_used_send_message_to_hint_with_marker: outbound.usedSendMessageToHintWithMarker,
    sender_send_message_result_observed: outbound.sendMessageResultObserved,
    // Bind the one text marker to the receiver's unique init session. The
    // receiver prompt never contains it, and tool/replay/child events cannot
    // substitute for a same-session inbound message.
    receiver_observed_marker: receiverMarkerIndex !== null,
    receiver_wait_boundary_before_marker:
      completedClaudeToolBoundaryBeforeMarker(receiver, "Bash", receiverMarkerIndex),
    receiver_used_party_channel_peers_for_reply: reply?.usedPeers ?? false,
    receiver_received_expected_sender_hint: reply?.receivedExpectedHint ?? false,
    receiver_used_list_agents_after_hint_for_reply: reply?.usedListAgentsAfterHint ?? false,
    receiver_rechecked_exact_candidate_before_reply: reply?.recheckedExactCandidateBeforeSend ?? false,
    receiver_used_send_message_to_sender_with_reply_marker: reply?.usedSendMessageToHintWithMarker ?? false,
    receiver_reply_send_message_result_observed: reply?.sendMessageResultObserved ?? false,
    sender_observed_reply_marker: senderReplyMarkerIndex !== null,
    sender_wait_boundary_before_reply_marker: completedClaudeToolBoundaryBeforeMarker(
      senderAll,
      "Bash",
      senderReplyMarkerIndex,
      outbound.sendResultIndex,
    ),
  };
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    if ((version[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

export function spawnCaptured(
  role: "sender" | "receiver",
  command: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onLine?: (line: string) => void,
  onStderrLine?: (line: string) => void,
): CapturedProcess {
  const process = Bun.spawn(command, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdoutCapture = captureBoundedCrossSessionLines(
    process.stdout,
    `${role}_stdout`,
    onLine,
  );
  const stderrCapture = captureBoundedCrossSessionLines(
    process.stderr,
    `${role}_stderr`,
    onStderrLine,
  );
  return {
    process,
    stdout: stdoutCapture.lines,
    stderr: stderrCapture.lines,
    stdoutDone: stdoutCapture.done,
    stderrDone: stderrCapture.done,
    captureFailure: Promise.race([stdoutCapture.failure, stderrCapture.failure]),
  };
}

async function stopCapturedOnce(captured: CapturedProcess): Promise<void> {
  const parentRunning = captured.process.exitCode === null;
  try {
    process.kill(-captured.process.pid, "SIGTERM");
  } catch {
    if (parentRunning) captured.process.kill();
  }
  if (!parentRunning) {
    // The detached bridge leader may exit before a Claude/MCP descendant that
    // inherited its pipes. Escalate the still-addressable group immediately;
    // otherwise evidence draining can hang after the recorded parent exit.
    try {
      process.kill(-captured.process.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    return;
  }
  try {
    await withTimeout(captured.process.exited, 2_000, "bridge shutdown");
    // The leader exited, but descendants can still retain the detached group
    // and its pipes after ignoring SIGTERM.
    try {
      process.kill(-captured.process.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    return;
  } catch {
    // Escalate the isolated verifier process group so an outer CLI killed by a
    // timeout cannot orphan its Claude or MCP grandchildren.
  }
  try {
    process.kill(-captured.process.pid, "SIGKILL");
  } catch {
    captured.process.kill(9);
  }
  await captured.process.exited.catch(() => undefined);
}

export function stopCaptured(captured: CapturedProcess): Promise<void> {
  captured.stopPromise ??= stopCapturedOnce(captured);
  return captured.stopPromise;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function writePrivateConfig(path: string, server: string, token: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify({ server, token })}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readPrivateArmReceipt(path: string): string[] {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return [];
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 4 * 1024 ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("arm receipt must be an owned, non-symlink regular file with mode 0600");
  }
  if (stat.size === 0) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
}

function childEnvironment(
  home: string,
  config: string,
  armReceiptFile?: string,
  releaseFile?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTPARTY_HOME: home, AGENTPARTY_CONFIG: config };
  if (armReceiptFile !== undefined) env[CLAUDE_SESSION_START_ARM_RECEIPT_FILE_ENV] = armReceiptFile;
  if (releaseFile !== undefined) env[ACCEPTANCE_RELEASE_FILE_ENV] = releaseFile;
  delete env.AGENTPARTY_RECEIVER_TOKEN;
  delete env.AGENTPARTY_SENDER_TOKEN;
  return env;
}

export function readPrivateAgentConfig(path: string, label: "receiver" | "sender"): AgentConfig {
  const absolute = resolve(path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absolute);
  } catch {
    throw invalidIntegrationRequest(`${label}_config_invalid`, `${label} config is unavailable`);
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 1_000_000 ||
    (stat.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw invalidIntegrationRequest(
      `${label}_config_invalid`,
      `${label} config must be an owned, non-symlink regular file with mode 0600`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw invalidIntegrationRequest(`${label}_config_invalid`, `${label} config is not valid JSON`);
  }
  if (!record(parsed) || typeof parsed.server !== "string" || typeof parsed.token !== "string" || parsed.token === "") {
    throw invalidIntegrationRequest(
      `${label}_config_invalid`,
      `${label} config must contain string server and non-empty token fields`,
    );
  }
  return { server: parsed.server, token: parsed.token };
}

export function resolveIntegrationWorkingDirectory(
  path: string,
  label: "receiver" | "sender",
): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!lstatSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw invalidIntegrationRequest(`${label}_cwd_invalid`, `${label} cwd must be an existing directory`);
  }
}

export function normalizeServer(raw: string): { url: string; origin: string } {
  const server = new URL(raw);
  if (server.protocol !== "https:" && server.protocol !== "http:") throw new Error("agent server must use http or https");
  if (server.username !== "" || server.password !== "") throw new Error("agent server must not contain credentials");
  const loopback = server.hostname === "localhost" || server.hostname === "127.0.0.1" || server.hostname === "[::1]";
  if (server.protocol === "http:" && !loopback) {
    throw new Error("remote agent server must use https; http is allowed only for loopback development");
  }
  return { url: server.toString().replace(/\/+$/, ""), origin: server.origin };
}

export function bridgeCommand(
  channel: string,
  prompt: string,
  allowedTools: string,
  inbound?: ClaudeCrossSessionInbound,
  selfCommand: IntegrationVerifierSelfCommand = {
    command: process.execPath,
    args: [resolve(import.meta.dir, "../cli/src/index.ts")],
  },
): string[] {
  return [
    selfCommand.command,
    ...selfCommand.args,
    "bridge", "claude", channel,
    "--cross-session", "required",
    ...(inbound === undefined ? [] : ["--cross-session-inbound", inbound]),
    "--", "-p",
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
    `--allowedTools=${allowedTools}`,
    prompt,
  ];
}

async function probeIntegrationIdentity(
  server: string,
  token: string,
  channel: string,
): Promise<IntegrationIdentityCheck> {
  try {
    return classifyIntegrationIdentity(await fetchMe(server, token), null, channel);
  } catch (error) {
    return classifyIntegrationIdentity(null, error, channel);
  }
}

async function probeIntegrationChannelAccess(
  server: string,
  token: string,
  channel: string,
  identity: IntegrationIdentityCheck,
): Promise<IntegrationChannelAccessCheck> {
  if (identity.status !== "confirmed") return { status: "not_checked" };
  try {
    await fetchPresence(server, token, channel);
    return classifyIntegrationChannelAccess(null);
  } catch (error) {
    return classifyIntegrationChannelAccess(error);
  }
}

/**
 * Bind lifecycle evidence to the exact live AgentParty identity and this
 * verifier launch window. Old activity, another identity, an offline row, or
 * a non-daemon observer cannot prove that Marketplace hooks ran in the bridge
 * session under test.
 */
export function integrationLifecycleActivityObserved(
  presence: readonly PresenceEntry[],
  expectedAgent: string,
  launchedAt: number,
  now: number = Date.now(),
): boolean {
  return presence.some((entry) =>
    entry.name === expectedAgent &&
    entry.live === true &&
    entry.wake?.kind === "daemon" &&
    entry.residency === "daemon" &&
    entry.activity !== undefined &&
    entry.activity.ts >= launchedAt &&
    entry.activity.ts <= now + 60_000 &&
    now - entry.activity.ts <= AGENT_ACTIVITY_TTL_MS
  );
}

export async function waitForIntegrationLifecycleActivity(
  server: string,
  token: string,
  channel: string,
  expectedAgent: string,
  launchedAt: number,
  timeoutMs = LIFECYCLE_ACTIVITY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const presence = await fetchPresence(
        server,
        token,
        channel,
        AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
      );
      if (integrationLifecycleActivityObserved(presence, expectedAgent, launchedAt)) return true;
    } catch {
      // A startup race or transient read failure is not evidence either way;
      // retry only inside this bounded acceptance window.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolveDelay) => {
      const timer = setTimeout(resolveDelay, Math.min(LIFECYCLE_ACTIVITY_POLL_MS, remaining));
      if (typeof timer.unref === "function") timer.unref();
    });
  }
}

function integrationParticipantFields(
  role: "receiver" | "sender",
  identity: IntegrationIdentityCheck,
  channel: IntegrationChannelAccessCheck,
): Record<string, unknown> {
  return {
    [`${role}_identity`]: identity.status,
    [`${role}_channel_access`]: channel.status,
    ...(identity.agent === undefined ? {} : { [`${role}_agent`]: identity.agent }),
    ...(identity.invalid_reason === undefined
      ? {}
      : { [`${role}_identity_invalid_reason`]: identity.invalid_reason }),
    ...(identity.http_status === undefined
      ? {}
      : { [`${role}_identity_http_status`]: identity.http_status }),
    ...(channel.http_status === undefined
      ? {}
      : { [`${role}_channel_http_status`]: channel.http_status }),
  };
}

export function bridgeLaunchAddress(lines: readonly string[]): string | null {
  const matches = lines.flatMap((line) => {
    const match = line.match(
      /cross_session=enabled_for_launch\s+mode=(?:auto|required)\s+reason=ready\s+address=([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\.|\s|$)/,
    );
    return match?.[1] === undefined ? [] : [match[1]];
  });
  return matches.length === 1 && isAgentPartyClaudeSessionAddress(matches[0]!) ? matches[0]! : null;
}

export function redactIntegrationEvidence(
  lines: readonly string[],
  secrets: readonly [string, string],
  privateRoot: string,
  privatePaths: readonly string[] = [],
): string {
  let redacted = lines.join("\n").replaceAll(privateRoot, "<private-runtime>");
  for (const path of [...new Set(privatePaths)].sort((left, right) => right.length - left.length)) {
    if (path !== "" && path !== "/" && path !== privateRoot) {
      redacted = redacted.replaceAll(path, "<private-cwd>");
    }
  }
  const labeled = [
    { secret: secrets[0], replacement: "<receiver-token>" },
    { secret: secrets[1], replacement: "<sender-token>" },
  ].sort((left, right) => right.secret.length - left.secret.length);
  for (const item of labeled) redacted = redacted.replaceAll(item.secret, item.replacement);
  return redacted;
}

function usage(command = "bun scripts/verify-agentparty-claude-cross-session.ts"): void {
  console.log(`usage: ${command} --channel SLUG \\
  --receiver-config PATH --sender-config PATH [--receiver-cwd DIR] [--sender-cwd DIR] \\
  [--preflight-only] [--keep-artifacts]

Both config files must be owned 0600 AgentParty configs for different agents on
the same server. Tokens are never accepted as command-line arguments.
Each cwd defaults independently to the verifier's current directory. Supplying both
lets the verifier exercise local agents in different worktrees or repositories.

Runs two real Claude sessions through the repository's current party bridge and
proves: authenticated identities -> successful top-level SessionStart arming -> expected local topology relation ->
party_channel_peers -> ListAgents -> party_channel_peer_check -> SendMessage ->
one same-session receiver marker after the unique system/init event -> the receiver
independently repeats the full gated chain -> one same-session reply marker at the sender.
The two streams must have distinct system/init session IDs and distinct generated bridge addresses.
Each send needs one matching non-error result, and each marker must follow its side's completed Bash wait boundary.
Every outbound tool use and result must follow its unique system/init with the same session_id;
exact-one tool-use counts cover the full stream. Each step must be a direct,
top-level singleton stream block with no unrelated tool between steps.
Both bridge exits share one 180-second deadline. A non-zero exit stops the
other isolated process group immediately; zero may exit first while its peer
finishes the valid round trip.
Receiver Claude/MCP initialization, bridge launch-address discovery, and the
matching live SessionStart arm receipt share one 20-second readiness deadline
and fail immediately on an early receiver exit.
Each bridge session also gets one bounded 10-second presence window. Acceptance
requires fresh Marketplace lifecycle activity on the exact live daemon identity
after that side's process launch; old, offline, observer, or other-agent rows do not count.

This makes real model calls. Token-bearing config files are always deleted.
Non-secret evidence is deleted on success unless --keep-artifacts is set.
--preflight-only makes no model calls and does not require another live peer.
Every non-help JSON result reports cross_machine_policy_on_launch=explicit_approval_required.
This is verifier launch intent, not proof that it was applied or that either peer is local.
Its lifecycle object verifies the installed/enabled/version-matched Marketplace lifecycle Hook shell without a model call.
Its blockers array reports every independently known lifecycle, Claude auth/provider, and AgentParty identity/channel/runtime prerequisite;
status and exit code retain their primary compatibility meaning. Startup failures also use this v1 JSON schema:
invalid input exits 9, unavailable local prerequisites exit 10, lifecycle unavailability exits 11,
and unexpected internal failures exit 1.
The full command uses the v2 acceptance schema for every non-help outcome,
including a nested fresh preflight result before any model call. Stable failure
phases separate request, preflight, receiver startup, execution, evidence, and
internal errors. Raw bridge diagnostics remain only in redacted artifacts; only
the complete live round trip sets delivery_verified=true.`);
}

interface IntegrationArguments {
  channel: string;
  receiverConfigPath: string;
  senderConfigPath: string;
  receiverCwd?: string;
  senderCwd?: string;
  keepArtifacts: boolean;
  preflightOnly: boolean;
}

export interface IntegrationVerifierSelfCommand {
  command: string;
  args: string[];
}

export interface IntegrationAcceptanceRunOptions {
  /** Command prefix used to launch this exact party build for both Claude sessions. */
  bridgeSelfCommand?: IntegrationVerifierSelfCommand;
  /** Default cwd for either bridge child when its explicit cwd flag is absent. */
  workspacePath?: string;
  /** User-facing command shown by --help. */
  usageCommand?: string;
  /** Test/embedding seam for the no-model Marketplace lifecycle audit. */
  probeClaudePluginLifecycle?: (
    rawClaudeVersion: string,
  ) => ClaudePluginShellInspection | Promise<ClaudePluginShellInspection>;
}

function defaultIntegrationPluginLifecycle(rawClaudeVersion: string): ClaudePluginShellInspection {
  return inspectClaudePluginShell({
    claudeVersion: () => rawClaudeVersion,
    claudePlugins: defaultClaudePluginDoctorDependencies.claudePlugins,
    inspectBundle: defaultClaudePluginDoctorDependencies.inspectBundle,
  });
}

async function integrationPluginLifecycle(
  options: IntegrationAcceptanceRunOptions,
  rawClaudeVersion: string,
): Promise<ClaudePluginShellInspection> {
  try {
    return await (options.probeClaudePluginLifecycle ?? defaultIntegrationPluginLifecycle)(
      rawClaudeVersion,
    );
  } catch {
    return {
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
    };
  }
}

export function parseIntegrationArguments(argv: readonly string[]): IntegrationArguments {
  const valueFlags = new Set([
    "--channel",
    "--receiver-config",
    "--sender-config",
    "--receiver-cwd",
    "--sender-cwd",
  ]);
  const booleanFlags = new Set(["--preflight-only", "--keep-artifacts"]);
  const seen = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!valueFlags.has(arg) && !booleanFlags.has(arg)) {
      throw invalidIntegrationRequest("invalid_arguments", `unknown argument: ${arg}`);
    }
    if (seen.has(arg)) {
      throw invalidIntegrationRequest("invalid_arguments", `duplicate argument: ${arg}`);
    }
    seen.add(arg);
    if (booleanFlags.has(arg)) continue;
    const value = argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw invalidIntegrationRequest("invalid_arguments", `${arg} requires a value`);
    }
    values.set(arg, value);
    index += 1;
  }

  const channel = values.get("--channel");
  const receiverConfigPath = values.get("--receiver-config");
  const senderConfigPath = values.get("--sender-config");
  if (channel === undefined || receiverConfigPath === undefined || senderConfigPath === undefined) {
    throw invalidIntegrationRequest(
      "invalid_arguments",
      "--channel, --receiver-config, and --sender-config are required",
    );
  }
  if (!CHANNEL_RE.test(channel)) {
    throw invalidIntegrationRequest("invalid_channel", "--channel must be a valid AgentParty slug");
  }
  return {
    channel,
    receiverConfigPath,
    senderConfigPath,
    ...(values.get("--receiver-cwd") === undefined
      ? {}
      : { receiverCwd: values.get("--receiver-cwd")! }),
    ...(values.get("--sender-cwd") === undefined
      ? {}
      : { senderCwd: values.get("--sender-cwd")! }),
    keepArtifacts: seen.has("--keep-artifacts"),
    preflightOnly: seen.has("--preflight-only"),
  };
}

async function main(
  argv: string[],
  options: IntegrationAcceptanceRunOptions = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage(options.usageCommand);
    return 0;
  }
  const {
    channel,
    receiverConfigPath,
    senderConfigPath,
    receiverCwd: requestedReceiverCwd,
    senderCwd: requestedSenderCwd,
    keepArtifacts,
    preflightOnly,
  } = parseIntegrationArguments(argv);
  const defaultWorkingDirectory = resolve(options.workspacePath ?? resolve(import.meta.dir, ".."));
  const receiverCwd = resolveIntegrationWorkingDirectory(
    requestedReceiverCwd ?? defaultWorkingDirectory,
    "receiver",
  );
  const senderCwd = resolveIntegrationWorkingDirectory(
    requestedSenderCwd ?? defaultWorkingDirectory,
    "sender",
  );
  const receiverSource = readPrivateAgentConfig(receiverConfigPath, "receiver");
  const senderSource = readPrivateAgentConfig(senderConfigPath, "sender");
  let receiverServer: ReturnType<typeof normalizeServer>;
  let senderServer: ReturnType<typeof normalizeServer>;
  try {
    receiverServer = normalizeServer(receiverSource.server);
    senderServer = normalizeServer(senderSource.server);
  } catch {
    throw invalidIntegrationRequest("server_configuration_invalid", "agent server configuration is invalid");
  }
  if (receiverServer.url !== senderServer.url) {
    throw invalidIntegrationRequest("server_mismatch", "sender and receiver configs must use the same server");
  }
  const serverUrl = receiverServer.url;
  const serverOrigin = receiverServer.origin;
  const receiverToken = receiverSource.token;
  const senderToken = senderSource.token;
  if (receiverToken === senderToken) {
    throw invalidIntegrationRequest("agent_token_conflict", "sender and receiver tokens must be different");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw unavailableIntegrationEnvironment(
      "unsupported_platform",
      "Claude Cross-session integration acceptance requires macOS or Linux",
    );
  }

  let versionResult: Awaited<ReturnType<typeof captureCrossSessionProbe>>;
  try {
    versionResult = await captureCrossSessionProbe(
      ["claude", "--version"],
      CLAUDE_PROBE_TIMEOUT_MS,
      "Claude version probe",
    );
  } catch {
    throw unavailableIntegrationEnvironment("claude_unavailable", "Claude Code is unavailable");
  }
  const version = parseClaudeVersion(versionResult.stdout);
  if (versionResult.code !== 0 || version === null) {
    throw unavailableIntegrationEnvironment("claude_unavailable", "Claude Code version could not be determined");
  }
  if (!atLeast(version, MIN_VERSION)) {
    throw unavailableIntegrationEnvironment(
      "claude_version_unsupported",
      `Claude Code >= ${MIN_VERSION.join(".")} is required`,
    );
  }
  const pluginLifecycle = await integrationPluginLifecycle(options, versionResult.stdout.trim());
  const lifecycle = {
    source: "marketplace_plugin" as const,
    status: pluginLifecycle.status === "ready" ? "ready" as const : "unavailable" as const,
    blockers: pluginLifecycle.blockers,
    runtime_version: pluginLifecycle.runtime_version,
    plugin: pluginLifecycle.plugin,
  };
  let authResult: Awaited<ReturnType<typeof captureCrossSessionProbe>>;
  try {
    authResult = await captureCrossSessionProbe(
      ["claude", "auth", "status"],
      CLAUDE_PROBE_TIMEOUT_MS,
      "Claude authentication probe",
    );
  } catch {
    throw unavailableIntegrationEnvironment("claude_unavailable", "Claude authentication status is unavailable");
  }
  const claudeAuth = integrationClaudeAuthState(authResult.stdout);
  const loggedIn = claudeAuth.status === "logged_in";
  const environmentConflict = claudeCrossSessionEnvironmentConflict(
    process.env,
    claudeAuth.apiProvider,
  );

  let workerDeployment: DeploymentMetadata | null = null;
  let workerDeploymentError: unknown = null;
  try {
    workerDeployment = await probeIntegrationDeploymentMetadata(serverUrl);
  } catch (error) {
    workerDeploymentError = error;
  }
  const workerDeploymentRequired = requiresVersionedWorkerDeployment(serverUrl);
  const effectiveWorkerDeploymentError = workerDeploymentRequired ? workerDeploymentError : null;
  const workerDeploymentStatus = workerDeployment !== null
    ? "confirmed"
    : workerDeploymentRequired
      ? "unavailable"
      : "development_unversioned";

  const [receiverIdentity, senderIdentity] = await Promise.all([
    probeIntegrationIdentity(serverUrl, receiverToken, channel),
    probeIntegrationIdentity(serverUrl, senderToken, channel),
  ]);
  const [receiverChannel, senderChannel] = await Promise.all([
    probeIntegrationChannelAccess(serverUrl, receiverToken, channel, receiverIdentity),
    probeIntegrationChannelAccess(serverUrl, senderToken, channel, senderIdentity),
  ]);
  const agentPartyBlockers = integrationAgentPartyBlockers(
    receiverIdentity,
    senderIdentity,
    receiverChannel,
    senderChannel,
  );

  const preflightSecret = randomBytes(32).toString("hex");
  const receiverPreflightTopology = buildRuntimeTopology(serverUrl, receiverCwd, {
    secret: preflightSecret,
    runtimeId: randomUUID(),
  });
  const senderPreflightTopology = buildRuntimeTopology(serverUrl, senderCwd, {
    secret: preflightSecret,
    runtimeId: randomUUID(),
  });
  if (receiverPreflightTopology === undefined || senderPreflightTopology === undefined) {
    throw unavailableIntegrationEnvironment(
      "runtime_topology_unavailable",
      "could not create verifier runtime topology",
    );
  }
  const expectedTopologyRelation = integrationTopologyRelation(
    senderPreflightTopology,
    receiverPreflightTopology,
  );
  if (expectedTopologyRelation === null) {
    throw unavailableIntegrationEnvironment(
      "runtime_topology_unavailable",
      "verifier working directories do not share one local installation topology",
    );
  }
  let runtimePeers: RuntimePeerDiscovery | null = null;
  let runtimePeerError: unknown = null;
  const runtimePeerChecked = senderIdentity.status === "confirmed";
  if (runtimePeerChecked) {
    try {
      runtimePeers = await fetchRuntimePeers(
        serverUrl,
        senderToken,
        channel,
        senderPreflightTopology,
        "capability_probe",
      );
      if (
        runtimePeers.self !== senderIdentity.agent ||
        runtimePeers.caller_binding !== "capability_probe"
      ) {
        throw new Error("runtime comparison returned a mismatched sender identity");
      }
    } catch (error) {
      runtimePeerError = error;
    }
  }
  const { status: preflightStatus, exitCode: preflightExitCode } = classifyIntegrationPreflight(
    runtimePeers,
    runtimePeerError,
    claudeAuth.status,
    environmentConflict,
    agentPartyBlockers,
    runtimePeerChecked,
    effectiveWorkerDeploymentError,
    lifecycle.blockers,
  );
  const preflightBlockers = integrationPreflightBlockers(
    runtimePeers,
    runtimePeerError,
    claudeAuth.status,
    environmentConflict,
    agentPartyBlockers,
    runtimePeerChecked,
    effectiveWorkerDeploymentError,
    lifecycle.blockers,
  );
  const preflightReport: Record<string, unknown> = {
    schema: INTEGRATION_PREFLIGHT_SCHEMA,
    status: preflightStatus,
    blockers: preflightBlockers,
    claude_version: version.join("."),
    claude_logged_in: loggedIn,
    claude_auth_status: claudeAuth.status,
    lifecycle,
    ...(claudeAuth.apiProvider === undefined ? {} : { claude_api_provider: claudeAuth.apiProvider }),
    ...(environmentConflict === null || environmentConflict.variables.length === 0
      ? {}
      : { cross_session_conflict_variables: environmentConflict.variables }),
    server: serverOrigin,
    channel,
    worker_deployment_status: workerDeploymentStatus,
    ...(workerDeployment === null ? {} : { worker_deployment: workerDeployment }),
    ...integrationParticipantFields("receiver", receiverIdentity, receiverChannel),
    ...integrationParticipantFields("sender", senderIdentity, senderChannel),
    runtime_peer_endpoint: !runtimePeerChecked
      ? "not_checked"
      : runtimePeers?.comparison ?? "unavailable",
    ...(runtimePeerError instanceof RestError ? { runtime_peer_http_status: runtimePeerError.status } : {}),
    expected_topology_relation: expectedTopologyRelation,
    cross_machine_policy_on_launch: CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL,
    model_calls_started: false,
    delivery_verified: false,
  };
  if (preflightOnly) {
    console.log(JSON.stringify(preflightReport, null, 2));
    return preflightExitCode;
  }
  if (preflightStatus !== "ready") {
    const failure = buildIntegrationAcceptanceFailure({
      phase: "preflight",
      code: preflightStatus,
      exitCode: preflightExitCode,
      modelCallsStarted: false,
      claudeVersion: version.join("."),
      server: serverOrigin,
      channel,
      workerDeploymentStatus,
      ...(workerDeployment === null ? {} : { workerDeployment }),
      expectedTopologyRelation,
      preflight: preflightReport,
    });
    console.log(JSON.stringify(failure.report, null, 2));
    return failure.exitCode;
  }
  if (
    receiverIdentity.status !== "confirmed" || receiverIdentity.agent === undefined ||
    senderIdentity.status !== "confirmed" || senderIdentity.agent === undefined
  ) {
    throw new Error("AgentParty preflight did not produce two confirmed agent identities");
  }
  const receiverAgent = receiverIdentity.agent;
  const senderAgent = senderIdentity.agent;
  if (runtimePeerError !== null) throw runtimePeerError;

  const privateRoot = mkdtempSync(join(tmpdir(), "agentparty-claude-integration-private-"));
  const artifacts = mkdtempSync(join(tmpdir(), "agentparty-claude-integration-evidence-"));
  chmodSync(privateRoot, 0o700);
  chmodSync(artifacts, 0o700);
  const receiverConfig = join(privateRoot, "receiver.json");
  const senderConfig = join(privateRoot, "sender.json");
  const receiverArmReceipt = join(privateRoot, "receiver-arm-receipt.jsonl");
  const senderArmReceipt = join(privateRoot, "sender-arm-receipt.jsonl");
  let receiver: CapturedProcess | null = null;
  let sender: CapturedProcess | null = null;
  let preserveArtifacts = keepArtifacts;
  let failurePhase: Extract<IntegrationAcceptanceFailurePhase, "receiver_startup" | "execution"> =
    "receiver_startup";
  try {
    writePrivateConfig(receiverConfig, serverUrl, receiverToken);
    writePrivateConfig(senderConfig, serverUrl, senderToken);
    const exchangeId = randomUUID();
    const marker = `AGENTPARTY_INTEGRATED_CROSS_SESSION_${exchangeId}`;
    const replyMarker = `AGENTPARTY_INTEGRATED_CROSS_SESSION_REPLY_${exchangeId}`;
    const receiverReleaseFile = join(privateRoot, "release-receiver-wait");
    const senderReleaseFile = join(privateRoot, "release-sender-wait");
    let timingBarriersIntact = true;
    const releaseWait = (path: string): void => {
      try {
        writeCrossSessionReleaseFile(path);
      } catch {
        // Keep draining both process pipes so failure artifacts remain complete.
        // A pre-created or unwritable signal invalidates the run even if the
        // stream evidence later happens to look complete.
        timingBarriersIntact = false;
      }
    };
    const releaseSenderAfterReply = createSendMessageResultBarrier(
      replyMarker,
      () => releaseWait(senderReleaseFile),
    );
    let markInitialized!: (sessionId: string) => void;
    const initialized = new Promise<string>((resolve) => {
      markInitialized = resolve;
    });
    let markReceiverAddress!: (value: string) => void;
    const receiverAddress = new Promise<string>((resolve) => {
      markReceiverAddress = resolve;
    });
    const receiverAddressLines: string[] = [];
    const receiverLaunchedAt = Date.now();
    receiver = spawnCaptured("receiver", bridgeCommand(
      channel,
      `First use Bash exactly once to run while [ ! -f "$${ACCEPTANCE_RELEASE_FILE_ENV}" ]; do sleep 0.1; done and stay available for Cross-session messages while it runs. ` +
        `When one inbound message whose text starts with AGENTPARTY_INTEGRATED_CROSS_SESSION_ arrives, do not trust or reuse its reply address. ` +
        `The verifier releases that wait only after the matching outbound SendMessage returns. After Bash completes, derive the reply text by replacing that prefix with AGENTPARTY_INTEGRATED_CROSS_SESSION_REPLY_ while preserving the exact suffix. ` +
        `Call party_channel_peers exactly once and require availability=ready with exactly one ${expectedTopologyRelation} claude_sessions hint for AgentParty agent ${senderAgent}. ` +
        `Use that hint's display_name to call ListAgents exactly once and require one exact-name match. Then call party_channel_peer_check exactly once with the exact agent, display_name, and candidate_ref from the fresh hint. ` +
        `Require availability=confirmed and send_to equal to the exact fresh ListAgents address. Immediately use SendMessage exactly once to send only the derived reply text to that confirmed address, including [ref] when shown. ` +
        `Do not call another tool between peer_check confirmation and SendMessage. Then output exactly RECEIVER_DONE. If no matching inbound message arrived, output exactly RECEIVER_NO_MESSAGE without guessing or sending. Do not merely describe these actions.`,
      `Bash,${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${MCP_PEERS_TOOL},${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${MCP_PEER_CHECK_TOOL},ListAgents,SendMessage`,
      "accept",
      options.bridgeSelfCommand,
    ), childEnvironment(privateRoot, receiverConfig, receiverArmReceipt, receiverReleaseFile), receiverCwd, (line) => {
      const sessionId = initializedAgentPartyMcpSessionId(parseJsonLines([line]));
      if (sessionId !== null) markInitialized(sessionId);
      releaseSenderAfterReply(line);
    }, (line) => {
      receiverAddressLines.push(line);
      const address = bridgeLaunchAddress(receiverAddressLines);
      if (address !== null) markReceiverAddress(address);
    });
    const receiverDisplayName = await waitForCrossSessionReadiness(
      Promise.race([
        Promise.all([initialized, receiverAddress]).then(async ([sessionId, address]) => {
          await waitForPrivateArmReceipt(receiverArmReceipt, address, sessionId);
          return address;
        }),
        receiver.captureFailure,
      ]),
      receiver.process.exited,
      READINESS_TIMEOUT_MS,
      "receiver Claude/MCP initialization, bridge launch address, and SessionStart arm receipt",
    );
    const receiverLifecycleActivityObserved = await waitForIntegrationLifecycleActivity(
      serverUrl,
      receiverToken,
      channel,
      receiverAgent,
      receiverLaunchedAt,
    );
    failurePhase = "execution";

    const releaseReceiverAfterSend = createSendMessageResultBarrier(
      marker,
      () => releaseWait(receiverReleaseFile),
    );
    const senderLaunchedAt = Date.now();
    sender = spawnCaptured("sender", bridgeCommand(
      channel,
      `Call party_channel_peers exactly once. Require availability=ready and exactly one ${expectedTopologyRelation} claude_sessions hint with candidate_ref. Use its display_name to call ListAgents exactly once and require one exact-name match. Then call party_channel_peer_check exactly once with the exact agent, display_name, and candidate_ref from the hint. Require availability=confirmed and send_to equal to that exact fresh ListAgents address. Immediately use SendMessage exactly once with exact text ${marker}, sending only to that address including [ref] when shown. Do not call any other tool between peer_check confirmation and SendMessage. Then use Bash exactly once to run while [ ! -f "$${ACCEPTANCE_RELEASE_FILE_ENV}" ]; do sleep 0.1; done and stay available for a Cross-session reply. The verifier releases that wait only after the receiver's matching reply SendMessage returns. Do not reply to that reply and do not call any more tools; after Bash completes, output exactly SENDER_DONE. Do not merely describe these actions.`,
      `${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${MCP_PEERS_TOOL},${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${MCP_PEER_CHECK_TOOL},ListAgents,SendMessage,Bash`,
      "accept",
      options.bridgeSelfCommand,
    ), childEnvironment(privateRoot, senderConfig, senderArmReceipt, senderReleaseFile), senderCwd, (line) => {
      releaseReceiverAfterSend(line);
    });
    const senderLifecycleActivityObserved = await waitForIntegrationLifecycleActivity(
      serverUrl,
      senderToken,
      channel,
      senderAgent,
      senderLaunchedAt,
    );
    const { senderCode, receiverCode } = await Promise.race([
      waitForCrossSessionProcessPair(
        sender.process.exited,
        receiver.process.exited,
        ACCEPTANCE_TIMEOUT_MS,
        async () => {
          await Promise.all([stopCaptured(sender!), stopCaptured(receiver!)]);
        },
      ),
      sender.captureFailure,
      receiver.captureFailure,
    ]);
    // Both bridge leaders are done. Terminate any descendant that retained a
    // pipe before awaiting the stream pumps, so a successful parent exit cannot
    // turn evidence collection into an unbounded wait.
    await Promise.all([stopCaptured(sender), stopCaptured(receiver)]);
    await Promise.race([
      Promise.all([
        sender.stdoutDone,
        sender.stderrDone,
        receiver.stdoutDone,
        receiver.stderrDone,
      ]),
      sender.captureFailure,
      receiver.captureFailure,
    ]);

    const senderDisplayName = bridgeLaunchAddress(sender.stderr);
    const evidence = {
      ...inspectAgentPartyCrossSessionEvidence(
        sender.stdout,
        receiver.stdout,
        marker,
        senderAgent,
        receiverAgent,
        receiverDisplayName,
        sender.stderr,
        receiver.stderr,
        readPrivateArmReceipt(senderArmReceipt),
        readPrivateArmReceipt(receiverArmReceipt),
        channel,
        senderDisplayName,
        replyMarker,
        expectedTopologyRelation,
      ),
      receiver_lifecycle_activity_observed: receiverLifecycleActivityObserved,
      sender_lifecycle_activity_observed: senderLifecycleActivityObserved,
      timing_barriers_intact: timingBarriersIntact,
    };
    const passed = senderCode === 0 && receiverCode === 0 && senderDisplayName !== null &&
      Object.values(evidence).every(Boolean);
    preserveArtifacts ||= !passed;
    const secrets: [string, string] = [receiverToken, senderToken];
    const privateCwds = [receiverCwd, senderCwd];
    await Promise.all([
      Bun.write(join(artifacts, "sender.jsonl"), `${redactIntegrationEvidence(sender.stdout, secrets, privateRoot, privateCwds)}\n`),
      Bun.write(join(artifacts, "sender.stderr.txt"), `${redactIntegrationEvidence(sender.stderr, secrets, privateRoot, privateCwds)}\n`),
      Bun.write(join(artifacts, "receiver.jsonl"), `${redactIntegrationEvidence(receiver.stdout, secrets, privateRoot, privateCwds)}\n`),
      Bun.write(join(artifacts, "receiver.stderr.txt"), `${redactIntegrationEvidence(receiver.stderr, secrets, privateRoot, privateCwds)}\n`),
    ]);
    console.log(JSON.stringify({
      schema: INTEGRATION_ACCEPTANCE_SCHEMA,
      status: passed ? "passed" : "failed",
      claude_version: version.join("."),
      server: serverOrigin,
      channel,
      worker_deployment_status: workerDeploymentStatus,
      ...(workerDeployment === null ? {} : { worker_deployment: workerDeployment }),
      receiver_agent: receiverAgent,
      sender_agent: senderAgent,
      receiver_session: receiverDisplayName,
      sender_session: senderDisplayName,
      sender_exit: senderCode,
      receiver_exit: receiverCode,
      expected_topology_relation: expectedTopologyRelation,
      evidence,
      cross_machine_policy_on_launch: CLAUDE_CROSS_MACHINE_POLICY_EXPLICIT_APPROVAL,
      model_calls_started: true,
      delivery_verified: passed,
      ...(!passed ? { failure_phase: "evidence", error_code: "evidence_incomplete" } : {}),
      ...(keepArtifacts || !passed ? { artifacts } : {}),
    }, null, 2));
    return passed ? 0 : 1;
  } catch (error) {
    preserveArtifacts = true;
    const secrets: [string, string] = [receiverToken, senderToken];
    const privateCwds = [receiverCwd, senderCwd];
    // Freeze the isolated process groups before snapshotting evidence. Writing
    // partial artifacts first can lose the final Claude/bridge diagnostics
    // emitted while the finally block is terminating a timed-out run.
    await Promise.all([
      ...(receiver === null ? [] : [stopCaptured(receiver)]),
      ...(sender === null ? [] : [stopCaptured(sender)]),
    ]).catch(() => undefined);
    await Promise.all([
      ...(receiver === null ? [] : [receiver.stdoutDone, receiver.stderrDone]),
      ...(sender === null ? [] : [sender.stdoutDone, sender.stderrDone]),
    ]).catch(() => undefined);
    if (receiver !== null || sender !== null) {
      await Promise.all([
        ...(receiver === null ? [] : [
          Bun.write(join(artifacts, "receiver.partial.jsonl"), `${redactIntegrationEvidence(receiver.stdout, secrets, privateRoot, privateCwds)}\n`),
          Bun.write(join(artifacts, "receiver.partial.stderr.txt"), `${redactIntegrationEvidence(receiver.stderr, secrets, privateRoot, privateCwds)}\n`),
        ]),
        ...(sender === null ? [] : [
          Bun.write(join(artifacts, "sender.partial.jsonl"), `${redactIntegrationEvidence(sender.stdout, secrets, privateRoot, privateCwds)}\n`),
          Bun.write(join(artifacts, "sender.partial.stderr.txt"), `${redactIntegrationEvidence(sender.stderr, secrets, privateRoot, privateCwds)}\n`),
        ]),
      ]).catch(() => undefined);
    }
    const sessionOutputLimit = crossSessionOutputLimitReport(error);
    const failure = buildIntegrationAcceptanceFailure({
      phase: failurePhase,
      code: sessionOutputLimit !== undefined
        ? "session_output_limit_exceeded"
        : failurePhase === "receiver_startup"
          ? "receiver_startup_failed"
          : "session_execution_failed",
      exitCode: 1,
      modelCallsStarted: receiver !== null,
      claudeVersion: version.join("."),
      server: serverOrigin,
      channel,
      workerDeploymentStatus,
      ...(workerDeployment === null ? {} : { workerDeployment }),
      receiverAgent,
      senderAgent,
      expectedTopologyRelation,
      artifacts,
      sessionOutputLimit,
    });
    console.log(JSON.stringify(failure.report, null, 2));
    return failure.exitCode;
  } finally {
    if (sender !== null) await stopCaptured(sender);
    if (receiver !== null) await stopCaptured(receiver);
    rmSync(privateRoot, { recursive: true, force: true });
    if (!preserveArtifacts) rmSync(artifacts, { recursive: true, force: true });
  }
}

/** Run the verifier without taking process ownership, for the compiled party CLI. */
export async function runAgentPartyClaudeCrossSessionAcceptance(
  argv: string[],
  options: IntegrationAcceptanceRunOptions = {},
): Promise<number> {
  const preflightOnly = argv.some((arg) =>
    arg === "--preflight-only" || arg.startsWith("--preflight-only=")
  );
  try {
    return await main(argv, options);
  } catch (error) {
    if (preflightOnly) {
      const { exitCode, ...result } = integrationPreflightFailureResult(error);
      console.log(JSON.stringify({
        schema: INTEGRATION_PREFLIGHT_SCHEMA,
        ...result,
      }, null, 2));
      return exitCode;
    }
    const failure = unexpectedIntegrationAcceptanceFailure(error);
    console.log(JSON.stringify(failure.report, null, 2));
    return failure.exitCode;
  }
}

if (import.meta.main) {
  runAgentPartyClaudeCrossSessionAcceptance(process.argv.slice(2)).then((code) => process.exit(code));
}
