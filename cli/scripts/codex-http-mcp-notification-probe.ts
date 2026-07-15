// Repro harness for AgentParty issue #553's Streamable HTTP cell.
//
// This is deliberately a one-shot process: it starts a sessionful MCP server
// on 127.0.0.1, drives the installed Codex app-server against that URL, checks
// notifications both during an active tool call and after a completed turn,
// then closes every HTTP/MCP/app-server resource and removes its isolated
// CODEX_HOME/workspace. The persisted JSONL contains aggregate evidence only;
// thread, turn, message, MCP-session, auth, and temporary-path identifiers are
// never written.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
};

type NotificationPhase = "active" | "idle";
type NotificationSend = { kind: string; ts_ms: number };
type ProbeRun = {
  phase: NotificationPhase;
  run_id: string;
  marker: string;
  started_at_ms: number;
  returned_at_ms?: number;
  sends: NotificationSend[];
  errors: Array<{ kind: string; error: string }>;
};

type TokenUsage = {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};

const invocationId = crypto.randomUUID();
const probeStartedAt = Date.now();
const outputPath = resolve(
  process.env.MCP_HTTP_PROBE_LOG ?? `${tmpdir()}/agentparty-ap553-http-${invocationId}.jsonl`,
);
const idleObservationMs = Number(process.env.MCP_HTTP_IDLE_MS ?? 20_000);
const idleDelayMs = Number(process.env.MCP_HTTP_NOTIFICATION_DELAY_MS ?? 10_000);
const activeHoldMs = Number(process.env.MCP_HTTP_ACTIVE_HOLD_MS ?? 1_500);
const turnTimeoutMs = Number(process.env.MCP_HTTP_TURN_TIMEOUT_MS ?? 180_000);
const appServerShutdownGraceMs = Number(process.env.MCP_HTTP_SHUTDOWN_GRACE_MS ?? 2_000);
const codexBin = resolve(process.env.MCP_HTTP_CODEX_BIN ?? Bun.which("codex") ?? "codex");
const sourceCodexHome = resolve(process.env.CODEX_HOME ?? `${homedir()}/.codex`);
const isolatedCodexHome = mkdtempSync(`${tmpdir()}/agentparty-ap553-http-codex-home-`);
const workspace = mkdtempSync(`${tmpdir()}/agentparty-ap553-http-workspace-`);
const runs: ProbeRun[] = [];
const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

for (const [name, value] of Object.entries({
  idleObservationMs,
  idleDelayMs,
  activeHoldMs,
  turnTimeoutMs,
  appServerShutdownGraceMs,
})) {
  if (!Number.isFinite(value) || value < 250) throw new Error(`${name} must be at least 250ms`);
}
if (!existsSync(codexBin)) throw new Error(`Codex binary not found: ${codexBin}`);

mkdirSync(dirname(outputPath), { recursive: true });

