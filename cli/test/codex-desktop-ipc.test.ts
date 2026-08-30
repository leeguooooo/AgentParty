import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexDesktopIpcClient,
  CodexDesktopIpcUnknownOutcomeError,
  codexDelegationEnvelope,
  selectCodexDesktopIpcRoute,
} from "../src/codex-desktop-ipc";

const SOURCE = "01a04eb6-6349-7871-9c05-8eb15d68635f";
const TARGET = "01a0499f-2ce2-76e1-8734-733f8f169c28";

let root: string | null = null;
let server: Server | null = null;

afterEach(() => {
  try { server?.close(); } catch {}
  if (root !== null) rmSync(root, { recursive: true, force: true });
  server = null;
  root = null;
});

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const output = Buffer.alloc(4 + body.length);
  output.writeUInt32LE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function reader(socket: Socket, onMessage: (value: Record<string, unknown>) => void): void {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    for (;;) {
      if (pending.length < 4) return;
      const length = pending.readUInt32LE(0);
      if (pending.length < length + 4) return;
      onMessage(JSON.parse(pending.subarray(4, length + 4).toString("utf8")));
      pending = pending.subarray(length + 4);
    }
  });
}

describe("ChatGPT Desktop follower IPC", () => {
  test("discovers the owner, sends native toolOutput XML, and follows canonical patches", async () => {
    root = mkdtempSync(join(tmpdir(), "agentparty-ipc-"));
    const ipcDir = join(root, "ipc");
    mkdirSync(ipcDir, { mode: 0o700 });
    const socketPath = join(ipcDir, "ipc.sock");
    let startRequest: Record<string, unknown> | null = null;
    let clientId = "client-1";
    const initialState = {
      id: TARGET,
      turnHistory: {
        kind: "canonical",
        history: { entitiesByKey: {}, generation: 1, isComplete: true, islands: [{ id: "tail", entries: [] }] },
      },
    };
    server = createServer((socket) => {
      reader(socket, (message) => {
        if (message.type === "broadcast" && message.method === "thread-stream-following-changed") {
          socket.write(frame({
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "owner-1",
            targetClientIds: [clientId],
            version: 11,
            params: {
              conversationId: TARGET,
              hostId: "local",
              change: { type: "snapshot", revision: 1, conversationState: initialState },
            },
          }));
          return;
        }
        if (message.type !== "request" || typeof message.requestId !== "string") return;
        if (message.method === "initialize") {
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            method: "initialize",
            handledByClientId: clientId,
            result: { clientId },
          }));
          return;
        }
        if (message.method === "thread-owner-discovery") {
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            handledByClientId: "owner-1",
            result: {},
          }));
          return;
        }
        if (message.method === "thread-follower-start-turn") {
          startRequest = message;
          socket.write(frame({
            type: "response",
            requestId: message.requestId,
            resultType: "success",
            handledByClientId: "owner-1",
            result: { result: { turn: { id: "turn-1", status: "inProgress", items: [] } } },
          }));
          setTimeout(() => socket.write(frame({
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "owner-1",
            targetClientIds: [clientId],
            version: 11,
            params: {
              conversationId: TARGET,
              hostId: "local",
              change: {
                type: "patches",
                baseRevision: 1,
                revision: 2,
                patches: [{
                  op: "add",
                  path: ["turnHistory", "history", "entitiesByKey", "tail:test"],
                  value: {
                    turnId: "turn-1",
                    status: "completed",
                    params: {
                      clientUserMessageId: "agentparty:delivery-1",
                      toolOutput: {
                        name: "send_message_to_thread",
                        namespace: "codex_app",
                        output: codexDelegationEnvelope(SOURCE, "hello"),
                      },
                    },
                    items: [{ type: "agentMessage", phase: "final_answer", text: "world" }],
                  },
                }],
              },
            },
          })), 5);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
    });

    const client = new CodexDesktopIpcClient({
      env: { CODEX_HOME: root },
      requestTimeoutMs: 1_000,
    });
    await client.connect();
    await client.followThread(TARGET);
    expect(await client.startDelegatedTurn({
      targetThreadId: TARGET,
      sourceThreadId: SOURCE,
      prompt: "hello",
      clientUserMessageId: "agentparty:delivery-1",
    })).toEqual({ turnId: "turn-1", ownerClientId: "owner-1" });
    const turn = await client.waitForDelegation({
      targetThreadId: TARGET,
      sourceThreadId: SOURCE,
      prompt: "hello",
      clientUserMessageId: "agentparty:delivery-1",
      turnId: "turn-1",
      timeoutMs: 1_000,
    });
    expect(turn.status).toBe("completed");
    expect(turn.items[0]).toMatchObject({ type: "agentMessage", text: "world" });
    expect(startRequest).toMatchObject({
      version: 2,
      method: "thread-follower-start-turn",
      params: {
        conversationId: TARGET,
        turnStart: { request: {
          input: [],
          clientUserMessageId: "agentparty:delivery-1",
          toolOutput: {
            name: "send_message_to_thread",
            namespace: "codex_app",
            output: codexDelegationEnvelope(SOURCE, "hello"),
          },
        } },
      },
    });
    client.close();
  });

  test("auto route requires the same app-server channel identity", () => {
    const base = {
      version: 1 as const,
      harness: "codex" as const,
      pid: 7,
      display_name: null,
      channel: "agentparty",
      server: "https://agentparty.example.com",
      identity: "codex-agent",
      cwd: "/repo",
      registered_at: 1,
    };
    expect(selectCodexDesktopIpcRoute(TARGET, 7, [
      { ...base, session_id: TARGET },
      { ...base, session_id: SOURCE, registered_at: 2 },
    ])).toEqual({ targetThreadId: TARGET, sourceThreadId: SOURCE });
    expect(selectCodexDesktopIpcRoute(TARGET, 7, [
      { ...base, session_id: TARGET },
      { ...base, session_id: SOURCE, identity: "other" },
    ])).toBeNull();
    expect(selectCodexDesktopIpcRoute(TARGET, 7, [
      { ...base, session_id: TARGET },
      { ...base, session_id: SOURCE, identity: undefined },
    ])).toBeNull();
  });

  test("start-turn timeout is an unknown outcome and must not be replayed", async () => {
    root = mkdtempSync(join(tmpdir(), "agentparty-ipc-"));
    const ipcDir = join(root, "ipc");
    mkdirSync(ipcDir, { mode: 0o700 });
    const socketPath = join(ipcDir, "ipc.sock");
    server = createServer((socket) => {
      reader(socket, (message) => {
        if (message.type !== "request" || typeof message.requestId !== "string") return;
        if (message.method === "initialize") {
          socket.write(frame({
            type: "response", requestId: message.requestId, resultType: "success",
            handledByClientId: "client-timeout", result: { clientId: "client-timeout" },
          }));
        } else if (message.method === "thread-owner-discovery") {
          socket.write(frame({
            type: "response", requestId: message.requestId, resultType: "success",
            handledByClientId: "owner-timeout", result: {},
          }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
    });
    const client = new CodexDesktopIpcClient({
      env: { CODEX_HOME: root },
      requestTimeoutMs: 100,
      startTurnTimeoutMs: 20,
    });
    await client.connect();
    await expect(client.startDelegatedTurn({
      targetThreadId: TARGET,
      sourceThreadId: SOURCE,
      prompt: "timeout",
      clientUserMessageId: "agentparty:timeout",
    })).rejects.toBeInstanceOf(CodexDesktopIpcUnknownOutcomeError);
    client.close();
  });

  test("revision mismatch discards patches and requests a fresh snapshot", async () => {
    root = mkdtempSync(join(tmpdir(), "agentparty-ipc-"));
    const ipcDir = join(root, "ipc");
    mkdirSync(ipcDir, { mode: 0o700 });
    const socketPath = join(ipcDir, "ipc.sock");
    let followCount = 0;
    server = createServer((socket) => {
      reader(socket, (message) => {
        if (message.type === "request" && message.method === "initialize" && typeof message.requestId === "string") {
          socket.write(frame({
            type: "response", requestId: message.requestId, resultType: "success",
            handledByClientId: "client-revision", result: { clientId: "client-revision" },
          }));
          return;
        }
        if (message.type !== "broadcast" || message.method !== "thread-stream-following-changed") return;
        followCount += 1;
        socket.write(frame({
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "owner-revision",
          targetClientIds: ["client-revision"],
          version: 11,
          params: {
            conversationId: TARGET,
            hostId: "local",
            change: {
              type: followCount === 1 ? "snapshot" : "snapshot",
              revision: 1,
              conversationState: {
                turnHistory: { kind: "canonical", history: { entitiesByKey: {} } },
              },
            },
          },
        }));
        if (followCount === 1) {
          setTimeout(() => socket.write(frame({
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "owner-revision",
            targetClientIds: ["client-revision"],
            version: 11,
            params: {
              conversationId: TARGET,
              hostId: "local",
              change: { type: "patches", baseRevision: 9, revision: 10, patches: [] },
            },
          })), 5);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { chmodSync(socketPath, 0o600); resolve(); });
    });
    const client = new CodexDesktopIpcClient({ env: { CODEX_HOME: root }, requestTimeoutMs: 500 });
    await client.connect();
    await client.followThread(TARGET);
    const deadline = Date.now() + 500;
    while (followCount < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(followCount).toBe(2);
    client.close();
  });
});
