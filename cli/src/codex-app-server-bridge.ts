/**
 * Codex app-server bridge.
 *
 * One app-server connection is owned by this process and exposed to the Codex
 * TUI through a private Unix socket. Both interactive TUI writes and
 * AgentParty delivery pass through the same CodexTurnArbiter; forwarding raw
 * bytes from two clients would allow a second turn/start to replace live work.
 */
import {
  BODY_LIMIT,
  DIRECTED_DELIVERY_LEASE_MS,
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_STREAM_ENDED,
  type ClientFrame,
  type DeliveryRecoverFrame,
  type DeliveryRecoveryResultFrame,
  type DirectedDelivery,
  type MsgFrame,
  type ServerFrame,
} from "@agentparty/shared";
import type { ServerWebSocket } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import pkg from "../package.json" with { type: "json" };
import {
  CodexBridgeQueueFullError,
  CodexRetryableBeforeWriteError,
  CodexTurnArbiter,
  type CodexBridgeInput,
  type CodexDispatch,
  type CodexInteractiveMutation,
  type CodexTurnTransport,
} from "./codex-turn-arbiter";
import type { Connection } from "./client";
import {
  DeliveryRecoveryJournal,
  type DeliveryRecoveryEntry,
} from "./delivery-recovery-journal";
import { stripTerminalControls } from "./format";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export class CodexRpcDisconnectedError extends Error {
  readonly codexBridgeRequestWritten: boolean;

  constructor(
    message = "Codex app-server control connection closed",
    options: { requestWritten?: boolean } = {},
  ) {
    super(message);
    this.name = "CodexRpcDisconnectedError";
    this.codexBridgeRequestWritten = options.requestWritten ?? true;
  }
}

interface PendingRpc {
  fromMessageDispatch: boolean;
  responseReceived: boolean;
  applyStarted: boolean;
  applyResponse?: (result: unknown) => void | Promise<void>;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}

export interface CodexRpcClientOptions {
  spawnProxy: () => ChildProcessWithoutNullStreams;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  log?: (line: string) => void;
}

