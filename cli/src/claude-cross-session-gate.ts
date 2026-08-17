import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";

export const CLAUDE_CROSS_SESSION_GATE_DIR_ENV = "AGENTPARTY_CLAUDE_CROSS_SESSION_GATE_DIR";
export const CLAUDE_CROSS_SESSION_GATE_STATE_TTL_MS = 5 * 60_000;
export const CLAUDE_CROSS_SESSION_GATE_PERMIT_TTL_MS = 30_000;
export const AGENTPARTY_CLAUDE_MCP_SERVER_NAME = "agentparty-channel";
export const AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX = `mcp__${AGENTPARTY_CLAUDE_MCP_SERVER_NAME}__`;
const STATE_FILE = "state.json";
const ARM_FILE = "armed.json";
const CONSUME_LOCK_FILE = "consume.lock";
const CONSUME_LOCK_WAIT_MS = 250;
const MAX_CANDIDATES = 64;
const MAX_TOOL_RESULT_DEPTH = 64;
const MAX_TOOL_RESULT_NODES = 4_096;
const MAX_EMBEDDED_JSON_BYTES = 256 * 1024;
const GENERATED_ADDRESS_RE = /^apcs-[A-Za-z0-9][A-Za-z0-9_-]{0,45}-[a-f0-9]{12}$/;
// Recognize a complete bridge-generated address token even when a caller adds
// malformed decoration before or after it. Those targets must fail closed
// instead of falling through to Claude's ordinary team-recipient path. A name
// character touching either edge means this is a different ordinary name, not
// the generated token (for example `apcs-...-a1b2c3d4e5f6-extra`).
const GENERATED_ADDRESS_TOKEN_RE =
  /(?:^|[^A-Za-z0-9_-])apcs-[A-Za-z0-9][A-Za-z0-9_-]{0,45}-[a-f0-9]{12}(?:$|[^A-Za-z0-9_-])/;
// Claude's current ListAgents model output distinguishes local peers from
// Remote Control and cloud sessions with these row-local labels. AgentParty
// correlation is deliberately same-machine only, so a generated name in one
// of those rows must never become a send permit. `isolatePeerMachines: true`
// remains the native enforcement fallback if upstream formatting changes.
const REMOTE_CLAUDE_AGENT_ROW_RE =
  /(?:\bon another machine\s*\(Remote Control\)|\bRemote Control\b|\bin the cloud\b|Claude Code on the web)/i;
const REMOTE_CLAUDE_AGENT_KIND_VALUES = new Set([
  "remote",
  "cloud",
  "bridge-session",
  "cloud-session",
]);
const CANDIDATE_REF_RE = /^candidate_[A-Za-z0-9_-]{16,64}$/;
const PEERS_TOOL = "party_channel_peers";
const PEER_CHECK_TOOL = "party_channel_peer_check";
const CLAUDE_LIST_AGENTS_TOOL = "ListAgents";
const CLAUDE_SEND_MESSAGE_TOOL = "SendMessage";

interface GateCandidate {
  agent: string;
  display_name: string;
  candidate_ref: string;
}

interface GateListing extends GateCandidate {
  send_to: string;
}

interface GatePermit extends GateListing {
  expires_at: number;
}

type GatePendingToolKind = "peers" | "list_agents" | "peer_check" | "send_message";

interface GatePendingTool {
  kind: GatePendingToolKind;
  tool_use_id: string;
}

interface GateState {
  version: 1;
  updated_at: number;
  candidates: GateCandidate[];
  listings: GateListing[];
  permit: GatePermit | null;
  pending_tool: GatePendingTool | null;
  send_barrier_expires_at: number | null;
}

interface HookToolCall {
  tool_name: string;
  tool_use_id: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

export interface ClaudeHookInput {
  session_id?: unknown;
  agent_id?: unknown;
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_calls?: unknown;
}

export interface ClaudeCrossSessionGateArm {
  version: 1;
  session_id: string;
  armed_at: number;
}

export interface ClaudeHookDecision {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAgentPartyClaudeSessionAddress(value: string): boolean {
  return GENERATED_ADDRESS_RE.test(value);
}

function gateDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env[CLAUDE_CROSS_SESSION_GATE_DIR_ENV];
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) return null;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    return path;
  } catch {
    return null;
  }
}

