#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uniqueClaudeListAgentsAddress } from "../cli/src/claude-cross-session-gate";
import {
  claudeCrossSessionEnvironmentConflict,
  parseClaudeAuthInfo,
} from "../cli/src/commands/bridge";
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

const MIN_VERSION = [2, 1, 224] as const;
const ACCEPTANCE_TIMEOUT_MS = 60_000;
const CLAUDE_PROBE_TIMEOUT_MS = 10_000;
const NATIVE_RELEASE_FILE_ENV = "AGENTPARTY_CROSS_SESSION_NATIVE_RELEASE_FILE";
const NATIVE_PREFLIGHT_SCHEMA = "agentparty.claude-cross-session-native-preflight.v1";
const NATIVE_ACCEPTANCE_SCHEMA = "agentparty.claude-cross-session-acceptance.v1";

interface CapturedProcess {
  process: ReturnType<typeof Bun.spawn>;
  stdout: string[];
  stderr: string[];
  stdoutDone: Promise<void>;
  stderrDone: Promise<void>;
  captureFailure: Promise<never>;
  stopPromise?: Promise<void>;
}

export interface CrossSessionEvidence {
  receiver_initialized: boolean;
  distinct_claude_session_ids: boolean;
  sender_used_list_agents: boolean;
  sender_used_send_message_with_marker: boolean;
  sender_send_message_result_observed: boolean;
  receiver_observed_marker: boolean;
  receiver_wait_boundary_before_marker: boolean;
  timing_barrier_intact: boolean;
}

export type NativeClaudeAuthStatus = "logged_in" | "logged_out" | "unavailable";
export type NativeClaudePreflightStatus =
  | "ready"
  | "claude_auth_required"
  | "claude_auth_unavailable"
  | "unsupported_provider"
  | "feature_flag_evaluation_disabled"
  | "environment_unavailable";
export type NativeClaudePreflightBlocker =
  | "unsupported_platform"
  | "claude_unavailable"
  | "claude_version_unsupported"
  | Exclude<NativeClaudePreflightStatus, "ready" | "environment_unavailable">;

export interface NativeClaudePreflightInput {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** `undefined` means the platform gate skipped the probe; `null` means it failed. */
  versionProbe?: { stdout: string; code: number } | null;
  /** `undefined` means the platform gate skipped the probe; `null` means it failed. */
  authProbe?: { stdout: string; code: number } | null;
}

export interface NativeClaudePreflightReport {
  schema: typeof NATIVE_PREFLIGHT_SCHEMA;
  status: NativeClaudePreflightStatus;
  blockers: NativeClaudePreflightBlocker[];
  claude_logged_in: boolean;
  claude_auth_status: NativeClaudeAuthStatus;
  claude_version?: string;
  claude_api_provider?: string;
  cross_session_conflict_variables?: string[];
  model_calls_started: false;
  delivery_verified: false;
}

export interface NativeClaudePreflightResult {
  report: NativeClaudePreflightReport;
  exitCode: number;
}

export type NativeClaudePreflightFailureCode = "invalid_arguments" | "internal_error";
export type NativeClaudePreflightFailureStatus = "invalid_request" | "internal_error";

export interface NativeClaudePreflightFailureReport {
  schema: typeof NATIVE_PREFLIGHT_SCHEMA;
  status: NativeClaudePreflightFailureStatus;
  blockers: [NativeClaudePreflightFailureCode];
  error_code: NativeClaudePreflightFailureCode;
  model_calls_started: false;
  delivery_verified: false;
}

export class NativeClaudePreflightFailure extends Error {
  constructor(
    readonly code: NativeClaudePreflightFailureCode,
    readonly status: NativeClaudePreflightFailureStatus,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "NativeClaudePreflightFailure";
  }
}

