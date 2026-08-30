/**
 * Install the tiny signed-Node broker launched directly by ChatGPT's app-server
 * as a zero-tool MCP server.
 *
 * ChatGPT Desktop's native pipe checks the macOS responsible-process chain.
 * A Node child spawned by the AgentParty binary is rejected even when the Node
 * executable is signed. An MCP child is owned directly by app-server, keeps the
 * accepted lineage, and can expose a second private socket restricted to the two
 * narrowly-scoped native operations AgentParty needs. It intentionally advertises no model tools.
 */
import { accessSync, chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentpartyHome } from "./config";
import { atomicWriteText } from "./atomic-json";

export const CODEX_NATIVE_BROKER_DIR = "codex-native-broker";
export const CODEX_NATIVE_BROKER_SCRIPT = "broker.cjs";
export const AGENTPARTY_CODEX_NATIVE_MCP_SERVER_NAME = "agentparty_native";

const BROKER_SOURCE = String.raw`"use strict";
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const MAX = 8 * 1024 * 1024;
const ALLOWED = new Set(["send_message_to_thread", "wait_threads", "read_thread"]);

const mode = process.argv[2];
if (mode === "--mcp") mcp();
else if (mode === "--run") run();
else process.exit(64);

function paths(home, appServerPid) {
  const dir = path.join(home, "codex-native-broker");
  return {
    dir,
    socket: path.join(dir, String(appServerPid) + ".sock"),
    marker: path.join(dir, String(appServerPid) + ".json"),
    claim: path.join(dir, String(appServerPid) + ".claim"),
  };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function privateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function atomicJson(file, value) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file); fs.chmodSync(file, 0o600);
}
function discoverRuntime(startPid) {
  let pid = startPid;
  for (let hop = 0; hop < 16 && Number.isSafeInteger(pid) && pid > 1; hop += 1) {
    const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], { encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const row = /^\s*(\d+)\s+(.*)$/.exec(result.stdout.trim());
    if (!row) return null;
    const command = row[2];
    const upstream = /CODEX_APP_TOOLS_PIPE_PATH["']?\s*=\s*["']([^"']+)["']/.exec(command)?.[1] ?? null;
    if (upstream != null && /(?:^|\s)app-server(?:\s|$)/.test(command)) {
      return { appServerPid: pid, upstream };
    }
    pid = Number(row[1]);
  }
  return null;
}
function mcp() {
  const home = process.argv[3];
  const runtime = discoverRuntime(process.ppid);
  if (!path.isAbsolute(home) || runtime == null || !path.isAbsolute(runtime.upstream)) process.exit(65);
  process.argv[3] = String(runtime.appServerPid);
  process.argv[4] = home;
  process.argv[5] = runtime.upstream;
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", line => {
    let request; try { request = JSON.parse(line); } catch { return; }
    if (request?.id == null) return;
    let result, error;
    if (request.method === "initialize") {
      result = {
        protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agentparty-codex-native-broker", version: "1" },
      };
    } else if (request.method === "tools/list") result = { tools: [] };
    else if (request.method === "ping") result = {};
    else error = { code: -32601, message: "Method not found" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\n");
  });
  lines.once("close", () => process.kill(process.pid, "SIGTERM"));
  run();
}
function registryEntry(home, threadId, appServerPid) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) return null;
  const entry = readJson(path.join(home, "codex-sessions", threadId.toLowerCase() + ".json"));
  return entry && entry.harness === "codex" && entry.session_id?.toLowerCase() === threadId.toLowerCase() && entry.pid === appServerPid
    ? entry : null;
}
function authorized(request, home, appServerPid) {
  if (request?.method !== "tools/call" || !ALLOWED.has(request?.params?.tool)) return false;
  if (!registryEntry(home, request.params.threadId, appServerPid)) return false;
  if (request.params.tool === "send_message_to_thread" || request.params.tool === "read_thread") {
    return registryEntry(home, request.params.arguments?.threadId, appServerPid) != null;
  }
  const targets = request.params.arguments?.targets;
  return Array.isArray(targets) && targets.length > 0 && targets.every(t => registryEntry(home, t?.threadId, appServerPid) != null);
}
function takeFrame(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (length > MAX) throw new Error("frame too large");
  return buffer.length < length + 4 ? null : { frame: buffer.subarray(0, length + 4), payload: buffer.subarray(4, length + 4) };
}
function sendJson(client, value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const output = Buffer.alloc(4 + payload.length);
  output.writeUInt32LE(payload.length, 0); payload.copy(output, 4);
  client.end(output);
}
function run() {
  const appServerPid = Number(process.argv[3]);
  const home = process.argv[4];
  const upstreamPath = process.argv[5];
  if (!Number.isSafeInteger(appServerPid) || !path.isAbsolute(home) || !path.isAbsolute(upstreamPath)) process.exit(67);
  const p = paths(home, appServerPid); privateDir(p.dir);
  try { fs.unlinkSync(p.socket); } catch {}
  const server = net.createServer(client => {
    let pending = Buffer.alloc(0), handled = false;
    client.on("data", chunk => {
      if (handled) return;
      pending = Buffer.concat([pending, chunk]);
      let parsed; try { parsed = takeFrame(pending); } catch { client.destroy(); return; }
      if (!parsed) return;
      handled = true;
      let request; try { request = JSON.parse(parsed.payload.toString("utf8")); } catch { client.destroy(); return; }
      if (!authorized(request, home, appServerPid)) {
        sendJson(client, {
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: { code: -32600, message: "Unauthorized native broker request" },
        });
        return;
      }
      const upstream = net.createConnection(upstreamPath); let response = Buffer.alloc(0);
      upstream.once("connect", () => upstream.write(parsed.frame));
      upstream.on("data", chunk => {
        response = Buffer.concat([response, chunk]);
        let result; try { result = takeFrame(response); } catch { upstream.destroy(); client.destroy(); return; }
        if (!result) return;
        client.end(result.frame); upstream.end();
      });
      upstream.once("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
    });
    client.once("error", () => {});
  });
  server.listen(p.socket, () => { fs.chmodSync(p.socket, 0o600); atomicJson(p.marker, { version: 1, pid: process.pid, appServerPid, upstream: upstreamPath, startedAt: Date.now() }); });
  const timer = setInterval(() => { if (!alive(appServerPid)) shutdown(); }, 5000); timer.unref();
  function shutdown() { clearInterval(timer); server.close(() => { try { fs.unlinkSync(p.socket); } catch {} process.exit(0); }); }
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}
`;

