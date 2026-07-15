// Repro harness for issue #553: distinguish "the MCP server completed a
// notification send" from "an idle harness created a new model turn". A send
// completion alone does not prove client handling; client-side logs/TUI state
// must be recorded separately.
//
// Run this only as an MCP stdio child. Protocol messages use stdout; all probe
// evidence is append-only JSONL at MCP_PROBE_LOG so stderr/UI rendering cannot
// be mistaken for model-visible payload.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const logPath = resolve(process.env.MCP_PROBE_LOG ?? "mcp-notification-probe.jsonl");
const invocationId = process.env.MCP_PROBE_INVOCATION_ID ?? crypto.randomUUID();
const probeStartedAt = Date.now();
let runNumber = 0;

mkdirSync(dirname(logPath), { recursive: true });

function record(event: string, data: Record<string, unknown> = {}): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({ ts: Date.now(), elapsed_ms: Date.now() - probeStartedAt, pid: process.pid, invocation_id: invocationId, event, ...data })}\n`,
    "utf8",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const server = new McpServer(
  { name: "agentparty-mcp-idle-wake-probe", version: "1.0.0" },
  {
    capabilities: {
      logging: {},
      resources: { subscribe: true, listChanged: true },
      tools: { listChanged: true },
    },
  },
);

async function emitNotificationSet(runId: string, hiddenToken: string, phase: "active" | "idle"): Promise<void> {
  const payload = { run_id: runId, hidden_token: hiddenToken, phase, emitted_at: Date.now() };
  const notifications: Array<[string, () => void | Promise<void>]> = [
    [
      "logging/message",
      () => server.sendLoggingMessage({ level: "alert", logger: "agentparty-wake-probe", data: payload }),
    ],
    ["resources/updated", () => server.server.sendResourceUpdated({ uri: "probe://latest" })],
    ["resources/list_changed", () => server.server.sendResourceListChanged()],
    ["tools/list_changed", () => server.server.sendToolListChanged()],
  ];

  for (const [kind, send] of notifications) {
    record("notification_attempt", { run_id: runId, hidden_token: hiddenToken, phase, kind });
    try {
      await send();
      record("notification_sent", { run_id: runId, hidden_token: hiddenToken, phase, kind });
    } catch (error) {
      record("notification_error", {
        run_id: runId,
        hidden_token: hiddenToken,
        phase,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function newRun(phase: "active" | "idle"): { runId: string; hiddenToken: string } {
  runNumber += 1;
  return {
    runId: `${phase}-${process.pid}-${runNumber}`,
    hiddenToken: `AP553-${crypto.randomUUID()}`,
  };
}

server.registerResource(
  "latest-probe",
  "probe://latest",
  { title: "Latest MCP notification probe", mimeType: "application/json" },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ log_path: logPath, note: "The hidden token is intentionally never exposed by this resource." }),
      },
    ],
  }),
);

server.registerTool(
  "probe_active",
  {
    title: "Emit notifications while a tool call is active",
    description:
      "Emits logging/resource/tool-list notifications before this tool returns. The notification token is omitted from the tool result.",
    inputSchema: { hold_ms: z.number().int().min(100).max(30_000).default(1_500) },
  },
  async ({ hold_ms }) => {
    const { runId, hiddenToken } = newRun("active");
    record("active_probe_started", { run_id: runId, hidden_token: hiddenToken, hold_ms });
    await emitNotificationSet(runId, hiddenToken, "active");
    await sleep(hold_ms);
    record("active_probe_returned", { run_id: runId, hidden_token: hiddenToken });
    return {
      content: [
        {
          type: "text",
          text: `Active probe ${runId} completed. Its notification-only token is intentionally omitted from this tool result.`,
        },
      ],
      structuredContent: { run_id: runId, phase: "active", token_exposed_by_tool_result: false },
    };
  },
);

server.registerTool(
  "probe_arm_idle",
  {
    title: "Emit notifications after the current tool call returns",
    description:
      "Arms server notifications for a future delay. Use it to test whether an idle client creates a new model turn.",
    inputSchema: { delay_ms: z.number().int().min(250).max(3_600_000).default(10_000) },
  },
  async ({ delay_ms }) => {
    const { runId, hiddenToken } = newRun("idle");
    record("idle_probe_armed", { run_id: runId, hidden_token: hiddenToken, delay_ms });
    setTimeout(() => {
      void emitNotificationSet(runId, hiddenToken, "idle").then(() => {
        record("idle_probe_finished", { run_id: runId, hidden_token: hiddenToken });
      });
    }, delay_ms);
    return {
      content: [
        {
          type: "text",
          text: `Idle probe ${runId} armed for ${delay_ms} ms. Its notification-only token is intentionally omitted from this tool result.`,
        },
      ],
      structuredContent: { run_id: runId, phase: "idle", delay_ms, token_exposed_by_tool_result: false },
    };
  },
);

server.server.oninitialized = () => {
  record("client_initialized", {
    client_version: server.server.getClientVersion(),
    client_capabilities: server.server.getClientCapabilities(),
  });
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    record("process_signal", { signal });
    process.exit(0);
  });
}
process.stdin.on("end", () => record("stdin_end"));
process.stdin.on("close", () => record("stdin_close"));
process.on("exit", (code) => record("process_exit", { code }));
process.on("uncaughtException", (error) => {
  record("uncaught_exception", { error: error.stack ?? error.message });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  record("unhandled_rejection", { error: error instanceof Error ? error.stack ?? error.message : String(error) });
  process.exit(1);
});

record("probe_process_started", { log_path: logPath });
await server.connect(new StdioServerTransport());
record("transport_connected");