function emptyState(now: number): GateState {
  return {
    version: 1,
    updated_at: now,
    candidates: [],
    listings: [],
    permit: null,
    pending_tool: null,
    send_barrier_expires_at: null,
  };
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function writePrivateJson(directory: string, filename: string, value: unknown): void {
  const path = join(directory, filename);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readArm(directory: string): ClaudeCrossSessionGateArm | null {
  try {
    const path = join(directory, ARM_FILE);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !record(value) ||
      value.version !== 1 ||
      !validSessionId(value.session_id) ||
      typeof value.armed_at !== "number" ||
      !Number.isFinite(value.armed_at)
    ) return null;
    return value as unknown as ClaudeCrossSessionGateArm;
  } catch {
    return null;
  }
}

function matchingArmedSession(directory: string | null, sessionId: unknown): boolean {
  if (directory === null || !validSessionId(sessionId)) return false;
  return readArm(directory)?.session_id === sessionId;
}

function hasAgentId(input: ClaudeHookInput): boolean {
  return input.agent_id !== undefined && input.agent_id !== null;
}

export function isClaudeCrossSessionGateArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const directory = gateDirectory(env);
  // Claude documents that a stdio MCP subprocess may retain its startup ID
  // across /clear or an implicit resume while hooks receive the current ID.
  // The private per-launch directory binds this MCP process to the bridge;
  // the current ID is enforced separately on every hook event.
  return directory !== null && readArm(directory) !== null;
}

export function readClaudeCrossSessionGateArm(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCrossSessionGateArm | null {
  const directory = gateDirectory(env);
  return directory === null ? null : readArm(directory);
}

function armGate(input: ClaudeHookInput, directory: string | null, now: number): ClaudeHookDecision {
  if (directory === null || !validSessionId(input.session_id) || hasAgentId(input)) {
    return noDecision();
  }
  const lockPath = join(directory, CONSUME_LOCK_FILE);
  const lockFd = waitForConsumeLock(lockPath);
  if (lockFd === null) {
    throw new Error("AgentParty Cross-session state is busy during SessionStart.");
  }
  try {
    // Publish the empty state before changing the arm pointer. A lock-free
    // reader may temporarily see the previous session with an empty chain,
    // but can never see the new session with the previous session's permit.
    writeState(directory, emptyState(now));
    writePrivateJson(directory, ARM_FILE, {
      version: 1,
      session_id: input.session_id,
      armed_at: now,
    } satisfies ClaudeCrossSessionGateArm);
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
  // SessionStart stdout is model context. Keep the hook silent: the parent
  // bridge reads the private arm file after Claude exits and emits evidence on
  // its own stderr, outside Claude's conversation stream.
  return noDecision();
}

function validCandidate(value: unknown): value is GateCandidate {
  return record(value) &&
    typeof value.agent === "string" &&
    typeof value.display_name === "string" &&
    typeof value.candidate_ref === "string" &&
    GENERATED_ADDRESS_RE.test(value.display_name) &&
    CANDIDATE_REF_RE.test(value.candidate_ref);
}

function validListing(value: unknown): value is GateListing {
  if (!validCandidate(value) || !record(value)) return false;
  return typeof value.send_to === "string" && (
    value.send_to === value.display_name ||
    new RegExp(`^${escapeRegExp(value.display_name)} \\[[^\\]\\r\\n]{1,64}\\]$`).test(value.send_to)
  );
}

function validPermit(value: unknown): value is GatePermit {
  return validListing(value) && record(value) &&
    typeof value.expires_at === "number" && Number.isFinite(value.expires_at);
}

function validToolUseId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\s\x00-\x1f\x7f]/u.test(value);
}

function validPendingTool(value: unknown): value is GatePendingTool {
  return record(value) &&
    (
      value.kind === "peers" ||
      value.kind === "list_agents" ||
      value.kind === "peer_check" ||
      value.kind === "send_message"
    ) &&
    validToolUseId(value.tool_use_id);
}