function record(event: string, data: Record<string, unknown> = {}): void {
  appendFileSync(
    outputPath,
    `${JSON.stringify({
      ts_ms: Date.now(),
      elapsed_ms: Date.now() - probeStartedAt,
      invocation_id: invocationId,
      transport: "streamable_http",
      event,
      ...data,
    })}\n`,
    "utf8",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function createProbeRun(phase: NotificationPhase): ProbeRun {
  const run: ProbeRun = {
    phase,
    run_id: `${phase}-${crypto.randomUUID()}`,
    marker: `AP553-HTTP-${crypto.randomUUID()}`,
    started_at_ms: Date.now(),
    sends: [],
    errors: [],
  };
  runs.push(run);
  return run;
}

function createProbeServer(): McpServer {
  const server = new McpServer(
    { name: "agentparty-mcp-http-idle-wake-probe", version: "1.0.0" },
    {
      capabilities: {
        logging: {},
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
      },
    },
  );

  async function emitNotificationSet(run: ProbeRun): Promise<void> {
    const payload = {
      run_id: run.run_id,
      hidden_token: run.marker,
      phase: run.phase,
      emitted_at: Date.now(),
    };
    const notifications: Array<[string, () => void | Promise<void>]> = [
      [
        "logging/message",
        () => server.sendLoggingMessage({ level: "alert", logger: "agentparty-http-wake-probe", data: payload }),
      ],
      ["resources/updated", () => server.server.sendResourceUpdated({ uri: "probe://http/latest" })],
      ["resources/list_changed", () => server.server.sendResourceListChanged()],
      ["tools/list_changed", () => server.server.sendToolListChanged()],
    ];

    for (const [kind, send] of notifications) {
      try {
        await send();
        run.sends.push({ kind, ts_ms: Date.now() });
      } catch (error) {
        run.errors.push({ kind, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  server.registerResource(
    "latest-http-probe",
    "probe://http/latest",
    { title: "Latest Streamable HTTP notification probe", mimeType: "application/json" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ note: "The notification-only marker is intentionally omitted." }),
      }],
    }),
  );

  server.registerTool(
    "probe_active",
    {
      title: "Emit HTTP notifications while a tool call is active",
      description:
        "Emits four Streamable HTTP MCP notifications before returning. The random marker is omitted from the tool result.",
      inputSchema: { hold_ms: z.number().int().min(100).max(30_000).default(1_500) },
    },
    async ({ hold_ms }) => {
      const run = createProbeRun("active");
      await emitNotificationSet(run);
      await sleep(hold_ms);
      run.returned_at_ms = Date.now();
      return {
        content: [{
          type: "text",
          text: `Active HTTP probe ${run.run_id} completed. Its notification-only token is omitted.`,
        }],
        structuredContent: { run_id: run.run_id, phase: "active", token_exposed_by_tool_result: false },
      };
    },
  );

  server.registerTool(
    "probe_arm_idle",
    {
      title: "Emit HTTP notifications after the current tool call returns",
      description:
        "Arms four Streamable HTTP MCP notifications for a delay, so they can be sent after the current turn completes.",
      inputSchema: { delay_ms: z.number().int().min(250).max(3_600_000).default(10_000) },
    },
    async ({ delay_ms }) => {
      const run = createProbeRun("idle");
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        void emitNotificationSet(run).then(() => {
          run.returned_at_ms = Date.now();
        });
      }, delay_ms);
      pendingTimers.add(timer);
      return {
        content: [{
          type: "text",
          text: `Idle HTTP probe ${run.run_id} armed for ${delay_ms} ms. Its notification-only token is omitted.`,
        }],
        structuredContent: {
          run_id: run.run_id,
          phase: "idle",
          delay_ms,
          token_exposed_by_tool_result: false,
        },
      };
    },
  );

  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const httpServer = createServer(async (req, res) => {
  try {
    if (req.url !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    let body: unknown;

    if (req.method === "POST") body = await readJsonBody(req);

    if (!session && req.method === "POST" && !sessionId && isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (createdSessionId) => {
          sessions.set(createdSessionId, { transport, server });
        },
        onsessionclosed: (closedSessionId) => {
          sessions.delete(closedSessionId);
        },
      });
      const server = createProbeServer();
      session = { transport, server };
      await server.connect(transport);
    }

    if (!session) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Missing or invalid MCP session" },
      });
      return;
    }

    await session.transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      });
    } else {
      res.end();
    }
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  httpServer.once("error", rejectListen);
  httpServer.listen(0, "127.0.0.1", () => resolveListen());
});
const address = httpServer.address();
if (!address || typeof address === "string") throw new Error("HTTP probe did not obtain a TCP port");
const endpoint = `http://127.0.0.1:${address.port}/mcp`;

const sourceAuth = resolve(sourceCodexHome, "auth.json");
const isolatedAuth = resolve(isolatedCodexHome, "auth.json");
if (!existsSync(sourceAuth)) throw new Error(`Codex auth.json not found: ${sourceAuth}`);
symlinkSync(sourceAuth, isolatedAuth);

const safeAppEnvKeys = [
  "PATH", "HOME", "USER", "TMPDIR", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "CODEX_API_BASE_URL",
] as const;
const appEnv: Record<string, string> = { CODEX_HOME: isolatedCodexHome };
for (const key of safeAppEnvKeys) {
  const value = process.env[key];
  if (value !== undefined) appEnv[key] = value;
}

const child = Bun.spawn(
  [codexBin, "app-server", "--stdio", "-c", `mcp_servers.ap553_http.url=${JSON.stringify(endpoint)}`],
  {
    cwd: workspace,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: appEnv,
    detached: process.platform !== "win32",
  },
);
let childExitCode: number | null = null;
const childExited = child.exited.then((code) => {
  childExitCode = code;
  return code;
});

function signalAppServer(signal: NodeJS.Signals): void {
  if (childExitCode !== null) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, signal); } catch { /* leader fallback below */ }
  }
  try { child.kill(signal); } catch { /* already exited */ }
}