type MessageListener = (message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>;
type ReconnectListener = (generation: number) => void | Promise<void>;
type DisconnectListener = (generation: number) => void;
export interface CodexFrontendReset {
  disconnectedGeneration: number;
  threadId: string | null;
}
type FrontendResetListener = (event: CodexFrontendReset) => void;
export type ThreadSwitchMethod =
  | "thread/start"
  | "thread/resume"
  | "thread/fork"
  | "thread/rollback"
  | "thread/inject_items";
export type ThreadSwitchGuard = (attempt: {
  method: ThreadSwitchMethod;
  currentThreadId: string;
  targetThreadId: string | null;
}) => void;
export type SessionMutationGuard = (attempt: {
  method: ThreadSwitchMethod | CodexInteractiveMutation;
  currentThreadId: string | null;
  mode: "wait" | "check";
}) => void | Promise<void>;
export type UnresolvedUnknownListener = (event: {
  threadId: string;
  input: CodexBridgeInput;
}) => void | Promise<void>;
export type CodexFrontendRecovery =
  | {
    disposition: "resume";
    threadId: string;
    generation: number;
  }
  | {
    disposition: "restart";
    threadId: null;
    generation: number;
  }
  | {
    disposition: "restart_thread_with_prompt";
    threadId: string;
    generation: number;
    initialInput?: unknown;
  }
  | {
    disposition: "unknown";
    threadId: string | null;
    generation: number;
    reason: string;
  };
type FrontendRecoveryListener = (event: CodexFrontendRecovery) => void | Promise<void>;

function rpcIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonRpcMessage(value: unknown): JsonRpcMessage | null {
  if (!isObject(value)) return null;
  if (typeof value.method === "string") {
    if ("id" in value) {
      const id = value.id;
      if (typeof id !== "string" && typeof id !== "number" && id !== null) return null;
      return {
        id,
        method: value.method,
        ...("params" in value ? { params: value.params } : {}),
      };
    }
    return {
      method: value.method,
      ...("params" in value ? { params: value.params } : {}),
    };
  }
  if (!("id" in value)) return null;
  const id = value.id;
  if (typeof id !== "string" && typeof id !== "number" && id !== null) return null;
  if ("error" in value) {
    if (!isObject(value.error) || typeof value.error.code !== "number" || typeof value.error.message !== "string") {
      return null;
    }
    return {
      id,
      error: {
        code: value.error.code,
        message: value.error.message,
        ...("data" in value.error ? { data: value.error.data } : {}),
      },
    };
  }
  return { id, ...("result" in value ? { result: value.result } : {}) };
}

function isRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalSafeLogger(
  sink: (line: string) => void = (line) => console.error(line),
): (line: string) => void {
  return (line) => sink(stripTerminalControls(line));
}

/**
 * Reconnecting JSON-RPC client over `codex app-server proxy --sock …` stdio.
 *
 * Requests whose connection closes after write are rejected, never replayed.
 * The session controller resumes the thread and lets the arbiter reconcile
 * clientUserMessageId before deciding whether an AgentParty input is safe to
 * retry.
 */
export class CodexRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: ReadLineInterface | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private generation = 0;
  private requestSeq = 1;
  private reconnectDelay: number;
  private initializeValue: unknown = null;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly reconnectListeners = new Set<ReconnectListener>();
  private readonly disconnectListeners = new Set<DisconnectListener>();
  private readonly messageDispatchContext = new AsyncLocalStorage<boolean>();
  private messageDispatchGeneration = 0;
  private messageDispatchTail: Promise<void> = Promise.resolve();
  private lastDisconnectedGeneration = 0;
  private readonly log: (line: string) => void;

  constructor(private readonly options: CodexRpcClientOptions) {
    this.log = terminalSafeLogger(options.log);
    this.reconnectDelay = options.reconnectDelayMs ?? 100;
  }

  get initializeResult(): unknown {
    return this.initializeValue;
  }

  get connected(): boolean {
    return this.child !== null &&
      this.initializeValue !== null &&
      !this.child.stdin.destroyed &&
      this.child.stdin.writable;
  }

  get connectionGeneration(): number | null {
    return this.connected ? this.generation : null;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onReconnect(listener: ReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  onDisconnect(listener: DisconnectListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private write(message: JsonRpcMessage): void {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new CodexRpcDisconnectedError(
        "Codex app-server control connection closed before request write",
        { requestWritten: false },
      );
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rawRequest(
    method: string,
    params?: unknown,
    applyResponse?: (result: unknown) => void | Promise<void>,
  ): Promise<unknown> {
    const id = `agentparty:${this.generation}:${this.requestSeq++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(rpcIdKey(id), {
        fromMessageDispatch: this.messageDispatchContext.getStore() === true,
        responseReceived: false,
        applyStarted: false,
        ...(applyResponse === undefined ? {} : { applyResponse }),
        resolve,
        reject,
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(rpcIdKey(id));
        reject(error);
      }
    });
  }

  private rejectPending(
    error: Error,
    options: { preserveApplyingResponses?: boolean } = {},
  ): void {
    for (const [key, pending] of this.pending) {
      if (
        options.preserveApplyingResponses === true &&
        pending.responseReceived &&
        pending.applyStarted &&
        pending.applyResponse !== undefined
      ) {
        continue;
      }
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  private enqueueMessage(
    message: JsonRpcRequest | JsonRpcNotification,
    generation: number,
  ): void {
    // Preserve app-server wire order for stateful notifications and requests.
    // Responses intentionally bypass this lane in handleLine so a listener can
    // await its own RPC without deadlocking the dispatch queue.
    const listeners = [...this.messageListeners];
    const dispatch = async (): Promise<void> => {
      if (
        generation !== this.generation ||
        generation !== this.messageDispatchGeneration
      ) {
        return;
      }
      await Promise.all(listeners.map(async (listener) => {
        try {
          await this.messageDispatchContext.run(
            true,
            async () => await listener(message),
          );
        } catch (error) {
          this.log(`codex-bridge: JSON-RPC listener failed: ${errorDetail(error)}`);
        }
      }));
    };
    this.messageDispatchTail = this.messageDispatchTail.then(dispatch, dispatch);
  }

  private handleLine(line: string, generation: number): void {
    if (generation !== this.generation || line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.log("codex-bridge: app-server emitted invalid JSON; reconnecting control proxy");
      this.child?.kill("SIGTERM");
      return;
    }
    const message = asJsonRpcMessage(parsed);
    if (message === null) {
      this.log("codex-bridge: app-server emitted an invalid JSON-RPC frame; reconnecting control proxy");
      this.child?.kill("SIGTERM");
      return;
    }
    if (isRpcResponse(message)) {
      const key = rpcIdKey(message.id);
      const pending = this.pending.get(key);
      if (!pending || pending.responseReceived) return;
      pending.responseReceived = true;
      const settle = async (): Promise<void> => {
        if (this.pending.get(key) !== pending) return;
        const generationIsCurrent = (): boolean =>
          generation === this.generation &&
          generation === this.messageDispatchGeneration &&
          this.child !== null &&
          !this.child.stdin.destroyed &&
          this.child.stdin.writable;
        if (!generationIsCurrent()) {
          this.pending.delete(key);
          pending.reject(new CodexRpcDisconnectedError());
          return;
        }
        if (message.error) {
          this.pending.delete(key);
          pending.reject(
            new CodexRpcError(message.error.code, message.error.message, message.error.data),
          );
          return;
        }
        try {
          if (pending.applyResponse) {
            pending.applyStarted = true;
            await this.messageDispatchContext.run(
              true,
              async () => await pending.applyResponse!(message.result),
            );
          }
          if (this.pending.get(key) !== pending) return;
          this.pending.delete(key);
          if (generationIsCurrent()) {
            pending.resolve(message.result);
          } else {
            pending.reject(new CodexRpcDisconnectedError());
          }
        } catch (error) {
          if (this.pending.get(key) !== pending) return;
          this.pending.delete(key);
          pending.reject(
            generationIsCurrent() ? error : new CodexRpcDisconnectedError(),
          );
        }
      };
      if (pending.applyResponse && !pending.fromMessageDispatch) {
        // Installing an authoritative thread snapshot is itself a wire-order
        // dispatch barrier: preceding notifications finish first, and later
        // notifications cannot run until the snapshot has been applied.
        const apply = async (): Promise<void> => await settle();
        this.messageDispatchTail = this.messageDispatchTail.then(apply, apply);
      } else {
        void settle();
      }
      return;
    }
    this.enqueueMessage(message, generation);
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    const max = this.options.maxReconnectDelayMs ?? 2_000;
    this.reconnectDelay = Math.min(max, Math.max(delay, 1) * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch((error) => {
        this.log(`codex-bridge: app-server proxy reconnect failed: ${errorDetail(error)}`);
        this.scheduleReconnect();
      });
    }, delay);
    if (typeof this.reconnectTimer.unref === "function") this.reconnectTimer.unref();
  }

  private disconnected(generation: number): void {
    if (generation !== this.generation) return;
    if (this.lastDisconnectedGeneration === generation) return;
    this.lastDisconnectedGeneration = generation;
    this.messageDispatchGeneration = 0;
    this.reader?.close();
    this.reader = null;
    this.child = null;
    this.initializeValue = null;
    this.rejectPending(
      new CodexRpcDisconnectedError(),
      { preserveApplyingResponses: true },
    );
    if (!this.closing) {
      for (const listener of this.disconnectListeners) {
        try {
          listener(generation);
        } catch (error) {
          this.log(`codex-bridge: disconnect listener failed: ${errorDetail(error)}`);
        }
      }
      this.log("codex-bridge: app-server stdio proxy disconnected; reconnecting");
      this.scheduleReconnect();
    }
  }

  private async connectOnce(): Promise<void> {
    if (this.closing) throw new CodexRpcDisconnectedError("Codex RPC client is closed");
    const generation = ++this.generation;
    this.messageDispatchGeneration = generation;
    const child = this.options.spawnProxy();
    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    this.reader.on("line", (line) => this.handleLine(line, generation));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string | Buffer) => {
      const text = String(chunk).trimEnd();
      if (text) this.log(`codex app-server: ${text}`);
    });
    child.once("exit", () => this.disconnected(generation));
    child.once("error", () => this.disconnected(generation));

    const initialized = await this.rawRequest("initialize", {
      clientInfo: {
        name: "agentparty-codex-bridge",
        title: "AgentParty Codex session bridge",
        version: pkg.version,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    if (generation !== this.generation || this.child !== child) {
      throw new CodexRpcDisconnectedError();
    }
    this.write({ method: "initialized" });
    this.initializeValue = initialized;
    const reconnected = generation > 1;
    this.reconnectDelay = this.options.reconnectDelayMs ?? 100;
    if (reconnected) {
      for (const listener of this.reconnectListeners) {
        void Promise.resolve(listener(generation)).catch((error) => {
          this.log(`codex-bridge: reconnect reconciliation failed: ${errorDetail(error)}`);
        });
      }
    }
  }

  async start(): Promise<void> {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.connectOnce().finally(() => {
        this.connectPromise = null;
      });
    }
    return await this.connectPromise;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.start();
    return await this.rawRequest(method, params);
  }

  private disconnectedRequestBeforeWrite(
    method: string,
    expectedGeneration?: number,
  ): CodexRpcDisconnectedError | null {
    const generationChanged =
      expectedGeneration !== undefined && expectedGeneration !== this.generation;
    if (this.child && this.initializeValue !== null && !generationChanged) {
      return null;
    }
    return new CodexRpcDisconnectedError(
      generationChanged
        ? `Codex app-server generation changed before ${method} request write`
        : "Codex app-server control connection closed before request write",
      { requestWritten: false },
    );
  }

  requestConnected(
    method: string,
    params?: unknown,
    expectedGeneration?: number,
  ): Promise<unknown> {
    const disconnected = this.disconnectedRequestBeforeWrite(method, expectedGeneration);
    if (disconnected) return Promise.reject(disconnected);
    return this.rawRequest(method, params);
  }

  requestConnectedApplied(
    method: string,
    params: unknown,
    expectedGeneration: number | undefined,
    applyResponse: (result: unknown) => void | Promise<void>,
  ): Promise<unknown> {
    const disconnected = this.disconnectedRequestBeforeWrite(method, expectedGeneration);
    if (disconnected) return Promise.reject(disconnected);
    return this.rawRequest(method, params, applyResponse);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.start();
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  notifyConnected(method: string, params?: unknown): void {
    if (!this.child || this.initializeValue === null) {
      throw new CodexRpcDisconnectedError(
        "Codex app-server control connection closed before notification write",
        { requestWritten: false },
      );
    }
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: JsonRpcId, result?: unknown, error?: JsonRpcResponse["error"]): void {
    this.write({
      id,
      ...(error === undefined ? { result } : { error }),
    });
  }

  close(): void {
    this.closing = true;
    this.messageDispatchGeneration = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reader?.close();
    this.reader = null;
    this.rejectPending(new CodexRpcDisconnectedError("Codex RPC client closed"));
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

export interface CodexRpcPeer {
  readonly initializeResult: unknown;
  readonly connected?: boolean;
  readonly connectionGeneration: number | null;
  start(): Promise<void>;
  request(method: string, params?: unknown): Promise<unknown>;
  requestConnected(
    method: string,
    params?: unknown,
    expectedGeneration?: number,
  ): Promise<unknown>;
  requestConnectedApplied?(
    method: string,
    params: unknown,
    expectedGeneration: number | undefined,
    applyResponse: (result: unknown) => void | Promise<void>,
  ): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  notifyConnected?(method: string, params?: unknown): void | Promise<void>;
  respond(id: JsonRpcId, result?: unknown, error?: JsonRpcResponse["error"]): void;
  onMessage(listener: MessageListener): () => void;
  onReconnect(listener: ReconnectListener): () => void;
  onDisconnect?(listener: DisconnectListener): () => void;
}

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items?: CodexThreadItem[];
}

export interface CodexThreadItem extends Record<string, unknown> {
  type: string;
  clientId?: string | null;
}

export interface CodexThread {
  id: string;
  status: { type: "idle" | "active" | "notLoaded" | "systemError" };
  turns: CodexTurn[];
}

interface AccumulatedAgentMessage {
  item: CodexThreadItem;
  text: string;
  completed: boolean;
  hasStarted: boolean;
  hasDelta: boolean;
}

const MAX_RETAINED_COMPLETED_TURNS = 256;
const MAX_RETAINED_COMPLETED_TURN_BYTES = 16 * 1024 * 1024;

export type DispatchListener = (input: CodexBridgeInput, dispatch: CodexDispatch) => void | Promise<void>;
export type CompletedTurnListener = (turn: CodexTurn) => void | Promise<void>;

function asThread(value: unknown): CodexThread | null {
  if (!isObject(value) || typeof value.id !== "string" || !isObject(value.status) || typeof value.status.type !== "string") {
    return null;
  }
  const status = value.status.type;
  if (status !== "idle" && status !== "active" && status !== "notLoaded" && status !== "systemError") return null;
  const turns = Array.isArray(value.turns) ? value.turns.flatMap((turn) => {
    if (!isObject(turn) || typeof turn.id !== "string" || typeof turn.status !== "string") return [];
    if (
      turn.status !== "completed" &&
      turn.status !== "interrupted" &&
      turn.status !== "failed" &&
      turn.status !== "inProgress"
    ) {
      return [];
    }
    return [{
      id: turn.id,
      status: turn.status,
      ...(Array.isArray(turn.items) ? { items: turn.items.flatMap(asThreadItem) } : {}),
    } satisfies CodexTurn];
  }) : [];
  return { id: value.id, status: { type: status }, turns };
}

function responseThread(value: unknown): CodexThread | null {
  return isObject(value) ? asThread(value.thread) : null;
}

function requireRecoveryThreadIdentity(
  value: unknown,
  expectedThreadId: string,
  method: "thread/resume" | "thread/read",
): CodexThread {
  const thread = responseThread(value);
  if (thread === null) {
    throw new Error(`${method} returned no valid thread while restoring ${expectedThreadId}`);
  }
  if (thread.id !== expectedThreadId) {
    throw new Error(
      `${method} restored thread ${thread.id}, expected ${expectedThreadId}`,
    );
  }
  return thread;
}

function requireRecoveryThreadSnapshot(
  value: unknown,
  expectedThreadId: string,
): CodexThread {
  const thread = requireRecoveryThreadIdentity(value, expectedThreadId, "thread/read");
  const rawThread = isObject(value) && isObject(value.thread) ? value.thread : null;
  if (rawThread === null || !Array.isArray(rawThread.turns)) {
    throw new Error(
      `thread/read did not return a complete turn snapshot for ${expectedThreadId}`,
    );
  }
  if (thread.turns.length !== rawThread.turns.length) {
    throw new Error(
      `thread/read returned malformed turn history for ${expectedThreadId}`,
    );
  }
  for (let index = 0; index < rawThread.turns.length; index += 1) {
    const rawTurn = rawThread.turns[index];
    const parsedTurn = thread.turns[index];
    if (
      !isObject(rawTurn) ||
      !Array.isArray(rawTurn.items) ||
      parsedTurn === undefined ||
      (parsedTurn.items?.length ?? 0) !== rawTurn.items.length
    ) {
      throw new Error(
        `thread/read returned an incomplete turn snapshot for ${expectedThreadId}`,
      );
    }
  }
  return thread;
}

function clientIds(turn: CodexTurn): string[] {
  return (turn.items ?? []).flatMap((item) =>
    item.type === "userMessage" && typeof item.clientId === "string" ? [item.clientId] : []
  );
}

function paramsRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

const INTERACTIVE_MUTATIONS = new Set<CodexInteractiveMutation>([
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
  "thread/compact/start",
  "thread/shellCommand",
]);

class CodexSessionReadinessChanged extends Error {}
class CodexSessionMutationReadinessChanged extends CodexRetryableBeforeWriteError {}
class CodexRecoverySuperseded extends Error {}
class CodexInitialThreadStartRestartRequired extends Error {}

interface CodexRecoveryState {
  attempt: number;
  generation: number;
  threadId: string | null;
  status: "restoring" | "ready" | "failed";
  error: Error | null;
  retryAttempt: number;
  cancelRetry: (() => void) | null;
  promise: Promise<void>;
}

interface InitialThreadStartAttempt {
  operation: "initial thread/start" | "initial turn/start";
  params: Record<string, unknown>;
  phase: "waiting" | "writing" | "finished";
  cancelled: boolean;
  outcome: "resume" | "restart" | "unknown" | null;
  unknownReason: string | null;
  readonly cancelledRun: Promise<void>;
  readonly finished: Promise<void>;
  cancel(): void;
  finish(): void;
}

function initialThreadStartAttempt(
  operation: InitialThreadStartAttempt["operation"],
  params: Record<string, unknown>,
): InitialThreadStartAttempt {
  let cancel!: () => void;
  let finish!: () => void;
  const cancelledRun = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    operation,
    params,
    phase: "waiting",
    cancelled: false,
    outcome: null,
    unknownReason: null,
    cancelledRun,
    finished,
    cancel,
    finish,
  };
}

function disconnectedBeforeWrite(error: unknown): boolean {
  return error instanceof CodexRpcDisconnectedError &&
    error.codexBridgeRequestWritten === false;
}

/**
 * Protocol/state router shared by the Unix TUI proxy and AgentParty delivery.
 */
export class CodexSessionController {
  private threadId: string | null = null;
  private arbiter: CodexTurnArbiter | null = null;
  private sessionLane: Promise<void> = Promise.resolve();
  private restoreTail: Promise<void> = Promise.resolve();
  private recovery: CodexRecoveryState | null = null;
  private requestGenerationFence: number | null = null;
  private reconnectAttempt = 0;
  private readonly beforeSession: CodexBridgeInput[] = [];
  private readonly dispatchListeners = new Set<DispatchListener>();
  private readonly completedListeners = new Set<CompletedTurnListener>();
  private readonly frontendListeners = new Set<MessageListener>();
  private readonly frontendResetListeners = new Set<FrontendResetListener>();
  private readonly frontendRecoveryListeners = new Set<FrontendRecoveryListener>();
  private readonly threadSwitchGuards = new Set<ThreadSwitchGuard>();
  private readonly sessionMutationGuards = new Set<SessionMutationGuard>();
  private readonly unresolvedUnknownListeners = new Set<UnresolvedUnknownListener>();
  private readonly turnByClientId = new Map<string, string>();
  private readonly turns = new Map<string, CodexTurn>();
  private readonly retainedTurnBytesById = new Map<string, number>();
  private retainedCompletedTurnBytes = 0;
  private retainedCompletedTurnCount = 0;
  private readonly agentMessagesByTurn =
    new Map<string, Map<string, AccumulatedAgentMessage>>();
  private readonly log: (line: string) => void;
  private beforeSessionFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private initialThreadStart: InitialThreadStartAttempt | null = null;
  private initialPromptStart: InitialThreadStartAttempt | null = null;
  private bootstrapThreadId: string | null = null;
  private noThreadRecovery:
    | { disposition: "restart" }
    | { disposition: "unknown"; reason: string }
    | null = null;
  private bootstrapRecovery:
    | { disposition: "restart_thread_with_prompt"; initialInput?: unknown }
    | { disposition: "unknown"; reason: string; initialInput: unknown }
    | null = null;

  constructor(
    private readonly rpc: CodexRpcPeer,
    private readonly options: {
      maxQueue?: number;
      log?: (line: string) => void;
      /** Hold pre-attach AgentParty input until the TUI's initial prompt is accepted. */
      expectBootstrapPrompt?: boolean;
      /** Base delay for same-generation app-server recovery retries. */
      recoveryRetryDelayMs?: number;
    } = {},
  ) {
    this.log = terminalSafeLogger(options.log);
    rpc.onMessage((message) => this.handleBackendMessage(message));
    const hasDisconnectBoundary = rpc.onDisconnect !== undefined;
    rpc.onDisconnect?.((disconnectedGeneration) => {
      // Wake a same-generation recovery that is sleeping in backoff. Its
      // generation check will retire the old barrier so a waiting writer can
      // drive rpc.start() and the successor recovery instead of waiting for a
      // stale timer.
      this.recovery?.cancelRetry?.();
      if (this.threadId === null) {
        const attempt = this.initialThreadStart;
        if (attempt?.phase === "waiting") {
          this.cancelInitialThreadStart(attempt);
        } else if (!attempt && this.noThreadRecovery?.disposition !== "unknown") {
          this.noThreadRecovery = { disposition: "restart" };
        }
      } else if (this.bootstrapThreadId === this.threadId) {
        const attempt = this.initialPromptStart;
        if (attempt?.phase === "waiting") {
          this.cancelInitialPromptStart(attempt);
        } else if (
          !attempt &&
          this.bootstrapRecovery === null
        ) {
          this.bootstrapRecovery = {
            disposition: "restart_thread_with_prompt",
          };
        }
      }
      const event = {
        disconnectedGeneration,
        threadId: this.threadId,
      };
      for (const listener of this.frontendResetListeners) listener(event);
    });
    rpc.onReconnect(async (generation) => {
      const attempt = ++this.reconnectAttempt;
      // Older/test peers expose only reconnect. Real CodexRpcClient announces
      // reset at disconnect time so the supervisor can quiesce the old TUI
      // before it exits and accidentally terminates the whole bridge.
      if (!hasDisconnectBoundary) {
        const event = {
          disconnectedGeneration: Math.max(0, generation - 1),
          threadId: this.threadId,
        };
        for (const listener of this.frontendResetListeners) listener(event);
      }
      const state = this.scheduleRecovery(attempt, generation);
      await state.promise;
    });
  }

  get activeThreadId(): string | null {
    return this.threadId;
  }

  get initializeResult(): unknown {
    return this.rpc.initializeResult;
  }

  onDispatch(listener: DispatchListener): () => void {
    this.dispatchListeners.add(listener);
    return () => this.dispatchListeners.delete(listener);
  }

  onTurnCompleted(listener: CompletedTurnListener): () => void {
    this.completedListeners.add(listener);
    return () => this.completedListeners.delete(listener);
  }

  onFrontendMessage(listener: MessageListener): () => void {
    this.frontendListeners.add(listener);
    return () => this.frontendListeners.delete(listener);
  }

  onFrontendReset(listener: FrontendResetListener): () => void {
    this.frontendResetListeners.add(listener);
    return () => this.frontendResetListeners.delete(listener);
  }

  onFrontendRecovery(listener: FrontendRecoveryListener): () => void {
    this.frontendRecoveryListeners.add(listener);
    return () => this.frontendRecoveryListeners.delete(listener);
  }

  onThreadSwitch(listener: ThreadSwitchGuard): () => void {
    this.threadSwitchGuards.add(listener);
    return () => this.threadSwitchGuards.delete(listener);
  }

  onSessionMutation(listener: SessionMutationGuard): () => void {
    this.sessionMutationGuards.add(listener);
    return () => this.sessionMutationGuards.delete(listener);
  }

  private async waitForSessionMutationGuards(method: CodexInteractiveMutation): Promise<void> {
    for (const guard of this.sessionMutationGuards) {
      await guard({
        method,
        currentThreadId: this.threadId,
        mode: "wait",
      });
    }
  }

  private checkSessionMutationGuards(method: CodexInteractiveMutation): void {
    for (const guard of this.sessionMutationGuards) {
      const result = guard({
        method,
        currentThreadId: this.threadId,
        mode: "check",
      });
      if (result !== undefined) {
        // A check-mode guard must never wait while the arbiter writer lane is
        // held; recovery itself may need that lane to restore queued delivery.
        void Promise.resolve(result).catch(() => {});
        throw new CodexSessionMutationReadinessChanged(
          "AgentParty ownership recovery changed before the Codex write boundary",
        );
      }
    }
  }

  onUnresolvedUnknown(listener: UnresolvedUnknownListener): () => void {
    this.unresolvedUnknownListeners.add(listener);
    return () => this.unresolvedUnknownListeners.delete(listener);
  }

  async abandonUnknownOutcome(
    threadId: string,
    input: CodexBridgeInput,
  ): Promise<CodexDispatch> {
    const arbiter = this.arbiter;
    if (!arbiter || this.threadId !== threadId) {
      throw new Error(`Cannot abandon an uncertain write for inactive Codex thread ${threadId}`);
    }
    return await arbiter.resolveUnknownOutcome(input, "abandoned");
  }

  private emitDispatch(input: CodexBridgeInput, dispatch: CodexDispatch): void {
    if (dispatch.turnId) this.turnByClientId.set(input.clientUserMessageId, dispatch.turnId);
    for (const listener of this.dispatchListeners) {
      void Promise.resolve(listener(input, dispatch)).catch((error) => {
        this.log(`codex-bridge: dispatch listener failed: ${errorDetail(error)}`);
      });
    }
  }

  private emitCompleted(turn: CodexTurn): void {
    const retainedTurn = this.storeTurn(turn);
    for (const listener of this.completedListeners) {
      void Promise.resolve(listener(retainedTurn)).catch((error) => {
        this.log(`codex-bridge: completion listener failed: ${errorDetail(error)}`);
      });
    }
  }

  private retainedTurnItem(item: CodexThreadItem): CodexThreadItem | null {
    const id = typeof item.id === "string" ? item.id : null;
    if (item.type === "userMessage") {
      const clientId =
        typeof item.clientId === "string" || item.clientId === null
          ? item.clientId
          : undefined;
      const bootstrapInput =
        this.bootstrapRecovery?.disposition === "unknown"
          ? this.bootstrapRecovery.initialInput
          : undefined;
      return {
        type: "userMessage",
        ...(id === null ? {} : { id }),
        ...(clientId === undefined ? {} : { clientId }),
        ...(clientId === null &&
            bootstrapInput !== undefined &&
            sameJsonValue(item.content, bootstrapInput)
          ? { content: item.content }
          : {}),
      };
    }
    if (item.type === "agentMessage") {
      return {
        type: "agentMessage",
        ...(id === null ? {} : { id }),
        ...(typeof item.text === "string" ? { text: item.text } : {}),
        ...(item.phase === "commentary" || item.phase === "final_answer"
          ? { phase: item.phase }
          : {}),
      };
    }
    return null;
  }

  private retainedTurn(turn: CodexTurn): CodexTurn {
    return {
      id: turn.id,
      status: turn.status,
      ...(turn.items === undefined
        ? {}
        : {
          items: turn.items.flatMap((item) => {
            const retained = this.retainedTurnItem(item);
            return retained === null ? [] : [retained];
          }),
        }),
    };
  }

  private retainedTurnBytes(turn: CodexTurn): number {
    try {
      return Buffer.byteLength(JSON.stringify(turn));
    } catch {
      return MAX_RETAINED_COMPLETED_TURN_BYTES + 1;
    }
  }

  private storeTurn(turn: CodexTurn): CodexTurn {
    const retained = this.retainedTurn(turn);
    const previous = this.turns.get(retained.id);
    if (previous?.status !== undefined && previous.status !== "inProgress") {
      this.retainedCompletedTurnBytes -=
        this.retainedTurnBytesById.get(retained.id) ?? 0;
      this.retainedCompletedTurnCount -= 1;
    }
    const retainedBytes = this.retainedTurnBytes(retained);
    this.turns.set(retained.id, retained);
    this.retainedTurnBytesById.set(retained.id, retainedBytes);
    if (retained.status !== "inProgress") {
      this.retainedCompletedTurnBytes += retainedBytes;
      this.retainedCompletedTurnCount += 1;
    }
    this.trimRetainedTurns();
    return retained;
  }

  private trimRetainedTurns(): void {
    if (
      this.retainedCompletedTurnCount <= MAX_RETAINED_COMPLETED_TURNS &&
      this.retainedCompletedTurnBytes <= MAX_RETAINED_COMPLETED_TURN_BYTES
    ) {
      return;
    }
    const completed = [...this.turns.entries()]
      .filter(([, turn]) => turn.status !== "inProgress")
      .map(([turnId, turn]) => ({
        turnId,
        turn,
        bytes: this.retainedTurnBytesById.get(turnId) ?? 0,
        bootstrapProof: (turn.items ?? []).some((item) =>
          item.type === "userMessage" &&
          item.clientId === null &&
          Object.prototype.hasOwnProperty.call(item, "content")
        ),
      }));
    while (
      this.retainedCompletedTurnCount > MAX_RETAINED_COMPLETED_TURNS ||
      this.retainedCompletedTurnBytes > MAX_RETAINED_COMPLETED_TURN_BYTES
    ) {
      const index = completed.findIndex((entry) => !entry.bootstrapProof);
      if (index < 0) break;
      const [evicted] = completed.splice(index, 1);
      if (!evicted) break;
      this.turns.delete(evicted.turnId);
      this.retainedTurnBytesById.delete(evicted.turnId);
      for (const [clientId, turnId] of this.turnByClientId) {
        if (turnId === evicted.turnId) {
          this.turnByClientId.delete(clientId);
        }
      }
      this.retainedCompletedTurnBytes -= evicted.bytes;
      this.retainedCompletedTurnCount -= 1;
    }
  }

  private observeAgentMessageItem(
    turnId: string,
    item: CodexThreadItem,
    completed: boolean,
    started = false,
  ): void {
    if (
      item.type !== "agentMessage" ||
      typeof item.id !== "string"
    ) {
      return;
    }
    let messages = this.agentMessagesByTurn.get(turnId);
    if (!messages) {
      messages = new Map();
      this.agentMessagesByTurn.set(turnId, messages);
    }
    const existing = messages.get(item.id);
    const itemText = typeof item.text === "string" ? item.text : "";
    if (
      completed &&
      existing?.completed === true &&
      itemText.trim() === ""
    ) {
      // item/completed is the authoritative terminal item. A later
      // turn/completed snapshot can contain only an empty shell for the same
      // id; do not erase the final text/phase already observed.
      return;
    }
    const text =
      completed
        ? itemText.trim() === "" &&
            existing?.hasStarted === true &&
            existing?.hasDelta === true &&
            existing.text.length > 0
          ? existing.text
          : itemText
        : existing?.text.length
          ? existing.text
          : itemText;
    const retainedItem = this.retainedTurnItem(item);
    if (retainedItem === null) return;
    messages.set(item.id, {
      item: {
        ...(existing?.item ?? {}),
        ...retainedItem,
        type: "agentMessage",
        id: item.id,
        text,
      },
      text,
      completed: completed || existing?.completed === true,
      hasStarted: started || existing?.hasStarted === true,
      hasDelta: existing?.hasDelta === true,
    });
  }

  private observeAgentMessageDelta(params: Record<string, unknown>): void {
    if (
      typeof params.turnId !== "string" ||
      typeof params.itemId !== "string" ||
      typeof params.delta !== "string"
    ) {
      return;
    }
    let messages = this.agentMessagesByTurn.get(params.turnId);
    if (!messages) {
      messages = new Map();
      this.agentMessagesByTurn.set(params.turnId, messages);
    }
    const existing = messages.get(params.itemId);
    // item/completed is authoritative. Ignore a duplicate/late delta instead
    // of appending it after the final item text.
    if (existing?.completed) return;
    const hadDelta = existing?.hasDelta === true;
    // item/started text is not streamed output. Seed this buffer only from
    // actual deltas so an empty delta cannot promote provisional item text.
    const text = `${hadDelta ? existing.text : ""}${params.delta}`;
    messages.set(params.itemId, {
      item: {
        ...(existing?.item ?? {}),
        type: "agentMessage",
        id: params.itemId,
        text,
      },
      text,
      completed: false,
      hasStarted: existing?.hasStarted === true,
      hasDelta: hadDelta || params.delta.length > 0,
    });
  }

  private observeTurnItem(turnId: string, item: CodexThreadItem): void {
    const retainedItem = this.retainedTurnItem(item);
    if (retainedItem === null) return;
    const turn = this.turns.get(turnId) ?? {
      id: turnId,
      status: "inProgress",
      items: [],
    } satisfies CodexTurn;
    const items = [...(turn.items ?? [])];
    const itemId = typeof item.id === "string" ? item.id : null;
    const existingIndex = itemId === null
      ? -1
      : items.findIndex((candidate) => candidate.id === itemId);
    if (existingIndex >= 0) {
      items[existingIndex] = {
        ...items[existingIndex],
        ...retainedItem,
      };
    } else {
      items.push(retainedItem);
    }
    this.storeTurn({ ...turn, items });
  }

  private observeTurnAgentMessages(turn: CodexTurn, completed: boolean): void {
    for (const item of turn.items ?? []) {
      this.observeAgentMessageItem(turn.id, item, completed);
    }
  }

  private completedTurnWithAgentText(
    turn: CodexTurn,
    previous = this.turns.get(turn.id),
  ): CodexTurn {
    const accumulated = this.agentMessagesByTurn.get(turn.id);
    const canonicalItems = (previous?.items ?? []).filter((item) => {
      if (item.type !== "agentMessage" || previous?.status !== "inProgress") {
        return true;
      }
      return typeof item.id === "string" &&
        accumulated?.get(item.id)?.completed === true;
    });
    for (const item of turn.items ?? []) {
      const itemId = typeof item.id === "string" ? item.id : null;
      const existingIndex = itemId === null
        ? -1
        : canonicalItems.findIndex((candidate) => candidate.id === itemId);
      if (existingIndex >= 0) {
        canonicalItems[existingIndex] = {
          ...canonicalItems[existingIndex],
          ...item,
        };
      } else {
        canonicalItems.push(item);
      }
    }
    const canonicalTurn = canonicalItems.length > 0
      ? { ...turn, items: canonicalItems }
      : turn;
    const snapshotAgents = agentMessageItems(canonicalTurn);
    if (
      snapshotAgents.some((item) => item.phase !== "commentary")
    ) {
      return canonicalTurn;
    }
    const accumulatedFallback = finalAgentItem(
      accumulated
        ? [...accumulated.values()]
          .filter(({ completed }) => completed)
          .map(({ item, text }) => ({ ...item, text }))
        : [],
    );
    const fallback = accumulatedFallback ??
      (previous?.status !== "inProgress"
        ? finalAgentItem(agentMessageItems(previous))
        : null);
    if (!fallback) return canonicalTurn;

    const items = [...(canonicalTurn.items ?? [])];
    const fallbackId = typeof fallback.id === "string" ? fallback.id : null;
    const existingIndex = fallbackId === null
      ? -1
      : items.findIndex((item) =>
        item.type === "agentMessage" && item.id === fallbackId
      );
    if (existingIndex >= 0) {
      const existing = items[existingIndex]!;
      if (typeof existing.text === "string" && existing.text.trim() !== "") {
        return canonicalTurn;
      }
      items[existingIndex] = {
        ...fallback,
        ...existing,
        text: fallback.text,
        phase: fallback.phase,
      };
    } else {
      items.push(fallback);
    }
    return { ...canonicalTurn, items };
  }

  private serializeSession<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.sessionLane.then(operation, operation);
    this.sessionLane = run.then(() => {}, () => {});
    return run;
  }

  private assertRecoveryCurrent(state: CodexRecoveryState): void {
    if (
      this.recovery !== state ||
      this.rpc.connectionGeneration !== state.generation ||
      this.rpc.connected === false
    ) {
      throw new CodexRecoverySuperseded();
    }
  }

  private async waitForRecoveryRetry(
    state: CodexRecoveryState,
    delayMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (state.cancelRetry === cancel) state.cancelRetry = null;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      const cancel = () => {
        clearTimeout(timer);
        finish();
      };
      state.cancelRetry = cancel;
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  private scheduleRecovery(attempt: number, generation: number): CodexRecoveryState {
    const active = this.recovery;
    if (
      active !== null &&
      active.generation === generation &&
      (active.status === "restoring" || active.status === "ready")
    ) {
      return active;
    }
    active?.cancelRetry?.();
    const state: CodexRecoveryState = {
      attempt,
      generation,
      threadId: this.threadId,
      status: "restoring",
      error: null,
      retryAttempt: 0,
      cancelRetry: null,
      promise: Promise.resolve(),
    };
    this.recovery = state;
    const preceding = this.restoreTail.catch(() => {});
    state.promise = preceding.then(async () => {
      if (this.recovery !== state) return;
      for (;;) {
        try {
          this.assertRecoveryCurrent(state);
          await this.restoreGeneration(state);
          this.assertRecoveryCurrent(state);
          state.status = "ready";
          state.error = null;
          state.retryAttempt = 0;
          return;
        } catch (error) {
          if (
            error instanceof CodexRecoverySuperseded ||
            this.recovery !== state ||
            this.rpc.connectionGeneration !== state.generation ||
            this.rpc.connected === false
          ) {
            return;
          }
          state.status = "restoring";
          state.error = error instanceof Error ? error : new Error(String(error));
          const baseDelayMs = Math.max(1, this.options.recoveryRetryDelayMs ?? 1_000);
          const retryDelayMs = Math.min(
            30_000,
            baseDelayMs * 2 ** Math.min(state.retryAttempt, 5),
          );
          state.retryAttempt += 1;
          this.log(
            `codex-bridge: app-server generation ${state.generation} recovery failed; ` +
              `retrying on the same connection in ${retryDelayMs}ms: ${state.error.message}`,
          );
          await this.waitForRecoveryRetry(state, retryDelayMs);
        }
      }
    });
    this.restoreTail = state.promise.catch(() => {});
    return state;
  }

  private async awaitRestoreBarrier(): Promise<void> {
    for (;;) {
      const state = this.recovery;
      if (!state) return;
      try {
        await state.promise;
      } catch {
        // The current state's structured failure is handled below. A replaced
        // state must never leak its rejection into the new generation.
      }
      if (state !== this.recovery) continue;
      if (state.status === "failed") throw state.error!;
      if (state.status === "ready") return;
      if (
        this.rpc.connected === false ||
        this.rpc.connectionGeneration !== state.generation
      ) {
        // The settled restoring promise belongs to a disconnected generation.
        // Return to ensureBackendReady so it can call rpc.start(); repeatedly
        // awaiting this already-settled promise would otherwise form a
        // microtask spin loop that can starve the reconnect timer.
        return;
      }
    }
  }

  /**
   * Establish/reconcile the backend before entering either the session lane or
   * the turn arbiter. A reconnect listener may need both locks while restoring,
   * so triggering reconnect from inside either lock would deadlock.
   */
  private throwIfInitialThreadStartCancelled(
    attempt: InitialThreadStartAttempt | undefined,
  ): void {
    if (attempt?.cancelled) {
      throw new CodexInitialThreadStartRestartRequired(
        `Codex backend disconnected before the ${attempt.operation} write`,
      );
    }
  }

  private async waitForInitialThreadStartCancellation<T>(
    operation: Promise<T>,
    attempt: InitialThreadStartAttempt | undefined,
  ): Promise<T> {
    if (!attempt) return await operation;
    this.throwIfInitialThreadStartCancelled(attempt);
    return await Promise.race([
      operation,
      attempt.cancelledRun.then(() => {
        throw new CodexInitialThreadStartRestartRequired(
          `Codex backend disconnected before the ${attempt.operation} write`,
        );
      }),
    ]);
  }

  private cancelInitialThreadStart(attempt: InitialThreadStartAttempt): void {
    if (attempt.phase !== "waiting" || attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.outcome = "restart";
    this.noThreadRecovery = { disposition: "restart" };
    attempt.cancel();
  }

  private cancelInitialPromptStart(attempt: InitialThreadStartAttempt): void {
    if (attempt.phase !== "waiting" || attempt.cancelled) return;
    attempt.cancelled = true;
    attempt.outcome = "restart";
    this.bootstrapRecovery = {
      disposition: "restart_thread_with_prompt",
      initialInput: attempt.params.input,
    };
    attempt.cancel();
  }

  private async ensureBackendReady(
    initialStart?: InitialThreadStartAttempt,
  ): Promise<{ attempt: number; generation: number }> {
    for (;;) {
      await this.waitForInitialThreadStartCancellation(
        this.rpc.start(),
        initialStart,
      );
      this.throwIfInitialThreadStartCancelled(initialStart);
      const generation = this.rpc.connectionGeneration;
      if (generation === null) {
        throw new CodexRpcDisconnectedError(
          "Codex app-server control connection is not ready",
          { requestWritten: false },
        );
      }
      await this.waitForInitialThreadStartCancellation(
        this.awaitRestoreBarrier(),
        initialStart,
      );
      this.throwIfInitialThreadStartCancelled(initialStart);
      if (
        this.rpc.connected !== false &&
        this.rpc.connectionGeneration === generation
      ) {
        return { attempt: this.reconnectAttempt, generation };
      }
    }
  }

  /**
   * Acquire a stable session generation without reconnecting while the session
   * lane is held. Reconnect restoration itself needs this lane, so a generation
   * change or a proven pre-write disconnect releases the lane and retries only
   * after the restore barrier has completed.
   */
  private async withReadySession<T>(
    operation: () => Promise<T>,
    initialStart?: InitialThreadStartAttempt,
  ): Promise<T> {
    for (;;) {
      const ready = await this.ensureBackendReady(initialStart);
      this.throwIfInitialThreadStartCancelled(initialStart);
      try {
        return await this.serializeSession(async () => {
          this.throwIfInitialThreadStartCancelled(initialStart);
          const previousFence = this.requestGenerationFence;
          this.requestGenerationFence = ready.generation;
          try {
            if (
              ready.attempt !== this.reconnectAttempt ||
              ready.generation !== this.rpc.connectionGeneration ||
              this.recovery?.status === "restoring" ||
              this.recovery?.status === "failed" ||
              this.rpc.connected === false
            ) {
              throw new CodexSessionReadinessChanged();
            }
            try {
              return await operation();
            } catch (error) {
              if (disconnectedBeforeWrite(error)) {
                throw new CodexSessionReadinessChanged();
              }
              throw error;
            }
          } finally {
            if (this.requestGenerationFence === ready.generation) {
              this.requestGenerationFence = previousFence;
            }
          }
        });
      } catch (error) {
        if (error instanceof CodexSessionReadinessChanged) continue;
        throw error;
      }
    }
  }

  private requestConnected(
    method: string,
    params?: unknown,
    expectedGeneration?: number,
  ): Promise<unknown> {
    return this.rpc.requestConnected(
      method,
      params,
      expectedGeneration ?? this.requestGenerationFence ?? undefined,
    );
  }

  private async requestConnectedApplied(
    method: string,
    params: unknown,
    applyResponse: (result: unknown) => void | Promise<void>,
    expectedGeneration?: number,
  ): Promise<unknown> {
    const generation =
      expectedGeneration ?? this.requestGenerationFence ?? undefined;
    if (this.rpc.requestConnectedApplied) {
      return await this.rpc.requestConnectedApplied(
        method,
        params,
        generation,
        applyResponse,
      );
    }
    const result = await this.rpc.requestConnected(method, params, generation);
    await applyResponse(result);
    return result;
  }

  private async notifyConnected(method: string, params?: unknown): Promise<void> {
    if (this.rpc.notifyConnected) {
      await this.rpc.notifyConnected(method, params);
      return;
    }
    await this.rpc.notify(method, params);
  }

  private transport(): CodexTurnTransport {
    return {
      turnStart: async (params) =>
        await this.requestConnected("turn/start", params) as { turn: { id: string } },
      turnSteer: async (params) =>
        await this.requestConnected("turn/steer", params) as { turnId: string },
    };
  }

  private async attachThread(
    thread: CodexThread,
    options: { backendRestarted?: boolean; deferQueuedInputs?: boolean } = {},
  ): Promise<void> {
    const threadChanged = this.threadId !== thread.id;
    const replacing = threadChanged || this.arbiter === null;
    // Every attached Thread payload is an authoritative history snapshot.
    // Rebuild affinity indexes even for the same thread so rollback cannot
    // leave a removed source clientId cached and authorize owner_answer.
    this.turns.clear();
    this.retainedTurnBytesById.clear();
    this.retainedCompletedTurnBytes = 0;
    this.retainedCompletedTurnCount = 0;
    this.turnByClientId.clear();
    this.agentMessagesByTurn.clear();
    this.threadId = thread.id;
    this.noThreadRecovery = null;
    if (replacing) {
      this.arbiter = new CodexTurnArbiter(thread.id, this.transport(), {
        maxQueue: this.options.maxQueue,
        onQueuedDispatch: ({ input, dispatch }) => this.emitDispatch(input, dispatch),
        onQueuedError: ({ input, error }) => {
          this.log(
            `codex-bridge: queued input ${input.clientUserMessageId} remains pending: ` +
              errorDetail(error),
          );
        },
      });
    }
    await this.arbiter!.observeResume({ thread }, options);

    for (const turn of thread.turns) {
      this.observeTurnAgentMessages(turn, turn.status !== "inProgress");
      const observedTurn = turn.status === "inProgress"
        ? turn
        : this.completedTurnWithAgentText(turn);
      const retainedTurn = this.storeTurn(observedTurn);
      for (const clientId of clientIds(retainedTurn)) {
        this.turnByClientId.set(clientId, turn.id);
        this.emitDispatch(
          { text: "recovered AgentParty input", clientUserMessageId: clientId },
          { kind: "duplicate", turnId: turn.id },
        );
      }
      if (observedTurn.status !== "inProgress") {
        this.emitCompleted(observedTurn);
        this.agentMessagesByTurn.delete(observedTurn.id);
      }
    }

    const bootstrapPromptPending =
      this.options.expectBootstrapPrompt === true &&
      this.bootstrapThreadId !== null &&
      this.bootstrapThreadId === thread.id;
    if (options.deferQueuedInputs !== true && !bootstrapPromptPending) {
      await this.flushBeforeSessionSafely();
    }
  }

  private async flushBeforeSession(): Promise<void> {
    if (!this.arbiter) return;
    while (this.beforeSession.length > 0) {
      const input = this.beforeSession.shift()!;
      try {
        const dispatch = await this.arbiter.submit(input);
        this.emitDispatch(input, dispatch);
      } catch (error) {
        this.beforeSession.unshift(input);
        throw error;
      }
    }
  }

  private async flushBeforeSessionSafely(): Promise<void> {
    if (this.beforeSessionFlushTimer !== null) {
      clearTimeout(this.beforeSessionFlushTimer);
      this.beforeSessionFlushTimer = null;
    }
    try {
      await this.flushBeforeSession();
    } catch (error) {
      // The frontend thread/start or initial turn/start may already have
      // succeeded upstream. A side-channel delivery WAL failure must not
      // rewrite that authoritative response into a TUI error. Keep the input
      // at the head of beforeSession and retry independently.
      this.log(
        `codex-bridge: queued AgentParty delivery flush is still pending: ${errorDetail(error)}`,
      );
      if (this.beforeSession.length === 0 || this.beforeSessionFlushTimer !== null) return;
      this.beforeSessionFlushTimer = setTimeout(() => {
        this.beforeSessionFlushTimer = null;
        void this.flushBeforeSessionSafely();
      }, 100);
      if (typeof this.beforeSessionFlushTimer.unref === "function") {
        this.beforeSessionFlushTimer.unref();
      }
    }
  }

  async start(): Promise<void> {
    await this.rpc.start();
  }

  async submit(input: CodexBridgeInput): Promise<CodexDispatch> {
    return await this.withReadySession(async () => {
      if (
        !this.arbiter ||
        (
          this.options.expectBootstrapPrompt === true &&
          this.bootstrapThreadId !== null &&
          this.bootstrapThreadId === this.threadId
        )
      ) {
        const duplicate = this.beforeSession.find((entry) =>
          entry.clientUserMessageId === input.clientUserMessageId
        );
        if (duplicate) {
          return {
            kind: "queued",
            queuePosition: this.beforeSession.indexOf(duplicate) + 1,
            reason: "unknown",
          };
        }
        const limit = this.options.maxQueue ?? 128;
        if (this.beforeSession.length >= limit) throw new CodexBridgeQueueFullError(limit);
        this.beforeSession.push(input);
        return { kind: "queued", queuePosition: this.beforeSession.length, reason: "unknown" };
      }
      const dispatch = await this.arbiter.submit(input);
      this.emitDispatch(input, dispatch);
      return dispatch;
    });
  }

  /**
   * Revoke an AgentParty input only while it is still on a pre-write queue.
   * This intentionally bypasses backend readiness: cancellation is local
   * bookkeeping needed while an AgentParty reconnect is reconciling ownership.
   */
  async cancelQueued(clientUserMessageId: string): Promise<boolean> {
    return await this.serializeSession(async () => {
      const beforeSessionIndex = this.beforeSession.findIndex((entry) =>
        entry.clientUserMessageId === clientUserMessageId
      );
      if (beforeSessionIndex >= 0) {
        this.beforeSession.splice(beforeSessionIndex, 1);
        if (this.beforeSession.length === 0 && this.beforeSessionFlushTimer !== null) {
          clearTimeout(this.beforeSessionFlushTimer);
          this.beforeSessionFlushTimer = null;
        }
        return true;
      }
      return await this.arbiter?.cancelQueued(clientUserMessageId) ?? false;
    });
  }

  turnForClientId(clientId: string): CodexTurn | null {
    const turnId = this.turnByClientId.get(clientId);
    return turnId ? this.turns.get(turnId) ?? null : null;
  }

  private async routeThreadResponse(
    method: string,
    result: unknown,
    params: Record<string, unknown>,
    options: { backendRestarted?: boolean; deferQueuedInputs?: boolean } = {},
  ): Promise<void> {
    if (method === "thread/read" && params.includeTurns !== true) return;
    const thread = responseThread(result);
    if (thread === null) {
      throw new Error(`${method} returned no valid thread`);
    }
    const expectedThreadId =
      (method === "thread/resume" || method === "thread/read" || method === "thread/rollback") &&
        typeof params.threadId === "string"
        ? params.threadId
        : null;
    if (expectedThreadId !== null && thread.id !== expectedThreadId) {
      throw new Error(`${method} returned thread ${thread.id}, expected ${expectedThreadId}`);
    }
    await this.attachThread(thread, options);
  }

  private async requestInitialThreadStart(params?: unknown): Promise<unknown> {
    if (this.initialThreadStart !== null) {
      throw new CodexRpcError(
        -32_002,
        "Cannot start a second Codex thread while the initial thread/start is pending",
      );
    }
    if (this.noThreadRecovery?.disposition === "unknown") {
      throw new CodexRpcError(
        -32_097,
        this.noThreadRecovery.reason,
      );
    }

    const record = paramsRecord(params);
    const attempt = initialThreadStartAttempt("initial thread/start", record);
    this.initialThreadStart = attempt;
    try {
      return await this.withReadySession(async () => {
        this.throwIfInitialThreadStartCancelled(attempt);
        attempt.phase = "writing";
        try {
          const result = await this.requestConnectedApplied(
            "thread/start",
            params,
            async (response) => {
              const thread = responseThread(response);
              if (thread === null) {
                throw new Error("thread/start returned no valid thread");
              }
              await this.attachThread(thread, {
                deferQueuedInputs: this.options.expectBootstrapPrompt === true,
              });
              this.bootstrapThreadId = this.threadId;
              this.bootstrapRecovery = {
                disposition: "restart_thread_with_prompt",
              };
              if (this.options.expectBootstrapPrompt !== true) {
                await this.flushBeforeSessionSafely();
              }
            },
          );
          attempt.outcome = "resume";
          return result;
        } catch (error) {
          if (disconnectedBeforeWrite(error)) {
            attempt.outcome = "restart";
            this.noThreadRecovery = { disposition: "restart" };
            throw new CodexInitialThreadStartRestartRequired(
              "Codex backend disconnected before the initial thread/start write",
            );
          }
          if (error instanceof CodexRpcDisconnectedError) {
            const reason =
              "Codex backend disconnected after the initial thread/start write; " +
              "its outcome is unknown, so the initial prompt will not be replayed";
            attempt.outcome = "unknown";
            attempt.unknownReason = reason;
            this.noThreadRecovery = { disposition: "unknown", reason };
          }
          throw error;
        }
      }, attempt);
    } finally {
      attempt.phase = "finished";
      if (this.initialThreadStart === attempt) this.initialThreadStart = null;
      attempt.finish();
    }
  }

  private async requestInitialPromptTurnStart(
    params: unknown,
    record: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.arbiter || this.threadId === null || this.bootstrapThreadId !== this.threadId) {
      throw new CodexRpcError(
        -32_002,
        "Cannot start the initial Codex prompt without its bootstrap thread",
      );
    }
    if (this.initialPromptStart !== null) {
      throw new CodexRpcError(
        -32_002,
        "Cannot start a second Codex prompt while the initial turn/start is pending",
      );
    }
    if (this.bootstrapRecovery?.disposition === "unknown") {
      throw new CodexRpcError(-32_097, this.bootstrapRecovery.reason);
    }

    const attempt = initialThreadStartAttempt("initial turn/start", record);
    this.initialPromptStart = attempt;
    try {
      return await this.withReadySession(async () => {
        const requestThreadId =
          typeof record.threadId === "string" ? record.threadId : null;
        if (
          !this.arbiter ||
          requestThreadId === null ||
          requestThreadId !== this.threadId ||
          requestThreadId !== this.bootstrapThreadId
        ) {
          throw new CodexRpcError(
            -32_002,
            requestThreadId === null
              ? "Cannot start the initial Codex prompt without an active thread id"
              : `Cannot run Codex turn/start for inactive thread ${requestThreadId}`,
          );
        }
        try {
          const result = await this.arbiter.runInteractiveMutation(
            "turn/start",
            record,
            async () => {
              this.checkSessionMutationGuards("turn/start");
              this.throwIfInitialThreadStartCancelled(attempt);
              attempt.phase = "writing";
              try {
                return await this.requestConnected("turn/start", params);
              } catch (error) {
                if (disconnectedBeforeWrite(error)) {
                  attempt.outcome = "restart";
                  this.bootstrapRecovery = {
                    disposition: "restart_thread_with_prompt",
                    initialInput: record.input,
                  };
                } else if (error instanceof CodexRpcDisconnectedError) {
                  const reason =
                    "Codex backend disconnected after the initial turn/start write; " +
                    "its outcome is unknown, so the initial prompt will not be replayed";
                  attempt.outcome = "unknown";
                  attempt.unknownReason = reason;
                  this.bootstrapRecovery = {
                    disposition: "unknown",
                    reason,
                    initialInput: record.input,
                  };
                }
                throw error;
              }
            },
          );
          attempt.outcome = "resume";
          this.bootstrapThreadId = null;
          this.bootstrapRecovery = null;
          await this.flushBeforeSessionSafely();
          return result;
        } catch (error) {
          if (disconnectedBeforeWrite(error)) {
            throw new CodexInitialThreadStartRestartRequired(
              "Codex backend disconnected before the initial turn/start write",
            );
          }
          throw error;
        }
      }, attempt);
    } finally {
      attempt.phase = "finished";
      if (this.initialPromptStart === attempt) this.initialPromptStart = null;
      attempt.finish();
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (method === "initialize") {
      await this.rpc.start();
      return this.rpc.initializeResult;
    }
    const record = paramsRecord(params);
    if (method === "thread/start" && this.threadId === null) {
      return await this.requestInitialThreadStart(params);
    }
    const requestThreadId = typeof record.threadId === "string" ? record.threadId : null;
    if (
      method === "turn/start" &&
      requestThreadId !== null &&
      requestThreadId === this.bootstrapThreadId
    ) {
      for (;;) {
        await this.waitForSessionMutationGuards("turn/start");
        try {
          return await this.requestInitialPromptTurnStart(params, record);
        } catch (error) {
          if (error instanceof CodexSessionMutationReadinessChanged) continue;
          throw error;
        }
      }
    }
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      return await this.withReadySession(async () => {
        if (this.threadId !== null) {
          const targetThreadId = method === "thread/fork"
            ? null
            : typeof record.threadId === "string"
              ? record.threadId
              : null;
          const switching =
            method === "thread/start" ||
            method === "thread/fork" ||
            targetThreadId !== this.threadId;
          if (switching) {
            for (const guard of this.threadSwitchGuards) {
              guard({
                method,
                currentThreadId: this.threadId,
                targetThreadId,
              });
            }
          }
        }
        return await this.requestConnectedApplied(
          method,
          params,
          async (result) => await this.routeThreadResponse(method, result, record),
        );
      });
    }

    if (method === "thread/rollback" || method === "thread/inject_items") {
      return await this.withReadySession(async () => {
        if (requestThreadId === null || requestThreadId !== this.threadId) {
          throw new CodexRpcError(
            -32_002,
            requestThreadId === null
              ? `Cannot run Codex ${method} without an active thread id`
              : `Cannot run Codex ${method} for inactive thread ${requestThreadId}`,
          );
        }
        for (const guard of this.threadSwitchGuards) {
          guard({
            method,
            currentThreadId: requestThreadId,
            targetThreadId: requestThreadId,
          });
        }
        if (method === "thread/rollback") {
          return await this.requestConnectedApplied(
            method,
            params,
            async (result) => await this.routeThreadResponse(method, result, record),
          );
        }
        return await this.requestConnected(method, params);
      });
    }
    if (INTERACTIVE_MUTATIONS.has(method as CodexInteractiveMutation)) {
      const mutation = method as CodexInteractiveMutation;
      for (;;) {
        await this.waitForSessionMutationGuards(mutation);
        try {
          return await this.withReadySession(async () => {
            if (!this.arbiter || requestThreadId === null || requestThreadId !== this.threadId) {
              throw new CodexRpcError(
                -32_002,
                requestThreadId === null
                  ? `Cannot run Codex ${method} without an active thread id`
                  : `Cannot run Codex ${method} for inactive thread ${requestThreadId}`,
              );
            }
            return await this.arbiter.runInteractiveMutation(
              mutation,
              record,
              () => {
                this.checkSessionMutationGuards(mutation);
                return this.requestConnected(method, params);
              },
            );
          });
        } catch (error) {
          if (error instanceof CodexSessionMutationReadinessChanged) continue;
          throw error;
        }
      }
    }

    if ((method === "thread/read" || method === "thread/resume") && requestThreadId === this.threadId) {
      return await this.withReadySession(async () =>
        await this.requestConnectedApplied(
          method,
          params,
          async (result) => await this.routeThreadResponse(method, result, record),
        )
      );
    }
    await this.ensureBackendReady();
    return await this.requestConnected(method, params);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    // The bridge owns the only backend initialize handshake. A reconnect uses
    // the same sequence before restoring the active thread.
    if (method === "initialized") return;
    await this.ensureBackendReady();
    await this.notifyConnected(method, params);
  }

  respond(id: JsonRpcId, result?: unknown, error?: JsonRpcResponse["error"]): void {
    this.rpc.respond(id, result, error);
  }

  private async handleBackendMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!("id" in message)) {
      const params = paramsRecord(message.params);
      const notificationThreadId = typeof params.threadId === "string" ? params.threadId : null;
      if (this.arbiter && notificationThreadId === this.threadId) {
        if (message.method === "turn/started") {
          const turn = asTurn(params.turn);
          if (turn) {
            const previous = this.turns.get(turn.id);
            const observedTurn =
              (turn.items?.length ?? 0) === 0 && (previous?.items?.length ?? 0) > 0
                ? { ...turn, items: [...previous!.items!] }
                : turn;
            this.observeTurnAgentMessages(observedTurn, false);
            const retainedTurn = this.storeTurn(observedTurn);
            for (const clientId of clientIds(retainedTurn)) {
              this.turnByClientId.set(clientId, turn.id);
              this.emitDispatch(
                { text: "observed AgentParty input", clientUserMessageId: clientId },
                { kind: "duplicate", turnId: turn.id },
              );
            }
            await this.arbiter.observeTurnStarted(
              observedTurn.id,
              clientIds(observedTurn),
            );
          }
        } else if (message.method === "turn/completed") {
          const turn = asTurn(params.turn);
          if (turn) {
            this.observeTurnAgentMessages(turn, true);
            const completedTurn = this.completedTurnWithAgentText(turn);
            for (const clientId of clientIds(completedTurn)) {
              this.turnByClientId.set(clientId, completedTurn.id);
            }
            this.emitCompleted(completedTurn);
            this.agentMessagesByTurn.delete(completedTurn.id);
            await this.arbiter.observeTurnCompleted(completedTurn.id);
          }
        } else if (
          message.method === "item/agentMessage/delta"
        ) {
          this.observeAgentMessageDelta(params);
        } else if (
          (message.method === "item/started" || message.method === "item/completed") &&
          typeof params.turnId === "string" &&
          isObject(params.item) &&
          typeof params.item.id === "string"
        ) {
          const item = asThreadItem(params.item)[0];
          if (item) this.observeTurnItem(params.turnId, item);
          if (item?.type === "userMessage" && typeof item.clientId === "string") {
            const knownTurnId = this.turnByClientId.get(item.clientId);
            this.turnByClientId.set(item.clientId, params.turnId);
            if (knownTurnId !== params.turnId) {
              this.emitDispatch(
                {
                  text: "observed AgentParty input",
                  clientUserMessageId: item.clientId,
                },
                { kind: "duplicate", turnId: params.turnId },
              );
              await this.arbiter.observeTurnStarted(params.turnId, [item.clientId]);
            }
          } else if (item?.type === "agentMessage") {
            this.observeAgentMessageItem(
              params.turnId,
              item,
              message.method === "item/completed",
              message.method === "item/started",
            );
          } else if (
            item?.type === "commandExecution" &&
            item.source === "userShell"
          ) {
            if (message.method === "item/started") {
              await this.arbiter.observeUserShellStarted(params.turnId, params.item.id);
            } else {
              await this.arbiter.observeUserShellCompleted(params.turnId, params.item.id);
            }
          }
        } else if (
          message.method === "thread/status/changed" &&
          isObject(params.status) &&
          params.status.type === "idle"
        ) {
          await this.arbiter.observeThreadIdle();
        }
      }
    }
    for (const listener of this.frontendListeners) {
      void Promise.resolve(listener(message)).catch((error) => {
        this.log(`codex-bridge: frontend notification failed: ${errorDetail(error)}`);
      });
    }
  }

  private recoveredBootstrapInput(initialInput: unknown): boolean {
    if (!Array.isArray(initialInput)) return false;
    const matches = [...this.turns.values()].flatMap((turn) =>
      (turn.items ?? []).filter((item) =>
        item.type === "userMessage" &&
        item.clientId === null &&
        sameJsonValue(item.content, initialInput)
      )
    );
    return matches.length === 1;
  }

  private async restoreGeneration(state: CodexRecoveryState): Promise<void> {
    let threadId = state.threadId;
    if (!threadId) {
      const initialStart = this.initialThreadStart;
      if (initialStart?.phase === "waiting") {
        // The old frontend request has not crossed the authoritative transport
        // write boundary. Cancel it before advertising that replaying the
        // original argv (including its positional prompt) is safe.
        this.cancelInitialThreadStart(initialStart);
      }
      if (initialStart) await initialStart.finished;
      this.assertRecoveryCurrent(state);
      threadId = this.threadId;
      if (!threadId) {
        const disposition = this.noThreadRecovery ?? { disposition: "restart" as const };
        const event: CodexFrontendRecovery = disposition.disposition === "unknown"
          ? {
            disposition: "unknown",
            threadId: null,
            generation: state.generation,
            reason: disposition.reason,
          }
          : {
            disposition: "restart",
            threadId: null,
            generation: state.generation,
          };
        for (const listener of this.frontendRecoveryListeners) {
          try {
            await listener(event);
          } catch (error) {
            this.log(`codex-bridge: frontend recovery listener failed: ${errorDetail(error)}`);
          }
          this.assertRecoveryCurrent(state);
        }
        this.log(
          event.disposition === "restart"
            ? `codex-bridge: app-server generation ${state.generation} is ready; ` +
              "the initial thread/start was proven not written"
            : `codex-bridge: app-server generation ${state.generation} is ready, but ` +
              "the initial thread/start outcome is unknown",
        );
        return;
      }
    }
    if (threadId === this.bootstrapThreadId) {
      const initialPrompt = this.initialPromptStart;
      if (initialPrompt?.phase === "waiting") {
        this.cancelInitialPromptStart(initialPrompt);
      }
      if (initialPrompt) await initialPrompt.finished;
      this.assertRecoveryCurrent(state);
    }
    await this.serializeSession(async () => {
      this.assertRecoveryCurrent(state);
      this.requestGenerationFence = state.generation;
      try {
        // A resume response is intentionally not applied on its own. Recovery
        // becomes authoritative only after resume and the full history read
        // both complete on this exact app-server process.
        const resumeResult = await this.requestConnected(
          "thread/resume",
          { threadId },
          state.generation,
        );
        this.assertRecoveryCurrent(state);
        requireRecoveryThreadIdentity(resumeResult, threadId, "thread/resume");
        await this.requestConnectedApplied(
          "thread/read",
          { threadId, includeTurns: true },
          async (result) => {
            this.assertRecoveryCurrent(state);
            const restoredThread = requireRecoveryThreadSnapshot(result, threadId);
            await this.attachThread(restoredThread, {
              backendRestarted: true,
              // A bootstrap prompt that is about to be replayed (or whose outcome
              // is still unknown) always retains priority over pre-attach delivery.
              deferQueuedInputs: this.bootstrapThreadId === threadId,
            });
            this.assertRecoveryCurrent(state);
          },
          state.generation,
        );
        this.assertRecoveryCurrent(state);

        let frontendEvent: CodexFrontendRecovery = {
          disposition: "resume",
          threadId,
          generation: state.generation,
        };
        if (this.bootstrapThreadId === threadId) {
          const bootstrap = this.bootstrapRecovery ?? {
            disposition: "restart_thread_with_prompt" as const,
          };
          if (bootstrap.disposition === "unknown") {
            if (this.recoveredBootstrapInput(bootstrap.initialInput)) {
              this.bootstrapThreadId = null;
              this.bootstrapRecovery = null;
              for (const turn of [...this.turns.values()]) {
                this.storeTurn(turn);
              }
              this.trimRetainedTurns();
              await this.flushBeforeSessionSafely();
              this.assertRecoveryCurrent(state);
            } else {
              frontendEvent = {
                disposition: "unknown",
                threadId,
                generation: state.generation,
                reason: bootstrap.reason,
              };
            }
          } else {
            frontendEvent = {
              disposition: "restart_thread_with_prompt",
              threadId,
              generation: state.generation,
              ...("initialInput" in bootstrap
                ? { initialInput: bootstrap.initialInput }
                : {}),
            };
          }
        }

        // A full scan can positively reconcile accepted client IDs. Absence is
        // deliberately not treated as proof of non-execution: a hard crash may
        // occur between an external side effect and durable history.
        const arbiter = this.threadId === threadId ? this.arbiter : null;
        if (arbiter) {
          for (const input of arbiter.unresolvedUnknownInputs()) {
            this.assertRecoveryCurrent(state);
            if (this.unresolvedUnknownListeners.size === 0) {
              this.log(
                `codex-bridge: unresolved transport outcome for ${input.clientUserMessageId}; ` +
                  "no delivery ledger is attached to record terminal-unknown",
              );
              continue;
            }
            for (const listener of this.unresolvedUnknownListeners) {
              try {
                await listener({ threadId, input });
              } catch (error) {
                this.log(
                  `codex-bridge: could not terminalize uncertain input ` +
                    `${input.clientUserMessageId}: ${errorDetail(error)}`,
                );
              }
              this.assertRecoveryCurrent(state);
            }
          }
        }
        this.assertRecoveryCurrent(state);
        for (const listener of this.frontendRecoveryListeners) {
          try {
            await listener(frontendEvent);
          } catch (error) {
            this.log(`codex-bridge: frontend recovery listener failed: ${errorDetail(error)}`);
          }
          this.assertRecoveryCurrent(state);
        }
        this.log(
          `codex-bridge: restored thread ${threadId} on app-server generation ${state.generation}`,
        );
      } finally {
        if (this.requestGenerationFence === state.generation) {
          this.requestGenerationFence = null;
        }
      }
    });
  }
}

function asTurn(value: unknown): CodexTurn | null {
  if (!isObject(value) || typeof value.id !== "string" || typeof value.status !== "string") return null;
  if (
    value.status !== "completed" &&
    value.status !== "interrupted" &&
    value.status !== "failed" &&
    value.status !== "inProgress"
  ) {
    return null;
  }
  return {
    id: value.id,
    status: value.status,
    ...(Array.isArray(value.items) ? { items: value.items.flatMap(asThreadItem) } : {}),
  };
}

function asThreadItem(value: unknown): CodexThreadItem[] {
  if (!isObject(value) || typeof value.type !== "string") return [];
  return [{
    ...value,
    type: value.type,
    ...(typeof value.clientId === "string" || value.clientId === null
      ? { clientId: value.clientId }
      : {}),
  }];
}

function jsonRpcError(error: unknown): JsonRpcResponse["error"] {
  if (error instanceof CodexRpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  if (
    error instanceof Error &&
    isObject(error) &&
    typeof error.code === "number"
  ) {
    return {
      code: error.code,
      message: error.message,
      ...("data" in error ? { data: error.data } : {}),
    };
  }
  if (error instanceof CodexRpcDisconnectedError) {
    return { code: -32_097, message: error.message };
  }
  return { code: -32_000, message: errorDetail(error) };
}

interface PendingFrontendServerRequest {
  backendId: JsonRpcId;
  frontendId: string;
  request: JsonRpcRequest;
}

export const CODEX_TUI_WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0;
// Codex's remote client accepts 128 MiB WebSocket messages. Its app-server
// legitimately returns multi-megabyte startup/list responses, so the bridge
// must not impose a smaller wire limit than the client it fronts.
export const CODEX_TUI_WEBSOCKET_MAX_FRAME_BYTES = 128 * 1_024 * 1_024;
export const CODEX_TUI_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES =
  CODEX_TUI_WEBSOCKET_MAX_FRAME_BYTES;
export const CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_MAX_BYTES =
  CODEX_TUI_WEBSOCKET_MAX_FRAME_BYTES + 1_024 * 1_024;
// Charge a conservative fixed cost per queued frame as well as its UTF-8
// payload. This bounds queue object overhead without treating an arbitrary
// message count as a protocol limit.
export const CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_ENTRY_COST_BYTES = 1_024;
// Bun's backpressure buffer and this bridge queue are independent. In the
// worst serialized-data case they can retain roughly 257 MiB combined before
// JavaScript string/object and native framing overhead, so surface a warning
// before the bridge-owned half reaches its hard limit.
const CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_WARNING_BYTES =
  Math.floor(CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_MAX_BYTES / 2);

/**
 * Private Unix WebSocket JSON-RPC endpoint used by
 * `codex --remote unix://PATH`.
 *
 * Codex app-server stdio is newline-delimited JSON, but the Unix transport is
 * WebSocket-framed. Keeping that boundary explicit avoids treating a raw Unix
 * stream as the remote protocol.
 * Exactly one TUI client is accepted at a time; a disconnected TUI can attach
 * again without replacing the backend app-server or AgentParty delivery loop.
 */
export class CodexUnixJsonRpcProxy {
  private static readonly MAX_PENDING_SERVER_REQUESTS = 128;
  private static readonly MAX_OUTBOUND_QUEUE_BYTES =
    CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_MAX_BYTES;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private socket: ServerWebSocket<{ connectionId: string }> | null = null;
  private frontendReady = false;
  private frontendInvalidated = false;
  private backendGeneration = 0;
  private nextFrontendRequestId = 0;
  private backpressuredSocket: ServerWebSocket<{ connectionId: string }> | null = null;
  private readonly outboundQueue: Array<{
    socket: ServerWebSocket<{ connectionId: string }>;
    payload: string;
    bytes: number;
  }> = [];
  private outboundQueueBytes = 0;
  private outboundQueueWarningEmitted = false;
  private readonly pendingServerRequestsByBackendId =
    new Map<string, PendingFrontendServerRequest>();
  private readonly pendingServerRequestsByFrontendId =
    new Map<string, PendingFrontendServerRequest>();
  private readonly unsubscribeMessages: () => void;
  private readonly unsubscribeReset: () => void;
  private readonly log: (line: string) => void;

  constructor(
    private readonly controller: CodexSessionController,
    options: { log?: (line: string) => void } = {},
  ) {
    this.log = terminalSafeLogger(options.log);
    this.unsubscribeMessages = controller.onFrontendMessage((message) => {
      let outbound: JsonRpcRequest | JsonRpcNotification = message;
      if ("id" in message) {
        const backendKey = rpcIdKey(message.id);
        const existing = this.pendingServerRequestsByBackendId.get(backendKey);
        if (
          !existing &&
          this.pendingServerRequestsByBackendId.size >=
            CodexUnixJsonRpcProxy.MAX_PENDING_SERVER_REQUESTS
        ) {
          this.log(
            `codex-bridge: refusing server request ${message.method}; TUI request replay queue is full`,
          );
          try {
            this.controller.respond(message.id, undefined, {
              code: -32_000,
              message: "Codex TUI request replay queue is full",
            });
          } catch (error) {
            this.log(`codex-bridge: failed to reject overflowed server request: ${errorDetail(error)}`);
          }
          return;
        }
        const frontendId = existing?.frontendId ??
          `agentparty-server:${this.backendGeneration}:${++this.nextFrontendRequestId}`;
        const pending = {
          backendId: message.id,
          frontendId,
          request: { ...message, id: frontendId },
        };
        this.pendingServerRequestsByBackendId.set(backendKey, pending);
        this.pendingServerRequestsByFrontendId.set(rpcIdKey(frontendId), pending);
        if (this.frontendReady) this.send(pending.request);
        return;
      } else if (message.method === "serverRequest/resolved") {
        const params = paramsRecord(message.params);
        const requestId = params.requestId;
        if (
          typeof requestId === "string" ||
          typeof requestId === "number" ||
          requestId === null
        ) {
          const pending = this.pendingServerRequestsByBackendId.get(rpcIdKey(requestId));
          if (pending) {
            outbound = {
              ...message,
              params: { ...params, requestId: pending.frontendId },
            };
            this.pendingServerRequestsByBackendId.delete(rpcIdKey(pending.backendId));
            this.pendingServerRequestsByFrontendId.delete(rpcIdKey(pending.frontendId));
          }
        }
      }
      if (this.frontendReady) this.send(outbound);
    });
    this.unsubscribeReset = controller.onFrontendReset(() => {
      // Request IDs belong to one app-server process. A cold backend reconnect
      // invalidates the old IDs; thread/resume will emit any still-pending
      // server requests with IDs owned by the new process.
      const staleRequests = [...this.pendingServerRequestsByBackendId.values()];
      this.backendGeneration += 1;
      this.pendingServerRequestsByBackendId.clear();
      this.pendingServerRequestsByFrontendId.clear();
      if (this.frontendReady) {
        for (const pending of staleRequests) {
          const threadId = paramsRecord(pending.request.params).threadId;
          // app-server's lifecycle cleanup notification is the protocol-defined
          // way to dismiss an approval/input prompt. A JSON-RPC error response
          // would travel in the wrong direction for a backend-initiated request.
          if (typeof threadId === "string") {
            this.send({
              method: "serverRequest/resolved",
              params: { threadId, requestId: pending.frontendId },
            });
          }
        }
      }
      if (this.socket) this.frontendInvalidated = true;
      this.frontendReady = false;
    });
  }

  get frontendAttached(): boolean {
    return this.socket !== null;
  }

  /**
   * Synchronously revoke the current frontend slot before a replacement TUI
   * can attach. Old socket callbacks/messages are fenced by object identity;
   * pending backend requests remain durable for replay to the replacement.
   */
  quiesceFrontend(reason = "Codex app-server backend restarted"): boolean {
    const socket = this.socket;
    if (!socket) return true;
    this.socket = null;
    this.frontendReady = false;
    this.frontendInvalidated = false;
    this.backpressuredSocket = null;
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    this.outboundQueueWarningEmitted = false;
    try {
      socket.close(1012, reason);
    } catch (error) {
      this.log(`codex-bridge: failed to close stale TUI socket: ${errorDetail(error)}`);
    }
    return this.socket === null;
  }

  private send(message: JsonRpcMessage): void {
    if (!this.socket) return;
    this.sendPayloadTo(this.socket, JSON.stringify(message));
  }

  private sendTo(
    socket: ServerWebSocket<{ connectionId: string }>,
    message: JsonRpcMessage,
  ): void {
    if (this.socket !== socket) return;
    this.sendPayloadTo(socket, JSON.stringify(message));
  }

  private sendPayloadTo(
    socket: ServerWebSocket<{ connectionId: string }>,
    payload: string,
  ): void {
    if (this.socket !== socket) return;
    const bytes = Buffer.byteLength(payload);
    if (bytes > CODEX_TUI_WEBSOCKET_MAX_FRAME_BYTES) {
      this.failFrontendSocket(
        socket,
        `Codex bridge JSON-RPC frame exceeded its ${CODEX_TUI_WEBSOCKET_MAX_FRAME_BYTES}-byte safety limit`,
      );
      return;
    }
    if (this.backpressuredSocket === socket) {
      const estimatedQueueBytes =
        this.outboundQueueBytes +
        bytes +
        (this.outboundQueue.length + 1) *
          CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_ENTRY_COST_BYTES;
      if (estimatedQueueBytes > CodexUnixJsonRpcProxy.MAX_OUTBOUND_QUEUE_BYTES) {
        this.failFrontendSocket(
          socket,
          `Codex bridge outbound queue exceeded its safety limit ` +
            `(entries=${this.outboundQueue.length}, bytes=${this.outboundQueueBytes}, ` +
            `incoming=${bytes}, estimated=${estimatedQueueBytes})`,
        );
        return;
      }
      if (
        !this.outboundQueueWarningEmitted &&
        estimatedQueueBytes >= CODEX_TUI_WEBSOCKET_OUTBOUND_QUEUE_WARNING_BYTES
      ) {
        this.outboundQueueWarningEmitted = true;
        this.log(
          `codex-bridge: outbound queue crossed its warning threshold ` +
            `(entries=${this.outboundQueue.length + 1}, ` +
            `bytes=${this.outboundQueueBytes + bytes}, ` +
            `estimated=${estimatedQueueBytes}, ` +
            `limit=${CodexUnixJsonRpcProxy.MAX_OUTBOUND_QUEUE_BYTES})`,
        );
      }
      this.outboundQueue.push({ socket, payload, bytes });
      this.outboundQueueBytes += bytes;
      return;
    }
    const status = socket.send(payload);
    if (status === -1) {
      // Bun already enqueued this payload. Pause subsequent writes until drain
      // instead of duplicating the backpressured frame.
      this.backpressuredSocket = socket;
      return;
    }
    if (status === 0) {
      // A dropped JSON-RPC response or approval must never be treated as sent.
      // Fail the transport visibly; durable backend requests remain mapped and
      // will replay if the user reattaches.
      this.failFrontendSocket(socket, "Codex bridge could not deliver a JSON-RPC frame");
    }
  }

  private failFrontendSocket(
    socket: ServerWebSocket<{ connectionId: string }>,
    reason: string,
  ): void {
    if (this.socket !== socket) return;
    this.frontendReady = false;
    this.backpressuredSocket = null;
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    this.outboundQueueWarningEmitted = false;
    this.log(`codex-bridge: ${reason}; closing the unhealthy TUI socket`);
    socket.close(1011, reason);
  }

  private drain(socket: ServerWebSocket<{ connectionId: string }>): void {
    if (this.socket !== socket || this.backpressuredSocket !== socket) return;
    this.backpressuredSocket = null;
    while (this.outboundQueue.length > 0 && this.socket === socket) {
      const next = this.outboundQueue.shift()!;
      this.outboundQueueBytes -= next.bytes;
      if (next.socket !== socket) continue;
      this.sendPayloadTo(socket, next.payload);
      if (this.backpressuredSocket === socket || this.socket !== socket) return;
    }
  }

  private flushPendingServerRequests(): void {
    if (!this.frontendReady) return;
    for (const pending of this.pendingServerRequestsByBackendId.values()) {
      this.send(pending.request);
    }
  }

  private async handleLine(
    line: string,
    socket: ServerWebSocket<{ connectionId: string }>,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.sendTo(socket, { id: null, error: { code: -32_700, message: "Parse error" } });
      return;
    }
    const message = asJsonRpcMessage(parsed);
    if (!message) {
      this.sendTo(socket, { id: null, error: { code: -32_600, message: "Invalid Request" } });
      return;
    }
    if (this.frontendInvalidated && !isRpcResponse(message)) {
      if ("id" in message) {
        this.sendTo(socket, {
          id: message.id,
          error: {
            code: -32_098,
            message: "Codex frontend must reattach after backend recovery",
          },
        });
      }
      return;
    }
    if (isRpcResponse(message)) {
      const key = rpcIdKey(message.id);
      const pending = this.pendingServerRequestsByFrontendId.get(key);
      if (!pending) {
        this.log(`codex-bridge: ignored response for unknown server request ${String(message.id)}`);
        return;
      }
      try {
        this.controller.respond(pending.backendId, message.result, message.error);
        this.pendingServerRequestsByBackendId.delete(rpcIdKey(pending.backendId));
        this.pendingServerRequestsByFrontendId.delete(key);
      } catch (error) {
        this.log(`codex-bridge: failed to forward server response: ${errorDetail(error)}`);
      }
      return;
    }
    if (!("id" in message)) {
      try {
        await this.controller.notify(message.method, message.params);
        if (message.method === "initialized" && this.socket === socket) {
          this.frontendReady = true;
          this.flushPendingServerRequests();
        }
      } catch (error) {
        this.log(`codex-bridge: failed to forward TUI notification ${message.method}: ${errorDetail(error)}`);
      }
      return;
    }
    try {
      const result = await this.controller.request(message.method, message.params);
      this.sendTo(socket, { id: message.id, result });
    } catch (error) {
      this.sendTo(socket, { id: message.id, error: jsonRpcError(error) });
    }
  }

  private accept(socket: ServerWebSocket<{ connectionId: string }>): void {
    if (this.socket) {
      socket.close(1008, "one Codex TUI is already attached");
      this.log("codex-bridge: rejected a second TUI connection; one interactive writer is already attached");
      return;
    }
    this.socket = socket;
    this.frontendReady = false;
    this.frontendInvalidated = false;
    this.backpressuredSocket = null;
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    this.outboundQueueWarningEmitted = false;
  }

  async listen(socketPath: string): Promise<void> {
    if (this.server) throw new Error("Codex Unix proxy is already listening");
    const self = this;
    this.server = Bun.serve<{ connectionId: string }>({
      unix: socketPath,
      fetch(request, server) {
        if (server.upgrade(request, {
          data: { connectionId: crypto.randomUUID() },
        })) {
          return;
        }
        return new Response("Codex app-server bridge requires WebSocket upgrade", { status: 426 });
      },
      websocket: {
        // The official Codex remote client does not send application pings.
        // A session bridge must remain attached while a user or approval is
        // legitimately quiet for longer than Bun's 120-second default.
        idleTimeout: CODEX_TUI_WEBSOCKET_IDLE_TIMEOUT_SECONDS,
        // Match Codex remote's explicit per-frame ceiling. A legitimate
        // app-server response can exceed both Bun's smaller defaults and the
        // proxy's former 1 MiB queue cap; the second bounded queue absorbs a
        // short burst while drain catches up.
        maxPayloadLength: CODEX_TUI_WEBSOCKET_MAX_FRAME_BYTES,
        backpressureLimit: CODEX_TUI_WEBSOCKET_BACKPRESSURE_LIMIT_BYTES,
        closeOnBackpressureLimit: false,
        open(socket) {
          self.accept(socket);
        },
        message(socket, message) {
          if (self.socket !== socket) return;
          if (typeof message !== "string") {
            self.sendTo(socket, {
              id: null,
              error: { code: -32_600, message: "Codex JSON-RPC frames must be text" },
            });
            return;
          }
          void self.handleLine(message, socket);
        },
        drain(socket) {
          self.drain(socket);
        },
        close(socket) {
          if (self.socket !== socket) return;
          self.socket = null;
          self.frontendReady = false;
          self.frontendInvalidated = false;
          self.backpressuredSocket = null;
          self.outboundQueue.length = 0;
          self.outboundQueueBytes = 0;
          self.outboundQueueWarningEmitted = false;
          self.log("codex-bridge: TUI disconnected; bridge remains ready for the same session to reattach");
        },
      },
    });
    chmodSync(socketPath, 0o600);
  }

  async close(): Promise<void> {
    this.unsubscribeMessages();
    this.unsubscribeReset();
    this.pendingServerRequestsByBackendId.clear();
    this.pendingServerRequestsByFrontendId.clear();
    this.socket?.close(1001, "AgentParty bridge stopped");
    this.socket = null;
    this.frontendInvalidated = false;
    this.backpressuredSocket = null;
    this.outboundQueue.length = 0;
    this.outboundQueueBytes = 0;
    this.outboundQueueWarningEmitted = false;
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.stop(true);
  }
}

type BridgeConnection = Pick<Connection, "frames" | "send" | "ack" | "close" | "cursor">;
type DeliveryUpdateFrame = Extract<ClientFrame, { type: "delivery_update" }>;
type AuthoritativeDeliveryState =
  Extract<ServerFrame, { type: "delivery_state" }>["delivery"]["state"];

interface PendingDeliveryAck {
  deliveryId: string;
  state: DeliveryUpdateFrame["state"];
  resolve: (state: AuthoritativeDeliveryState) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingDeliveryRecovery {
  deliveryId: string;
  resolve: (frame: DeliveryRecoveryResultFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingCodexDelivery {
  message: MsgFrame;
  delivery: DirectedDelivery | null;
  clientId: string;
  turnId: string | null;
  threadId: string | null;
  renewTimer: ReturnType<typeof setInterval> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  settling: boolean;
  terminalError: string | null;
  replyIdempotencyKey: string;
  replyBody: string | null;
  replySeq: number | null;
  continuationKey: string | null;
  continuationSourceDeliveryId: string | null;
  /**
   * AgentParty welcome generation that positively authorized the next
   * pre-harness app-server write. Reconnect increments the bridge generation
   * synchronously, invalidating every queued input before recovery awaits I/O.
   */
  authorizationGeneration: number;
}

interface ParkedCodexContinuation {
  key: string;
  workId: string;
  continuationRef: string;
  sourceDeliveryId: string;
  sourceMessageSeq: number;
  threadId: string;
}

export interface CodexAgentPartyBridgeOptions {
  channel: string;
  connection: BridgeConnection;
  session: CodexAgentPartySession;
  postReply: (reply: {
    body: string;
    mentions: string[];
    replyTo: number;
    idempotencyKey: string;
  }) => Promise<{ seq: number }>;
  leaseRenewIntervalMs?: number;
  deliveryAckTimeoutMs?: number;
  retryDelayMs?: number;
  recoveryJournal?: DeliveryRecoveryJournal;
  /** Production refuses a Worker that cannot CAS-recover private ownership. */
  requireDeliveryRecovery?: boolean;
  /** Test/embedding seam; production uses request_id + delivery_state. */
  confirmDeliveryUpdate?: (
    update: DeliveryUpdateFrame,
  ) => Promise<AuthoritativeDeliveryState | void>;
  log?: (line: string) => void;
}

/**
 * The delivery ledger needs a small session-facing contract. The classic
 * bridge implements it with a directly owned app-server connection; the
 * native ChatGPT bridge implements it through codex_app tools on Desktop's
 * existing app-server.
 */
export interface CodexAgentPartySession {
  readonly activeThreadId: string | null;
  onDispatch(listener: DispatchListener): () => void;
  onTurnCompleted(listener: CompletedTurnListener): () => void;
  onThreadSwitch(listener: ThreadSwitchGuard): () => void;
  onSessionMutation(listener: SessionMutationGuard): () => void;
  onUnresolvedUnknown(listener: UnresolvedUnknownListener): () => void;
  abandonUnknownOutcome(threadId: string, input: CodexBridgeInput): Promise<CodexDispatch>;
  cancelQueued(clientUserMessageId: string): Promise<boolean>;
  submit(input: CodexBridgeInput): Promise<CodexDispatch>;
  turnForClientId(clientId: string): CodexTurn | null;
}

function deliveryUpdate(
  delivery: DirectedDelivery,
  state: "running" | "replied" | "failed",
  extra: { replySeq?: number; error?: string } = {},
): DeliveryUpdateFrame {
  return {
    type: "delivery_update",
    delivery_id: delivery.id,
    state,
    attempt: delivery.attempt,
    ...(delivery.lease_epoch === undefined ? {} : { lease_epoch: delivery.lease_epoch }),
    ...(delivery.lease_token === undefined ? {} : { lease_token: delivery.lease_token }),
    ...(delivery.work_id === null ? {} : { work_id: delivery.work_id }),
    ...(delivery.continuation_ref === null ? {} : { continuation_ref: delivery.continuation_ref }),
    ...(extra.replySeq === undefined ? {} : { reply_seq: extra.replySeq }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
  };
}

function codexInput(
  channel: string,
  message: MsgFrame,
  delivery: DirectedDelivery | null,
): CodexBridgeInput {
  const clientId = `agentparty:${delivery?.id ?? `${channel}:${message.seq}`}`;
  return {
    clientUserMessageId: clientId,
    text:
      `AgentParty message in #${channel} from @${message.sender.name} (seq=${message.seq}):\n\n` +
      `${message.body}\n\n` +
      "Answer this message in the current Codex session. AgentParty will persist the final answer as a linked reply.",
    metadata: {
      source: "agentparty",
      channel,
      seq: String(message.seq),
      sender: message.sender.name,
      ...(delivery === null
        ? {}
        : {
            delivery_id: delivery.id,
            delivery_cause: delivery.cause,
            ...(delivery.work_id === null ? {} : { work_id: delivery.work_id }),
            ...(delivery.continuation_ref === null
              ? {}
              : { continuation_ref: delivery.continuation_ref }),
          }),
    },
  };
}

function replyIdempotencyKey(
  channel: string,
  message: MsgFrame,
  delivery: DirectedDelivery | null,
): string {
  return delivery === null
    ? `codex-bridge-reply:${channel}:${message.seq}`
    : `codex-bridge-reply:${delivery.id}`;
}

function continuationKey(delivery: DirectedDelivery): string | null {
  if (delivery.work_id === null || delivery.continuation_ref === null) return null;
  return `${delivery.work_id}\u0000${delivery.continuation_ref}`;
}

type AgentMessageItem = CodexThreadItem & { text: string };

function agentMessageItems(turn: CodexTurn | null | undefined): AgentMessageItem[] {
  return (turn?.items ?? []).filter((item): item is AgentMessageItem =>
    item.type === "agentMessage" &&
    typeof item.text === "string" &&
    item.text.trim() !== ""
  );
}

function finalAgentItem(items: AgentMessageItem[]): AgentMessageItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.text.trim() !== "" && item.phase === "final_answer") return item;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.text.trim() !== "" && item.phase !== "commentary") return item;
  }
  return null;
}

function finalAgentText(turn: CodexTurn): string | null {
  return finalAgentItem(agentMessageItems(turn))?.text.trim() || null;
}

class CodexDeliveryConnectionReplacedError extends Error {}
class CodexDeliveryAuthorizationStaleError extends CodexRetryableBeforeWriteError {}

/**
 * AgentParty delivery ledger for the Codex session.
 *
 * A successful turn/start or turn/steer is only an accepted wake. Directed
 * delivery remains running until the corresponding turn completes and the
 * linked REST reply succeeds.
 */
export class CodexAgentPartyBridge {
  private self = "";
  private directedDeliveryMode = false;
  private exitCode = 0;
  private intentionalClose = false;
  private readonly pending = new Map<string, PendingCodexDelivery>();
  private readonly parkedContinuations = new Map<string, ParkedCodexContinuation>();
  private readonly completedContinuationKeys = new Set<string>();
  private readonly settledDeliveryIds = new Set<string>();
  private readonly seenPlainSeqs = new Set<number>();
  private readonly deliveryAcks = new Map<string, PendingDeliveryAck>();
  private readonly deliveryRecoveries = new Map<string, PendingDeliveryRecovery>();
  private readonly log: (line: string) => void;
  private readonly unsubscribeDispatch: () => void;
  private readonly unsubscribeCompleted: () => void;
  private readonly unsubscribeThreadSwitch: () => void;
  private readonly unsubscribeSessionMutation: () => void;
  private readonly unsubscribeUnresolvedUnknown: () => void;
  private frameWork: Promise<void> = Promise.resolve();
  private recoveryWork: Promise<void> = Promise.resolve();
  private welcomeGeneration = 0;
  private recoveryReadyGeneration = -1;
  private recoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryRetryAttempt = 0;
  private recoveryPassGeneration: number | null = null;
  private recoveryPassDirty = false;
  private readonly recoveryReadyWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  constructor(private readonly options: CodexAgentPartyBridgeOptions) {
    if (options.requireDeliveryRecovery === true && options.recoveryJournal === undefined) {
      throw new Error("Codex delivery recovery requires a durable recovery journal");
    }
    this.log = terminalSafeLogger(options.log);
    this.unsubscribeDispatch = options.session.onDispatch((input, dispatch) => {
      this.observeDispatch(input, dispatch);
    });
    this.unsubscribeCompleted = options.session.onTurnCompleted((turn) => this.settleTurn(turn));
    this.unsubscribeThreadSwitch = options.session.onThreadSwitch(({ currentThreadId, method }) => {
      const durableObligations = this.options.recoveryJournal?.entries().length ?? 0;
      const obligations = Math.max(
        durableObligations,
        this.pending.size + this.parkedContinuations.size,
      );
      if (obligations === 0) return;
      const action = method === "thread/rollback" || method === "thread/inject_items"
        ? `mutate the history of Codex thread ${currentThreadId} with ${method}`
        : `leave Codex thread ${currentThreadId}`;
      throw new CodexRpcError(
        -32_002,
        `Cannot ${action} while ${obligations} AgentParty ` +
        `deliver${obligations === 1 ? "y is" : "ies are"} still pending or parked`,
      );
    });
    this.unsubscribeSessionMutation = options.session.onSessionMutation(({ mode }) => {
      const durableObligations = this.options.recoveryJournal?.entries().length ?? 0;
      if (
        durableObligations === 0 ||
        this.recoveryReadyGeneration === this.welcomeGeneration
      ) {
        return;
      }
      if (mode === "check") {
        throw new CodexSessionMutationReadinessChanged(
          "AgentParty ownership recovery changed before the Codex write boundary",
        );
      }
      return this.waitForRecoveryReady();
    });
    this.unsubscribeUnresolvedUnknown = options.session.onUnresolvedUnknown(
      async ({ threadId, input }) => {
        const pending = this.pending.get(input.clientUserMessageId);
        if (!pending) {
          throw new Error(
            `no AgentParty delivery ledger exists for ${input.clientUserMessageId}`,
          );
        }
        pending.threadId ??= threadId;
        if (pending.renewTimer) clearInterval(pending.renewTimer);
        pending.renewTimer = null;
        if (pending.delivery) {
          this.options.recoveryJournal?.update(pending.delivery.id, {
            threadId: pending.threadId,
          });
        }
        // Absence from a cold resume/read is not proof that an after-write
        // input had no effect. Release the arbiter's global writer fence so
        // unrelated work can proceed, but retain the delivery WAL and exact
        // bearer token for a later authoritative turn/completed event.
        await this.options.session.abandonUnknownOutcome(threadId, input);
        this.log(
          `codex-bridge: preserved unknown post-write delivery ` +
            `${pending.delivery?.id ?? pending.clientId} for late reply; input was not replayed`,
        );
      },
    );
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get parkedContinuationCount(): number {
    return this.parkedContinuations.size;
  }

  /**
   * Fence queued app-server writes at websocket transport loss, not only when
   * the next welcome eventually arrives. Worker ownership may already have
   * expired while Codex backend notifications continue to flush local queues.
   */
  handleConnectionStatus(status: "open" | "reconnecting" | "closed"): void {
    if (status === "open") return;
    this.welcomeGeneration += 1;
    this.recoveryReadyGeneration = -1;
    if (this.recoveryRetryTimer !== null) {
      clearTimeout(this.recoveryRetryTimer);
      this.recoveryRetryTimer = null;
    }
    for (const [requestId, pending] of this.deliveryAcks) {
      clearTimeout(pending.timer);
      pending.reject(new CodexDeliveryConnectionReplacedError(
        "AgentParty websocket disconnected before the delivery acknowledgement arrived",
      ));
      this.deliveryAcks.delete(requestId);
    }
    for (const [requestId, pending] of this.deliveryRecoveries) {
      clearTimeout(pending.timer);
      pending.reject(new CodexDeliveryConnectionReplacedError(
        "AgentParty websocket disconnected before ownership recovery completed",
      ));
      this.deliveryRecoveries.delete(requestId);
    }
    for (const pending of this.pending.values()) {
      if (pending.renewTimer) clearInterval(pending.renewTimer);
      pending.renewTimer = null;
    }
  }

  private async waitForRecoveryReady(): Promise<void> {
    if (this.recoveryReadyGeneration === this.welcomeGeneration) return;
    await new Promise<void>((resolve, reject) => {
      this.recoveryReadyWaiters.add({ resolve, reject });
    });
  }

  private releaseRecoveryReadyWaiters(): void {
    for (const waiter of this.recoveryReadyWaiters) waiter.resolve();
    this.recoveryReadyWaiters.clear();
  }

  private rejectRecoveryReadyWaiters(error: Error): void {
    for (const waiter of this.recoveryReadyWaiters) waiter.reject(error);
    this.recoveryReadyWaiters.clear();
  }

  private rememberBounded<T extends string | number>(set: Set<T>, value: T): void {
    set.add(value);
    if (set.size <= 4_096) return;
    const oldest = set.values().next().value as T | undefined;
    if (oldest !== undefined) set.delete(oldest);
  }

  private clearPending(clientId: string): PendingCodexDelivery | null {
    const pending = this.pending.get(clientId) ?? null;
    if (!pending) return null;
    // Invalidate synchronously before the asynchronous local queue removal.
    // A backend notification may already be trying to flush this input.
    pending.authorizationGeneration = -1;
    if (pending.renewTimer) clearInterval(pending.renewTimer);
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
    this.pending.delete(clientId);
    void this.options.session.cancelQueued(clientId).catch((error) => {
      this.log(
        `codex-bridge: could not remove revoked queued input ${clientId}: ${errorDetail(error)}`,
      );
    });
    return pending;
  }

  private createPending(
    message: MsgFrame,
    delivery: DirectedDelivery | null,
    threadId: string | null,
    continuation: string | null,
    continuationSourceDeliveryId: string | null = null,
  ): PendingCodexDelivery {
    const input = codexInput(this.options.channel, message, delivery);
    return {
      message,
      delivery,
      clientId: input.clientUserMessageId,
      turnId: null,
      threadId,
      renewTimer: null,
      retryTimer: null,
      retryAttempt: 0,
      settling: false,
      terminalError: null,
      replyIdempotencyKey: replyIdempotencyKey(this.options.channel, message, delivery),
      replyBody: null,
      replySeq: null,
      continuationKey: continuation,
      continuationSourceDeliveryId,
      authorizationGeneration: delivery === null ? this.welcomeGeneration : -1,
    };
  }

  private inputForPending(pending: PendingCodexDelivery): CodexBridgeInput {
    const input = codexInput(this.options.channel, pending.message, pending.delivery);
    const delivery = pending.delivery;
    const journal = this.options.recoveryJournal;
    if (delivery === null || journal === undefined) return input;
    const assertWriteAuthorized = () => {
      if (
        this.pending.get(pending.clientId) !== pending ||
        pending.authorizationGeneration !== this.welcomeGeneration
      ) {
        throw new CodexDeliveryAuthorizationStaleError(
          `AgentParty delivery ${delivery.id} must complete current ownership recovery before write`,
        );
      }
    };
    return {
      ...input,
      beforeWrite: () => {
        assertWriteAuthorized();
        const activeThreadId = this.options.session.activeThreadId;
        if (activeThreadId === null) {
          throw new Error(
            `cannot write AgentParty delivery ${delivery.id} without an active Codex thread`,
          );
        }
        if (pending.threadId !== null && pending.threadId !== activeThreadId) {
          throw new Error(
            `AgentParty delivery ${delivery.id} is bound to Codex thread ` +
              `${pending.threadId}, not active thread ${activeThreadId}`,
          );
        }
        // A delivery may be queued before the TUI attaches. Capture the
        // authoritative thread at the single-writer boundary, before the WAL
        // crosses harness_issued and before turn/start or turn/steer is sent.
        // A crash after the transport write can then cold-resume this exact
        // thread without replaying the input.
        pending.threadId = activeThreadId;
        try {
          journal.update(delivery.id, {
            phase: "harness_issued",
            threadId: activeThreadId,
          });
        } catch (error) {
          throw new CodexRetryableBeforeWriteError(
            `could not durably authorize Codex write for ${delivery.id}: ${errorDetail(error)}`,
            { cause: error },
          );
        }
      },
      checkWriteAuthorized: assertWriteAuthorized,
      onWriteRejected: () => {
        journal.update(delivery.id, {
          phase: "running_authorized",
          threadId: pending.threadId,
          turnId: null,
        });
      },
    };
  }

  private restorePending(entry: DeliveryRecoveryEntry): PendingCodexDelivery {
    const clientId = `agentparty:${entry.delivery.id}`;
    const existing = this.pending.get(clientId);
    if (existing) {
      if (existing.renewTimer) clearInterval(existing.renewTimer);
      existing.renewTimer = null;
      existing.delivery = entry.delivery;
      existing.threadId = entry.threadId;
      existing.turnId = entry.turnId;
      existing.replyBody = entry.replyBody;
      existing.replySeq = entry.replySeq;
      existing.terminalError = entry.terminalError;
      existing.continuationSourceDeliveryId =
        entry.delivery.cause === "owner_answer"
          ? entry.message.decision_response?.delivery_id ?? null
          : null;
      return existing;
    }
    const pending = this.createPending(
      entry.message,
      entry.delivery,
      entry.threadId,
      entry.delivery.cause === "owner_answer" ? continuationKey(entry.delivery) : null,
      entry.delivery.cause === "owner_answer"
        ? entry.message.decision_response?.delivery_id ?? null
        : null,
    );
    pending.turnId = entry.turnId;
    pending.replyBody = entry.replyBody;
    pending.replySeq = entry.replySeq;
    pending.terminalError = entry.terminalError;
    this.pending.set(clientId, pending);
    return pending;
  }

  private prepareJournalRecovery(
    journal: DeliveryRecoveryJournal,
    deliveryId: string,
  ): { entry: DeliveryRecoveryEntry; frame: DeliveryRecoverFrame } {
    const current = journal.get(deliveryId);
    if (current === null) throw new Error(`no recovery journal entry for ${deliveryId}`);
    // Codex task content crosses the harness boundary as soon as submit is
    // issued. Only the two phases strictly before submit may ask Worker to
    // revive an exact terminal_unknown assignment.
    const replaySafe =
      current.phase === "claimed" || current.phase === "running_authorized";
    const frame = journal.prepareRecovery(deliveryId, {
      replaySafe,
      expected: {
        phase: current.phase,
        updatedAt: current.updatedAt,
        attempt: current.delivery.attempt,
        leaseEpoch: current.delivery.lease_epoch!,
        leaseToken: current.delivery.lease_token!,
      },
    });
    const prepared = journal.get(deliveryId);
    if (prepared === null || prepared.nextLeaseToken !== frame.next_lease_token) {
      throw new Error(`delivery ${deliveryId} changed while recovery was being prepared`);
    }
    return { entry: prepared, frame };
  }

  private startLeaseRenewal(pending: PendingCodexDelivery): void {
    if (
      pending.delivery === null ||
      (pending.delivery.state !== "claimed" && pending.delivery.state !== "running") ||
      pending.renewTimer !== null ||
      pending.settling ||
      pending.terminalError !== null ||
      !this.pending.has(pending.clientId)
    ) {
      return;
    }
    const interval = this.options.leaseRenewIntervalMs ??
      Math.floor(DIRECTED_DELIVERY_LEASE_MS / 2);
    pending.renewTimer = setInterval(() => {
      const delivery = pending.delivery;
      if (
        delivery === null ||
        !this.pending.has(pending.clientId) ||
        pending.settling ||
        pending.terminalError !== null
      ) {
        return;
      }
      void this.confirmDeliveryUpdate(deliveryUpdate(delivery, "running")).catch((error) => {
        this.log(
          `codex-bridge: delivery ${delivery.id} lease renewal was not confirmed: ` +
            errorDetail(error),
        );
      });
    }, interval);
    if (typeof pending.renewTimer.unref === "function") pending.renewTimer.unref();
  }

  private scheduleRetry(
    pending: PendingCodexDelivery,
    operation: () => Promise<void>,
  ): void {
    if (pending.retryTimer || !this.pending.has(pending.clientId)) return;
    const base = this.options.retryDelayMs ?? 1_000;
    const delay = Math.min(30_000, Math.max(1, base) * 2 ** Math.min(pending.retryAttempt, 5));
    pending.retryAttempt += 1;
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      void operation().catch((error) => {
        this.log(
          `codex-bridge: pending delivery retry failed for seq=${pending.message.seq}: ` +
            errorDetail(error),
        );
      });
    }, delay);
    if (typeof pending.retryTimer.unref === "function") pending.retryTimer.unref();
  }

  private async confirmDeliveryUpdate(
    update: DeliveryUpdateFrame,
  ): Promise<AuthoritativeDeliveryState> {
    if (this.options.confirmDeliveryUpdate) {
      return await this.options.confirmDeliveryUpdate(update) ?? update.state;
    }
    const requestId = randomUUID();
    const timeoutMs = this.options.deliveryAckTimeoutMs ?? 5_000;
    return await new Promise<AuthoritativeDeliveryState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deliveryAcks.delete(requestId);
        reject(new Error(`delivery update acknowledgement timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.deliveryAcks.set(requestId, {
        deliveryId: update.delivery_id,
        state: update.state,
        resolve: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      if (!this.options.connection.send({ ...update, request_id: requestId })) {
        this.deliveryAcks.delete(requestId);
        clearTimeout(timer);
        reject(new Error("AgentParty websocket is not open"));
      }
    });
  }

  private observeDeliveryAck(incoming: Extract<ServerFrame, { type: "delivery_state" }>): void {
    if (!incoming.request_id) {
      this.reconcileUnsolicitedDeliveryState(incoming);
      return;
    }
    const pending = this.deliveryAcks.get(incoming.request_id);
    if (!pending || pending.deliveryId !== incoming.delivery.id) return;
    this.deliveryAcks.delete(incoming.request_id);
    if (
      incoming.delivery.state === pending.state ||
      (pending.state === "replied" &&
        (incoming.delivery.state === "replied" || incoming.delivery.state === "waiting_owner"))
    ) {
      pending.resolve(incoming.delivery.state);
      return;
    }
    pending.reject(
      new Error(`delivery state is ${incoming.delivery.state}, expected ${pending.state}`),
    );
  }

  private reconcileUnsolicitedDeliveryState(
    incoming: Extract<ServerFrame, { type: "delivery_state" }>,
  ): void {
    const journal = this.options.recoveryJournal;
    const stored = journal?.get(incoming.delivery.id) ?? null;
    if (!journal || !stored) return;
    try {
      if (incoming.delivery.state === "replied") {
        journal.remove(incoming.delivery.id);
        this.clearPending(`agentparty:${incoming.delivery.id}`);
        for (const [key, parked] of this.parkedContinuations) {
          if (parked.sourceDeliveryId === incoming.delivery.id) {
            this.parkedContinuations.delete(key);
          }
        }
        this.rememberBounded(this.settledDeliveryIds, incoming.delivery.id);
        if (journal.entries().length === 0) {
          this.recoveryReadyGeneration = this.welcomeGeneration;
          this.releaseRecoveryReadyWaiters();
        }
        return;
      }
      if (incoming.delivery.state === "failed") {
        // Public state intentionally omits terminal_reason. In particular,
        // failed/unknown_outcome may still be replay-safe before the harness
        // boundary or must retain late-reply debt after it. Fence writers and
        // ask the token-bearing recovery protocol to classify it.
        const pending = this.pending.get(`agentparty:${incoming.delivery.id}`);
        if (pending) pending.authorizationGeneration = -1;
        this.recoveryReadyGeneration = -1;
        this.queueJournalRecovery(this.welcomeGeneration);
        return;
      }
      if (
        incoming.delivery.state === "waiting_owner" &&
        stored.replyBody !== null &&
        (stored.phase === "reply_posted" || stored.phase === "waiting_owner")
      ) {
        const entry = journal.update(incoming.delivery.id, {
          phase: "waiting_owner",
          delivery: {
            ...stored.delivery,
            state: "waiting_owner",
            reply_seq: incoming.delivery.reply_seq ?? stored.replySeq,
            lease_until: null,
          },
          replySeq: incoming.delivery.reply_seq ?? stored.replySeq,
        });
        this.clearPending(`agentparty:${incoming.delivery.id}`);
        this.restoreParkedContinuation(entry);
      }
    } catch (error) {
      this.log(
        `codex-bridge: could not reconcile authoritative delivery state for ` +
          `${incoming.delivery.id}: ${errorDetail(error)}`,
      );
      this.scheduleJournalRecoveryRetry(this.welcomeGeneration);
    }
  }

  private async confirmDeliveryRecovery(
    recovery: DeliveryRecoverFrame,
  ): Promise<DeliveryRecoveryResultFrame> {
    const timeoutMs = this.options.deliveryAckTimeoutMs ?? 5_000;
    return await new Promise<DeliveryRecoveryResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.deliveryRecoveries.delete(recovery.request_id);
        reject(new Error(`delivery recovery acknowledgement timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.deliveryRecoveries.set(recovery.request_id, {
        deliveryId: recovery.delivery_id,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      if (!this.options.connection.send(recovery)) {
        this.deliveryRecoveries.delete(recovery.request_id);
        clearTimeout(timer);
        reject(new Error("AgentParty websocket is not open"));
      }
    });
  }

  private observeDeliveryRecovery(incoming: DeliveryRecoveryResultFrame): void {
    const pending = this.deliveryRecoveries.get(incoming.request_id);
    if (!pending || pending.deliveryId !== incoming.delivery_id) return;
    this.deliveryRecoveries.delete(incoming.request_id);
    pending.resolve(incoming);
  }

  private async settleRecoveredReply(pending: PendingCodexDelivery): Promise<void> {
    if (pending.replyBody === null || pending.delivery === null) return;
    if (pending.settling || !this.pending.has(pending.clientId)) return;
    pending.settling = true;
    if (pending.renewTimer) clearInterval(pending.renewTimer);
    pending.renewTimer = null;
    try {
      if (pending.replySeq === null) {
        const posted = await this.options.postReply({
          body: pending.replyBody,
          mentions: [pending.message.sender.name],
          replyTo: pending.message.seq,
          idempotencyKey: pending.replyIdempotencyKey,
        });
        pending.replySeq = posted.seq;
        try {
          this.options.recoveryJournal?.update(pending.delivery.id, {
            phase: "reply_posted",
            replyBody: pending.replyBody,
            replySeq: posted.seq,
          });
        } catch (error) {
          // A stable idempotency key makes the REST result safe to ask for
          // again, but the in-memory sequence must not outrun durable recovery.
          pending.replySeq = null;
          throw error;
        }
      }
      const replySeq = pending.replySeq;
      if (replySeq === null) throw new Error("recovered reply has no persisted sequence");
      const state = await this.confirmDeliveryUpdate(deliveryUpdate(pending.delivery, "replied", {
        replySeq,
      }));
      if (state === "waiting_owner") {
        const parked = this.parkContinuation(pending);
        if (parked !== null) {
          this.options.recoveryJournal?.update(pending.delivery.id, {
            phase: "waiting_owner",
            delivery: {
              ...pending.delivery,
              state: "waiting_owner",
              reply_seq: replySeq,
            },
            threadId: parked.threadId,
            turnId: pending.turnId,
            replyBody: pending.replyBody,
            replySeq,
          });
        } else {
          // The owner answer already completed while this source ACK was in
          // flight. Persistently discard the late source obligation before
          // clearing pending, otherwise a restart could resurrect it.
          this.options.recoveryJournal?.remove(pending.delivery.id);
        }
      } else if (state !== "replied") {
        throw new Error(`delivery state is ${state}, expected replied or waiting_owner`);
      }
      if (state !== "waiting_owner") this.removeSettledJournalEntries(pending);
      const completed = this.clearPending(pending.clientId);
      if (completed?.delivery) {
        this.rememberBounded(this.settledDeliveryIds, completed.delivery.id);
        if (state === "replied") this.releaseParkedContinuation(completed);
      }
    } catch (error) {
      pending.settling = false;
      this.log(
        `codex-bridge: recovered reply for ${pending.delivery.id} did not settle: ` +
          errorDetail(error),
      );
      this.scheduleRetry(pending, async () => {
        await this.settleRecoveredReply(pending);
      });
    }
  }

  private async resumeRecoveredExecution(
    entry: DeliveryRecoveryEntry,
    options: {
      confirmRunning: boolean;
      allowSubmit: boolean;
      authorizationGeneration: number;
    },
  ): Promise<void> {
    const pending = this.restorePending(entry);
    const delivery = pending.delivery;
    if (delivery === null) return;
    const input = this.inputForPending(pending);
    if (delivery.cause === "owner_answer") {
      const binding = this.bindingFor(delivery, pending.message);
      const activeThreadId = this.options.session.activeThreadId;
      if (
        binding === null ||
        activeThreadId === null ||
        binding.threadId !== activeThreadId
      ) {
        await this.failPending(
          pending.clientId,
          "recovered owner answer has no exact active Codex thread/work/continuation lineage",
        );
        return;
      }
      pending.threadId = binding.threadId;
      pending.continuationKey = binding.key;
    }
    if (options.confirmRunning) {
      try {
        const state = await this.confirmDeliveryUpdate(deliveryUpdate(delivery, "running"));
        if (state !== "running") throw new Error(`delivery state is ${state}, expected running`);
        if (options.authorizationGeneration !== this.welcomeGeneration) return;
        pending.delivery = { ...delivery, state: "running" };
        this.options.recoveryJournal?.update(delivery.id, {
          phase: "running_authorized",
          delivery: pending.delivery,
          threadId: pending.threadId,
        });
        pending.authorizationGeneration = options.authorizationGeneration;
      } catch (error) {
        if (error instanceof CodexDeliveryConnectionReplacedError) return;
        await this.failPending(
          pending.clientId,
          `could not confirm recovered running delivery: ${errorDetail(error)}`,
        );
        return;
      }
    }
    this.startLeaseRenewal(pending);
    const existingTurn = this.options.session.turnForClientId(pending.clientId);
    if (existingTurn) {
      pending.turnId = existingTurn.id;
      pending.threadId ??= this.options.session.activeThreadId;
      this.options.recoveryJournal?.update(delivery.id, {
        phase: "harness_accepted",
        turnId: pending.turnId,
        threadId: pending.threadId,
      });
      if (existingTurn.status !== "inProgress") await this.settleOne(pending, existingTurn);
      return;
    }
    if (!options.allowSubmit) {
      if (pending.renewTimer) clearInterval(pending.renewTimer);
      pending.renewTimer = null;
      this.log(
        `codex-bridge: Codex input ${pending.clientId} is absent from authoritative history ` +
          "after the harness write boundary; preserving late-reply debt without replay",
      );
      return;
    }
    try {
      const dispatch = await this.options.session.submit(input);
      this.observeDispatch(input, dispatch);
    } catch (error) {
      if (error instanceof CodexDeliveryAuthorizationStaleError) {
        this.log(
          `codex-bridge: recovered delivery ${delivery.id} is waiting for the current recovery generation`,
        );
        return;
      }
      await this.failPending(
        pending.clientId,
        `recovered Codex session injection failed: ${errorDetail(error)}`,
      );
    }
  }

  private scheduleJournalRecoveryRetry(generation: number): void {
    if (
      generation !== this.welcomeGeneration ||
      this.recoveryRetryTimer !== null
    ) {
      return;
    }
    const delay = Math.min(30_000, 100 * 2 ** Math.min(this.recoveryRetryAttempt, 8));
    this.recoveryRetryAttempt += 1;
    this.recoveryRetryTimer = setTimeout(() => {
      this.recoveryRetryTimer = null;
      this.queueJournalRecovery(generation);
    }, delay);
    if (typeof this.recoveryRetryTimer.unref === "function") {
      this.recoveryRetryTimer.unref();
    }
  }

  private queueJournalRecovery(generation: number): void {
    if (generation !== this.welcomeGeneration) return;
    if (this.recoveryPassGeneration === generation) {
      this.recoveryPassDirty = true;
      return;
    }
    this.recoveryPassGeneration = generation;
    this.recoveryPassDirty = false;
    const preceding = this.frameWork;
    let succeeded = false;
    const recovery = preceding
      .then(async () => {
        if (generation !== this.welcomeGeneration) return;
        await this.recoverJournalEntries(generation);
        if (generation !== this.welcomeGeneration) return;
        succeeded = true;
        if (!this.recoveryPassDirty) {
          this.recoveryReadyGeneration = generation;
          this.releaseRecoveryReadyWaiters();
        }
        this.recoveryRetryAttempt = 0;
      })
      .catch((error) => {
        if (generation !== this.welcomeGeneration) return;
        this.log(`codex-bridge: delivery recovery failed: ${errorDetail(error)}`);
        // Ownership uncertainty is a writer fence, not a best-effort warning.
        // Control frames remain readable while this independent backoff retries.
        this.scheduleJournalRecoveryRetry(generation);
      })
      .then(() => {
        if (this.recoveryPassGeneration !== generation) return;
        const rerun =
          succeeded &&
          this.recoveryPassDirty &&
          generation === this.welcomeGeneration;
        this.recoveryPassGeneration = null;
        this.recoveryPassDirty = false;
        if (rerun) this.queueJournalRecovery(generation);
      });
    this.recoveryWork = recovery;
    this.frameWork = recovery;
  }

  private async recoverJournalEntries(generation = this.welcomeGeneration): Promise<void> {
    const journal = this.options.recoveryJournal;
    if (!journal) return;
    for (const initial of journal.entries()) {
      if (generation !== this.welcomeGeneration) return;
      let prepared = this.prepareJournalRecovery(journal, initial.delivery.id);
      let stored = prepared.entry;
      let request = prepared.frame;
      let outcome: DeliveryRecoveryResultFrame;
      try {
        outcome = await this.confirmDeliveryRecovery(request);
      } catch (firstError) {
        if (generation !== this.welcomeGeneration) return;
        prepared = this.prepareJournalRecovery(journal, stored.delivery.id);
        stored = prepared.entry;
        request = prepared.frame;
        try {
          outcome = await this.confirmDeliveryRecovery(request);
        } catch (retryError) {
          throw new Error(
            `could not recover delivery ${stored.delivery.id}: ` +
              `${errorDetail(retryError)} (first: ${errorDetail(firstError)})`,
          );
        }
      }
      if (generation !== this.welcomeGeneration) return;
      // The harness writer may have advanced this exact entry while the
      // recovery CAS was awaiting its ACK. Classify the result from the latest
      // durable phase, never from the pre-request replay_safe snapshot.
      const requestSnapshot = stored;
      const latest = journal.get(stored.delivery.id);
      if (latest === null) continue;
      const snapshotWasPostHarness =
        requestSnapshot.phase === "harness_issued" ||
        requestSnapshot.phase === "harness_accepted" ||
        requestSnapshot.phase === "reply_posted" ||
        requestSnapshot.replyBody !== null;
      const latestIsPostHarness =
        latest.phase === "harness_issued" ||
        latest.phase === "harness_accepted" ||
        latest.phase === "reply_posted" ||
        latest.replyBody !== null;
      const crossedHarnessDuringRecovery =
        !snapshotWasPostHarness &&
        latestIsPostHarness &&
        (
          latest.updatedAt !== requestSnapshot.updatedAt ||
          latest.phase !== requestSnapshot.phase
        );
      stored = latest;

      let entry: DeliveryRecoveryEntry;
      let activeLease = outcome.result === "recovered";
      if (outcome.result === "recovered") {
        entry = journal.acceptRecovery(outcome);
      } else {
        if (
          outcome.result === "terminal" &&
          outcome.state === "waiting_owner" &&
          (
            stored.phase === "waiting_owner" ||
            (
              stored.phase === "reply_posted" &&
              stored.replyBody !== null &&
              stored.replySeq !== null
            )
          )
        ) {
          // Worker terminal/waiting_owner is positive authority that the
          // linked reply/source binding still exists. A local waiting_owner WAL
          // is never trusted by itself: another legitimate holder may have
          // completed the owner answer while this bridge was offline.
          entry = journal.update(stored.delivery.id, {
            phase: "waiting_owner",
            delivery: {
              ...stored.delivery,
              state: "waiting_owner",
              reply_seq: stored.replySeq ?? stored.delivery.reply_seq,
              lease_until: null,
            },
          });
          this.clearPending(`agentparty:${stored.delivery.id}`);
          this.restoreParkedContinuation(entry);
          continue;
        }
        const postHarness =
          stored.phase === "harness_issued" ||
          stored.phase === "harness_accepted" ||
          stored.phase === "reply_posted" ||
          stored.replyBody !== null;
        const waitingOwnerReplyDebt =
          outcome.result === "terminal" &&
          outcome.state === "waiting_owner" &&
          stored.replyBody !== null;
        if (
          (
            outcome.result === "terminal" &&
            !crossedHarnessDuringRecovery &&
            !waitingOwnerReplyDebt
          ) ||
          stored.phase === "failed_pending" ||
          !postHarness
        ) {
          journal.remove(stored.delivery.id);
          this.clearPending(`agentparty:${stored.delivery.id}`);
          continue;
        }
        if (outcome.result === "superseded_safe") {
          entry = journal.update(stored.delivery.id, {
            delivery: {
              ...stored.delivery,
              state: outcome.state,
              lease_until: null,
            },
          });
          activeLease = false;
          this.log(
            `codex-bridge: preserving unexpected post-harness superseded debt ` +
              `${stored.delivery.id} without replay`,
          );
        } else {
          entry = journal.update(stored.delivery.id, {
            delivery: { ...stored.delivery, state: outcome.state, lease_until: null },
          });
          activeLease = false;
        }
      }

      const pending = this.restorePending(entry);
      if (entry.replyBody !== null || entry.phase === "reply_posted") {
        await this.settleRecoveredReply(pending);
        continue;
      }
      if (entry.phase === "failed_pending") {
        await this.failPending(
          pending.clientId,
          entry.terminalError ?? "recovered Codex delivery was pending failure",
        );
        continue;
      }
      if (entry.phase === "claimed" || entry.phase === "running_authorized") {
        if (!activeLease) {
          journal.remove(entry.delivery.id);
          this.clearPending(pending.clientId);
          continue;
        }
        await this.resumeRecoveredExecution(entry, {
          confirmRunning: true,
          allowSubmit: true,
          authorizationGeneration: generation,
        });
        continue;
      }
      if (entry.phase === "harness_issued") {
        await this.resumeRecoveredExecution(entry, {
          confirmRunning: false,
          allowSubmit: false,
          authorizationGeneration: generation,
        });
        continue;
      }
      if (entry.phase === "harness_accepted") {
        await this.resumeRecoveredExecution(entry, {
          confirmRunning: false,
          allowSubmit: false,
          authorizationGeneration: generation,
        });
      }
    }
  }

  private restoreParkedContinuation(entry: DeliveryRecoveryEntry): void {
    const delivery = entry.delivery;
    const key = continuationKey(delivery);
    const activeThreadId = this.options.session.activeThreadId;
    if (
      key === null ||
      delivery.work_id === null ||
      delivery.continuation_ref === null ||
      entry.threadId === null ||
      entry.replySeq === null ||
      activeThreadId !== entry.threadId
    ) {
      this.log(
        `codex-bridge: retained waiting-owner journal ${delivery.id}, but its exact ` +
          `thread/continuation affinity is not active`,
      );
      return;
    }
    this.parkedContinuations.set(key, {
      key,
      workId: delivery.work_id,
      continuationRef: delivery.continuation_ref,
      sourceDeliveryId: delivery.id,
      sourceMessageSeq: entry.message.seq,
      threadId: entry.threadId,
    });
    this.rememberBounded(this.settledDeliveryIds, delivery.id);
  }

  private continuationMatches(
    delivery: DirectedDelivery,
    message: MsgFrame,
    binding: ParkedCodexContinuation,
  ): boolean {
    const decision = message.decision_response;
    return (
      decision !== undefined &&
      delivery.work_id !== null &&
      delivery.continuation_ref !== null &&
      binding.workId === delivery.work_id &&
      binding.continuationRef === delivery.continuation_ref &&
      decision.delivery_id === binding.sourceDeliveryId &&
      decision.origin_seq === binding.sourceMessageSeq &&
      decision.origin_channel === this.options.channel &&
      decision.work_id === binding.workId &&
      decision.continuation_ref === binding.continuationRef &&
      message.reply_to === decision.request_seq
    );
  }

  private bindingFor(
    delivery: DirectedDelivery,
    message: MsgFrame,
  ): ParkedCodexContinuation | null {
    const key = continuationKey(delivery);
    const decision = message.decision_response;
    if (
      key === null ||
      this.completedContinuationKeys.has(key) ||
      decision === undefined ||
      decision.delivery_id === undefined ||
      decision.origin_seq === undefined ||
      delivery.work_id === null ||
      delivery.continuation_ref === null
    ) {
      return null;
    }
    const parked = this.parkedContinuations.get(key);
    if (parked) return this.continuationMatches(delivery, message, parked) ? parked : null;
    for (const pending of this.pending.values()) {
      if (
        pending.threadId !== null &&
        pending.delivery !== null &&
        continuationKey(pending.delivery) === key &&
        pending.delivery.id === decision.delivery_id &&
        pending.message.seq === decision.origin_seq
      ) {
        const inFlight = {
          key,
          workId: delivery.work_id!,
          continuationRef: delivery.continuation_ref!,
          sourceDeliveryId: pending.delivery.id,
          sourceMessageSeq: pending.message.seq,
          threadId: pending.threadId,
        };
        return this.continuationMatches(delivery, message, inFlight) ? inFlight : null;
      }
    }
    const activeThreadId = this.options.session.activeThreadId;
    if (
      activeThreadId === null ||
      this.options.session.turnForClientId(`agentparty:${decision.delivery_id}`) === null
    ) {
      return null;
    }
    // decision_response is Worker-authored lineage. Combining its exact
    // delivery/work/request chain with a recovered userMessage.clientId in the
    // currently attached thread reconstructs the durable continuation after
    // this bridge process restarts, without trusting another thread's cache.
    const recovered = {
      key,
      workId: delivery.work_id,
      continuationRef: delivery.continuation_ref,
      sourceDeliveryId: decision.delivery_id,
      sourceMessageSeq: decision.origin_seq,
      threadId: activeThreadId,
    };
    return this.continuationMatches(delivery, message, recovered) ? recovered : null;
  }

  private parkContinuation(
    pending: PendingCodexDelivery,
  ): ParkedCodexContinuation | null {
    const delivery = pending.delivery;
    const key = delivery === null ? null : continuationKey(delivery);
    if (
      delivery === null ||
      key === null ||
      delivery.work_id === null ||
      delivery.continuation_ref === null ||
      pending.threadId === null
    ) {
      throw new Error(
        `waiting_owner delivery ${delivery?.id ?? pending.clientId} has no complete Codex session affinity`,
      );
    }
    if (this.completedContinuationKeys.has(key)) return null;
    const parked = {
      key,
      workId: delivery.work_id,
      continuationRef: delivery.continuation_ref,
      sourceDeliveryId: delivery.id,
      sourceMessageSeq: pending.message.seq,
      threadId: pending.threadId,
    };
    this.parkedContinuations.set(key, parked);
    return parked;
  }

  private releaseParkedContinuation(pending: PendingCodexDelivery): void {
    if (pending.delivery?.cause !== "owner_answer" || pending.continuationKey === null) return;
    const parked = this.parkedContinuations.get(pending.continuationKey) ?? null;
    this.rememberBounded(this.completedContinuationKeys, pending.continuationKey);
    this.parkedContinuations.delete(pending.continuationKey);
    if (parked !== null) {
      this.options.recoveryJournal?.remove(parked.sourceDeliveryId);
    }
  }

  private removeSettledJournalEntries(pending: PendingCodexDelivery): void {
    const delivery = pending.delivery;
    const journal = this.options.recoveryJournal;
    if (delivery === null || journal === undefined) return;
    const sourceDeliveryId =
      delivery.cause === "owner_answer"
        ? pending.continuationSourceDeliveryId ??
          (
            pending.continuationKey === null
              ? null
              : this.parkedContinuations.get(pending.continuationKey)?.sourceDeliveryId ?? null
          )
        : null;
    journal.removeMany(
      sourceDeliveryId === null
        ? [delivery.id]
        : [delivery.id, sourceDeliveryId],
    );
  }

  private async failPending(clientId: string, error: string): Promise<boolean> {
    const pending = this.pending.get(clientId) ?? null;
    if (!pending) return true;
    pending.terminalError = error;
    try {
      if (pending.delivery) {
        this.options.recoveryJournal?.update(pending.delivery.id, {
          phase: "failed_pending",
          terminalError: error,
        });
      }
    } catch (journalError) {
      // settleOne may enter with settling=true. A failed WAL write must reopen
      // the exact same pending object and retry before any irreversible failed
      // update is sent to Worker.
      pending.settling = false;
      this.log(
        `codex-bridge: could not durably record failed delivery ` +
          `${pending.delivery?.id ?? pending.clientId}: ${errorDetail(journalError)}`,
      );
      this.scheduleRetry(pending, async () => {
        await this.failPending(clientId, pending.terminalError ?? error);
      });
      return false;
    }
    pending.settling = true;
    if (pending.renewTimer) clearInterval(pending.renewTimer);
    pending.renewTimer = null;
    try {
      if (pending.delivery) {
        const state = await this.confirmDeliveryUpdate(deliveryUpdate(pending.delivery, "failed", {
          error: error.slice(0, 500),
        }));
        if (state !== "failed") {
          throw new Error(`delivery state is ${state}, expected failed`);
        }
      }
      this.log(`codex-bridge: failed seq=${pending.message.seq}: ${error}`);
      // Persist deletion of an owner answer and its parked source binding in
      // one snapshot before dropping the only retryable pending object.
      this.removeSettledJournalEntries(pending);
      const completed = this.clearPending(clientId);
      if (completed?.delivery) {
        this.rememberBounded(this.settledDeliveryIds, completed.delivery.id);
        this.releaseParkedContinuation(completed);
      }
      return true;
    } catch (updateError) {
      pending.settling = false;
      this.log(
        `codex-bridge: could not confirm failed delivery ` +
          `${pending.delivery?.id ?? pending.clientId}: ${errorDetail(updateError)}`,
      );
      this.scheduleRetry(pending, async () => {
        await this.failPending(clientId, pending.terminalError ?? error);
      });
      return false;
    }
  }

  private observeDispatch(input: CodexBridgeInput, dispatch: CodexDispatch): void {
    const pending = this.pending.get(input.clientUserMessageId);
    if (!pending) return;
    if (dispatch.turnId) {
      pending.turnId = dispatch.turnId;
      pending.threadId ??= this.options.session.activeThreadId;
      this.persistHarnessAccepted(pending);
    }
    const recovered = this.options.session.turnForClientId(input.clientUserMessageId);
    if (recovered) {
      pending.turnId = recovered.id;
      pending.threadId ??= this.options.session.activeThreadId;
      this.persistHarnessAccepted(pending);
      if (recovered.status !== "inProgress") void this.settleOne(pending, recovered);
    }
  }

  private persistHarnessAccepted(pending: PendingCodexDelivery): void {
    const delivery = pending.delivery;
    const journal = this.options.recoveryJournal;
    if (delivery === null || journal === undefined || pending.turnId === null) return;
    try {
      journal.update(delivery.id, {
        phase: "harness_accepted",
        turnId: pending.turnId,
        threadId: pending.threadId,
      });
      pending.retryAttempt = 0;
    } catch (error) {
      // turn/start or turn/steer already returned an accepted turn. Failure to
      // promote the local WAL cannot turn that external write into an ordinary
      // failed delivery or authorize replay. Keep harness_issued debt. A later
      // dispatch/history observation or terminal completion will advance the
      // same journal; no retry timer is occupied by this advisory promotion,
      // so reply/failed settlement always retains its own retry opportunity.
      this.log(
        `codex-bridge: could not durably promote accepted Codex turn ` +
          `${pending.turnId} for ${delivery.id}: ${errorDetail(error)}`,
      );
    }
  }

  private async inject(message: MsgFrame, delivery: DirectedDelivery | null): Promise<boolean> {
    const inputIdentity = codexInput(this.options.channel, message, delivery);
    const existing = this.pending.get(inputIdentity.clientUserMessageId);
    if (existing) {
      if (existing.terminalError !== null && !existing.settling) {
        await this.failPending(existing.clientId, existing.terminalError);
      }
      return true;
    }
    if (delivery) this.options.recoveryJournal?.recordClaim(delivery, message);
    const ownerAnswerBinding = delivery?.cause === "owner_answer"
      ? this.bindingFor(delivery, message)
      : null;
    if (delivery?.cause === "owner_answer") {
      const activeThreadId = this.options.session.activeThreadId;
      if (
        ownerAnswerBinding === null ||
        activeThreadId === null ||
        ownerAnswerBinding.threadId !== activeThreadId
      ) {
        const detail = ownerAnswerBinding === null
          ? "owner answer has no matching parked work_id/continuation_ref"
          : `owner answer belongs to Codex thread ${ownerAnswerBinding.threadId}, ` +
            `but the active thread is ${activeThreadId ?? "not attached"}`;
        try {
          const state = await this.confirmDeliveryUpdate(deliveryUpdate(delivery, "failed", {
            error: detail.slice(0, 500),
          }));
          if (state !== "failed") {
            throw new Error(`delivery state is ${state}, expected failed`);
          }
          const key = continuationKey(delivery);
          const sourceDeliveryId =
            key === null
              ? null
              : this.parkedContinuations.get(key)?.sourceDeliveryId ?? null;
          this.options.recoveryJournal?.removeMany(
            sourceDeliveryId === null
              ? [delivery.id]
              : [delivery.id, sourceDeliveryId],
          );
          this.rememberBounded(this.settledDeliveryIds, delivery.id);
          if (key !== null) {
            this.rememberBounded(this.completedContinuationKeys, key);
            this.parkedContinuations.delete(key);
          }
        } catch (error) {
          this.log(
            `codex-bridge: rejected unbound owner answer ${delivery.id}, but failed state ` +
              `was not confirmed: ${errorDetail(error)}`,
          );
          return false;
        }
        this.log(`codex-bridge: rejected owner answer ${delivery.id}: ${detail}`);
        return true;
      }
    }
    const pending = this.createPending(
      message,
      delivery,
      ownerAnswerBinding?.threadId ?? this.options.session.activeThreadId,
      delivery?.cause === "owner_answer" ? continuationKey(delivery) : null,
      ownerAnswerBinding?.sourceDeliveryId ?? null,
    );
    this.pending.set(inputIdentity.clientUserMessageId, pending);
    if (delivery) {
      const authorizationGeneration = this.welcomeGeneration;
      try {
        // Thread affinity is known before the asynchronous Worker running CAS.
        // Persist it while the entry is still replay-safe so a crash at any
        // point before the app-server writer can cold-resume the exact session.
        this.options.recoveryJournal?.update(delivery.id, {
          threadId: pending.threadId,
        });
        const state = await this.confirmDeliveryUpdate(deliveryUpdate(delivery, "running"));
        if (state !== "running") throw new Error(`delivery state is ${state}, expected running`);
        if (authorizationGeneration !== this.welcomeGeneration) {
          throw new CodexDeliveryAuthorizationStaleError(
            `AgentParty delivery ${delivery.id} changed websocket generation during running claim`,
          );
        }
        pending.delivery = { ...delivery, state: "running" };
        this.options.recoveryJournal?.update(delivery.id, {
          phase: "running_authorized",
          delivery: pending.delivery,
          threadId: pending.threadId,
        });
        if (this.recoveryReadyGeneration === authorizationGeneration) {
          pending.authorizationGeneration = authorizationGeneration;
        }
      } catch (error) {
        if (error instanceof CodexDeliveryConnectionReplacedError) {
          this.log(
            `codex-bridge: running acknowledgement for ${delivery.id} was interrupted by reconnect; ` +
              "recovering durable ownership before Codex submission",
          );
          return false;
        }
        if (error instanceof CodexDeliveryAuthorizationStaleError) {
          this.log(
            `codex-bridge: running delivery ${delivery.id} is waiting for current ownership recovery`,
          );
          return false;
        }
        this.log(`codex-bridge: could not claim running delivery ${delivery.id}: ${errorDetail(error)}`);
        await this.failPending(
          pending.clientId,
          `could not confirm running delivery before Codex submission: ${errorDetail(error)}`,
        );
        return false;
      }
      this.startLeaseRenewal(pending);
    }
    const input = this.inputForPending(pending);
    try {
      const dispatch = await this.options.session.submit(input);
      this.observeDispatch(input, dispatch);
      this.log(
        `codex-bridge: accepted #${this.options.channel} seq=${message.seq} ` +
          `(${dispatch.kind}${dispatch.queuePosition ? ` position=${dispatch.queuePosition}` : ""})`,
      );
      return true;
    } catch (error) {
      if (error instanceof CodexDeliveryAuthorizationStaleError) {
        this.log(
          `codex-bridge: delivery ${delivery?.id ?? pending.clientId} remains queued until ` +
            "current ownership recovery completes",
        );
        return false;
      }
      await this.failPending(input.clientUserMessageId, `Codex session injection failed: ${errorDetail(error)}`);
      this.log(`codex-bridge: failed to inject seq=${message.seq}: ${errorDetail(error)}`);
      return false;
    }
  }

  async handleFrame(incoming: ServerFrame): Promise<void> {
    if (incoming.type === "delivery_recovery") {
      this.observeDeliveryRecovery(incoming);
      return;
    }
    if (incoming.type === "delivery_state") {
      this.observeDeliveryAck(incoming);
      return;
    }
    if (incoming.type === "welcome") {
      const reconnect = this.welcomeGeneration > 0;
      this.welcomeGeneration += 1;
      if (this.recoveryRetryTimer !== null) {
        clearTimeout(this.recoveryRetryTimer);
        this.recoveryRetryTimer = null;
      }
      if (reconnect) {
        for (const [requestId, pending] of this.deliveryAcks) {
          clearTimeout(pending.timer);
          pending.reject(new CodexDeliveryConnectionReplacedError(
            "AgentParty websocket was replaced before the delivery acknowledgement arrived",
          ));
          this.deliveryAcks.delete(requestId);
        }
        for (const [requestId, pending] of this.deliveryRecoveries) {
          clearTimeout(pending.timer);
          pending.reject(new CodexDeliveryConnectionReplacedError(
            "AgentParty websocket was replaced before ownership recovery completed",
          ));
          this.deliveryRecoveries.delete(requestId);
        }
        for (const pending of this.pending.values()) {
          if (pending.renewTimer) clearInterval(pending.renewTimer);
          pending.renewTimer = null;
        }
      }
      this.self = incoming.self;
      this.directedDeliveryMode = incoming.directed_delivery === "v1";
      if (
        this.options.requireDeliveryRecovery === true &&
        (!this.directedDeliveryMode || incoming.delivery_recovery !== "v1")
      ) {
        this.exitCode = 1;
        this.log(
          "codex-bridge: Worker lacks directed_delivery v1 + delivery_recovery v1; " +
            "refusing Codex submission without durable ownership",
        );
        this.options.connection.close();
        return;
      }
      if (this.directedDeliveryMode) {
        this.options.connection.send({ type: "delivery_adapter", adapter: "watch", op: "register" });
        const generation = this.welcomeGeneration;
        // Incrementing welcomeGeneration above synchronously fences every old
        // pending input. Recovery and delivery frames are then serialized, while
        // control ACKs remain readable by run() to avoid handshake deadlock.
        // With no durable debt there is nothing to recover, so new assignments
        // may be authorized immediately.
        if ((this.options.recoveryJournal?.entries().length ?? 0) === 0) {
          this.recoveryReadyGeneration = generation;
          this.releaseRecoveryReadyWaiters();
        }
        this.queueJournalRecovery(generation);
      }
      this.log(
        `codex-bridge: attached to #${this.options.channel} as @${this.self}` +
          (this.directedDeliveryMode ? " (directed-delivery v1)" : " (legacy message fallback)"),
      );
      return;
    }
    if (incoming.type === "error") {
      if (
        incoming.code === "bad_request" &&
        (this.deliveryAcks.size > 0 || this.deliveryRecoveries.size > 0)
      ) {
        this.log(
          `codex-bridge: ignored uncorrelated delivery error while awaiting ACK: ${incoming.message}`,
        );
        return;
      }
      this.log(`codex-bridge: AgentParty error ${incoming.code}: ${incoming.message}`);
      if (incoming.code === "unauthorized") this.exitCode = EXIT_AUTH;
      else if (incoming.code === "archived") this.exitCode = EXIT_ARCHIVED;
      else this.exitCode = 1;
      this.options.connection.close();
      return;
    }

    const delivery = incoming.type === "delivery" ? incoming.delivery : null;
    const message = incoming.type === "delivery" ? incoming.message : incoming;
    if (message.type !== "msg") return;
    if (delivery) {
      if (
        delivery.target_name !== this.self ||
        delivery.state !== "claimed" ||
        message.sender.name === this.self ||
        this.settledDeliveryIds.has(delivery.id)
      ) {
        return;
      }
      await this.inject(message, delivery);
      return;
    }

    const fresh = message.seq > this.options.connection.cursor;
    const mentioned = message.mentions.includes(this.self);
    if (this.directedDeliveryMode && mentioned) {
      if (fresh) this.options.connection.ack(message.seq);
      return;
    }
    if (!fresh || !mentioned || message.sender.name === this.self || this.seenPlainSeqs.has(message.seq)) {
      if (fresh) this.options.connection.ack(message.seq);
      return;
    }
    if (await this.inject(message, null)) {
      this.rememberBounded(this.seenPlainSeqs, message.seq);
      this.options.connection.ack(message.seq);
    }
  }

  private async settleOne(pending: PendingCodexDelivery, turn: CodexTurn): Promise<void> {
    if (pending.terminalError !== null) {
      if (!pending.settling) await this.failPending(pending.clientId, pending.terminalError);
      return;
    }
    if (pending.settling || !this.pending.has(pending.clientId)) return;
    pending.settling = true;
    if (turn.status !== "completed") {
      await this.failPending(pending.clientId, `Codex turn ${turn.id} ended with ${turn.status}`);
      return;
    }
    const text = finalAgentText(turn);
    if (!text) {
      await this.failPending(pending.clientId, `Codex turn ${turn.id} completed without a final agent message`);
      return;
    }
    if (new TextEncoder().encode(text).byteLength > BODY_LIMIT) {
      await this.failPending(pending.clientId, `Codex final response exceeds AgentParty's ${BODY_LIMIT}-byte limit`);
      return;
    }
    pending.replyBody ??= text;
    try {
      if (pending.delivery) {
        this.options.recoveryJournal?.update(pending.delivery.id, {
          replyBody: pending.replyBody,
        });
      }
    } catch (error) {
      pending.settling = false;
      this.log(
        `codex-bridge: could not durably record reply body for seq=${pending.message.seq}; ` +
          `will retry before posting: ${errorDetail(error)}`,
      );
      this.scheduleRetry(pending, async () => {
        await this.settleOne(pending, turn);
      });
      return;
    }
    if (pending.replySeq === null) {
      try {
        const posted = await this.options.postReply({
          body: pending.replyBody,
          mentions: [pending.message.sender.name],
          replyTo: pending.message.seq,
          idempotencyKey: pending.replyIdempotencyKey,
        });
        pending.replySeq = posted.seq;
        if (pending.delivery) {
          try {
            this.options.recoveryJournal?.update(pending.delivery.id, {
              phase: "reply_posted",
              replyBody: pending.replyBody,
              replySeq: posted.seq,
            });
          } catch (error) {
            // The linked-reply POST can broadcast an unsolicited authoritative
            // `replied` state before its HTTP response returns. That path
            // removes the exact pending delivery and WAL entry. Once both
            // fences confirm that terminal state, the successful POST response
            // is not an unknown outcome and must not be retried.
            if (
              !this.pending.has(pending.clientId) &&
              this.settledDeliveryIds.has(pending.delivery.id)
            ) {
              this.log(`codex-bridge: replied to seq=${pending.message.seq} with seq=${posted.seq}`);
              return;
            }
            pending.replySeq = null;
            throw error;
          }
        }
        pending.retryAttempt = 0;
        if (pending.renewTimer) clearInterval(pending.renewTimer);
        pending.renewTimer = null;
      } catch (error) {
        // The request may have persisted before its response was lost. Retry
        // the same logical reply with one durable idempotency key; never mint a
        // second key for this inbound delivery.
        pending.settling = false;
        this.log(
          `codex-bridge: linked reply for seq=${pending.message.seq} has an unknown ` +
            `persistence outcome; retrying with the same idempotency key: ${errorDetail(error)}`,
        );
        this.scheduleRetry(pending, async () => {
          await this.settleOne(pending, turn);
        });
        return;
      }
    }

    const replySeq = pending.replySeq;
    if (replySeq === null) {
      pending.settling = false;
      return;
    }
    if (pending.delivery === null) {
      this.clearPending(pending.clientId);
      this.log(`codex-bridge: replied to seq=${pending.message.seq} with seq=${replySeq}`);
      return;
    }

    try {
      const state = await this.confirmDeliveryUpdate(deliveryUpdate(pending.delivery, "replied", {
        replySeq,
      }));
      if (state === "waiting_owner") {
        const parked = this.parkContinuation(pending);
        if (parked) {
          this.options.recoveryJournal?.update(pending.delivery.id, {
            phase: "waiting_owner",
            delivery: {
              ...pending.delivery,
              state: "waiting_owner",
              reply_seq: replySeq,
            },
            threadId: parked.threadId,
            turnId: pending.turnId,
            replyBody: pending.replyBody,
            replySeq,
          });
          this.log(
            `codex-bridge: parked delivery ${pending.delivery.id} on Codex thread ` +
              `${parked.threadId} until its owner answer arrives`,
          );
        } else {
          this.options.recoveryJournal?.remove(pending.delivery.id);
          this.log(
            `codex-bridge: ignored late waiting_owner acknowledgement for completed ` +
              `continuation ${pending.delivery.id}`,
          );
        }
      } else if (state !== "replied") {
        throw new Error(`delivery state is ${state}, expected replied or waiting_owner`);
      }
      if (state !== "waiting_owner") this.removeSettledJournalEntries(pending);
      const completed = this.clearPending(pending.clientId);
      if (completed?.delivery) {
        this.rememberBounded(this.settledDeliveryIds, completed.delivery.id);
        if (state === "replied") this.releaseParkedContinuation(completed);
      }
      this.log(`codex-bridge: replied to seq=${pending.message.seq} with seq=${replySeq}`);
    } catch (error) {
      pending.settling = false;
      this.log(
        `codex-bridge: linked reply seq=${replySeq} persisted but delivery ` +
          `acknowledgement did not settle: ${errorDetail(error)}`,
      );
      this.scheduleRetry(pending, async () => {
        await this.settleOne(pending, turn);
      });
    }
  }

  private async settleTurn(turn: CodexTurn): Promise<void> {
    const matches = [...this.pending.values()].filter((pending) => pending.turnId === turn.id);
    await Promise.all(matches.map((pending) => this.settleOne(pending, turn)));
  }

  close(): void {
    this.intentionalClose = true;
    this.unsubscribeDispatch();
    this.unsubscribeCompleted();
    this.unsubscribeThreadSwitch();
    this.unsubscribeSessionMutation();
    this.unsubscribeUnresolvedUnknown();
    if (this.recoveryRetryTimer !== null) {
      clearTimeout(this.recoveryRetryTimer);
      this.recoveryRetryTimer = null;
    }
    this.rejectRecoveryReadyWaiters(new Error("Codex AgentParty bridge closed"));
    for (const clientId of [...this.pending.keys()]) this.clearPending(clientId);
    this.parkedContinuations.clear();
    this.completedContinuationKeys.clear();
    for (const [requestId, pending] of this.deliveryAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex AgentParty bridge closed"));
      this.deliveryAcks.delete(requestId);
    }
    for (const [requestId, pending] of this.deliveryRecoveries) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex AgentParty bridge closed"));
      this.deliveryRecoveries.delete(requestId);
    }
    this.options.connection.close();
  }

  async run(): Promise<number> {
    try {
      for await (const frame of this.options.connection.frames) {
        if (
          frame.type === "delivery_state" ||
          frame.type === "delivery_recovery" ||
          frame.type === "welcome" ||
          frame.type === "error"
        ) {
          await this.handleFrame(frame);
          continue;
        }
        // Keep the frame reader available for the delivery_state ACK that the
        // scheduled work may be awaiting. Work itself stays serialized so two
        // deliveries or a reconnect recovery cannot race through the session
        // arbiter or local ledger.
        this.frameWork = this.frameWork
          .then(() => this.handleFrame(frame))
          .catch((error) => {
            this.log(`codex-bridge: failed to process AgentParty frame: ${errorDetail(error)}`);
          });
      }
    } finally {
      this.unsubscribeDispatch();
      this.unsubscribeCompleted();
      this.unsubscribeThreadSwitch();
      this.unsubscribeSessionMutation();
      this.unsubscribeUnresolvedUnknown();
      if (this.recoveryRetryTimer !== null) {
        clearTimeout(this.recoveryRetryTimer);
        this.recoveryRetryTimer = null;
      }
      this.rejectRecoveryReadyWaiters(new Error("Codex AgentParty frame stream stopped"));
      for (const [requestId, pending] of this.deliveryAcks) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex AgentParty frame stream stopped"));
        this.deliveryAcks.delete(requestId);
      }
      for (const [requestId, pending] of this.deliveryRecoveries) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex AgentParty frame stream stopped"));
        this.deliveryRecoveries.delete(requestId);
      }
      await this.recoveryWork.catch(() => {});
      await this.frameWork;
      for (const clientId of [...this.pending.keys()]) this.clearPending(clientId);
      this.parkedContinuations.clear();
      this.completedContinuationKeys.clear();
      this.options.connection.close();
    }
    if (this.intentionalClose) return this.exitCode;
    return this.exitCode === 0 ? EXIT_STREAM_ENDED : this.exitCode;
  }
}
