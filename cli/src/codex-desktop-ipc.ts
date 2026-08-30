/**
 * ChatGPT Desktop's native multi-window/thread follower IPC.
 *
 * The App owns a private 0600 Unix socket under $CODEX_HOME/ipc/ipc.sock.
 * Clients use length-prefixed JSON frames, discover the renderer that owns a
 * thread, then invoke the same `thread-follower-start-turn` path ChatGPT uses
 * across its own windows. A codex_app toolOutput preserves the native
 * cross-task label and source link without touching the private app-tools pipe.
 */
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection, type Socket } from "node:net";
import {
  isClaudeSessionRegistrySessionId,
  listCodexSessions,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";

const MAX_IPC_FRAME_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const INITIALIZING_CLIENT_ID = "initializing-client";

export interface CodexDesktopIpcRoute {
  targetThreadId: string;
  sourceThreadId: string;
}

export interface CodexDesktopTurn {
  turnId: string;
  status: string;
  items: Array<Record<string, unknown>>;
  params: Record<string, unknown>;
}

export class CodexDesktopIpcUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDesktopIpcUnavailableError";
  }
}

export class CodexDesktopIpcRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDesktopIpcRequestError";
  }
}

export class CodexDesktopIpcUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexDesktopIpcUnknownOutcomeError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function codexDesktopIpcSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "ipc", "ipc.sock");
}

export function validateCodexDesktopIpcSocket(path: string): void {
  let socket;
  let directory;
  try {
    socket = lstatSync(path);
    directory = lstatSync(dirname(path));
  } catch {
    throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC socket is missing: ${path}`);
  }
  const uid = process.getuid?.();
  if (!socket.isSocket() || !directory.isDirectory()) {
    throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC path is not a private socket`);
  }
  if (uid !== undefined && (socket.uid !== uid || directory.uid !== uid)) {
    throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC is owned by another uid`);
  }
  if ((socket.mode & 0o077) !== 0 || (directory.mode & 0o077) !== 0) {
    throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC is not private`);
  }
}

export function codexDesktopIpcAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    validateCodexDesktopIpcSocket(codexDesktopIpcSocketPath(env));
    return true;
  } catch {
    return false;
  }
}

export function selectCodexDesktopIpcRoute(
  targetThreadId: string,
  appServerPid: number,
  sessions: readonly ClaudeSessionRegistryEntry[],
): CodexDesktopIpcRoute | null {
  const wanted = targetThreadId.toLowerCase();
  const target = sessions.find(
    (entry) => entry.pid === appServerPid && entry.session_id.toLowerCase() === wanted,
  );
  if (target === undefined || target.server === undefined || target.identity === undefined) return null;
  const source = [...sessions].reverse().find((entry) =>
    entry.pid === appServerPid &&
    entry.session_id.toLowerCase() !== wanted &&
    entry.channel === target.channel &&
    entry.server === target.server &&
    entry.identity === target.identity
  );
  return source === undefined
    ? null
    : { targetThreadId: target.session_id, sourceThreadId: source.session_id };
}