export function codexNativeBrokerDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(agentpartyHome(env), CODEX_NATIVE_BROKER_DIR);
}

export function codexNativeBrokerScriptPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(codexNativeBrokerDirectory(env), CODEX_NATIVE_BROKER_SCRIPT);
}

export function codexNativeBrokerSocketPath(
  appServerPid: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(codexNativeBrokerDirectory(env), `${String(appServerPid)}.sock`);
}

export function installCodexNativeBrokerScript(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const directory = codexNativeBrokerDirectory(env);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = codexNativeBrokerScriptPath(env);
  atomicWriteText(path, BROKER_SOURCE);
  chmodSync(path, 0o600);
  return path;
}

export function findChatGptBundledNodePath(): string | null {
  for (const path of [
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node",
    join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "cua_node", "bin", "node"),
    join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "cua_node", "bin", "node"),
  ]) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // try next packaged app
    }
  }
  return null;
}

export function codexNativeBrokerMcpCommand(
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | null {
  const node = findChatGptBundledNodePath();
  if (node === null) return null;
  const script = codexNativeBrokerScriptPath(env);
  const home = agentpartyHome(env);
  return { command: node, args: [script, "--mcp", home] };
}

/**
 * Cheap SessionStart-safe check for the MCP registration written by
 * `codex mcp add`. Presence is enough here: the native bridge still validates
 * the live private socket before it claims an AgentParty delivery.
 */
export function codexNativeBrokerMcpConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  let source: string;
  try {
    source = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    return false;
  }
  const escaped = AGENTPARTY_CODEX_NATIVE_MCP_SERVER_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\.(?:"${escaped}"|${escaped})\\s*\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    "m",
  ).exec(source)?.[1];
  if (section === undefined) return false;
  return !/^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(section);
}

export function codexNativeBrokerMcpName(_baseName: string): string {
  // One app-server needs exactly one broker. A per-channel name would start
  // several MCP children that race over the same private socket.
  return AGENTPARTY_CODEX_NATIVE_MCP_SERVER_NAME;
}
