/**
 * Native ChatGPT/Codex Desktop cross-thread transport.
 *
 * ChatGPT Desktop exposes its first-party app tools over a private Unix socket.
 * The socket authorizes the signed Node runtime bundled inside ChatGPT.app, so
 * the AgentParty binary cannot connect directly. We spawn that exact runtime,
 * pass the JSON-RPC request on stdin (never argv), and keep the app bundle
 * read-only.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isClaudeSessionRegistrySessionId,
  listCodexSessions,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";
import { codexNativeBrokerSocketPath } from "./codex-native-broker";

const APP_TOOLS_PIPE_KEY = "CODEX_APP_TOOLS_PIPE_PATH";
const MAX_NATIVE_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_NATIVE_TOOL_TIMEOUT_MS = 130_000;

export interface CodexAppNativeRuntime {
  appServerPid: number;
  codexPath: string;
  nodePath: string;
  pipePath: string;
  /** Private AgentParty broker socket, when app-server loaded the zero-tool MCP. */
  brokerPath?: string;
}

export interface CodexAppNativeRoute {
  targetThreadId: string;
  sourceThreadId: string;
}

/**
 * Pick a real second ChatGPT task for the native delegation label/link.
 * Shared PID alone is insufficient: source and target must also belong to the
 * same AgentParty channel identity and server, otherwise the UI link could
 * silently cross an identity boundary.
 */
export function selectCodexAppNativeRoute(
  targetThreadId: string,
  appServerPid: number,
  sessions: readonly ClaudeSessionRegistryEntry[],
): CodexAppNativeRoute | null {
  const wanted = targetThreadId.toLowerCase();
  const target = sessions.find(
    (entry) => entry.pid === appServerPid && entry.session_id.toLowerCase() === wanted,
  );
  if (target === undefined || target.server === undefined || target.identity === undefined) return null;
  const source = [...sessions]
    .reverse()
    .find((entry) =>
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

export const CODEX_NATIVE_BROKER_ENV = "AGENTPARTY_CODEX_NATIVE_BROKER";

export interface CodexAppNativeToolResult {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
    | { type: "inputAudio"; audioUrl: string }
  >;
}

export class CodexAppNativeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppNativeUnavailableError";
  }
}

export class CodexAppNativeToolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "CodexAppNativeToolError";
  }
}

/** The broker accepted a request, but no authoritative tool result came back. */
export class CodexAppNativeUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppNativeUnknownOutcomeError";
  }
}

type SpawnLike = typeof spawnSync;

export function parseCodexAppNativeRuntimeCommand(
  command: string,
  appServerPid: number,
): CodexAppNativeRuntime | null {
  const executable = /(?:^|\s)(?:"([^"]*\/Contents\/Resources\/codex)"|'([^']*\/Contents\/Resources\/codex)'|(\S*\/Contents\/Resources\/codex))(?=\s|$)/
    .exec(command);
  const codexPath = executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? null;
  if (codexPath === null || !isAbsolute(codexPath)) return null;
  const pipe = /CODEX_APP_TOOLS_PIPE_PATH["']?\s*=\s*["']([^"']+)["']/
    .exec(command)?.[1] ?? null;
  if (pipe === null || !isAbsolute(pipe)) return null;
  const resources = dirname(codexPath);
  return {
    appServerPid,
    codexPath,
    nodePath: join(resources, "cua_node", "bin", "node"),
    pipePath: pipe,
  };
}