export function validateCodexDesktopIpcRoute(
  route: CodexDesktopIpcRoute,
  env: NodeJS.ProcessEnv = process.env,
  sessions: typeof listCodexSessions = listCodexSessions,
): void {
  if (
    !isClaudeSessionRegistrySessionId(route.targetThreadId) ||
    !isClaudeSessionRegistrySessionId(route.sourceThreadId) ||
    route.targetThreadId.toLowerCase() === route.sourceThreadId.toLowerCase()
  ) {
    throw new CodexDesktopIpcUnavailableError(`ChatGPT IPC requires two distinct valid task ids`);
  }
  const entries = sessions(env);
  const target = entries.find((entry) => entry.session_id.toLowerCase() === route.targetThreadId.toLowerCase());
  const source = entries.find((entry) => entry.session_id.toLowerCase() === route.sourceThreadId.toLowerCase());
  if (
    target === undefined || source === undefined || target.pid !== source.pid ||
    target.channel !== source.channel ||
    target.server === undefined || source.server === undefined || target.server !== source.server ||
    target.identity === undefined || source.identity === undefined || target.identity !== source.identity
  ) {
    throw new CodexDesktopIpcUnavailableError(
      `ChatGPT IPC source and target are not registered to the same app-server identity`,
    );
  }
  validateCodexDesktopIpcSocket(codexDesktopIpcSocketPath(env));
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function codexDelegationEnvelope(sourceThreadId: string, prompt: string): string {
  return [
    "<codex_delegation>",
    `  <source_thread_id>${escapeXml(sourceThreadId)}</source_thread_id>`,
    `  <input>${escapeXml(prompt)}</input>`,
    "</codex_delegation>",
  ].join("\n");
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > MAX_IPC_FRAME_BYTES) {
    throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC request is too large`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

interface PendingRequest {
  method: string;
  written: boolean;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConversationState {
  revision: number;
  state: Record<string, unknown>;
}

export interface CodexDesktopIpcClientOptions {
  env?: NodeJS.ProcessEnv;
  clientType?: string;
  requestTimeoutMs?: number;
  startTurnTimeoutMs?: number;
}

export interface CodexDesktopIpcTransport {
  connect(): Promise<void>;
  discoverThreadOwner(threadId: string, hostId?: string): Promise<string>;
  followThread(threadId: string, hostId?: string): Promise<void>;
  startDelegatedTurn(input: {
    targetThreadId: string;
    sourceThreadId: string;
    prompt: string;
    clientUserMessageId: string;
    hostId?: string;
  }): Promise<{ turnId: string; ownerClientId: string }>;
  waitForDelegation(input: {
    targetThreadId: string;
    sourceThreadId: string;
    prompt: string;
    clientUserMessageId: string;
    turnId?: string;
    timeoutMs?: number;
  }): Promise<CodexDesktopTurn>;
  close(): void;
}

export class CodexDesktopIpcClient implements CodexDesktopIpcTransport {
  private socket: Socket | null = null;
  private clientId = INITIALIZING_CLIENT_ID;
  private pending = new Map<string, PendingRequest>();
  private incoming = Buffer.alloc(0);
  private states = new Map<string, ConversationState>();
  private stateListeners = new Set<(threadId: string) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  private closed = false;
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly startTurnTimeoutMs: number;
  private readonly clientType: string;

  constructor(options: CodexDesktopIpcClientOptions = {}) {
    this.socketPath = codexDesktopIpcSocketPath(options.env ?? process.env);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.startTurnTimeoutMs = options.startTurnTimeoutMs ?? 30_000;
    this.clientType = options.clientType ?? "agentparty-native-bridge";
  }

  async connect(): Promise<void> {
    if (this.socket !== null) return;
    validateCodexDesktopIpcSocket(this.socketPath);
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.on("data", (chunk) => this.handleData(Buffer.from(chunk)));
    socket.once("error", (error) => this.handleClose(error));
    socket.once("close", () => this.handleClose(new Error("ChatGPT Desktop IPC closed")));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC connect timed out`)), this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const response = await this.request("initialize", 0, { clientType: this.clientType });
    const id = object(response.result) && typeof response.result.clientId === "string"
      ? response.result.clientId
      : null;
    if (id === null) throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC initialize failed`);
    this.clientId = id;
  }

  async discoverThreadOwner(threadId: string, hostId: string = "local"): Promise<string> {
    const response = await this.request(
      "thread-owner-discovery",
      1,
      { hostId, conversationId: threadId },
    );
    if (typeof response.handledByClientId !== "string" || response.handledByClientId === "") {
      throw new CodexDesktopIpcUnavailableError(`No ChatGPT renderer owns task ${threadId}`);
    }
    return response.handledByClientId;
  }

  async followThread(threadId: string, hostId: string = "local"): Promise<void> {
    const next = this.waitForStateUpdate(threadId, this.timeoutMs);
    this.broadcast("thread-stream-following-changed", 1, {
      conversationId: threadId,
      hostId,
      following: true,
    });
    await next;
  }

  async startDelegatedTurn(input: {
    targetThreadId: string;
    sourceThreadId: string;
    prompt: string;
    clientUserMessageId: string;
    hostId?: string;
  }): Promise<{ turnId: string; ownerClientId: string }> {
    const ownerClientId = await this.discoverThreadOwner(input.targetThreadId, input.hostId ?? "local");
    const response = await this.request(
      "thread-follower-start-turn",
      2,
      {
        conversationId: input.targetThreadId,
        turnStart: {
          request: {
            threadId: input.targetThreadId,
            input: [],
            clientUserMessageId: input.clientUserMessageId,
            toolOutput: {
              name: "send_message_to_thread",
              namespace: "codex_app",
              output: codexDelegationEnvelope(input.sourceThreadId, input.prompt),
            },
          },
          context: { inheritThreadSettings: true, threadStartKind: "user" },
        },
      },
      { targetClientId: ownerClientId, timeoutMs: this.startTurnTimeoutMs },
    );
    const result = object(response.result) && object(response.result.result)
      ? response.result.result
      : null;
    const turn = result !== null && object(result.turn) ? result.turn : null;
    if (turn === null || typeof turn.id !== "string") {
      throw new CodexDesktopIpcUnknownOutcomeError(`ChatGPT IPC returned no accepted turn id`);
    }
    return { turnId: turn.id, ownerClientId };
  }

  async waitForDelegation(input: {
    targetThreadId: string;
    sourceThreadId: string;
    prompt: string;
    clientUserMessageId: string;
    turnId?: string;
    timeoutMs?: number;
  }): Promise<CodexDesktopTurn> {
    const deadline = Date.now() + (input.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const matched = this.findDelegation(input);
      if (matched !== null && matched.status !== "inProgress") return matched;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CodexDesktopIpcUnknownOutcomeError(`Timed out waiting for ChatGPT task ${input.targetThreadId}`);
      await this.waitForStateUpdate(input.targetThreadId, Math.min(remaining, 5_000)).catch(async () => {
        if (this.closed) throw new CodexDesktopIpcUnknownOutcomeError(`ChatGPT IPC closed while waiting for task completion`);
        await this.followThread(input.targetThreadId);
      });
    }
  }

  findDelegation(input: {
    targetThreadId: string;
    sourceThreadId: string;
    prompt: string;
    clientUserMessageId: string;
    turnId?: string;
  }): CodexDesktopTurn | null {
    const state = this.states.get(input.targetThreadId)?.state;
    if (state === undefined) return null;
    const turns = canonicalTurns(state);
    const expectedOutput = codexDelegationEnvelope(input.sourceThreadId, input.prompt);
    const turn = turns.find((candidate) => {
      if (input.turnId !== undefined && candidate.turnId !== input.turnId) return false;
      return candidate.params.clientUserMessageId === input.clientUserMessageId &&
        object(candidate.params.toolOutput) &&
        candidate.params.toolOutput.name === "send_message_to_thread" &&
        candidate.params.toolOutput.namespace === "codex_app" &&
        candidate.params.toolOutput.output === expectedOutput;
    });
    return turn ?? null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    this.handleClose(new Error("ChatGPT Desktop IPC client closed"));
  }

  private request(
    method: string,
    version: number,
    params: Record<string, unknown>,
    options: { targetClientId?: string; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (socket === null || this.closed) {
      return Promise.reject(new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC is not connected`));
    }
    const requestId = randomUUID();
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      ...(options.targetClientId === undefined ? {} : { targetClientId: options.targetClientId }),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(method === "thread-follower-start-turn"
          ? new CodexDesktopIpcUnknownOutcomeError(`ChatGPT IPC start-turn response timed out`)
          : new CodexDesktopIpcUnavailableError(`ChatGPT IPC ${method} timed out`));
      }, options.timeoutMs ?? this.timeoutMs);
      const pending: PendingRequest = { method, written: false, resolve, reject, timer };
      this.pending.set(requestId, pending);
      try {
        socket.write(encodeFrame(message));
        // Once queued to the connected local router, a lost response cannot
        // prove the renderer did not start the turn. Prefer unknown over replay.
        pending.written = true;
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    }).then((response) => {
      if (response.resultType !== "success") {
        throw new CodexDesktopIpcRequestError(
          typeof response.error === "string" ? response.error : `ChatGPT IPC ${method} failed`,
        );
      }
      return response;
    });
  }

  private broadcast(method: string, version: number, params: Record<string, unknown>): void {
    if (this.socket === null || this.closed) throw new CodexDesktopIpcUnavailableError(`ChatGPT Desktop IPC is not connected`);
    this.socket.write(encodeFrame({
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      version,
      params,
    }));
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    this.incoming = Buffer.concat([this.incoming, chunk]);
    for (;;) {
      if (this.incoming.length < 4) return;
      const length = this.incoming.readUInt32LE(0);
      if (length === 0 || length > MAX_IPC_FRAME_BYTES) {
        const error = new Error(`Invalid ChatGPT IPC frame length ${length}`);
        const socket = this.socket;
        this.handleClose(error);
        socket?.destroy();
        this.socket = null;
        return;
      }
      if (this.incoming.length < length + 4) return;
      let message: unknown;
      try {
        message = JSON.parse(this.incoming.subarray(4, length + 4).toString("utf8"));
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        const socket = this.socket;
        this.handleClose(cause);
        socket?.destroy();
        this.socket = null;
        return;
      }
      this.incoming = this.incoming.subarray(length + 4);
      this.handleMessage(message);
    }
  }

  private handleMessage(value: unknown): void {
    if (!object(value) || typeof value.type !== "string") return;
    if (value.type === "response" && typeof value.requestId === "string") {
      const pending = this.pending.get(value.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.requestId);
      pending.resolve(value);
      return;
    }
    if (
      value.type !== "broadcast" || value.method !== "thread-stream-state-changed" ||
      !object(value.params) || typeof value.params.conversationId !== "string" || !object(value.params.change)
    ) return;
    const threadId = value.params.conversationId;
    const change = value.params.change;
    if (change.type === "snapshot" && typeof change.revision === "number" && object(change.conversationState)) {
      this.states.set(threadId, { revision: change.revision, state: change.conversationState });
      this.notifyState(threadId);
      return;
    }
    if (
      change.type === "patches" && typeof change.baseRevision === "number" &&
      typeof change.revision === "number" && Array.isArray(change.patches)
    ) {
      const current = this.states.get(threadId);
      if (current === undefined || current.revision !== change.baseRevision) {
        try { this.broadcast("thread-stream-following-changed", 1, { conversationId: threadId, hostId: "local", following: true }); } catch {}
        return;
      }
      try {
        for (const patch of change.patches) applyPatch(current.state, patch);
        current.revision = change.revision;
        this.notifyState(threadId);
      } catch {
        try { this.broadcast("thread-stream-following-changed", 1, { conversationId: threadId, hostId: "local", following: true }); } catch {}
      }
    }
  }

  private waitForStateUpdate(threadId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let done = false;
      const listener = (changed: string) => {
        if (changed !== threadId || done) return;
        done = true;
        clearTimeout(timer);
        this.stateListeners.delete(listener);
        resolve();
      };
      const onClose = (error: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.stateListeners.delete(listener);
        this.closeListeners.delete(onClose);
        reject(error);
      };
      const timer = setTimeout(() => {
        done = true;
        this.stateListeners.delete(listener);
        this.closeListeners.delete(onClose);
        reject(new CodexDesktopIpcUnavailableError(`Timed out waiting for ChatGPT task snapshot`));
      }, timeoutMs);
      this.stateListeners.add(listener);
      this.closeListeners.add(onClose);
    });
  }

  private notifyState(threadId: string): void {
    for (const listener of this.stateListeners) listener(threadId);
  }

  private handleClose(cause: unknown): void {
    if (!this.closed) this.closed = true;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(pending.method === "thread-follower-start-turn" && pending.written
        ? new CodexDesktopIpcUnknownOutcomeError(`ChatGPT IPC closed after start-turn write`)
        : new CodexDesktopIpcUnavailableError(error.message));
    }
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }
}

