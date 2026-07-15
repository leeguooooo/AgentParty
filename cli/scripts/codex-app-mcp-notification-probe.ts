// Repro harness for issue #553's Codex Desktop/App cell. Codex Desktop uses the
// Codex app-server as its agent backend; this script drives that same JSON-RPC
// boundary without changing the user's global MCP configuration or opening UI.
//
// It starts one thread, asks the model to arm the stdio notification probe,
// waits until the turn is complete, observes the idle backend for a new turn,
// and then sends a manual follow-up to check whether the notification-only
// marker leaked into model context. All app-server messages and probe-server
// events are kept as JSONL evidence.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
};

const probeScript = resolve(process.env.MCP_APP_PROBE_SERVER ?? "cli/scripts/mcp-notification-probe.ts");
const evidencePath = resolve(process.env.MCP_APP_PROBE_LOG ?? "cli/.probe-results/codex-app-server.jsonl");
const serverLogPath = resolve(process.env.MCP_PROBE_LOG ?? "cli/.probe-results/codex-app-server-mcp.jsonl");
const idleObservationMs = Number(process.env.MCP_APP_IDLE_MS ?? 30_000);
const notificationDelayMs = Number(process.env.MCP_APP_NOTIFICATION_DELAY_MS ?? 5_000);
const turnTimeoutMs = Number(process.env.MCP_APP_TURN_TIMEOUT_MS ?? 180_000);
const appServerShutdownGraceMs = Number(process.env.MCP_APP_SHUTDOWN_GRACE_MS ?? 2_000);
const bunPath = Bun.which("bun");
const desktopBinaryCandidates = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
const codexBin = resolve(
  process.env.MCP_APP_CODEX_BIN ?? desktopBinaryCandidates.find(existsSync) ?? Bun.which("codex") ?? "codex",
);
const sourceCodexHome = resolve(process.env.CODEX_HOME ?? `${homedir()}/.codex`);
const configuredCodexHome = process.env.MCP_APP_ISOLATED_CODEX_HOME;
const isolatedCodexHome = configuredCodexHome
  ? resolve(configuredCodexHome)
  : mkdtempSync(`${tmpdir()}/agentparty-ap553-codex-home-`);
const configuredWorkspace = process.env.MCP_APP_PROBE_CWD;
const cwd = configuredWorkspace
  ? resolve(configuredWorkspace)
  : mkdtempSync(`${tmpdir()}/agentparty-ap553-workspace-`);
const keepIsolatedState = process.env.MCP_APP_KEEP_ISOLATED_STATE === "1";
const invocationId = crypto.randomUUID();

if (!bunPath) throw new Error("bun executable not found");
if (!existsSync(codexBin)) throw new Error(`Codex binary not found: ${codexBin}`);
for (const [name, value] of Object.entries({ idleObservationMs, notificationDelayMs, turnTimeoutMs, appServerShutdownGraceMs })) {
  if (!Number.isFinite(value) || value < 250) throw new Error(`${name} must be at least 250ms`);
}
mkdirSync(dirname(evidencePath), { recursive: true });
mkdirSync(dirname(serverLogPath), { recursive: true });
const serverLogStartOffset = existsSync(serverLogPath) ? statSync(serverLogPath).size : 0;
mkdirSync(isolatedCodexHome, { recursive: true });
mkdirSync(cwd, { recursive: true });
const sourceAuth = resolve(sourceCodexHome, "auth.json");
const isolatedAuth = resolve(isolatedCodexHome, "auth.json");
if (!existsSync(isolatedAuth)) {
  if (!existsSync(sourceAuth)) throw new Error(`Codex auth.json not found: ${sourceAuth}`);
  // Reuse authentication without copying credential bytes into probe output or
  // the repository. The isolated home contains no config/plugins/hooks/MCPs.
  symlinkSync(sourceAuth, isolatedAuth);
}