export function nativeClaudePreflightFailureResult(error: unknown): {
  report: NativeClaudePreflightFailureReport;
  exitCode: number;
} {
  const failure = error instanceof NativeClaudePreflightFailure
    ? error
    : new NativeClaudePreflightFailure("internal_error", "internal_error", 1, "unexpected preflight failure");
  return {
    exitCode: failure.exitCode,
    report: {
      schema: NATIVE_PREFLIGHT_SCHEMA,
      status: failure.status,
      blockers: [failure.code],
      error_code: failure.code,
      model_calls_started: false,
      delivery_verified: false,
    },
  };
}

interface NativeClaudeArguments {
  keepArtifacts: boolean;
  preflightOnly: boolean;
}

export function parseNativeClaudeArguments(argv: readonly string[]): NativeClaudeArguments {
  const allowed = new Set(["--keep-artifacts", "--preflight-only"]);
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!allowed.has(arg) || seen.has(arg)) {
      throw new NativeClaudePreflightFailure(
        "invalid_arguments",
        "invalid_request",
        9,
        "invalid native Claude acceptance arguments",
      );
    }
    seen.add(arg);
  }
  return {
    keepArtifacts: seen.has("--keep-artifacts"),
    preflightOnly: seen.has("--preflight-only"),
  };
}

export type NativeClaudeAcceptanceFailurePhase =
  | "request"
  | "preflight"
  | "receiver_startup"
  | "execution"
  | "evidence"
  | "internal";
export type NativeClaudeAcceptanceFailureCode =
  | NativeClaudePreflightFailureCode
  | Exclude<NativeClaudePreflightStatus, "ready">
  | "receiver_startup_failed"
  | "session_execution_failed"
  | "session_output_limit_exceeded"
  | "evidence_incomplete";

export interface NativeClaudeAcceptanceFailureInput {
  phase: NativeClaudeAcceptanceFailurePhase;
  code: NativeClaudeAcceptanceFailureCode;
  exitCode: number;
  modelCallsStarted: boolean | "unknown";
  claudeVersion?: string;
  preflight?: NativeClaudePreflightReport;
  artifacts?: string;
  sessionOutputLimit?: CrossSessionOutputLimitReport;
}

export interface NativeClaudeAcceptanceFailureReport {
  schema: typeof NATIVE_ACCEPTANCE_SCHEMA;
  status: "failed";
  failure_phase: NativeClaudeAcceptanceFailurePhase;
  error_code: NativeClaudeAcceptanceFailureCode;
  model_calls_started: boolean | "unknown";
  delivery_verified: false;
  claude_version?: string;
  preflight?: NativeClaudePreflightReport;
  artifacts?: string;
  session_output_limit?: CrossSessionOutputLimitReport;
}

export function buildNativeClaudeAcceptanceFailure(
  input: NativeClaudeAcceptanceFailureInput,
): { report: NativeClaudeAcceptanceFailureReport; exitCode: number } {
  return {
    exitCode: input.exitCode,
    report: {
      schema: NATIVE_ACCEPTANCE_SCHEMA,
      status: "failed",
      failure_phase: input.phase,
      error_code: input.code,
      model_calls_started: input.modelCallsStarted,
      delivery_verified: false,
      ...(input.claudeVersion === undefined ? {} : { claude_version: input.claudeVersion }),
      ...(input.preflight === undefined ? {} : { preflight: input.preflight }),
      ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
      ...(input.sessionOutputLimit === undefined
        ? {}
        : { session_output_limit: input.sessionOutputLimit }),
    },
  };
}