async function stopAppServer(): Promise<number> {
  try { child.stdin.end(); } catch { /* stdin may already be closed after an early app-server exit */ }
  signalAppServer("SIGTERM");
  const stopped = await Promise.race([
    childExited.then(() => true),
    Bun.sleep(appServerShutdownGraceMs).then(() => false),
  ]);
  if (!stopped) signalAppServer("SIGKILL");
  return await childExited;
}
const version = Bun.spawnSync([codexBin, "--version"], { env: appEnv }).stdout.toString().trim();
const binarySha256 = Bun.spawnSync(["shasum", "-a", "256", codexBin]).stdout.toString().trim().split(/\s+/)[0];

record("probe_started", {
  client: "Codex app-server",
  codex_version: version,
  codex_binary_sha256: binarySha256,
  endpoint_host: "127.0.0.1",
  endpoint_path: "/mcp",
  ephemeral_port: true,
  isolated_codex_home: true,
  existing_user_config_loaded: false,
  sandbox: "read-only",
  idle_delay_ms: idleDelayMs,
  idle_observation_ms: idleObservationMs,
  active_hold_ms: activeHoldMs,
  identifier_policy: "thread, turn, message, MCP-session, auth, and temporary paths are not persisted",
});

let nextId = 1;
const responseWaiters = new Map<number, { resolve: (message: RpcMessage) => void; reject: (error: Error) => void }>();
const messages: RpcMessage[] = [];
const notificationWaiters: Array<{
  predicate: (message: RpcMessage) => boolean;
  resolve: (message: RpcMessage) => void;
}> = [];
const usageByTurn = new Map<string, TokenUsage>();
const assistantTextByTurn = new Map<string, string[]>();
let stderrText = "";

function rpcTurnId(message: RpcMessage): string | undefined {
  const direct = message.params?.turnId;
  if (typeof direct === "string") return direct;
  const turn = message.params?.turn as { id?: unknown } | undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}

function ingest(message: RpcMessage): void {
  messages.push(message);
  const messageTurnId = rpcTurnId(message);
  if (message.method === "thread/tokenUsage/updated" && messageTurnId) {
    const tokenUsage = message.params?.tokenUsage as { last?: TokenUsage } | undefined;
    if (tokenUsage?.last) usageByTurn.set(messageTurnId, tokenUsage.last);
  }
  if (message.method === "item/completed" && messageTurnId) {
    const item = message.params?.item as { type?: unknown; text?: unknown; phase?: unknown } | undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      const texts = assistantTextByTurn.get(messageTurnId) ?? [];
      texts.push(item.text);
      assistantTextByTurn.set(messageTurnId, texts);
    }
  }
  if (message.method === "mcpServer/elicitation/request" && (typeof message.id === "number" || typeof message.id === "string")) {
    const meta = message.params?._meta as Record<string, unknown> | undefined;
    const allowedTitles = new Set([
      "Emit HTTP notifications while a tool call is active",
      "Emit HTTP notifications after the current tool call returns",
    ]);
    const isExactProbeApproval =
      message.params?.serverName === "ap553_http" &&
      meta?.codex_approval_kind === "mcp_tool_call" &&
      typeof meta.tool_title === "string" &&
      allowedTitles.has(meta.tool_title);
    write(isExactProbeApproval
      ? { id: message.id, result: { action: "accept", content: {} } }
      : { id: message.id, result: { action: "decline", content: null } });
  }
  if (typeof message.id === "number" && ("result" in message || "error" in message)) {
    const waiter = responseWaiters.get(message.id);
    if (waiter) {
      responseWaiters.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(`RPC ${message.id} failed: ${JSON.stringify(message.error)}`));
      else waiter.resolve(message);
    }
  }
  for (let index = notificationWaiters.length - 1; index >= 0; index--) {
    const waiter = notificationWaiters[index]!;
    if (!waiter.predicate(message)) continue;
    notificationWaiters.splice(index, 1);
    waiter.resolve(message);
  }
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      onLine(line);
    }
  }
  buffered += decoder.decode();
  if (buffered) onLine(buffered);
}

const stdoutLoop = readLines(child.stdout, (line) => {
  if (!line.trim()) return;
  try {
    ingest(JSON.parse(line) as RpcMessage);
  } catch {
    // Raw app-server output is intentionally not persisted.
  }
});
const stderrLoop = readLines(child.stderr, (line) => {
  stderrText += `${line}\n`;
});

function write(message: RpcMessage): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.flush();
}

