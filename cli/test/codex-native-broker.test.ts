import { afterEach, describe, expect, test } from "bun:test";
import { createServer, createConnection, type Server } from "node:net";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTPARTY_CODEX_NATIVE_MCP_SERVER_NAME,
  codexNativeBrokerMcpConfigured,
  codexNativeBrokerMcpName,
  installCodexNativeBrokerScript,
} from "../src/codex-native-broker";

const SOURCE = "01a04eb6-6349-7871-9c05-8eb15d68635f";
const TARGET = "01a0499f-2ce2-76e1-8734-733f8f169c28";
const MAX = 8 * 1024 * 1024;

let root: string | null = null;
let server: Server | null = null;
let child: ReturnType<typeof Bun.spawn> | null = null;

afterEach(async () => {
  try { child?.kill("SIGTERM"); } catch { /* already gone */ }
  try { server?.close(); } catch { /* already closed */ }
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
  server = null;
  child = null;
});

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX) throw new Error("test frame too large");
  const output = Buffer.alloc(4 + body.length);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function listenUnix(socketPath: string, onRequest: (value: unknown) => unknown): Promise<Server> {
  return new Promise((resolve, reject) => {
    const created = createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        if (pending.length < 4) return;
        const length = pending.readUInt32LE(0);
        if (pending.length < length + 4) return;
        const value = JSON.parse(pending.subarray(4, length + 4).toString("utf8"));
        socket.end(frame(onRequest(value)));
      });
    });
    created.once("error", reject);
    created.listen(socketPath, () => resolve(created));
  });
}

function callFramed(socketPath: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let pending = Buffer.alloc(0);
    socket.once("connect", () => socket.write(frame(value)));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (pending.length < length + 4) return;
      resolve(JSON.parse(pending.subarray(4, length + 4).toString("utf8")));
      socket.end();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      if (pending.length === 0) reject(new Error("broker closed without a response"));
    });
  });
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      if (lstatSync(path).isSocket()) return;
    } catch { /* not ready */ }
    await Bun.sleep(20);
  }
  throw new Error(`broker socket did not appear: ${path}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe("ChatGPT native broker MCP", () => {
  test("uses one global MCP name instead of racing one broker per channel", () => {
    expect(codexNativeBrokerMcpName("party-a")).toBe(AGENTPARTY_CODEX_NATIVE_MCP_SERVER_NAME);
    expect(codexNativeBrokerMcpName("party-b")).toBe(AGENTPARTY_CODEX_NATIVE_MCP_SERVER_NAME);
  });

  test("detects the registered broker section without reading any channel credentials", () => {
    root = mkdtempSync(join(tmpdir(), "agentparty-native-config-"));
    const codexHome = join(root, ".codex");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      "[mcp_servers.agentparty_native]",
      'command = "/signed/node"',
      'args = ["/broker.cjs", "--mcp", "/agentparty"]',
      "",
    ].join("\n"));
    expect(codexNativeBrokerMcpConfigured({ CODEX_HOME: codexHome })).toBe(true);
    writeFileSync(join(codexHome, "config.toml"), [
      "[mcp_servers.agentparty_native]",
      "enabled = false",
      "",
    ].join("\n"));
    expect(codexNativeBrokerMcpConfigured({ CODEX_HOME: codexHome })).toBe(false);
  });

  test("MCP child advertises no tools and forwards only registered cross-task calls", async () => {
    root = mkdtempSync(join(tmpdir(), "agentparty-native-broker-"));
    chmodSync(root, 0o700);
    const upstreamPath = join(root, "upstream.sock");
    let forwarded: unknown = null;
    server = await listenUnix(upstreamPath, (request) => {
      forwarded = request;
      return {
        jsonrpc: "2.0",
        id: "native-response",
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify({ threadId: TARGET }) }],
        },
      };
    });

    const script = installCodexNativeBrokerScript({ AGENTPARTY_HOME: root });
    expect(readFileSync(script, "utf8")).toContain("agentparty-codex-native-broker");
    const command =
      `: 'codex app-server CODEX_APP_TOOLS_PIPE_PATH="${upstreamPath}"'; ` +
      `${shellQuote(process.execPath)} ${shellQuote(script)} --mcp ${shellQuote(root)}; exit $?`;
    const proc = Bun.spawn(["/bin/bash", "-c", command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = proc;

    const registry = join(root, "codex-sessions");
    mkdirSync(registry, { recursive: true, mode: 0o700 });
    for (const threadId of [SOURCE, TARGET]) {
      writeFileSync(join(registry, `${threadId}.json`), JSON.stringify({
        version: 1,
        harness: "codex",
        session_id: threadId,
        pid: proc.pid,
      }), { mode: 0o600 });
    }

    const brokerPath = join(root, "codex-native-broker", `${proc.pid}.sock`);
    await waitForSocket(brokerPath);
    expect(lstatSync(brokerPath).mode & 0o077).toBe(0);

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    }) + "\n");
    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }) + "\n");

    const request = {
      jsonrpc: "2.0",
      id: "native-request",
      method: "tools/call",
      params: {
        namespace: "codex_app",
        threadId: SOURCE,
        tool: "send_message_to_thread",
        arguments: { threadId: TARGET, prompt: "native broker test" },
      },
    };
    const response = await callFramed(brokerPath, request);
    expect(forwarded).toEqual(request);
    expect(response).toMatchObject({ result: { success: true } });

    const rejected = await callFramed(brokerPath, {
      ...request,
      id: "unauthorized-request",
      params: { ...request.params, threadId: "01a0499f-2ce2-76e1-8734-733f8f169c29" },
    });
    expect(rejected).toMatchObject({
      id: "unauthorized-request",
      error: { code: -32600, message: "Unauthorized native broker request" },
    });

    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const replies = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(replies).toContainEqual(expect.objectContaining({
      id: 1,
      result: expect.objectContaining({ capabilities: { tools: {} } }),
    }));
    expect(replies).toContainEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  });
});