function readState(directory: string, now: number): GateState {
  try {
    const path = join(directory, STATE_FILE);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 64 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return emptyState(now);
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.updated_at !== "number" ||
      !Number.isFinite(value.updated_at) ||
      now - value.updated_at > CLAUDE_CROSS_SESSION_GATE_STATE_TTL_MS ||
      value.updated_at > now + 5_000 ||
      !Array.isArray(value.candidates) ||
      value.candidates.length > MAX_CANDIDATES ||
      !value.candidates.every(validCandidate) ||
      !Array.isArray(value.listings) ||
      value.listings.length > MAX_CANDIDATES ||
      !value.listings.every(validListing) ||
      !(value.permit === null || validPermit(value.permit)) ||
      !(value.pending_tool === null || validPendingTool(value.pending_tool)) ||
      !(
        value.send_barrier_expires_at === null ||
        (typeof value.send_barrier_expires_at === "number" &&
          Number.isFinite(value.send_barrier_expires_at))
      )
    ) return emptyState(now);
    const permit = value.permit !== null && value.permit.expires_at >= now
      ? value.permit as unknown as GatePermit
      : null;
    return {
      version: 1,
      updated_at: value.updated_at,
      candidates: value.candidates,
      listings: value.listings,
      permit,
      pending_tool: value.pending_tool,
      send_barrier_expires_at:
        typeof value.send_barrier_expires_at === "number" && value.send_barrier_expires_at >= now
          ? value.send_barrier_expires_at
          : null,
    };
  } catch {
    return emptyState(now);
  }
}

function writeState(directory: string, state: GateState): void {
  writePrivateJson(directory, STATE_FILE, state);
}

function strings(value: unknown): string[] | null {
  const results: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_TOOL_RESULT_NODES || current.depth > MAX_TOOL_RESULT_DEPTH) return null;
    if (typeof current.value === "string") {
      results.push(current.value);
      continue;
    }
    const children = Array.isArray(current.value)
      ? current.value
      : record(current.value)
        ? Object.values(current.value)
        : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
  return results;
}