function canonicalTurns(state: Record<string, unknown>): CodexDesktopTurn[] {
  if (!object(state.turnHistory) || state.turnHistory.kind !== "canonical" ||
      !object(state.turnHistory.history) || !object(state.turnHistory.history.entitiesByKey)) return [];
  const out: CodexDesktopTurn[] = [];
  for (const value of Object.values(state.turnHistory.history.entitiesByKey)) {
    if (!object(value) || typeof value.turnId !== "string" || typeof value.status !== "string" || !object(value.params)) continue;
    out.push({
      turnId: value.turnId,
      status: value.status,
      items: Array.isArray(value.items) ? value.items.filter(object) : [],
      params: value.params,
    });
  }
  return out;
}

const FORBIDDEN_PATCH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function applyPatch(root: Record<string, unknown>, raw: unknown): void {
  if (!object(raw) || typeof raw.op !== "string" || !Array.isArray(raw.path) || raw.path.length === 0) {
    throw new Error(`Invalid ChatGPT IPC patch`);
  }
  const path: Array<string | number> = [];
  for (const segment of raw.path) {
    if (
      (typeof segment !== "string" && typeof segment !== "number") ||
      (typeof segment === "number" && (!Number.isSafeInteger(segment) || segment < 0))
    ) {
      throw new Error(`Invalid ChatGPT IPC patch path segment`);
    }
    if (typeof segment === "string" && FORBIDDEN_PATCH_SEGMENTS.has(segment)) {
      throw new Error(`Rejected ChatGPT IPC patch path segment`);
    }
    path.push(segment);
  }
  let target: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!object(target) && !Array.isArray(target)) throw new Error(`Invalid ChatGPT IPC patch path`);
    target = (target as Record<string | number, unknown>)[segment];
  }
  const key = path[path.length - 1]!;
  if (Array.isArray(target) && typeof key === "number") {
    if (raw.op === "add") target.splice(key, 0, raw.value);
    else if (raw.op === "remove") target.splice(key, 1);
    else if (raw.op === "replace") target[key] = raw.value;
    else throw new Error(`Unknown ChatGPT IPC patch operation`);
    return;
  }
  if (!object(target)) throw new Error(`Invalid ChatGPT IPC patch target`);
  if (raw.op === "remove") delete target[String(key)];
  else if (raw.op === "add" || raw.op === "replace") target[String(key)] = raw.value;
  else throw new Error(`Unknown ChatGPT IPC patch operation`);
}

export function finalAgentText(turn: CodexDesktopTurn): string | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index]!;
    if (item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string") {
      const text = item.text.trim();
      return text === "" ? null : text;
    }
  }
  return null;
}