function record(event: string, data: Record<string, unknown> = {}): void {
  appendFileSync(evidencePath, `${JSON.stringify({ ts: Date.now(), invocation_id: invocationId, event, ...data })}\n`, "utf8");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

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
const minimalMcpPath = [dirname(bunPath), "/usr/bin", "/bin"].join(":");

const child = Bun.spawn(
  [
    codexBin,
    "app-server",
    "--stdio",
    "-c",
    `mcp_servers.ap553.command=${tomlString("/usr/bin/env")}`,
    "-c",
    `mcp_servers.ap553.args=[${[
      "-i",
      `MCP_PROBE_LOG=${serverLogPath}`,
      `MCP_PROBE_INVOCATION_ID=${invocationId}`,
      `HOME=${cwd}`,
      `TMPDIR=${tmpdir()}`,
      `PATH=${minimalMcpPath}`,
      bunPath,
      probeScript,
    ].map(tomlString).join(",")}]`,
  ],
  {
    cwd,
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
record("app_server_started", {
  invocation_id: invocationId,
  pid: child.pid,
  codex_binary: codexBin,
  codex_binary_sha256: binarySha256,
  codex_version: version,
  isolated_codex_home: isolatedCodexHome,
  existing_user_config_loaded: false,
  inherited_environment_keys: Object.keys(appEnv).sort(),
  cwd,
  probe_script: probeScript,
  probe_server_log: serverLogPath,
  idle_observation_ms: idleObservationMs,
  notification_delay_ms: notificationDelayMs,
});

let nextId = 1;
const responseWaiters = new Map<number, { resolve: (message: RpcMessage) => void; reject: (error: Error) => void }>();
const messages: RpcMessage[] = [];
const notificationWaiters: Array<{
  predicate: (message: RpcMessage) => boolean;
  resolve: (message: RpcMessage) => void;
}> = [];

function ingest(message: RpcMessage): void {
  messages.push(message);
  record("app_server_message", { message });
  if (message.method === "mcpServer/elicitation/request" && (typeof message.id === "number" || typeof message.id === "string")) {
    const meta = message.params?._meta as Record<string, unknown> | undefined;
    const isExactProbeApproval =
      message.params?.serverName === "ap553" &&
      meta?.codex_approval_kind === "mcp_tool_call" &&
      meta?.tool_title === "Emit notifications after the current tool call returns";
    if (!isExactProbeApproval) {
      write({ id: message.id, result: { action: "decline", content: null } });
      record("unexpected_elicitation_declined", { request: message });
    } else {
      write({ id: message.id, result: { action: "accept", content: {} } });
      record("probe_elicitation_accepted", { request_id: message.id });
    }
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
  } catch (error) {
    record("app_server_stdout_parse_error", { line, error: error instanceof Error ? error.message : String(error) });
  }
});

const stderrLoop = readLines(child.stderr, (line) => record("app_server_stderr", { line }));

function write(message: RpcMessage): void {
  record("app_client_message", { message });
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

function turnId(message: RpcMessage): string | undefined {
  const turn = message.params?.turn as { id?: unknown } | undefined;
  return typeof turn?.id === "string" ? turn.id : undefined;
}

function readIdleMarker(): {
  runId: string;
  hiddenToken: string;
  sent: Array<{ kind: string; ts: number }>;
  runCount: number;
} {
  const appended = readFileSync(serverLogPath).subarray(serverLogStartOffset).toString("utf8");
  const rows = appended
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.invocation_id === invocationId);
  const armedRuns = rows.filter((row) => row.event === "idle_probe_armed");
  const armed = armedRuns[0];
  if (!armed || typeof armed.run_id !== "string" || typeof armed.hidden_token !== "string") {
    throw new Error("probe server did not record idle_probe_armed");
  }
  const sent = rows
    .filter(
      (row) => row.event === "notification_sent" &&
        row.run_id === armed.run_id &&
        row.hidden_token === armed.hidden_token,
    )
    .map((row) => ({ kind: String(row.kind), ts: Number(row.ts) }));
  return { runId: armed.run_id, hiddenToken: armed.hidden_token, sent, runCount: armedRuns.length };
}

let exitCode = 1;
try {
  await request("initialize", {
    clientInfo: { name: "agentparty-mcp-wake-probe", title: "AgentParty MCP Wake Probe", version: "1.0.0" },
    capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
  });
  write({ method: "initialized", params: {} });

  const threadResponse = await request("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    // Default runs leave no persisted conversation. Set KEEP_ISOLATED_STATE=1
    // only for the explicit restart cell, then delete that isolated home.
    ephemeral: !keepIsolatedState,
  });
  const thread = threadResponse.result?.thread as { id?: unknown } | undefined;
  if (typeof thread?.id !== "string") throw new Error(`thread/start returned no id: ${JSON.stringify(threadResponse)}`);
  const threadId = thread.id;

  const firstStart = await request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: `Call mcp__ap553__probe_arm_idle exactly once with delay_ms=${notificationDelayMs}. Then finish immediately. Do not poll, sleep, or call any other tool. In the final answer return only ARMED.`,
    }],
  });
  const firstTurn = firstStart.result?.turn as { id?: unknown } | undefined;
  if (typeof firstTurn?.id !== "string") throw new Error(`turn/start returned no id: ${JSON.stringify(firstStart)}`);
  await waitFor((message) => message.method === "turn/completed" && turnId(message) === firstTurn.id, turnTimeoutMs);
  const firstTurnCompletedAt = Date.now();
  const idleStartedAt = firstTurnCompletedAt;
  record("idle_observation_started", { thread_id: threadId, completed_turn_id: firstTurn.id });

  await Bun.sleep(idleObservationMs);
  const unsolicitedTurns = messages.filter(
    (message) => message.method === "turn/started" && turnId(message) !== firstTurn.id,
  );
  const marker = readIdleMarker();
  const preFollowupMessageCount = messages.length;
  record("idle_observation_finished", {
    thread_id: threadId,
    completed_turn_id: firstTurn.id,
    elapsed_ms: Date.now() - idleStartedAt,
    server_run_id: marker.runId,
    server_run_count: marker.runCount,
    server_notification_sends: marker.sent.map((item) => item.kind),
    all_notifications_after_turn_completed: marker.sent.every((item) => item.ts > firstTurnCompletedAt),
    unsolicited_turn_count: unsolicitedTurns.length,
  });

  const followup = await request("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "Without calling any tool, answer only this JSON: {\"saw_unsolicited_notification_token\":false,\"exact_token_or_null\":null}. Change false/null only if an unsolicited MCP notification token was actually placed in your model context.",
    }],
  });
  const followupTurn = followup.result?.turn as { id?: unknown } | undefined;
  if (typeof followupTurn?.id !== "string") throw new Error(`follow-up turn/start returned no id: ${JSON.stringify(followup)}`);
  await waitFor((message) => message.method === "turn/completed" && turnId(message) === followupTurn.id, turnTimeoutMs);
  const followupMessages = messages.slice(preFollowupMessageCount);
  const assistantPayload = followupMessages
    .filter((message) => message.method === "item/completed")
    .map((message) => message.params?.item)
    .filter((item) => (item as { type?: unknown } | undefined)?.type === "agentMessage");
  const markerInAssistantOutput = JSON.stringify(assistantPayload).includes(marker.hiddenToken);
  const assistantText = assistantPayload
    .map((item) => (item as { text?: unknown }).text)
    .findLast((text): text is string => typeof text === "string") ?? "";
  let parsedFollowup: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(assistantText) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      parsedFollowup = parsed as Record<string, unknown>;
    }
  } catch {
    // Strict verdict below fails closed on malformed/refused output.
  }
  const followupExplicitlyDeniedMarker =
    parsedFollowup?.saw_unsolicited_notification_token === false &&
    parsedFollowup.exact_token_or_null === null;
  // Re-read after the manual follow-up so an unexpected second tool call anywhere in this
  // invocation cannot be hidden by the marker snapshot taken before that turn.
  const finalMarker = readIdleMarker();
  const expectedKinds = ["logging/message", "resources/updated", "resources/list_changed", "tools/list_changed"];
  const sentKinds = marker.sent.map((item) => item.kind);
  const allNotificationsAfterTurnCompleted = marker.sent.every((item) => item.ts > firstTurnCompletedAt);
  const exactNotificationSet =
    sentKinds.length === expectedKinds.length &&
    expectedKinds.every((kind) => sentKinds.filter((sent) => sent === kind).length === 1);
  record("probe_summary", {
    client: "Codex app-server (Codex Desktop backend)",
    thread_id: threadId,
    armed_turn_id: firstTurn.id,
    followup_turn_id: followupTurn.id,
    server_run_id: marker.runId,
    server_run_count: finalMarker.runCount,
    server_notification_sends: sentKinds,
    first_turn_completed_at: firstTurnCompletedAt,
    notification_send_timestamps: marker.sent,
    all_notifications_after_turn_completed: allNotificationsAfterTurnCompleted,
    idle_observation_ms: Date.now() - idleStartedAt,
    unsolicited_turn_created: unsolicitedTurns.length > 0,
    marker_in_followup_assistant_output: markerInAssistantOutput,
    followup_explicitly_denied_marker: followupExplicitlyDeniedMarker,
    followup_assistant_items: assistantPayload,
  });
  exitCode =
    finalMarker.runCount === 1 &&
    unsolicitedTurns.length === 0 &&
    !markerInAssistantOutput &&
    followupExplicitlyDeniedMarker &&
    exactNotificationSet &&
    allNotificationsAfterTurnCompleted
      ? 0
      : 2;
} catch (error) {
  record("probe_error", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  console.error(error);
} finally {
  const appServerExitCode = await stopAppServer();
  await Promise.allSettled([stdoutLoop, stderrLoop]);
  record("app_server_stopped", { exit_code: appServerExitCode, probe_exit_code: exitCode });
  if (!keepIsolatedState) {
    if (configuredCodexHome === undefined) rmSync(isolatedCodexHome, { recursive: true, force: true });
    if (configuredWorkspace === undefined) rmSync(cwd, { recursive: true, force: true });
  } else {
    record("isolated_state_retained", { isolated_codex_home: isolatedCodexHome, cwd });
  }
}

process.exit(exitCode);