function processCommand(pid: number, spawn: SpawnLike = spawnSync): string | null {
  try {
    const result = spawn("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const command = result.stdout.trim();
    return command === "" ? null : command;
  } catch {
    return null;
  }
}

export interface ResolveCodexAppNativeRuntimeDeps {
  sessions?: typeof listCodexSessions;
  commandForPid?: (pid: number) => string | null;
  brokerPath?: (appServerPid: number, env: NodeJS.ProcessEnv) => string | null;
  validateRuntime?: (runtime: CodexAppNativeRuntime) => void;
}

export function validateCodexAppNativeRuntime(runtime: CodexAppNativeRuntime): void {
  let socket;
  try {
    socket = lstatSync(runtime.pipePath);
  } catch {
    throw new CodexAppNativeUnavailableError(
      `ChatGPT app tools pipe is missing: ${runtime.pipePath}`,
    );
  }
  if (!socket.isSocket()) {
    throw new CodexAppNativeUnavailableError(
      `ChatGPT app tools pipe is not a socket: ${runtime.pipePath}`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && socket.uid !== uid) {
    throw new CodexAppNativeUnavailableError(
      `ChatGPT app tools pipe belongs to uid ${socket.uid}, expected ${uid}`,
    );
  }
  if ((socket.mode & 0o077) !== 0) {
    throw new CodexAppNativeUnavailableError(
      `ChatGPT app tools pipe is not private: mode ${(socket.mode & 0o777).toString(8)}`,
    );
  }
  try {
    accessSync(runtime.nodePath, constants.X_OK);
  } catch {
    throw new CodexAppNativeUnavailableError(
      `ChatGPT bundled Node runtime is unavailable: ${runtime.nodePath}`,
    );
  }
  const resources = dirname(runtime.codexPath);
  const realNode = realpathSync(runtime.nodePath);
  const rel = relative(resources, realNode);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CodexAppNativeUnavailableError(
      `ChatGPT bundled Node escaped its Resources directory: ${realNode}`,
    );
  }
}

export function resolveCodexAppNativeRuntime(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveCodexAppNativeRuntimeDeps = {},
): CodexAppNativeRuntime {
  if (!isClaudeSessionRegistrySessionId(threadId)) {
    throw new CodexAppNativeUnavailableError(`Invalid Codex thread id: ${threadId}`);
  }
  const sessions = (deps.sessions ?? listCodexSessions)(env);
  const matches = sessions.filter(
    (entry) => entry.session_id.toLowerCase() === threadId.toLowerCase(),
  );
  if (matches.length !== 1) {
    throw new CodexAppNativeUnavailableError(
      matches.length === 0
        ? `Codex thread ${threadId} is not registered in this ChatGPT app session`
        : `Codex thread ${threadId} has ${matches.length} live registry entries`,
    );
  }
  const pid = matches[0]!.pid;
  const command = (deps.commandForPid ?? processCommand)(pid);
  if (command === null) {
    throw new CodexAppNativeUnavailableError(
      `Cannot inspect ChatGPT app-server process ${pid} for thread ${threadId}`,
    );
  }
  const runtime = parseCodexAppNativeRuntimeCommand(command, pid);
  if (runtime === null) {
    throw new CodexAppNativeUnavailableError(
      `Process ${pid} is not a ChatGPT Desktop app-server with native app tools`,
    );
  }
  const broker = deps.brokerPath !== undefined ? deps.brokerPath(pid, env) : (() => {
    const explicitBroker = env[CODEX_NATIVE_BROKER_ENV]?.trim();
    const defaultBroker = codexNativeBrokerSocketPath(pid, env);
    return explicitBroker !== undefined && explicitBroker !== ""
      ? explicitBroker
      : existsSync(defaultBroker)
        ? defaultBroker
        : null;
  })();
  const resolved = broker === null ? runtime : { ...runtime, brokerPath: broker };
  (deps.validateRuntime ?? validateCodexAppNativeRuntime)(resolved);
  if (resolved.brokerPath !== undefined) validatePrivateSocket(resolved.brokerPath, "AgentParty native broker");
  return resolved;
}

function validatePrivateSocket(path: string, label: string): void {
  let socket;
  try {
    socket = lstatSync(path);
  } catch {
    throw new CodexAppNativeUnavailableError(`${label} socket is missing: ${path}`);
  }
  if (!socket.isSocket()) {
    throw new CodexAppNativeUnavailableError(`${label} path is not a socket: ${path}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && socket.uid !== uid) {
    throw new CodexAppNativeUnavailableError(`${label} socket belongs to uid ${socket.uid}, expected ${uid}`);
  }
  if ((socket.mode & 0o077) !== 0) {
    throw new CodexAppNativeUnavailableError(
      `${label} socket is not private: mode ${(socket.mode & 0o777).toString(8)}`,
    );
  }
}

const NATIVE_PIPE_HELPER = String.raw`
const net = require("node:net");
const pipePath = process.argv[1];
const MAX = ${MAX_NATIVE_FRAME_BYTES};
let request = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { request += chunk; if (Buffer.byteLength(request) > MAX) process.exit(64); });
process.stdin.on("end", () => {
  let payload;
  try { payload = Buffer.from(JSON.stringify(JSON.parse(request)), "utf8"); }
  catch { process.exit(65); }
  if (payload.length > MAX) process.exit(66);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  const socket = net.createConnection(pipePath);
  let pending = Buffer.alloc(0);
  socket.once("connect", () => socket.write(frame));
  socket.on("data", chunk => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 4) return;
    const length = pending.readUInt32LE(0);
    if (length > MAX) { socket.destroy(); process.exit(67); }
    if (pending.length < length + 4) return;
    process.stdout.write(pending.subarray(4, length + 4));
    socket.end();
  });
  socket.once("error", error => { process.stderr.write(error.message); process.exit(68); });
  socket.once("close", () => { if (pending.length < 4) process.exitCode = 69; });
});
`;

export type CodexAppNativeInvoke = (
  runtime: CodexAppNativeRuntime,
  request: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

export async function invokeCodexAppNativeRequest(
  runtime: CodexAppNativeRuntime,
  request: unknown,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_NATIVE_TOOL_TIMEOUT_MS,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (runtime.brokerPath !== undefined) {
    return invokeFramedSocket(runtime.brokerPath, request, signal, timeoutMs);
  }
  const proc = Bun.spawn(
    [runtime.nodePath, "-e", NATIVE_PIPE_HELPER, runtime.pipePath],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const abort = () => proc.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    signal?.throwIfAborted();
    if (code !== 0) {
      throw new CodexAppNativeUnavailableError(
        `ChatGPT native app tool transport exited ${code}` +
          (stderr.trim() === "" ? "" : `: ${stderr.trim().slice(0, 240)}`),
      );
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new CodexAppNativeUnavailableError(
        `ChatGPT native app tool returned invalid JSON`,
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function invokeFramedSocket(
  path: string,
  request: unknown,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_NATIVE_TOOL_TIMEOUT_MS,
): Promise<unknown> {
  const { createConnection } = await import("node:net");
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  if (payload.length > MAX_NATIVE_FRAME_BYTES) {
    throw new CodexAppNativeUnavailableError(`ChatGPT native app tool request is too large`);
  }
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return await new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(path);
    let pending = Buffer.alloc(0);
    let settled = false;
    let connected = false;
    const transportError = (message: string, cause?: unknown): Error => {
      const detail = cause instanceof Error && cause.message !== "" ? `: ${cause.message}` : "";
      return connected
        ? new CodexAppNativeUnknownOutcomeError(`${message}${detail}`)
        : new CodexAppNativeUnavailableError(`${message}${detail}`);
    };
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(
      connected
        ? new CodexAppNativeUnknownOutcomeError("ChatGPT native app tool aborted after broker acceptance")
        : signal?.reason ?? new Error("native app tool aborted"),
    );
    const timer = setTimeout(
      () => finish(transportError("ChatGPT native app tool timed out")),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (length > MAX_NATIVE_FRAME_BYTES) {
        finish(new CodexAppNativeUnknownOutcomeError(`ChatGPT native app tool response is too large`));
        return;
      }
      if (pending.length < length + 4) return;
      try {
        finish(undefined, JSON.parse(pending.subarray(4, length + 4).toString("utf8")));
      } catch {
        finish(new CodexAppNativeUnknownOutcomeError(`ChatGPT native app tool returned invalid JSON`));
      }
    });
    socket.once("error", (error) => finish(transportError("ChatGPT native broker transport failed", error)));
    socket.once("close", () => {
      if (!settled) finish(transportError("AgentParty native broker closed without a response"));
    });
    if (signal?.aborted) onAbort();
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNativeToolResult(value: unknown): CodexAppNativeToolResult {
  if (!object(value)) {
    throw new CodexAppNativeUnknownOutcomeError(`ChatGPT native app tool response is not an object`);
  }
  if (object(value.error)) {
    const code = typeof value.error.code === "number" ? value.error.code : -32_000;
    const message = typeof value.error.message === "string"
      ? value.error.message
      : `ChatGPT native app tool failed`;
    throw new CodexAppNativeToolError(code, message);
  }
  const result = object(value.result) ? value.result : null;
  if (result === null || typeof result.success !== "boolean" || !Array.isArray(result.contentItems)) {
    throw new CodexAppNativeUnknownOutcomeError(`ChatGPT native app tool result is malformed`);
  }
  const contentItems: CodexAppNativeToolResult["contentItems"] = [];
  for (const item of result.contentItems) {
    if (!object(item) || typeof item.type !== "string") continue;
    if (item.type === "inputText" && typeof item.text === "string") {
      contentItems.push({ type: "inputText", text: item.text });
    } else if (item.type === "inputImage" && typeof item.imageUrl === "string") {
      contentItems.push({ type: "inputImage", imageUrl: item.imageUrl });
    } else if (item.type === "inputAudio" && typeof item.audioUrl === "string") {
      contentItems.push({ type: "inputAudio", audioUrl: item.audioUrl });
    }
  }
  return { success: result.success, contentItems };
}

export async function callCodexAppNativeTool(
  input: {
    runtime: CodexAppNativeRuntime;
    sourceThreadId: string;
    tool: string;
    arguments: Record<string, unknown>;
    turnId?: string;
    callId?: string;
  },
  deps: { invoke?: CodexAppNativeInvoke; signal?: AbortSignal } = {},
): Promise<CodexAppNativeToolResult> {
  if (!isClaudeSessionRegistrySessionId(input.sourceThreadId)) {
    throw new CodexAppNativeUnavailableError(
      `Invalid native source thread id: ${input.sourceThreadId}`,
    );
  }
  const id = randomUUID();
  const response = await (deps.invoke ?? invokeCodexAppNativeRequest)(
    input.runtime,
    {
      id,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: input.arguments,
        callId: input.callId ?? `agentparty-${randomUUID()}`,
        namespace: "codex_app",
        threadId: input.sourceThreadId,
        tool: input.tool,
        turnId: input.turnId ?? `agentparty-${randomUUID()}`,
      },
    },
    deps.signal,
  );
  return parseNativeToolResult(response);
}

export function nativeToolTextJson<T>(
  result: CodexAppNativeToolResult,
  validate: (value: unknown) => value is T,
): T {
  if (!result.success) throw new CodexAppNativeToolError(-32_000, `ChatGPT app tool reported failure`);
  const text = result.contentItems.find((item) => item.type === "inputText")?.text;
  if (text === undefined) {
    throw new CodexAppNativeUnavailableError(`ChatGPT app tool returned no text result`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodexAppNativeUnavailableError(`ChatGPT app tool returned non-JSON text`);
  }
  if (!validate(value)) {
    throw new CodexAppNativeUnavailableError(`ChatGPT app tool returned an unexpected result shape`);
  }
  return value;
}

export interface NativeWaitThreadResult {
  timedOut: boolean;
  polls: Array<{
    cursor?: string;
    latestTurn?: { id: string; status: string; error?: unknown } | null;
    latestAssistantMessage?: { text: string; phase?: string } | null;
    thread?: { id: string; status?: { type?: string } };
  }>;
  wake?: { reason?: string; turnId?: string; threadId?: string } | null;
}

export function isNativeWaitThreadResult(value: unknown): value is NativeWaitThreadResult {
  return object(value) && typeof value.timedOut === "boolean" && Array.isArray(value.polls);
}

export function isNativeSendThreadResult(value: unknown): value is { threadId: string } {
  return object(value) && typeof value.threadId === "string";
}

export interface NativeReadThreadResult {
  turns: Array<{
    id: string;
    status: string;
    items: Array<{
      type: string;
      name?: string;
      namespace?: string;
      output?: { text?: string; truncated?: boolean };
    }>;
  }>;
}

export function isNativeReadThreadResult(value: unknown): value is NativeReadThreadResult {
  return object(value) && Array.isArray(value.turns);
}

export function nativeDelegationEnvelope(sourceThreadId: string, prompt: string): string {
  return `<codex_delegation>\n` +
    `  <source_thread_id>${sourceThreadId}</source_thread_id>\n` +
    `  <input>${prompt}</input>\n` +
    `</codex_delegation>`;
}

/** Positive reconciliation: exact target turn + exact native delegation body. */
export function nativeReadThreadMatchesDelegation(
  read: NativeReadThreadResult,
  expected: { turnId: string; sourceThreadId: string; prompt: string },
): boolean {
  const turn = read.turns.find((candidate) => candidate.id === expected.turnId);
  if (turn === undefined) return false;
  const output = turn.items.find((item) =>
    item.type === "functionCallOutput" &&
    item.name === "send_message_to_thread" &&
    item.namespace === "codex_app"
  )?.output;
  return output?.truncated !== true &&
    output?.text === nativeDelegationEnvelope(expected.sourceThreadId, expected.prompt);
}