function jsonObjects(value: unknown): Record<string, unknown>[] | null {
  const objects: Record<string, unknown>[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let embeddedJsonBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_TOOL_RESULT_NODES || current.depth > MAX_TOOL_RESULT_DEPTH) return null;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (record(current.value)) {
      objects.push(current.value);
      const children = Object.values(current.value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ value: children[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (typeof current.value !== "string") continue;
    embeddedJsonBytes += Buffer.byteLength(current.value, "utf8");
    if (embeddedJsonBytes > MAX_EMBEDDED_JSON_BYTES) return null;
    try {
      stack.push({ value: JSON.parse(current.value), depth: current.depth + 1 });
    } catch {
      // Ordinary tool output is not JSON.
    }
  }
  return objects;
}

function toolBaseName(name: string): string {
  const marker = name.lastIndexOf("__");
  return marker === -1 ? name : name.slice(marker + 2);
}

function candidatesFromPeersResult(value: unknown): GateCandidate[] {
  const byRef = new Map<string, GateCandidate | null>();
  const objects = jsonObjects(value);
  if (objects === null) return [];
  for (const item of objects) {
    if (item.version !== 2 || item.availability !== "ready" || !Array.isArray(item.peers)) continue;
    for (const peer of item.peers) {
      if (!record(peer) || typeof peer.agent !== "string" || !Array.isArray(peer.claude_sessions)) continue;
      for (const session of peer.claude_sessions) {
        const candidate = {
          agent: peer.agent,
          display_name: record(session) ? session.display_name : undefined,
          candidate_ref: record(session) ? session.candidate_ref : undefined,
        };
        if (!validCandidate(candidate)) continue;
        const previous = byRef.get(candidate.candidate_ref);
        if (previous === undefined) {
          byRef.set(candidate.candidate_ref, candidate);
        } else if (
          previous !== null &&
          (previous.agent !== candidate.agent || previous.display_name !== candidate.display_name)
        ) {
          // A candidate ref is the identity of one live runtime hint. If one
          // response binds it to conflicting rows, discard that ref instead of
          // allowing traversal order to choose an identity.
          byRef.set(candidate.candidate_ref, null);
        }
      }
    }
  }
  return [...byRef.values()].filter((candidate): candidate is GateCandidate => candidate !== null)
    .slice(0, MAX_CANDIDATES);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasStructuredRemoteClaudeAgent(value: unknown, addressPattern: RegExp): boolean | null {
  const objects = jsonObjects(value);
  if (objects === null) return null;
  for (const item of objects) {
    const directStrings = Object.values(item).filter((field): field is string => typeof field === "string");
    if (!directStrings.some((field) => addressPattern.test(field))) continue;
    if (directStrings.some((field) =>
      REMOTE_CLAUDE_AGENT_KIND_VALUES.has(field) || REMOTE_CLAUDE_AGENT_ROW_RE.test(field)
    )) return true;
  }
  return false;
}

export function uniqueClaudeListAgentsAddress(value: unknown, displayName: string): string | null {
  const source =
    `(?<![A-Za-z0-9_-])${escapeRegExp(displayName)}(?: \\[[^\\]\\r\\n]{1,64}\\]|(?! \\[))(?![A-Za-z0-9_-])`;
  if (hasStructuredRemoteClaudeAgent(value, new RegExp(source)) !== false) return null;
  const pattern = new RegExp(source, "g");
  const matches: string[] = [];
  const textValues = strings(value);
  if (textValues === null) return null;
  for (const text of textValues) {
    for (const row of text.split(/\r?\n/)) {
      const rowMatches = [...row.matchAll(pattern)];
      if (rowMatches.length > 0 && REMOTE_CLAUDE_AGENT_ROW_RE.test(row)) return null;
      for (const match of rowMatches) matches.push(match[0]);
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

function listingsFromListAgents(value: unknown, candidates: GateCandidate[]): GateListing[] {
  const byName = new Map<string, string | null>();
  for (const candidate of candidates) {
    if (!byName.has(candidate.display_name)) {
      byName.set(candidate.display_name, uniqueClaudeListAgentsAddress(value, candidate.display_name));
    }
  }
  return candidates.flatMap((candidate) => {
    const sendTo = byName.get(candidate.display_name);
    return sendTo === null || sendTo === undefined ? [] : [{ ...candidate, send_to: sendTo }];
  });
}

function permitFromPeerCheck(value: unknown, now: number): GatePermit | null {
  const permits = new Map<string, GatePermit>();
  const objects = jsonObjects(value);
  if (objects === null) return null;
  for (const item of objects) {
    const candidate = {
      agent: item.agent,
      display_name: item.display_name,
      candidate_ref: item.candidate_ref,
      send_to: item.send_to,
      expires_at: now + CLAUDE_CROSS_SESSION_GATE_PERMIT_TTL_MS,
    };
    if (
      item.version === 1 &&
      item.availability === "confirmed" &&
      item.topology_evidence === "client_asserted" &&
      item.comparison === "server_rechecked_live_topology" &&
      validListing(candidate)
    ) {
      const key = JSON.stringify([
        candidate.agent,
        candidate.display_name,
        candidate.candidate_ref,
        candidate.send_to,
      ]);
      permits.set(key, candidate);
    }
  }
  return permits.size === 1 ? permits.values().next().value ?? null : null;
}

function deny(reason: string): ClaudeHookDecision {
  return {
    // Claude documents exit 2 as the only command-hook exit code that blocks
    // PreToolUse on its own. Keep the structured deny output as well, but do
    // not rely on JSON parsing for the fail-closed path.
    exitCode: 2,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }) + "\n",
    stderr: "",
  };
}

function noDecision(): ClaudeHookDecision {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function waitForConsumeLock(lockPath: string): number | null {
  const deadline = Date.now() + CONSUME_LOCK_WAIT_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    try {
      return openSync(lockPath, "wx", 0o600);
    } catch {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      Atomics.wait(sleeper, 0, 0, Math.min(5, remaining));
    }
  }
}

function sendTarget(input: unknown): string | null {
  if (!record(input)) return null;
  const to = typeof input.to === "string" ? input.to : undefined;
  const recipient = typeof input.recipient === "string" ? input.recipient : undefined;
  if (to !== undefined && recipient !== undefined && to !== recipient) return null;
  return to ?? recipient ?? null;
}

function containsAgentPartyRecipient(input: unknown): boolean {
  if (!record(input)) return false;
  return [input.to, input.recipient].some((value) =>
    typeof value === "string" &&
    containsAgentPartyClaudeSessionAddressToken(value)
  );
}

function containsAgentPartyClaudeSessionAddressToken(target: string): boolean {
  return GENERATED_ADDRESS_TOKEN_RE.test(target);
}

function isAgentPartyMcpTool(name: string, tool: string): boolean {
  return name === `${AGENTPARTY_CLAUDE_MCP_TOOL_PREFIX}${tool}`;
}

function pendingToolKind(name: string): GatePendingToolKind | null {
  if (isAgentPartyMcpTool(name, PEERS_TOOL)) return "peers";
  if (name === CLAUDE_LIST_AGENTS_TOOL) return "list_agents";
  if (isAgentPartyMcpTool(name, PEER_CHECK_TOOL)) return "peer_check";
  if (name === CLAUDE_SEND_MESSAGE_TOOL) return "send_message";
  return null;
}

function pendingTool(kind: GatePendingToolKind, toolUseId: unknown): GatePendingTool | null {
  return validToolUseId(toolUseId) ? { kind, tool_use_id: toolUseId } : null;
}

function preToolUse(input: ClaudeHookInput, directory: string | null, now: number): ClaudeHookDecision {
  if (typeof input.tool_name !== "string") return deny("AgentParty Cross-session gate received an invalid tool name.");
  const name = toolBaseName(input.tool_name);
  if (hasAgentId(input)) {
    if (name !== CLAUDE_SEND_MESSAGE_TOOL) return noDecision();
    if (containsAgentPartyRecipient(input.tool_input)) {
      return deny("Only the bridged top-level Claude session may use an AgentParty Cross-session address.");
    }
    return noDecision();
  }
  const armedSessionMatches = matchingArmedSession(directory, input.session_id);
  if (input.tool_name !== CLAUDE_SEND_MESSAGE_TOOL) {
    const denyLookalike = name === CLAUDE_SEND_MESSAGE_TOOL &&
      containsAgentPartyRecipient(input.tool_input);
    if (directory === null || !armedSessionMatches) {
      return denyLookalike
        ? deny("Only Claude's exact built-in SendMessage tool may use an AgentParty Cross-session address.")
        : noDecision();
    }
    const lockPath = join(directory, CONSUME_LOCK_FILE);
    const lockFd = waitForConsumeLock(lockPath);
    if (lockFd === null) {
      return deny("AgentParty Cross-session state is busy. Retry this tool in the next model turn.");
    }
    try {
      if (!matchingArmedSession(directory, input.session_id)) {
        return denyLookalike
          ? deny("Only Claude's exact built-in SendMessage tool may use an AgentParty Cross-session address.")
          : noDecision();
      }
      const state = readState(directory, now);
      if (state.send_barrier_expires_at !== null) {
        return deny(
          "An AgentParty SendMessage is the only allowed call in this tool batch. " +
          "Retry other work in the next model turn.",
        );
      }
      const kind = pendingToolKind(input.tool_name);
      const advancesChain = kind === "peers" ||
        (kind === "list_agents" && state.candidates.length > 0) ||
        (kind === "peer_check" && state.listings.length > 0);
      if (advancesChain && !validToolUseId(input.tool_use_id)) {
        writeState(directory, emptyState(now));
        return deny(
          "AgentParty Cross-session cannot correlate this tool result without Claude's tool_use_id. " +
          "Restart from party_channel_peers or use the Channel.",
        );
      }
      const next = kind === "list_agents"
        ? { ...emptyState(now), candidates: state.candidates }
        : kind === "peer_check"
          ? { ...emptyState(now), candidates: state.candidates, listings: state.listings }
          : emptyState(now);
      next.pending_tool = advancesChain && kind !== null
        ? pendingTool(kind, input.tool_use_id)
        : null;
      writeState(directory, next);
    } finally {
      closeSync(lockFd);
      rmSync(lockPath, { force: true });
    }
    return denyLookalike
      ? deny("Only Claude's exact built-in SendMessage tool may use an AgentParty Cross-session address.")
      : noDecision();
  }
  const target = sendTarget(input.tool_input);
  if (target === null) return deny("SendMessage must contain one unambiguous string recipient.");
  // AgentParty bridge addresses always end in the random 12-hex launch suffix.
  // Leave unrelated subagent/team messages under Claude's normal controls.
  const agentPartyTarget = containsAgentPartyClaudeSessionAddressToken(target);
  if (agentPartyTarget && !armedSessionMatches) {
    return deny("The AgentParty Cross-session Hook was not armed for this Claude session. Use the Channel instead.");
  }
  if (
    directory !== null &&
    armedSessionMatches &&
    readState(directory, now).send_barrier_expires_at !== null
  ) {
    return deny(
      "An AgentParty SendMessage is the only allowed call in this tool batch. " +
      "Retry other messages in the next model turn.",
    );
  }
  if (!agentPartyTarget) {
    if (directory !== null && armedSessionMatches) {
      // Ordinary Claude recipients need no AgentParty permit, but this exact
      // built-in still participates in the same tool batch. Serialize its
      // chain reset with permit consumption so a stale lock-free snapshot
      // cannot erase a concurrently successful AgentParty send barrier.
      const lockPath = join(directory, CONSUME_LOCK_FILE);
      const lockFd = waitForConsumeLock(lockPath);
      if (lockFd === null) {
        return deny("AgentParty Cross-session state is busy. Retry this message in the next model turn.");
      }
      try {
        if (!matchingArmedSession(directory, input.session_id)) return noDecision();
        const state = readState(directory, now);
        if (state.send_barrier_expires_at !== null) {
          return deny(
            "An AgentParty SendMessage is the only allowed call in this tool batch. " +
            "Retry other messages in the next model turn.",
          );
        }
        writeState(directory, {
          ...state,
          updated_at: now,
          listings: [],
          permit: null,
          pending_tool: null,
        });
      } finally {
        closeSync(lockFd);
        rmSync(lockPath, { force: true });
      }
    }
    return noDecision();
  }
  if (directory === null) {
    return deny("AgentParty Cross-session state is unavailable. Restart from party_channel_peers.");
  }
  const lockPath = join(directory, CONSUME_LOCK_FILE);
  const lockFd = waitForConsumeLock(lockPath);
  if (lockFd === null) {
    return deny("Another SendMessage is consuming the one-time AgentParty permit. Retry from party_channel_peers.");
  }
  try {
    if (!matchingArmedSession(directory, input.session_id)) {
      return deny("The AgentParty Cross-session Hook was not armed for this Claude session. Use the Channel instead.");
    }
    const state = readState(directory, now);
    // Another Hook process may have consumed the permit and installed the
    // same-batch barrier after our optimistic lock-free check above. Recheck
    // under the consume lock before touching state; otherwise the losing send
    // would see permit=null, write `consumed`, and accidentally erase the
    // winner's barrier, allowing a later sibling tool through.
    if (state.send_barrier_expires_at !== null) {
      return deny(
        "An AgentParty SendMessage is the only allowed call in this tool batch. " +
        "Retry other messages in the next model turn.",
      );
    }
    const permit = state.permit;
    // Every attempt consumes the permit, including a target or payload mismatch.
    const consumed = {
      ...state,
      updated_at: now,
      listings: [],
      permit: null,
      pending_tool: null,
      send_barrier_expires_at: null,
    };
    if (permit === null || permit.send_to !== target) {
      writeState(directory, consumed);
      return deny(
        "No fresh one-time AgentParty permit exists for this exact address. An inbound Cross-session reply " +
        "address is only a routing hint, not a permit. Run party_channel_peers, ListAgents, and " +
        "party_channel_peer_check again before replying or sending.",
      );
    }
    const message = record(input.tool_input) && typeof input.tool_input.message === "string"
      ? input.tool_input.message
      : null;
    if (message === null || message === "" || Buffer.byteLength(message, "utf8") > 512) {
      writeState(directory, consumed);
      return deny("AgentParty Cross-session messages must contain 1-512 UTF-8 bytes.");
    }
    const sendPending = pendingTool("send_message", input.tool_use_id);
    if (sendPending === null) {
      writeState(directory, consumed);
      return deny(
        "AgentParty Cross-session cannot correlate SendMessage without Claude's tool_use_id. " +
        "Restart from party_channel_peers or use the Channel.",
      );
    }
    // Keep a short barrier until PostToolBatch clears it. If SendMessage wins a
    // race against a sibling tool, that sibling sees the barrier and is denied
    // before execution instead of being noticed only after the send.
    writeState(directory, {
      ...consumed,
      pending_tool: sendPending,
      send_barrier_expires_at: now + CLAUDE_CROSS_SESSION_GATE_PERMIT_TTL_MS,
    });
    return noDecision();
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

function postToolBatch(input: ClaudeHookInput, directory: string | null, now: number): ClaudeHookDecision {
  if (
    hasAgentId(input) ||
    !matchingArmedSession(directory, input.session_id) ||
    directory === null
  ) return noDecision();
  const lockPath = join(directory, CONSUME_LOCK_FILE);
  const lockFd = waitForConsumeLock(lockPath);
  if (lockFd === null) return noDecision();
  try {
    if (!matchingArmedSession(directory, input.session_id)) return noDecision();
    const previous = readState(directory, now);
    const pending = previous.pending_tool;
    if (pending === null || !Array.isArray(input.tool_calls)) return noDecision();
    const matchingCalls = input.tool_calls.filter((call): call is Record<string, unknown> =>
      record(call) &&
      typeof call.tool_name === "string" &&
      call.tool_name !== "" &&
      call.tool_use_id === pending.tool_use_id &&
      pendingToolKind(call.tool_name) === pending.kind
    );
    // A PostToolBatch from an older invocation must not consume the pending
    // result slot, clear a newer send barrier, or mint a fresh permit from a
    // stale peer check. Claude's documented tool_use_id is the correlation
    // boundary between PreToolUse and the corresponding batch result.
    if (matchingCalls.length === 0) return noDecision();
    let next = emptyState(now);
    // A malformed sibling still makes this a non-singleton batch. Once the
    // current pending call is present, clear the chain but never advance it
    // unless that call is the one and only batch member.
    if (input.tool_calls.length === 1 && matchingCalls.length === 1) {
      const rawCall = matchingCalls[0]!;
      const call: HookToolCall = {
        tool_name: rawCall.tool_name as string,
        tool_use_id: rawCall.tool_use_id as string,
        tool_input: rawCall.tool_input,
        tool_response: rawCall.tool_response,
      };
      if (pending.kind === "peers") {
        next.candidates = candidatesFromPeersResult(call.tool_response);
      } else if (pending.kind === "list_agents" && previous.candidates.length > 0) {
        next.candidates = previous.candidates;
        next.listings = listingsFromListAgents(call.tool_response, previous.candidates);
      } else if (pending.kind === "peer_check" && previous.listings.length > 0) {
        const permit = permitFromPeerCheck(call.tool_response, now);
        if (permit !== null && previous.listings.some((item) =>
          item.agent === permit.agent &&
          item.display_name === permit.display_name &&
          item.candidate_ref === permit.candidate_ref &&
          item.send_to === permit.send_to
        )) {
          next.candidates = previous.candidates;
          next.listings = previous.listings;
          next.permit = permit;
        }
      }
    }
    writeState(directory, next);
    return noDecision();
  } finally {
    closeSync(lockFd);
    rmSync(lockPath, { force: true });
  }
}

export function listedClaudeCrossSessionAddress(
  agent: string,
  displayName: string,
  candidateRef: string,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): string | null {
  const directory = gateDirectory(env);
  if (directory === null || !isClaudeCrossSessionGateArmed(env)) return null;
  const state = readState(directory, now);
  const matches = state.listings.filter((item) =>
    item.agent === agent &&
    item.display_name === displayName &&
    item.candidate_ref === candidateRef
  );
  return matches.length === 1 ? matches[0]!.send_to : null;
}

export function runClaudeCrossSessionHook(
  input: ClaudeHookInput,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): ClaudeHookDecision {
  const directory = gateDirectory(env);
  if (input.hook_event_name === "SessionStart") return armGate(input, directory, now);
  if (input.hook_event_name === "PreToolUse") return preToolUse(input, directory, now);
  if (input.hook_event_name === "PostToolBatch") return postToolBatch(input, directory, now);
  return noDecision();
}