async function request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcMessage> {
  const id = nextId++;
  const response = new Promise<RpcMessage>((resolveResponse, rejectResponse) => {
    responseWaiters.set(id, { resolve: resolveResponse, reject: rejectResponse });
  });
  write({ id, method, params });
  const timer = setTimeout(() => {
    const waiter = responseWaiters.get(id);
    if (!waiter) return;
    responseWaiters.delete(id);
    waiter.reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await response;
  } finally {
    clearTimeout(timer);
  }
}

function waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs: number): Promise<RpcMessage> {
  const existing = messages.findLast(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolveMessage, rejectMessage) => {
    const waiter = { predicate, resolve: resolveMessage };
    notificationWaiters.push(waiter);
    setTimeout(() => {
      const index = notificationWaiters.indexOf(waiter);
      if (index < 0) return;
      notificationWaiters.splice(index, 1);
      rejectMessage(new Error(`notification wait timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function startTurn(threadId: string, text: string): Promise<string> {
  const response = await request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  const turn = response.result?.turn as { id?: unknown } | undefined;
  if (typeof turn?.id !== "string") throw new Error(`turn/start returned no turn id`);
  return turn.id;
}

async function waitForTurnCompleted(turnId: string): Promise<number> {
  await waitFor((message) => message.method === "turn/completed" && rpcTurnId(message) === turnId, turnTimeoutMs);
  return Date.now();
}

function finalAssistantText(turnId: string): string {
  return (assistantTextByTurn.get(turnId) ?? []).findLast((text) => text.length > 0) ?? "";
}

const expectedKinds = ["logging/message", "resources/updated", "resources/list_changed", "tools/list_changed"];
function exactNotificationSet(run: ProbeRun): boolean {
  const kinds = run.sends.map((send) => send.kind);
  return run.errors.length === 0 &&
    kinds.length === expectedKinds.length &&
    expectedKinds.every((kind) => kinds.filter((sent) => sent === kind).length === 1);
}

let exitCode = 1;
try {
  await request("initialize", {
    clientInfo: { name: "agentparty-mcp-http-wake-probe", title: "AgentParty MCP HTTP Wake Probe", version: "1.0.0" },
    capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
  });
  write({ method: "initialized", params: {} });

  const threadResponse = await request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });
  const thread = threadResponse.result?.thread as { id?: unknown } | undefined;
  if (typeof thread?.id !== "string") throw new Error("thread/start returned no thread id");
  const threadId = thread.id;

  const activeStartedAt = Date.now();
  const activeTurnId = await startTurn(
    threadId,
    `Call mcp__ap553_http__probe_active exactly once with hold_ms=${activeHoldMs}. ` +
      "Then return only this JSON: {\"called_once\":true,\"saw_unsolicited_notification_token\":false,\"exact_token_or_null\":null}. " +
      "Do not call another tool.",
  );
  const activeCompletedAt = await waitForTurnCompleted(activeTurnId);
  const activeRun = runs.find((run) => run.phase === "active");
  if (!activeRun) throw new Error("HTTP server did not record the active probe");
  const activeOutput = finalAssistantText(activeTurnId);

  const idleTurnId = await startTurn(
    threadId,
    `Call mcp__ap553_http__probe_arm_idle exactly once with delay_ms=${idleDelayMs}. ` +
      "Then finish immediately and return only ARMED. Do not poll, sleep, or call another tool.",
  );
  const idleCompletedAt = await waitForTurnCompleted(idleTurnId);
  const messageIndexAfterIdleCompleted = messages.length;
  const idleObservationStartedAt = Date.now();
  await sleep(idleObservationMs);
  const idleObservationElapsedMs = Date.now() - idleObservationStartedAt;
  const idleRun = runs.find((run) => run.phase === "idle");
  if (!idleRun) throw new Error("HTTP server did not record the idle probe");
  const unsolicitedTurns = messages
    .slice(messageIndexAfterIdleCompleted)
    .filter((message) => message.method === "turn/started");

  const followupTurnId = await startTurn(
    threadId,
    "Without calling any tool, answer only this JSON: " +
      "{\"saw_unsolicited_notification_token\":false,\"exact_token_or_null\":null}. " +
      "Change false/null only if an unsolicited MCP notification token was actually placed in your model input.",
  );
  await waitForTurnCompleted(followupTurnId);
  const followupOutput = finalAssistantText(followupTurnId);
  let followupDeniedMarker = false;
  try {
    const parsed = JSON.parse(followupOutput) as Record<string, unknown>;
    followupDeniedMarker =
      parsed.saw_unsolicited_notification_token === false && parsed.exact_token_or_null === null;
  } catch {
    followupDeniedMarker = false;
  }

  const activeMarkerInOutput = activeOutput.includes(activeRun.marker);
  const idleMarkerInOutput = followupOutput.includes(idleRun.marker);
  const activeClientReceipt = stderrText.includes(activeRun.marker);
  const idleClientReceipt = stderrText.includes(idleRun.marker);
  const activeDuringTurn = activeRun.sends.every(
    (send) => send.ts_ms >= activeStartedAt && send.ts_ms < activeCompletedAt,
  );
  const idleAfterCompleted = idleRun.sends.every((send) => send.ts_ms > idleCompletedAt);
  const activeRunCount = runs.filter((run) => run.phase === "active").length;
  const idleRunCount = runs.filter((run) => run.phase === "idle").length;

  record("active_probe_result", {
    run_id: activeRun.run_id,
    phase_run_count: activeRunCount,
    server_hidden_marker: activeRun.marker,
    server_sent: activeRun.sends,
    exact_notification_set: exactNotificationSet(activeRun),
    all_sends_during_deliberate_turn: activeDuringTurn,
    client_stderr_rendered_logging_marker: activeClientReceipt,
    marker_in_model_output: activeMarkerInOutput,
    deliberate_turn_usage: usageByTurn.get(activeTurnId) ?? null,
    notification_incremental_token_cost: "not isolated from the deliberate active turn",
  });
  record("idle_probe_result", {
    run_id: idleRun.run_id,
    phase_run_count: idleRunCount,
    server_hidden_marker: idleRun.marker,
    completed_to_first_send_ms: idleRun.sends.length > 0 ? idleRun.sends[0]!.ts_ms - idleCompletedAt : null,
    server_sent: idleRun.sends,
    exact_notification_set: exactNotificationSet(idleRun),
    all_sends_after_turn_completed: idleAfterCompleted,
    client_stderr_rendered_logging_marker: idleClientReceipt,
    idle_observation_ms: idleObservationElapsedMs,
    unsolicited_turn_count: unsolicitedTurns.length,
    marker_in_followup_model_output: idleMarkerInOutput,
    followup_explicitly_denied_marker: followupDeniedMarker,
    arming_turn_usage: usageByTurn.get(idleTurnId) ?? null,
    manual_followup_usage: usageByTurn.get(followupTurnId) ?? null,
    notification_triggered_model_turns: idleAfterCompleted
      ? unsolicitedTurns.length
      : "not attributable because the after-completed timing precondition failed",
    notification_triggered_model_tokens: idleAfterCompleted && unsolicitedTurns.length === 0
      ? 0
      : "not attributable",
  });

  const passed =
    activeRunCount === 1 &&
    idleRunCount === 1 &&
    exactNotificationSet(activeRun) &&
    exactNotificationSet(idleRun) &&
    activeDuringTurn &&
    idleAfterCompleted &&
    activeClientReceipt &&
    idleClientReceipt &&
    !activeMarkerInOutput &&
    unsolicitedTurns.length === 0 &&
    !idleMarkerInOutput &&
    followupDeniedMarker;
  record("probe_summary", {
    passed,
    conclusion: idleAfterCompleted
      ? "In this run, Streamable HTTP logging notifications were visible in Codex client diagnostics, but the completed-turn notification set created no unsolicited model turn and its marker did not appear in the later verification output."
      : "This run is invalid for the completed-turn cell because one or more notifications were sent before the turn completed.",
    inference_limit:
      "Marker absence from model output does not prove absence from every internal client state or model-context path.",
    product_boundary:
      "A server-side notification send or diagnostic receipt is not a delivery ACK and is not an unattended wake contract.",
  });
  exitCode = passed ? 0 : 2;
} catch (error) {
  record("probe_error", { error: error instanceof Error ? error.message : String(error) });
  console.error(error);
} finally {
  for (const timer of pendingTimers) clearTimeout(timer);
  pendingTimers.clear();
  await stopAppServer();
  await Promise.allSettled([stdoutLoop, stderrLoop]);
  for (const session of sessions.values()) await session.server.close().catch(() => undefined);
  sessions.clear();
  await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  rmSync(isolatedCodexHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  record("probe_stopped", { exit_code: exitCode, temporary_state_removed: true });
  console.log(outputPath);
}

process.exit(exitCode);