export function unexpectedNativeClaudeAcceptanceFailure(error: unknown): {
  report: NativeClaudeAcceptanceFailureReport;
  exitCode: number;
} {
  if (error instanceof NativeClaudePreflightFailure) {
    return buildNativeClaudeAcceptanceFailure({
      phase: "request",
      code: error.code,
      exitCode: error.exitCode,
      modelCallsStarted: false,
    });
  }
  return buildNativeClaudeAcceptanceFailure({
    phase: "internal",
    code: "internal_error",
    exitCode: 1,
    modelCallsStarted: "unknown",
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClaudeVersion(value: string): [number, number, number] | null {
  const match = value.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < minimum.length; index++) {
    if ((version[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

/** Classify read-only local Claude probes without starting a model session. */
export function inspectNativeClaudePreflight(
  input: NativeClaudePreflightInput,
): NativeClaudePreflightResult {
  const blockers: NativeClaudePreflightBlocker[] = [];
  const supportedPlatform = input.platform === "darwin" || input.platform === "linux";
  if (!supportedPlatform) blockers.push("unsupported_platform");

  const version = input.versionProbe === undefined
    ? null
    : parseClaudeVersion(input.versionProbe?.stdout ?? "");
  if (supportedPlatform) {
    if (
      input.versionProbe === null || input.versionProbe === undefined ||
      input.versionProbe.code !== 0 || version === null
    ) {
      blockers.push("claude_unavailable");
    } else if (!atLeast(version, MIN_VERSION)) {
      blockers.push("claude_version_unsupported");
    }
  }

  const auth = input.authProbe === undefined
    ? null
    : parseClaudeAuthInfo(input.authProbe?.stdout ?? "");
  const authStatus: NativeClaudeAuthStatus = auth === null
    ? "unavailable"
    : auth.loggedIn
      ? "logged_in"
      : "logged_out";
  if (supportedPlatform) {
    if (authStatus === "logged_out") blockers.push("claude_auth_required");
    if (authStatus === "unavailable") blockers.push("claude_auth_unavailable");
  }

  const environmentConflict = claudeCrossSessionEnvironmentConflict(input.env, auth?.apiProvider);
  if (environmentConflict !== null) {
    blockers.push(environmentConflict.reason);
  }

  let status: NativeClaudePreflightStatus = "ready";
  let exitCode = 0;
  if (blockers.some((blocker) =>
    blocker === "unsupported_platform" || blocker === "claude_unavailable" ||
    blocker === "claude_version_unsupported"
  )) {
    status = "environment_unavailable";
    exitCode = 10;
  } else if (authStatus === "logged_out") {
    status = "claude_auth_required";
    exitCode = 2;
  } else if (authStatus === "unavailable") {
    status = "claude_auth_unavailable";
    exitCode = 5;
  } else if (environmentConflict?.reason === "unsupported_provider") {
    status = "unsupported_provider";
    exitCode = 6;
  } else if (environmentConflict?.reason === "feature_flag_evaluation_disabled") {
    status = "feature_flag_evaluation_disabled";
    exitCode = 7;
  }

  return {
    exitCode,
    report: {
      schema: NATIVE_PREFLIGHT_SCHEMA,
      status,
      blockers,
      claude_logged_in: authStatus === "logged_in",
      claude_auth_status: authStatus,
      ...(version === null ? {} : { claude_version: version.join(".") }),
      ...(auth?.apiProvider === undefined ? {} : { claude_api_provider: auth.apiProvider }),
      ...(environmentConflict === null || environmentConflict.variables.length === 0
        ? {}
        : { cross_session_conflict_variables: environmentConflict.variables }),
      model_calls_started: false,
      delivery_verified: false,
    },
  };
}

async function probeNativeClaudePreflight(): Promise<NativeClaudePreflightResult> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return inspectNativeClaudePreflight({
      platform: process.platform,
      env: process.env,
    });
  }
  const [versionProbe, authProbe] = await Promise.all([
    captureCrossSessionProbe(
      ["claude", "--version"],
      CLAUDE_PROBE_TIMEOUT_MS,
      "Claude version probe",
    ).catch(() => null),
    captureCrossSessionProbe(
      ["claude", "auth", "status"],
      CLAUDE_PROBE_TIMEOUT_MS,
      "Claude authentication probe",
    ).catch(() => null),
  ]);
  return inspectNativeClaudePreflight({
    platform: process.platform,
    env: process.env,
    versionProbe,
    authProbe,
  });
}

export function parseJsonLines(lines: readonly string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return record(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function toolUses(
  event: Record<string, unknown>,
  name: string,
  mainSessionOnly = true,
): Record<string, unknown>[] {
  return directClaudeToolUseBlocks(event, mainSessionOnly)
    .filter((value) => value.name === name);
}

function toolUse(event: Record<string, unknown>, name: string): Record<string, unknown> | null {
  return toolUses(event, name)[0] ?? null;
}

function toolUseCount(events: readonly Record<string, unknown>[], name: string): number {
  // Count the complete stream, including foreign and child sessions, so they
  // cannot hide a duplicate. Evidence lookup below remains top-level only.
  return events.reduce((count, event) => count + toolUses(event, name, false).length, 0);
}

function listedAddress(event: Record<string, unknown>, toolUseId: string, expectedName: string): string | null {
  const results = directClaudeToolResultBlocks(event);
  if (results.length !== 1 || results[0]!.tool_use_id !== toolUseId) return null;
  return uniqueClaudeListAgentsAddress([results[0]!.content], expectedName);
}

function exactSendMessageInput(input: unknown, recipient: string, message: string): boolean {
  if (!record(input) || input.message !== message) return false;
  const to = typeof input.to === "string" ? input.to : undefined;
  const alternate = typeof input.recipient === "string" ? input.recipient : undefined;
  if (to !== undefined && alternate !== undefined && to !== alternate) return false;
  return (to ?? alternate) === recipient;
}

function initializedReceiver(events: readonly Record<string, unknown>[]): boolean {
  const init = uniqueClaudeStreamInit(events);
  if (init === null) return false;
  const event = init.event;
  return typeof event.messaging_socket_path === "string" &&
    event.messaging_socket_path !== "" &&
    Array.isArray(event.tools) &&
    event.tools.includes("ListAgents") &&
    event.tools.includes("SendMessage") &&
    event.tools.includes("Bash");
}

export function inspectCrossSessionEvidence(
  senderLines: readonly string[],
  receiverLines: readonly string[],
  marker: string,
  expectedReceiverName: string,
  timingBarrierIntact: boolean = false,
): CrossSessionEvidence {
  const senderAll = parseJsonLines(senderLines);
  const sender = sameSessionEventsAfterUniqueInit(senderAll) ?? senderAll.map(() => ({}));
  const receiver = parseJsonLines(receiverLines);
  const senderInit = uniqueClaudeStreamInit(senderAll);
  const receiverInit = uniqueClaudeStreamInit(receiver);
  const exactlyOneList = toolUseCount(senderAll, "ListAgents") === 1;
  const exactlyOneSend = toolUseCount(senderAll, "SendMessage") === 1;
  const listIndex = exactlyOneList
    ? sender.findIndex((event) =>
      directClaudeToolUseBlocks(event).length === 1 && toolUse(event, "ListAgents") !== null
    )
    : -1;
  const listUse = listIndex < 0 ? null : toolUse(sender[listIndex]!, "ListAgents");
  const listUseId = typeof listUse?.id === "string" && listUse.id !== "" ? listUse.id : null;
  const candidateListResultIndex = uniqueSuccessfulClaudeToolResultIndex(
    senderAll,
    listUseId,
    listIndex,
  );
  const candidateAddress = candidateListResultIndex === null || listUseId === null
    ? null
    : listedAddress(sender[candidateListResultIndex]!, listUseId, expectedReceiverName);
  const address = candidateAddress;
  const listResultIndex = address === null ? -1 : candidateListResultIndex ?? -1;
  const sendIndex = exactlyOneSend ? sender.findIndex((event, index) => {
    if (index <= listResultIndex || address === null) return false;
    const use = toolUse(event, "SendMessage");
    return use !== null && directClaudeToolUseBlocks(event).length === 1 &&
      exactSendMessageInput(use.input ?? {}, address, marker);
  }) : -1;
  const sendUse = sendIndex < 0 ? null : toolUse(sender[sendIndex]!, "SendMessage");
  const sendUseId = typeof sendUse?.id === "string" && sendUse.id !== "" ? sendUse.id : null;
  const sendResultIndex = uniqueSuccessfulClaudeToolResultIndex(senderAll, sendUseId, sendIndex);
  const noInterveningTool = listResultIndex >= 0 && sendIndex > listResultIndex &&
    sender.slice(listResultIndex + 1, sendIndex)
      .every((event) => directClaudeToolUseBlocks(event).length === 0);
  const noToolBeforeSendResult = sendResultIndex !== null && sendResultIndex > sendIndex &&
    sender.slice(sendIndex + 1, sendResultIndex)
      .every((event) => directClaudeToolUseBlocks(event).length === 0);
  const receiverMarkerIndex = uniqueInboundTextMarkerIndex(receiver, marker);
  const senderChainComplete =
    exactlyOneList && exactlyOneSend && listResultIndex >= 0 && sendIndex > listResultIndex && noInterveningTool;
  return {
    receiver_initialized: initializedReceiver(receiver),
    distinct_claude_session_ids:
      senderInit !== null && receiverInit !== null && senderInit.sessionId !== receiverInit.sessionId,
    sender_used_list_agents: exactlyOneList && listIndex >= 0 && listResultIndex > listIndex,
    sender_used_send_message_with_marker: senderChainComplete,
    sender_send_message_result_observed:
      senderChainComplete && sendResultIndex !== null && noToolBeforeSendResult,
    // Require one marker after the receiver's unique init and bind it to that
    // session ID; prompt, tool, replay, and child-event echoes fail closed.
    receiver_observed_marker: receiverMarkerIndex !== null,
    receiver_wait_boundary_before_marker:
      completedClaudeToolBoundaryBeforeMarker(receiver, "Bash", receiverMarkerIndex),
    timing_barrier_intact: timingBarrierIntact,
  };
}

function spawnCaptured(
  role: "sender" | "receiver",
  command: string[],
  onStdoutLine?: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): CapturedProcess {
  const process = Bun.spawn(command, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdoutCapture = captureBoundedCrossSessionLines(
    process.stdout,
    `${role}_stdout`,
    onStdoutLine,
  );
  const stderrCapture = captureBoundedCrossSessionLines(process.stderr, `${role}_stderr`);
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
    // A detached Claude/tool descendant may outlive the recorded leader while
    // retaining its output pipes. Escalate the still-addressable group before
    // evidence draining can hang.
    try {
      process.kill(-captured.process.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    return;
  }
  try {
    await withTimeout(captured.process.exited, 2_000, "Claude verifier shutdown");
    try {
      process.kill(-captured.process.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
    return;
  } catch {
    // Escalate the isolated process group so timeouts cannot orphan Claude's
    // Cross-session registration or tool subprocesses.
  }
  try {
    process.kill(-captured.process.pid, "SIGKILL");
  } catch {
    captured.process.kill(9);
  }
  await captured.process.exited.catch(() => undefined);
}

function stopCaptured(captured: CapturedProcess): Promise<void> {
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

function sessionArgs(name: string): string[] {
  return [
    "-p",
    "--name", name,
    "--settings", JSON.stringify({ crossSessionInbound: "accept" }),
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
  ];
}

function usage(): void {
  console.log(`usage: bun scripts/verify-claude-cross-session.ts [--keep-artifacts] [--preflight-only]

Runs two real non-interactive Claude Code sessions and requires evidence for:
receiver socket initialization, sender ListAgents, sender SendMessage carrying a
random marker, its unique non-error result, and that marker appearing after the
receiver's completed Bash wait. The two unique system/init session IDs must differ. Every sender
tool use and result must follow its unique system/init with the same session_id;
exact-one tool-use counts cover the full stream. Each step must be a direct,
top-level singleton stream block with no intervening tool.
Both process exits share one 60-second deadline. A non-zero exit immediately
stops the other isolated process group.
Receiver initialization has one 15-second deadline and fails immediately if
the receiver exits before it becomes ready.

Use --preflight-only to emit machine-readable local version, authentication,
provider, and feature-flag diagnostics without starting model sessions.
Invalid or duplicate preflight arguments still emit the same JSON schema with
invalid_request/error_code=invalid_arguments and exit 9 before any Claude probe.
Unexpected preflight failures emit internal_error and exit 1 without raw details.
The full acceptance command also emits JSON for every non-help outcome. It
classifies request, preflight, receiver_startup, execution, evidence, and
internal failures without echoing raw diagnostics; partial diagnostics stay in
the reported artifact directory. Only complete live evidence sets
delivery_verified=true.

Requires Claude Code >= 2.1.224 and an active Claude authentication session.
This makes real model calls. Artifacts are deleted unless --keep-artifacts is set.`);
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }
  const { keepArtifacts, preflightOnly } = parseNativeClaudeArguments(argv);
  const preflight = await probeNativeClaudePreflight();
  if (preflightOnly) {
    console.log(JSON.stringify(preflight.report, null, 2));
    return preflight.exitCode;
  }
  if (preflight.report.status !== "ready") {
    const failure = buildNativeClaudeAcceptanceFailure({
      phase: "preflight",
      code: preflight.report.status,
      exitCode: preflight.exitCode,
      modelCallsStarted: false,
      claudeVersion: preflight.report.claude_version,
      preflight: preflight.report,
    });
    console.log(JSON.stringify(failure.report, null, 2));
    return failure.exitCode;
  }
  const version = parseClaudeVersion(preflight.report.claude_version ?? "");
  if (version === null) throw new Error("Claude Code version could not be determined after preflight");

  const privateRoot = mkdtempSync(join(tmpdir(), "agentparty-claude-cross-session-private-"));
  const artifacts = mkdtempSync(join(tmpdir(), "agentparty-claude-cross-session-evidence-"));
  chmodSync(privateRoot, 0o700);
  const runId = `${Date.now()}-${process.pid}`;
  const receiverName = `ap-cross-receiver-${runId}`;
  const senderName = `ap-cross-sender-${runId}`;
  const marker = `AGENTPARTY_CROSS_SESSION_${randomUUID()}`;
  const receiverReleaseFile = join(privateRoot, "release-receiver-wait");
  let timingBarrierIntact = false;
  let receiver: CapturedProcess | null = null;
  let sender: CapturedProcess | null = null;
  let preserveArtifacts = keepArtifacts;
  let failurePhase: Extract<NativeClaudeAcceptanceFailurePhase, "receiver_startup" | "execution"> =
    "receiver_startup";
  try {
    let markInitialized!: () => void;
    const initialized = new Promise<void>((resolve) => {
      markInitialized = resolve;
    });
    receiver = spawnCaptured("receiver", [
      "claude",
      ...sessionArgs(receiverName),
      "--allowedTools=Bash",
      `Use Bash exactly once to run while [ ! -f "$${NATIVE_RELEASE_FILE_ENV}" ]; do sleep 0.1; done. ` +
        `Stay available for Cross-session messages while it runs. After Bash completes, output exactly RECEIVER_DONE.`,
    ], (line) => {
      if (initializedReceiver(parseJsonLines([line]))) markInitialized();
    }, {
      ...process.env,
      [NATIVE_RELEASE_FILE_ENV]: receiverReleaseFile,
    });

    await waitForCrossSessionReadiness(
      Promise.race([initialized, receiver.captureFailure]),
      receiver.process.exited,
      15_000,
      "receiver initialization",
    );
    failurePhase = "execution";
    const releaseReceiverAfterSend = createClaudeSendMessageResultBarrier(marker, () => {
      try {
        writeCrossSessionReleaseFile(receiverReleaseFile);
        timingBarrierIntact = true;
      } catch {
        timingBarrierIntact = false;
      }
    });
    sender = spawnCaptured("sender", [
      "claude",
      ...sessionArgs(senderName),
      "--allowedTools=ListAgents,SendMessage",
      `Use ListAgents exactly once. Find the session named ${receiverName}. Use SendMessage exactly once to send it the exact text ${marker}. Then output exactly SENDER_DONE. Do not merely describe these actions.`,
    ], releaseReceiverAfterSend);
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

    await Promise.all([
      Bun.write(join(artifacts, "sender.jsonl"), `${sender.stdout.join("\n")}\n`),
      Bun.write(join(artifacts, "sender.stderr.txt"), `${sender.stderr.join("\n")}\n`),
      Bun.write(join(artifacts, "receiver.jsonl"), `${receiver.stdout.join("\n")}\n`),
      Bun.write(join(artifacts, "receiver.stderr.txt"), `${receiver.stderr.join("\n")}\n`),
    ]);

    const evidence = inspectCrossSessionEvidence(
      sender.stdout,
      receiver.stdout,
      marker,
      receiverName,
      timingBarrierIntact,
    );
    const passed = senderCode === 0 && receiverCode === 0 && Object.values(evidence).every(Boolean);
    preserveArtifacts = preserveArtifacts || !passed;
    console.log(JSON.stringify({
      schema: NATIVE_ACCEPTANCE_SCHEMA,
      status: passed ? "passed" : "failed",
      claude_version: version.join("."),
      sender_exit: senderCode,
      receiver_exit: receiverCode,
      evidence,
      model_calls_started: true,
      delivery_verified: passed,
      ...(!passed ? { failure_phase: "evidence", error_code: "evidence_incomplete" } : {}),
      ...(keepArtifacts || !passed ? { artifacts } : {}),
    }, null, 2));
    if (!passed) return 1;
    return 0;
  } catch (error) {
    preserveArtifacts = true;
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
          Bun.write(join(artifacts, "receiver.partial.jsonl"), `${receiver.stdout.join("\n")}\n`),
          Bun.write(join(artifacts, "receiver.partial.stderr.txt"), `${receiver.stderr.join("\n")}\n`),
        ]),
        ...(sender === null ? [] : [
          Bun.write(join(artifacts, "sender.partial.jsonl"), `${sender.stdout.join("\n")}\n`),
          Bun.write(join(artifacts, "sender.partial.stderr.txt"), `${sender.stderr.join("\n")}\n`),
        ]),
      ]).catch(() => undefined);
    }
    const sessionOutputLimit = crossSessionOutputLimitReport(error);
    const failure = buildNativeClaudeAcceptanceFailure({
      phase: failurePhase,
      code: sessionOutputLimit !== undefined
        ? "session_output_limit_exceeded"
        : failurePhase === "receiver_startup"
          ? "receiver_startup_failed"
          : "session_execution_failed",
      exitCode: 1,
      modelCallsStarted: receiver !== null,
      claudeVersion: version.join("."),
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

if (import.meta.main) {
  const argv = process.argv.slice(2);
  main(argv).then(
    (code) => process.exit(code),
    (error) => {
      if (argv.some((arg) => arg === "--preflight-only" || arg.startsWith("--preflight-only="))) {
        const failure = nativeClaudePreflightFailureResult(error);
        console.log(JSON.stringify(failure.report, null, 2));
        process.exit(failure.exitCode);
      }
      const failure = unexpectedNativeClaudeAcceptanceFailure(error);
      console.log(JSON.stringify(failure.report, null, 2));
      process.exit(failure.exitCode);
    },
  );
}
