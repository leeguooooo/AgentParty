import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexRpcDisconnectedError,
  CodexRpcClient,
  CodexSessionController,
  type CodexFrontendRecovery,
  type CodexRpcPeer,
  type CodexTurn,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/codex-app-server-bridge";
import type { CodexTurnArbiter } from "../src/codex-turn-arbiter";

const fixture = join(import.meta.dir, "fixtures", "mock-codex-app-server.ts");

let temp: string;
let clients: CodexRpcClient[];

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "ap-codex-rpc-"));
  clients = [];
});

afterEach(() => {
  for (const client of clients) client.close();
  rmSync(temp, { recursive: true, force: true });
});

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface RpcCall {
  method: string;
  params?: unknown;
  generation: number;
}

type RpcResponder = (params: unknown) => unknown | Promise<unknown>;

class ScriptedCodexRpc implements CodexRpcPeer {
  readonly initializeResult = {
    userAgent: "scripted-codex-app-server/0.144.4",
    platformFamily: "unix",
  };
  readonly calls: RpcCall[] = [];
  connected = true;
  connectionGeneration = 1;
  startCalls = 0;
  private readonly responders = new Map<string, RpcResponder[]>();
  private readonly reconnects = new Set<(generation: number) => void | Promise<void>>();
  private readonly disconnects = new Set<(generation: number) => void>();
  private readonly messages =
    new Set<(message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>>();

  queue(method: string, responder: RpcResponder | unknown): void {
    const responses = this.responders.get(method) ?? [];
    responses.push(
      typeof responder === "function"
        ? responder as RpcResponder
        : () => responder,
    );
    this.responders.set(method, responses);
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.connected) return;
    this.connected = true;
    this.connectionGeneration += 1;
    for (const listener of this.reconnects) {
      void Promise.resolve(listener(this.connectionGeneration)).catch(() => {});
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    return await this.dispatch(method, params);
  }

  async requestConnected(
    method: string,
    params?: unknown,
    expectedGeneration?: number,
  ): Promise<unknown> {
    if (!this.connected || (
      expectedGeneration !== undefined &&
      expectedGeneration !== this.connectionGeneration
    )) {
      throw new CodexRpcDisconnectedError(
        "disconnected before scripted request write",
        { requestWritten: false },
      );
    }
    const generation = this.connectionGeneration;
    const result = await this.dispatch(method, params);
    if (
      expectedGeneration !== undefined &&
      (!this.connected || generation !== this.connectionGeneration)
    ) {
      throw new CodexRpcDisconnectedError("scripted request lost its backend generation");
    }
    return result;
  }

  async notify(_method: string, _params?: unknown): Promise<void> {}

  respond(
    _id: JsonRpcId,
    _result?: unknown,
    _error?: JsonRpcResponse["error"],
  ): void {}

  onMessage(
    listener: (message: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>,
  ): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onReconnect(listener: (generation: number) => void | Promise<void>): () => void {
    this.reconnects.add(listener);
    return () => this.reconnects.delete(listener);
  }

  onDisconnect(listener: (generation: number) => void): () => void {
    this.disconnects.add(listener);
    return () => this.disconnects.delete(listener);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnects) listener(this.connectionGeneration);
  }

  async emit(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    await Promise.all([...this.messages].map(async (listener) => await listener(message)));
  }

  reconnect(): Promise<void> {
    this.connected = true;
    this.connectionGeneration += 1;
    return Promise.all(
      [...this.reconnects].map(async (listener) => await listener(this.connectionGeneration)),
    ).then(() => {});
  }

  private async dispatch(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({
      method,
      generation: this.connectionGeneration,
      ...(params === undefined ? {} : { params }),
    });
    const responses = this.responders.get(method);
    const responder = responses?.shift();
    if (!responder) throw new Error(`unexpected RPC call: ${method}`);
    return await responder(params);
  }
}

function idleThread(id: string): {
  thread: {
    id: string;
    status: { type: "idle" };
    turns: [];
  };
} {
  return {
    thread: {
      id,
      status: { type: "idle" },
      turns: [],
    },
  };
}

describe("Codex app-server stdio JSON-RPC and reconnect recovery", () => {
  test("serializes inbound messages without blocking JSON-RPC responses", async () => {
    const statePath = join(temp, "state.json");
    const logs: string[] = [];
    const rpc = new CodexRpcClient({
      log: (line) => logs.push(line),
      spawnProxy: () => spawn("bun", ["run", fixture], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
      }),
    });
    clients.push(rpc);

    const firstGate = deferred<void>();
    const firstEntered = deferred<void>();
    const received: string[] = [];
    rpc.onMessage(async (message) => {
      received.push(`slow:${message.method}`);
      if (message.method === "mock/ordered/first") {
        firstEntered.resolve(undefined);
        await firstGate.promise;
        throw new Error("expected listener failure");
      }
    });
    rpc.onMessage((message) => {
      received.push(`fast:${message.method}`);
    });

    await rpc.start();
    const response = rpc.request("mock/messageOrdering", {});
    await firstEntered.promise;

    try {
      expect(received).toEqual([
        "slow:mock/ordered/first",
        "fast:mock/ordered/first",
      ]);
      await expect(Promise.race([
        response,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("JSON-RPC response waited for message listeners")),
            1_000,
          );
        }),
      ])).resolves.toEqual({ ordered: true });
      expect(received).toEqual([
        "slow:mock/ordered/first",
        "fast:mock/ordered/first",
      ]);
    } finally {
      firstGate.resolve(undefined);
    }

    await waitFor(
      () => received.includes("fast:mock/ordered/second"),
      "second notification was not dispatched after the first listener settled",
    );
    expect(received).toEqual([
      "slow:mock/ordered/first",
      "fast:mock/ordered/first",
      "slow:mock/ordered/second",
      "fast:mock/ordered/second",
    ]);
    expect(logs).toContain(
      "codex-bridge: JSON-RPC listener failed: expected listener failure",
    );
  });

  test("fences queued old-generation messages without letting a replacement overtake", async () => {
    const statePath = join(temp, "state.json");
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
      spawnProxy: () => spawn("bun", ["run", fixture], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
      }),
    });
    clients.push(rpc);

    const firstGate = deferred<void>();
    const firstEntered = deferred<void>();
    const disconnected = deferred<number>();
    const received: string[] = [];
    rpc.onMessage(async (message) => {
      received.push(message.method);
      if (message.method === "mock/disconnect/first") {
        firstEntered.resolve(undefined);
        await firstGate.promise;
      }
    });
    rpc.onDisconnect((generation) => disconnected.resolve(generation));

    await rpc.start();
    const lostRequest = rpc.request("mock/messageOrderingDisconnect", {});
    void lostRequest.catch(() => {});
    await firstEntered.promise;
    await expect(disconnected.promise).resolves.toBe(1);
    await expect(lostRequest).rejects.toBeInstanceOf(CodexRpcDisconnectedError);

    await rpc.start();
    expect(rpc.connectionGeneration).toBe(2);
    const replacementResponse = rpc.request("mock/messageOrdering", {});
    try {
      await expect(Promise.race([
        replacementResponse,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("replacement response waited for the old listener")),
            1_000,
          );
        }),
      ])).resolves.toEqual({ ordered: true });
      expect(received).toEqual(["mock/disconnect/first"]);
    } finally {
      firstGate.resolve(undefined);
    }

    await waitFor(
      () => received.includes("mock/ordered/second"),
      "replacement generation did not resume ordered message dispatch",
    );
    expect(received).toEqual([
      "mock/disconnect/first",
      "mock/ordered/first",
      "mock/ordered/second",
    ]);
  });

  test("rejects a disconnected applying snapshot before the next generation can install its snapshot", async () => {
    let spawnGeneration = 0;
    const disconnected = deferred<number>();
    const oldApplyEntered = deferred<void>();
    const releaseOldApply = deferred<void>();
    const appliedSnapshots: string[] = [];
    let installedSnapshot: string | null = null;
    const currentInstalledSnapshot = (): string | null => installedSnapshot;
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
      spawnProxy: () => {
        const generation = ++spawnGeneration;
        const server = `
          const { createInterface } = require("node:readline");
          const input = createInterface({ input: process.stdin });
          const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
          input.on("line", (line) => {
            const frame = JSON.parse(line);
            if (frame.method === "initialized") return;
            if (frame.method === "initialize") {
              send({
                id: frame.id,
                result: {
                  userAgent: "disconnect-apply-test/${generation}",
                  platformFamily: "unix",
                },
              });
              return;
            }
            if (frame.method === "thread/read") {
              send({
                id: frame.id,
                result: {
                  thread: {
                    id: "snapshot-generation-${generation}",
                    status: { type: "idle" },
                    turns: [],
                  },
                },
              });
              return;
            }
            if (frame.method === "mock/exit") {
              process.exit(77);
              return;
            }
            send({ id: frame.id, result: {} });
          });
        `;
        return spawn("bun", ["-e", server], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    clients.push(rpc);
    rpc.onDisconnect((generation) => disconnected.resolve(generation));

    await rpc.start();
    expect(rpc.connectionGeneration).toBe(1);
    const oldRequest = rpc.requestConnectedApplied(
      "thread/read",
      { threadId: "snapshot-generation-1", includeTurns: true },
      1,
      async (result) => {
        oldApplyEntered.resolve(undefined);
        await releaseOldApply.promise;
        const threadId = (result as { thread: { id: string } }).thread.id;
        appliedSnapshots.push(threadId);
        installedSnapshot = threadId;
      },
    );
    let oldRequestSettled = false;
    void oldRequest.then(
      () => {
        oldRequestSettled = true;
      },
      () => {
        oldRequestSettled = true;
      },
    );

    await oldApplyEntered.promise;
    rpc.notifyConnected("mock/exit");
    await expect(disconnected.promise).resolves.toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(oldRequestSettled).toBe(false);
    expect(currentInstalledSnapshot()).toBeNull();

    await rpc.start();
    expect(rpc.connectionGeneration).toBe(2);
    let newApplyEntered = false;
    const newRequest = rpc.requestConnectedApplied(
      "thread/read",
      { threadId: "snapshot-generation-2", includeTurns: true },
      2,
      async (result) => {
        newApplyEntered = true;
        const threadId = (result as { thread: { id: string } }).thread.id;
        appliedSnapshots.push(threadId);
        installedSnapshot = threadId;
      },
    );
    const privateState = rpc as unknown as {
      pending: Map<string, { responseReceived: boolean }>;
    };
    await waitFor(
      () =>
        [...privateState.pending.values()].filter(
          ({ responseReceived }) => responseReceived,
        ).length === 2,
      "both generations' snapshot responses were not received",
    );
    expect(oldRequestSettled).toBe(false);
    expect(newApplyEntered).toBe(false);
    expect(appliedSnapshots).toEqual([]);

    releaseOldApply.resolve(undefined);
    await expect(oldRequest).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await expect(newRequest).resolves.toMatchObject({
      thread: { id: "snapshot-generation-2" },
    });
    expect(appliedSnapshots).toEqual([
      "snapshot-generation-1",
      "snapshot-generation-2",
    ]);
    expect(currentInstalledSnapshot()).toBe("snapshot-generation-2");
    expect(privateState.pending.size).toBe(0);
  });

  test("rejects a disconnected snapshot queued behind a slow notification without applying it", async () => {
    const notificationEntered = deferred<void>();
    const releaseNotification = deferred<void>();
    const disconnected = deferred<number>();
    let applyCalls = 0;
    const server = `
      const { createInterface } = require("node:readline");
      const input = createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      input.on("line", (line) => {
        const frame = JSON.parse(line);
        if (frame.method === "initialized") return;
        if (frame.method === "initialize") {
          send({
            id: frame.id,
            result: {
              userAgent: "queued-disconnect-test/1",
              platformFamily: "unix",
            },
          });
          return;
        }
        if (frame.method === "thread/read") {
          const frames = [
            {
              method: "mock/gated-notification",
              params: { generation: 1 },
            },
            {
              id: frame.id,
              result: {
                thread: {
                  id: "snapshot-queued-before-disconnect",
                  status: { type: "idle" },
                  turns: [],
                },
              },
            },
          ];
          process.stdout.write(
            frames.map((value) => JSON.stringify(value) + "\\n").join(""),
            () => setTimeout(() => process.exit(78), 100),
          );
          return;
        }
        send({ id: frame.id, result: {} });
      });
    `;
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
      spawnProxy: () => spawn("bun", ["-e", server], {
        stdio: ["pipe", "pipe", "pipe"],
      }),
    });
    clients.push(rpc);
    rpc.onMessage(async (message) => {
      if (message.method !== "mock/gated-notification") return;
      notificationEntered.resolve(undefined);
      await releaseNotification.promise;
    });
    rpc.onDisconnect((generation) => disconnected.resolve(generation));

    await rpc.start();
    const request = rpc.requestConnectedApplied(
      "thread/read",
      {
        threadId: "snapshot-queued-before-disconnect",
        includeTurns: true,
      },
      1,
      async () => {
        applyCalls += 1;
      },
    );
    void request.catch(() => {});
    const privateState = rpc as unknown as {
      pending: Map<string, {
        responseReceived: boolean;
        applyStarted: boolean;
      }>;
      messageDispatchTail: Promise<void>;
    };

    try {
      await notificationEntered.promise;
      await waitFor(
        () =>
          [...privateState.pending.values()].some(
            ({ responseReceived, applyStarted }) =>
              responseReceived && !applyStarted,
          ),
        "snapshot response was not queued behind the slow notification",
      );
      expect(applyCalls).toBe(0);
      await expect(disconnected.promise).resolves.toBe(1);

      await expect(Promise.race([
        request,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("queued snapshot request did not reject after disconnect")),
            500,
          );
        }),
      ])).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
      expect(applyCalls).toBe(0);
      expect(privateState.pending.size).toBe(0);
    } finally {
      releaseNotification.resolve(undefined);
    }

    await privateState.messageDispatchTail;
    expect(applyCalls).toBe(0);
    expect(privateState.pending.size).toBe(0);
  });

  test("holds a disconnected same-thread snapshot applier ahead of generation-2 recovery and fences its nested write", async () => {
    const callsPath = join(temp, "snapshot-session-lane-calls.jsonl");
    let spawnGeneration = 0;
    const disconnected = deferred<number>();
    const oldApplyEntered = deferred<void>();
    const releaseOldApply = deferred<void>();
    const recovered = deferred<CodexFrontendRecovery>();
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
      spawnProxy: () => {
        const generation = ++spawnGeneration;
        const server = `
          const { appendFileSync } = require("node:fs");
          const { createInterface } = require("node:readline");
          const input = createInterface({ input: process.stdin });
          const record = (method) => appendFileSync(
            ${JSON.stringify(callsPath)},
            JSON.stringify({ generation: ${generation}, method }) + "\\n",
          );
          const send = (id, result) =>
            process.stdout.write(JSON.stringify({ id, result }) + "\\n");
          const thread = {
            thread: {
              id: "thread-session-lane",
              status: { type: "idle" },
              turns: [],
            },
          };
          input.on("line", (line) => {
            const frame = JSON.parse(line);
            record(frame.method || "<response>");
            if (frame.method === "initialized") return;
            if (frame.method === "initialize") {
              send(frame.id, {
                userAgent: "session-lane-test/${generation}",
                platformFamily: "unix",
              });
              return;
            }
            if (
              frame.method === "thread/start" ||
              frame.method === "thread/resume" ||
              frame.method === "thread/read"
            ) {
              send(frame.id, thread);
              if (${generation} === 1 && frame.method === "thread/read") {
                setTimeout(() => process.exit(79), 10);
              }
              return;
            }
            if (frame.method === "turn/start") {
              send(frame.id, { turn: { id: "unexpected-cross-generation-turn" } });
              return;
            }
            send(frame.id, {});
          });
        `;
        return spawn("bun", ["-e", server], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    clients.push(rpc);
    rpc.onDisconnect((generation) => disconnected.resolve(generation));
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      if (event.generation === 2) recovered.resolve(event);
    });

    await session.start();
    await session.request("thread/start", {});
    await session.request("turn/start", {
      threadId: "thread-session-lane",
      clientUserMessageId: null,
      input: [{
        type: "text",
        text: "finish the bootstrap before probing snapshot recovery",
        text_elements: [],
      }],
    });

    const privateSession = session as unknown as {
      routeThreadResponse: (
        method: string,
        result: unknown,
        params: Record<string, unknown>,
      ) => Promise<void>;
      requestConnected: (method: string, params?: unknown) => Promise<unknown>;
    };
    const originalRouteThreadResponse =
      privateSession.routeThreadResponse.bind(session);
    let interceptedOldRead = false;
    privateSession.routeThreadResponse = async (method, result, params) => {
      if (method === "thread/read" && !interceptedOldRead) {
        interceptedOldRead = true;
        oldApplyEntered.resolve(undefined);
        await releaseOldApply.promise;
        // attachThread may flush a queued AgentParty input. Model that nested
        // write explicitly so this regression proves the old generation fence
        // survives while the snapshot callback is awaiting.
        await privateSession.requestConnected("turn/start", {
          threadId: "thread-session-lane",
          input: [],
        });
        return;
      }
      await originalRouteThreadResponse(method, result, params);
    };

    const oldRead = session.request("thread/read", {
      threadId: "thread-session-lane",
      includeTurns: true,
    });
    void oldRead.catch(() => {});
    await oldApplyEntered.promise;
    await expect(disconnected.promise).resolves.toBe(1);

    await rpc.start();
    expect(rpc.connectionGeneration).toBe(2);
    const recordedCalls = (): RpcCall[] => {
      try {
        return readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RpcCall);
      } catch {
        return [];
      }
    };
    await waitFor(
      () =>
        recordedCalls().some(({ generation, method }) =>
          generation === 2 && method === "initialized"
        ),
      "replacement app-server did not finish its initialize handshake",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      recordedCalls()
        .filter(({ generation }) => generation === 2)
        .map(({ method }) => method),
    ).toEqual(["initialize", "initialized"]);

    releaseOldApply.resolve(undefined);
    await expect(oldRead).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await expect(recovered.promise).resolves.toEqual({
      disposition: "resume",
      threadId: "thread-session-lane",
      generation: 2,
    });
    await waitFor(
      () =>
        recordedCalls().some(({ generation, method }) =>
          generation === 2 && method === "thread/read"
        ),
      "generation-2 recovery did not complete its authoritative read",
    );
    const generationTwoMethods = recordedCalls()
      .filter(({ generation }) => generation === 2)
      .map(({ method }) => method);
    expect(generationTwoMethods).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/read",
    ]);
    expect(generationTwoMethods).not.toContain("turn/start");
  });

  test("orders same-chunk item notifications and read or rollback snapshots in both directions", async () => {
    for (
      const [method, order] of [
        ["thread/read", "notification-first"],
        ["thread/rollback", "notification-first"],
        ["thread/read", "response-first"],
        ["thread/rollback", "response-first"],
      ] as const
    ) {
      const suffix = `${method.replace("/", "-")}-${order}`;
      const threadId = `thread-wire-barrier-${suffix}`;
      const turnId = `turn-wire-barrier-${suffix}`;
      const clientId = `agentparty:wire-barrier-${suffix}`;
      const server = `
        const { createInterface } = require("node:readline");
        const input = createInterface({ input: process.stdin });
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        const snapshot = {
          thread: {
            id: ${JSON.stringify(threadId)},
            status: { type: "idle" },
            turns: [],
          },
        };
        input.on("line", (line) => {
          const frame = JSON.parse(line);
          const params = frame.params || {};
          if (frame.method === "initialized") return;
          if (frame.method === "initialize") {
            send({
              id: frame.id,
              result: {
                userAgent: "wire-barrier-test/0.144.4",
                platformFamily: "unix",
              },
            });
            return;
          }
          if (frame.method === "thread/start") {
            send({ id: frame.id, result: snapshot });
            return;
          }
          if (frame.method === "thread/read" && params.listenerProbe === true) {
            send({ id: frame.id, result: snapshot });
            return;
          }
          if (frame.method === ${JSON.stringify(method)}) {
            const notification = {
              method: "item/completed",
              params: {
                threadId: ${JSON.stringify(threadId)},
                turnId: ${JSON.stringify(turnId)},
                item: {
                  type: "userMessage",
                  id: "user-wire-barrier",
                  clientId: ${JSON.stringify(clientId)},
                  content: [],
                },
              },
            };
            const response = { id: frame.id, result: snapshot };
            const frames = ${JSON.stringify(order)} === "notification-first"
              ? [notification, response]
              : [response, notification];
            process.stdout.write(
              frames.map((value) => JSON.stringify(value) + "\\n").join(""),
            );
            return;
          }
          send({ id: frame.id, result: {} });
        });
      `;
      const rpc = new CodexRpcClient({
        spawnProxy: () => spawn("bun", ["-e", server], {
          stdio: ["pipe", "pipe", "pipe"],
        }),
      });
      clients.push(rpc);

      const notificationEntered = deferred<void>();
      const releaseNotification = deferred<void>();
      const listenerRead = deferred<unknown>();
      let listenerApplyCount = 0;
      const delayedPeer: CodexRpcPeer = {
        get initializeResult() {
          return rpc.initializeResult;
        },
        get connected() {
          return rpc.connected;
        },
        get connectionGeneration() {
          return rpc.connectionGeneration;
        },
        start: () => rpc.start(),
        request: (rpcMethod, params) => rpc.request(rpcMethod, params),
        requestConnected: (rpcMethod, params, expectedGeneration) =>
          rpc.requestConnected(rpcMethod, params, expectedGeneration),
        requestConnectedApplied: (
          rpcMethod,
          params,
          expectedGeneration,
          applyResponse,
        ) => rpc.requestConnectedApplied(
          rpcMethod,
          params,
          expectedGeneration,
          applyResponse,
        ),
        notify: (rpcMethod, params) => rpc.notify(rpcMethod, params),
        notifyConnected: (rpcMethod, params) => rpc.notifyConnected(rpcMethod, params),
        respond: (id, result, error) => rpc.respond(id, result, error),
        onMessage: (listener) =>
          rpc.onMessage(async (message) => {
            const params = message.params as Record<string, unknown> | undefined;
            const item = params?.item as Record<string, unknown> | undefined;
            if (
              message.method === "item/completed" &&
              item?.clientId === clientId
            ) {
              notificationEntered.resolve(undefined);
              await releaseNotification.promise;
              // Snapshot methods issued from inside the dispatch listener must
              // bypass their own barrier; otherwise this request waits on the
              // dispatch that is awaiting it.
              listenerRead.resolve(await rpc.requestConnectedApplied(
                "thread/read",
                {
                  threadId,
                  includeTurns: true,
                  listenerProbe: true,
                },
                rpc.connectionGeneration ?? undefined,
                async () => {
                  listenerApplyCount += 1;
                },
              ));
            }
            await listener(message);
          }),
        onReconnect: (listener) => rpc.onReconnect(listener),
        onDisconnect: (listener) => rpc.onDisconnect(listener),
      };
      const session = new CodexSessionController(delayedPeer);

      await session.start();
      await session.request("thread/start", {});
      const snapshotRequest = session.request(method, {
        threadId,
        ...(method === "thread/read" ? { includeTurns: true } : {}),
      });
      let snapshotSettled = false;
      void snapshotRequest.then(
        () => {
          snapshotSettled = true;
        },
        () => {
          snapshotSettled = true;
        },
      );
      if (order === "notification-first") {
        await notificationEntered.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(snapshotSettled).toBe(false);
        expect(session.turnForClientId(clientId)).toBeNull();
      } else {
        await expect(snapshotRequest).resolves.toMatchObject({
          thread: { id: threadId, turns: [] },
        });
        await notificationEntered.promise;
        expect(snapshotSettled).toBe(true);
        expect(session.turnForClientId(clientId)).toBeNull();
      }

      releaseNotification.resolve(undefined);
      await expect(Promise.race([
        listenerRead.promise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`${method} listener RPC deadlocked on its own dispatch`)),
            2_000,
          );
        }),
      ])).resolves.toEqual({
        thread: {
          id: threadId,
          status: { type: "idle" },
          turns: [],
        },
      });
      expect(listenerApplyCount).toBe(1);
      const state = session as unknown as {
        turns: Map<string, CodexTurn>;
        turnByClientId: Map<string, string>;
        retainedTurnBytesById: Map<string, number>;
        retainedCompletedTurnBytes: number;
        retainedCompletedTurnCount: number;
      };
      if (order === "notification-first") {
        await expect(snapshotRequest).resolves.toMatchObject({
          thread: { id: threadId, turns: [] },
        });
        expect(session.turnForClientId(clientId)).toBeNull();
        expect(state.turns.has(turnId)).toBe(false);
        expect(state.turnByClientId.has(clientId)).toBe(false);
        expect(state.retainedTurnBytesById.size).toBe(0);
        expect(state.retainedCompletedTurnBytes).toBe(0);
        expect(state.retainedCompletedTurnCount).toBe(0);
      } else {
        await waitFor(
          () => session.turnForClientId(clientId) !== null,
          `${method} response-first item notification was not retained`,
        );
        expect(session.turnForClientId(clientId)).toMatchObject({
          id: turnId,
          status: "inProgress",
        });
        expect(state.turns.has(turnId)).toBe(true);
        expect(state.turnByClientId.get(clientId)).toBe(turnId);
        expect(state.retainedTurnBytesById.has(turnId)).toBe(true);
        expect(state.retainedCompletedTurnBytes).toBe(0);
        expect(state.retainedCompletedTurnCount).toBe(0);
      }
    }
  });

  test("uses authoritative completed items after reattach and terminal lifecycle duplicates", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-agent-text"));
    rpc.queue("thread/read", {
      thread: {
        id: "thread-agent-text",
        status: { type: "active" },
        turns: [{
          id: "turn-agent-text",
          status: "inProgress",
          items: [],
        }],
      },
    });
    const session = new CodexSessionController(rpc);
    const completed: CodexTurn[] = [];
    session.onTurnCompleted((turn) => {
      completed.push(turn);
    });

    await session.start();
    await session.request("thread/start", {});
    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-agent-text",
        turn: {
          id: "turn-agent-text",
          status: "inProgress",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    await rpc.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-agent-text",
        itemId: "agent-final",
        delta: "streamed partial",
      },
    });

    // A thread/read snapshot is authoritative even on the same thread. Do not
    // let pre-snapshot deltas resurrect items removed by rollback/recovery.
    await session.request("thread/read", {
      threadId: "thread-agent-text",
      includeTurns: true,
    });
    expect(
      (session as unknown as {
        agentMessagesByTurn: Map<string, unknown>;
      }).agentMessagesByTurn.size,
    ).toBe(0);
    const completedItem = {
      type: "agentMessage",
      id: "agent-final",
      text: "authoritative final",
      phase: "final_answer",
    };
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-agent-text",
        item: completedItem,
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-agent-text",
        item: completedItem,
      },
    });
    await rpc.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-agent-text",
        itemId: "agent-final",
        delta: " duplicate late delta",
      },
    });
    const unloadedCompletion = {
      method: "turn/completed",
      params: {
        threadId: "thread-agent-text",
        turn: {
          id: "turn-agent-text",
          status: "completed",
          items: [],
          itemsView: "notLoaded",
        },
      },
    } satisfies JsonRpcNotification;
    await rpc.emit(unloadedCompletion);
    await rpc.emit(unloadedCompletion);

    expect(completed).toHaveLength(2);
    for (const turn of completed) {
      expect(turn.items).toContainEqual(expect.objectContaining({
        type: "agentMessage",
        id: "agent-final",
        text: "authoritative final",
        phase: "final_answer",
      }));
    }

    for (const [suffix, phase] of [
      ["explicit-final", "final_answer"],
      ["legacy-final", undefined],
    ] as const) {
      const turnId = `turn-${suffix}`;
      const itemId = `agent-${suffix}`;
      await rpc.emit({
        method: "turn/started",
        params: {
          threadId: "thread-agent-text",
          turn: {
            id: turnId,
            status: "inProgress",
            items: [],
            itemsView: "notLoaded",
          },
        },
      });
      await rpc.emit({
        method: "item/completed",
        params: {
          threadId: "thread-agent-text",
          turnId,
          item: {
            type: "agentMessage",
            id: itemId,
            text: `${suffix} authoritative text`,
            ...(phase === undefined ? {} : { phase }),
          },
        },
      });
      // Some app-server snapshots reuse the item id but contain only an empty
      // commentary shell. Text and phase must both come from the completed
      // lifecycle item; keeping the shell's phase would hide a valid final.
      const emptyShellCompletion = {
        method: "turn/completed",
        params: {
          threadId: "thread-agent-text",
          turn: {
            id: turnId,
            status: "completed",
            items: [{
              type: "agentMessage",
              id: itemId,
              text: "",
              phase: "commentary",
            }],
          },
        },
      } satisfies JsonRpcNotification;
      const completedBefore = completed.length;
      await rpc.emit(emptyShellCompletion);
      await rpc.emit(emptyShellCompletion);
      expect(completed.slice(completedBefore)).toHaveLength(2);
      for (const completedTurn of completed.slice(completedBefore)) {
        const finalItem = completedTurn.items?.find((item) => item.id === itemId);
        expect(finalItem).toMatchObject({
          type: "agentMessage",
          id: itemId,
          text: `${suffix} authoritative text`,
        });
        if (phase === undefined) {
          expect(finalItem?.phase).toBeUndefined();
        } else {
          expect(finalItem?.phase).toBe(phase);
        }
      }
    }

    await rpc.emit({
      method: "item/started",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-partial-only",
        item: {
          type: "agentMessage",
          id: "agent-partial-only",
          text: "not terminal",
          phase: "final_answer",
        },
      },
    });
    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-agent-text",
        turn: {
          id: "turn-partial-only",
          status: "completed",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    expect(completed.at(-1)).toMatchObject({
      id: "turn-partial-only",
      status: "completed",
      items: [],
    });

    // Interleaved terminal turns keep independent item buffers. Their status
    // remains authoritative, so a delivery layer will still reject either.
    await rpc.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-interrupted",
        itemId: "agent-interrupted",
        delta: "interrupted text",
      },
    });
    await rpc.emit({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-agent-text",
        turnId: "turn-failed",
        itemId: "agent-failed",
        delta: "failed text",
      },
    });
    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-agent-text",
        turn: {
          id: "turn-interrupted",
          status: "interrupted",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-agent-text",
        turn: {
          id: "turn-failed",
          status: "failed",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });

    expect(completed.at(-2)).toMatchObject({
      id: "turn-interrupted",
      status: "interrupted",
      items: [],
    });
    expect(completed.at(-1)).toMatchObject({
      id: "turn-failed",
      status: "failed",
      items: [],
    });
    expect(
      (session as unknown as {
        agentMessagesByTurn: Map<string, unknown>;
      }).agentMessagesByTurn.size,
    ).toBe(0);
  });

  test("associates a client id and canonical items from item lifecycle events", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-item-lifecycle"));
    const session = new CodexSessionController(rpc);
    const dispatches: Array<{
      clientId: string;
      turnId: string | null;
    }> = [];
    session.onDispatch((input, dispatch) => {
      dispatches.push({
        clientId: input.clientUserMessageId,
        turnId: dispatch.turnId ?? null,
      });
    });

    await session.start();
    await session.request("thread/start", {});
    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-item-lifecycle",
        turn: {
          id: "turn-item-lifecycle",
          status: "inProgress",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-item-lifecycle",
        turnId: "turn-item-lifecycle",
        item: {
          type: "userMessage",
          id: "user-item",
          clientId: "agentparty:late-accepted",
          content: [],
        },
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-item-lifecycle",
        turnId: "turn-item-lifecycle",
        item: {
          type: "userMessage",
          id: "user-item",
          clientId: "agentparty:late-accepted",
          content: [],
        },
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-item-lifecycle",
        turnId: "turn-item-lifecycle",
        item: {
          type: "agentMessage",
          id: "agent-item",
          text: "late authoritative reply",
          phase: "final_answer",
        },
      },
    });
    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-item-lifecycle",
        turn: {
          id: "turn-item-lifecycle",
          status: "completed",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });

    expect(dispatches).toContainEqual({
      clientId: "agentparty:late-accepted",
      turnId: "turn-item-lifecycle",
    });
    expect(
      dispatches.filter(({ clientId }) => clientId === "agentparty:late-accepted"),
    ).toHaveLength(1);
    expect(session.turnForClientId("agentparty:late-accepted")).toMatchObject({
      id: "turn-item-lifecycle",
      status: "completed",
      items: [
        expect.objectContaining({
          type: "userMessage",
          clientId: "agentparty:late-accepted",
        }),
        expect.objectContaining({
          type: "agentMessage",
          text: "late authoritative reply",
        }),
      ],
    });

    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-item-lifecycle",
        turn: {
          id: "turn-duplicate-user-lifecycle",
          status: "inProgress",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    const duplicateUserItem = {
      type: "userMessage",
      id: "duplicate-user-item",
      clientId: "agentparty:duplicate-lifecycle",
      content: [],
    };
    await rpc.emit({
      method: "item/started",
      params: {
        threadId: "thread-item-lifecycle",
        turnId: "turn-duplicate-user-lifecycle",
        item: duplicateUserItem,
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-item-lifecycle",
        turnId: "turn-duplicate-user-lifecycle",
        item: duplicateUserItem,
      },
    });
    expect(
      dispatches.filter(({ clientId }) =>
        clientId === "agentparty:duplicate-lifecycle"
      ),
    ).toHaveLength(1);
  });

  test("updates retained turn byte accounting without rescanning completed history", () => {
    const session = new CodexSessionController(new ScriptedCodexRpc());
    const internal = session as unknown as {
      turns: Map<string, CodexTurn>;
      retainedTurnBytesById: Map<string, number>;
      retainedCompletedTurnBytes: number;
      retainedCompletedTurnCount: number;
      retainedTurnBytes: (turn: CodexTurn) => number;
      storeTurn: (turn: CodexTurn) => CodexTurn;
    };
    const retainedTurnBytes = internal.retainedTurnBytes.bind(session);
    let serializedTurns = 0;
    internal.retainedTurnBytes = (turn) => {
      serializedTurns += 1;
      return retainedTurnBytes(turn);
    };

    for (let index = 0; index < 16; index += 1) {
      internal.storeTurn({
        id: `completed-${index}`,
        status: "completed",
        items: [{
          type: "agentMessage",
          id: `final-${index}`,
          text: `final ${index}`,
          phase: "final_answer",
        }],
      });
    }
    const completedBytes = internal.retainedCompletedTurnBytes;
    serializedTurns = 0;

    internal.storeTurn({ id: "active", status: "inProgress", items: [] });
    expect(serializedTurns).toBe(1);
    expect(internal.retainedCompletedTurnCount).toBe(16);
    expect(internal.retainedCompletedTurnBytes).toBe(completedBytes);

    const replacedBytes = internal.retainedTurnBytesById.get("completed-0")!;
    internal.storeTurn({ id: "completed-0", status: "inProgress", items: [] });
    expect(serializedTurns).toBe(2);
    expect(internal.retainedCompletedTurnCount).toBe(15);
    expect(internal.retainedCompletedTurnBytes).toBe(completedBytes - replacedBytes);

    internal.storeTurn({
      id: "completed-0",
      status: "completed",
      items: [{
        type: "agentMessage",
        id: "replacement-final",
        text: "replacement final",
        phase: "final_answer",
      }],
    });
    expect(serializedTurns).toBe(3);
    expect(internal.retainedCompletedTurnCount).toBe(16);
    expect(internal.retainedCompletedTurnBytes).toBe(
      [...internal.turns.entries()]
        .filter(([, turn]) => turn.status !== "inProgress")
        .reduce(
          (total, [turnId]) =>
            total + (internal.retainedTurnBytesById.get(turnId) ?? 0),
          0,
        ),
    );
  });

  test("drops multi-megabyte tool lifecycle payloads and bounds completed turn affinity", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-retention"));
    const session = new CodexSessionController(rpc);
    await session.start();
    await session.request("thread/start", {});

    const heavyTurnId = "turn-heavy-lifecycle";
    const heavyClientId = "agentparty:heavy-lifecycle";
    const multiMegabytePayload =
      `MULTI_MEGABYTE_TOOL_PAYLOAD:${"x".repeat(3 * 1_024 * 1_024)}`;
    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-retention",
        turn: {
          id: heavyTurnId,
          status: "inProgress",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-retention",
        turnId: heavyTurnId,
        item: {
          type: "userMessage",
          id: "user-heavy-lifecycle",
          clientId: heavyClientId,
          content: [{ type: "text", text: "retain only affinity" }],
        },
      },
    });
    for (const item of [
      {
        type: "commandExecution",
        id: "command-heavy-lifecycle",
        command: "/usr/bin/printf payload",
        aggregatedOutput: multiMegabytePayload,
        status: "completed",
      },
      {
        type: "mcpToolCall",
        id: "mcp-heavy-lifecycle",
        server: "large-fixture",
        tool: "return_payload",
        result: { content: multiMegabytePayload },
        status: "completed",
      },
    ]) {
      await rpc.emit({
        method: "item/started",
        params: {
          threadId: "thread-retention",
          turnId: heavyTurnId,
          item,
        },
      });
      await rpc.emit({
        method: "item/completed",
        params: {
          threadId: "thread-retention",
          turnId: heavyTurnId,
          item,
        },
      });
    }

    const privateState = session as unknown as {
      turns: Map<string, CodexTurn>;
      turnByClientId: Map<string, string>;
      retainedTurnBytesById: Map<string, number>;
      retainedCompletedTurnBytes: number;
      retainedCompletedTurnCount: number;
    };
    expect(privateState.turns.get(heavyTurnId)).toEqual({
      id: heavyTurnId,
      status: "inProgress",
      items: [{
        type: "userMessage",
        id: "user-heavy-lifecycle",
        clientId: heavyClientId,
      }],
    });
    expect(JSON.stringify([...privateState.turns.values()])).not.toContain(
      "MULTI_MEGABYTE_TOOL_PAYLOAD",
    );

    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-retention",
        turn: {
          id: heavyTurnId,
          status: "completed",
          items: [],
          itemsView: "notLoaded",
        },
      },
    });
    for (let index = 0; index < 260; index += 1) {
      const turnId = `turn-retained-${index}`;
      const clientId = `agentparty:retained-${index}`;
      await rpc.emit({
        method: "turn/started",
        params: {
          threadId: "thread-retention",
          turn: {
            id: turnId,
            status: "inProgress",
            items: [{
              type: "userMessage",
              id: `user-retained-${index}`,
              clientId,
              content: [{ type: "text", text: `input ${index}` }],
            }],
          },
        },
      });
      await rpc.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-retention",
          turn: {
            id: turnId,
            status: "completed",
            items: [],
            itemsView: "notLoaded",
          },
        },
      });
    }

    // The implementation deliberately keeps at most 256 completed turns and
    // evicts their clientId affinity in lockstep.
    expect(privateState.turns.size).toBe(256);
    expect(privateState.turnByClientId.size).toBe(256);
    expect(privateState.retainedTurnBytesById.size).toBe(privateState.turns.size);
    expect(privateState.retainedCompletedTurnCount).toBe(256);
    expect(privateState.retainedCompletedTurnBytes).toBe(
      [...privateState.retainedTurnBytesById.values()]
        .reduce((total, bytes) => total + bytes, 0),
    );
    expect(session.turnForClientId(heavyClientId)).toBeNull();
    expect(session.turnForClientId("agentparty:retained-0")).toBeNull();
    expect(session.turnForClientId("agentparty:retained-259")).toMatchObject({
      id: "turn-retained-259",
      status: "completed",
    });
    const retainedJson = JSON.stringify([...privateState.turns.values()]);
    expect(retainedJson).not.toContain("MULTI_MEGABYTE_TOOL_PAYLOAD");
    expect(Buffer.byteLength(retainedJson)).toBeLessThan(256 * 1_024);
  });

  for (const method of ["thread/start", "thread/resume"] as const) {
    test(`${method} serializes a concurrent submit behind the thread switch`, async () => {
      const rpc = new ScriptedCodexRpc();
      const switchResponse = deferred<ReturnType<typeof idleThread>>();
      rpc.queue("thread/start", idleThread("thread-old"));
      rpc.queue(method, () => switchResponse.promise);
      rpc.queue("turn/start", (params: unknown) => {
        const threadId = (params as { threadId?: unknown }).threadId;
        return { turn: { id: `turn-for-${String(threadId)}` } };
      });
      const session = new CodexSessionController(rpc);

      await session.start();
      await session.request("thread/start", {});
      expect(session.activeThreadId).toBe("thread-old");

      const switching = session.request(
        method,
        method === "thread/resume" ? { threadId: "thread-new" } : {},
      );
      const expectedSwitchCalls = method === "thread/start" ? 2 : 1;
      await waitFor(
        () => rpc.calls.filter((call) => call.method === method).length === expectedSwitchCalls,
        `${method} did not reach the backend`,
      );

      let submitSettled = false;
      const submitted = session.submit({
        text: "must use the replacement thread",
        clientUserMessageId: `agentparty:${method}:concurrent`,
      }).finally(() => {
        submitSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);
      expect(submitSettled).toBe(false);

      switchResponse.resolve(idleThread("thread-new"));
      await switching;
      expect(session.activeThreadId).toBe("thread-new");
      expect(await submitted).toEqual({
        kind: "started",
        turnId: "turn-for-thread-new",
      });
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            threadId: "thread-new",
            clientUserMessageId: `agentparty:${method}:concurrent`,
          }),
        }),
      ]);
    });
  }

  for (
    const method of [
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "review/start",
      "thread/compact/start",
      "thread/shellCommand",
    ] as const
  ) {
    test(`${method} cannot overtake an in-flight thread switch`, async () => {
      const rpc = new ScriptedCodexRpc();
      const switchResponse = deferred<ReturnType<typeof idleThread>>();
      rpc.queue("thread/start", idleThread("thread-old"));
      rpc.queue("thread/resume", () => switchResponse.promise);
      const session = new CodexSessionController(rpc);

      await session.start();
      await session.request("thread/start", {});
      const switching = session.request("thread/resume", { threadId: "thread-new" });
      await waitFor(
        () => rpc.calls.some((call) => call.method === "thread/resume"),
        "thread switch did not reach the backend",
      );
      const mutation = session.request(method, {
        threadId: "thread-old",
        ...(method === "turn/steer" ? { expectedTurnId: "turn-old" } : {}),
        ...(method === "review/start" ? { delivery: "detached" } : {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rpc.calls.filter((call) => call.method === method)).toHaveLength(0);

      switchResponse.resolve(idleThread("thread-new"));
      await switching;
      await expect(mutation).rejects.toThrow(`inactive thread thread-old`);
      expect(rpc.calls.filter((call) => call.method === method)).toHaveLength(0);
    });
  }

  test("a pre-thread-start disconnect emits a safe restart only after cancelling the old request", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    rpc.disconnect();
    const starting = session.request("thread/start", {
      prompt: "the TUI positional prompt is still local",
    });
    await expect(starting).rejects.toThrow(
      "disconnected before the initial thread/start write",
    );
    await waitFor(
      () => recoveries.length === 1,
      "proven-not-written recovery was not published",
    );

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(0);
    expect(recoveries).toEqual([{
      disposition: "restart",
      threadId: null,
      generation: 2,
    }]);
  });

  test("the transport requestWritten marker is authoritative for safe initial replay", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    rpc.queue(
      "thread/start",
      () => {
        throw new CodexRpcDisconnectedError(
          "scripted disconnect before write",
          { requestWritten: false },
        );
      },
    );
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await expect(session.request("thread/start", {})).rejects.toThrow(
      "disconnected before the initial thread/start write",
    );
    rpc.disconnect();
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "restart",
      threadId: null,
      generation: 2,
    }]);
  });

  test("an after-write initial thread/start disconnect is terminal-unknown and never replayed", async () => {
    const rpc = new ScriptedCodexRpc();
    const startResponse = deferred<ReturnType<typeof idleThread>>();
    const recoveries: CodexFrontendRecovery[] = [];
    rpc.queue("thread/start", () => startResponse.promise);
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    const starting = session.request("thread/start", { prompt: "run once" });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/start"),
      "initial thread/start did not cross the scripted transport",
    );
    rpc.disconnect();
    startResponse.reject(new CodexRpcDisconnectedError("lost after write"));
    await expect(starting).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "unknown",
      threadId: null,
      generation: 2,
      reason:
        "Codex backend disconnected after the initial thread/start write; " +
        "its outcome is unknown, so the initial prompt will not be replayed",
    }]);
  });

  test("an invalid initial thread/start response fails closed and remains retryable", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", {});
    rpc.queue("thread/start", idleThread("thread-after-invalid"));
    const session = new CodexSessionController(rpc);

    await expect(session.request("thread/start", {})).rejects.toThrow(
      "thread/start returned no valid thread",
    );
    expect(session.activeThreadId).toBeNull();

    await expect(session.request("thread/start", {})).resolves.toEqual(
      idleThread("thread-after-invalid"),
    );
    expect(session.activeThreadId).toBe("thread-after-invalid");
    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
  });

  test("thread switching and authoritative snapshots reject invalid thread identity", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-current"));
    rpc.queue("thread/start", {});
    rpc.queue("thread/resume", idleThread("thread-wrong"));
    rpc.queue("thread/read", idleThread("thread-wrong"));
    rpc.queue("thread/rollback", idleThread("thread-wrong"));
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    await expect(session.request("thread/start", {})).rejects.toThrow(
      "thread/start returned no valid thread",
    );
    await expect(
      session.request("thread/resume", { threadId: "thread-requested" }),
    ).rejects.toThrow(
      "thread/resume returned thread thread-wrong, expected thread-requested",
    );
    await expect(
      session.request("thread/read", {
        threadId: "thread-current",
        includeTurns: true,
      }),
    ).rejects.toThrow(
      "thread/read returned thread thread-wrong, expected thread-current",
    );
    await expect(
      session.request("thread/rollback", {
        threadId: "thread-current",
        numTurns: 1,
      }),
    ).rejects.toThrow(
      "thread/rollback returned thread thread-wrong, expected thread-current",
    );
    expect(session.activeThreadId).toBe("thread-current");
  });

  test("a created bootstrap thread replays its prompt without creating the thread twice", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    rpc.queue("thread/start", idleThread("thread-bootstrap"));
    rpc.queue("thread/resume", idleThread("thread-bootstrap"));
    rpc.queue("thread/read", idleThread("thread-bootstrap"));
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await session.request("thread/start", {});
    rpc.disconnect();
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "restart_thread_with_prompt",
      threadId: "thread-bootstrap",
      generation: 2,
    }]);
  });

  test("bootstrap prompt stays ahead of queued AgentParty input across same-thread read and resume", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-bootstrap-order"));
    rpc.queue("thread/read", idleThread("thread-bootstrap-order"));
    rpc.queue("thread/resume", idleThread("thread-bootstrap-order"));
    rpc.queue("turn/start", {
      turn: { id: "turn-bootstrap-order", status: "inProgress", items: [] },
    });
    rpc.queue("turn/steer", { turnId: "turn-bootstrap-order" });
    const session = new CodexSessionController(rpc, {
      expectBootstrapPrompt: true,
    });

    await session.request("thread/start", {});
    expect(await session.submit({
      text: "recovered AgentParty delivery",
      clientUserMessageId: "agentparty:bootstrap-order",
    })).toMatchObject({ kind: "queued", reason: "unknown" });
    await session.request("thread/read", {
      threadId: "thread-bootstrap-order",
      includeTurns: true,
    });
    await session.request("thread/resume", {
      threadId: "thread-bootstrap-order",
    });
    expect(
      rpc.calls.filter((call) =>
        call.method === "turn/start" || call.method === "turn/steer"
      ),
    ).toHaveLength(0);

    await session.request("turn/start", {
      threadId: "thread-bootstrap-order",
      clientUserMessageId: null,
      input: [{
        type: "text",
        text: "the user's initial prompt",
        text_elements: [],
      }],
    });
    const writes = rpc.calls.filter((call) =>
      call.method === "turn/start" || call.method === "turn/steer"
    );
    expect(writes.map((call) => call.method)).toEqual(["turn/start", "turn/steer"]);
    expect(writes[1]!.params).toMatchObject({
      threadId: "thread-bootstrap-order",
      expectedTurnId: "turn-bootstrap-order",
      clientUserMessageId: "agentparty:bootstrap-order",
    });
  });

  test("initial prompt replay requires the turn/start transport to prove not-written", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    const initialInput = [{
      type: "text",
      text: "WIRE_PROMPT_746",
      text_elements: [],
    }];
    rpc.queue("thread/start", idleThread("thread-bootstrap"));
    rpc.queue("turn/start", () => {
      throw new CodexRpcDisconnectedError(
        "scripted initial turn disconnect before write",
        { requestWritten: false },
      );
    });
    rpc.queue("thread/resume", idleThread("thread-bootstrap"));
    rpc.queue("thread/read", idleThread("thread-bootstrap"));
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await session.request("thread/start", {});
    await expect(session.request("turn/start", {
      threadId: "thread-bootstrap",
      clientUserMessageId: null,
      input: initialInput,
    })).rejects.toThrow("disconnected before the initial turn/start write");
    rpc.disconnect();
    await rpc.reconnect();

    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(recoveries).toEqual([{
      disposition: "restart_thread_with_prompt",
      threadId: "thread-bootstrap",
      generation: 2,
      initialInput,
    }]);
  });

  test("an after-write initial prompt is unknown unless full history positively matches it", async () => {
    for (const historyMatches of [false, true]) {
      const rpc = new ScriptedCodexRpc();
      const turnResponse = deferred<unknown>();
      const recoveries: CodexFrontendRecovery[] = [];
      const initialInput = [{
        type: "text",
        text: "WIRE_PROMPT_746",
        text_elements: [],
      }];
      rpc.queue("thread/start", idleThread("thread-bootstrap"));
      rpc.queue("turn/start", () => turnResponse.promise);
      rpc.queue("thread/resume", idleThread("thread-bootstrap"));
      rpc.queue("thread/read", historyMatches
        ? {
          thread: {
            id: "thread-bootstrap",
            status: { type: "active" },
            turns: [{
              id: "turn-bootstrap",
              status: "inProgress",
              items: [{
                type: "userMessage",
                id: "user-bootstrap",
                clientId: null,
                content: initialInput,
              }],
            }],
          },
        }
        : idleThread("thread-bootstrap"));
      const session = new CodexSessionController(rpc);
      session.onFrontendRecovery((event) => {
        recoveries.push(event);
      });

      await session.request("thread/start", {});
      const starting = session.request("turn/start", {
        threadId: "thread-bootstrap",
        clientUserMessageId: null,
        input: initialInput,
      });
      await waitFor(
        () => rpc.calls.some((call) => call.method === "turn/start"),
        "initial prompt did not cross the scripted transport",
      );
      rpc.disconnect();
      turnResponse.reject(new CodexRpcDisconnectedError("lost after initial prompt write"));
      await expect(starting).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
      await rpc.reconnect();

      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      if (historyMatches) {
        expect(recoveries).toEqual([{
          disposition: "resume",
          threadId: "thread-bootstrap",
          generation: 2,
        }]);
      } else {
        expect(recoveries).toEqual([{
          disposition: "unknown",
          threadId: "thread-bootstrap",
          generation: 2,
          reason:
            "Codex backend disconnected after the initial turn/start write; " +
            "its outcome is unknown, so the initial prompt will not be replayed",
        }]);
      }
    }
  });

  test("reprojects accepted unknown bootstrap proof without retaining content beyond the cache cap", async () => {
    const rpc = new ScriptedCodexRpc();
    const turnResponse = deferred<unknown>();
    const recoveries: CodexFrontendRecovery[] = [];
    const completed: CodexTurn[] = [];
    const initialInput = [{
      type: "text",
      text: `BOOTSTRAP_PROOF_OVER_CAP:${"b".repeat(16 * 1_024 * 1_024)}`,
      text_elements: [],
    }];
    const recoveredTurn = {
      id: "turn-bootstrap-proof-over-cap",
      status: "completed" as const,
      items: [{
        type: "userMessage",
        id: "user-bootstrap-proof-over-cap",
        clientId: null,
        content: initialInput,
      }],
    };
    rpc.queue("thread/start", idleThread("thread-bootstrap-proof-over-cap"));
    rpc.queue("turn/start", () => turnResponse.promise);
    rpc.queue("thread/resume", idleThread("thread-bootstrap-proof-over-cap"));
    rpc.queue("thread/read", {
      thread: {
        id: "thread-bootstrap-proof-over-cap",
        status: { type: "idle" },
        turns: [recoveredTurn],
      },
    });
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });
    session.onTurnCompleted((turn) => {
      completed.push(turn);
    });

    await session.request("thread/start", {});
    const starting = session.request("turn/start", {
      threadId: "thread-bootstrap-proof-over-cap",
      clientUserMessageId: null,
      input: initialInput,
    });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "turn/start"),
      "oversized bootstrap prompt did not cross the scripted transport",
    );
    rpc.disconnect();
    turnResponse.reject(new CodexRpcDisconnectedError("lost after oversized prompt write"));
    await expect(starting).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await rpc.reconnect();

    expect(recoveries).toEqual([{
      disposition: "resume",
      threadId: "thread-bootstrap-proof-over-cap",
      generation: 2,
    }]);
    expect(completed).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(completed[0]))).toBeGreaterThan(
      16 * 1_024 * 1_024,
    );
    expect(completed[0]?.items?.[0]).toHaveProperty("content", initialInput);

    const state = session as unknown as {
      turns: Map<string, CodexTurn>;
      bootstrapRecovery: unknown;
      bootstrapThreadId: string | null;
    };
    expect(state.bootstrapRecovery).toBeNull();
    expect(state.bootstrapThreadId).toBeNull();
    expect(state.turns.get(recoveredTurn.id)).toEqual({
      id: recoveredTurn.id,
      status: "completed",
      items: [{
        type: "userMessage",
        id: "user-bootstrap-proof-over-cap",
        clientId: null,
      }],
    });
    const retainedBytes = Buffer.byteLength(
      JSON.stringify([...state.turns.values()]),
    );
    expect(retainedBytes).toBeLessThan(16 * 1_024 * 1_024);
  });

  test("an accepted initial turn resumes even if the backend drops before the TUI sees its response", async () => {
    const rpc = new ScriptedCodexRpc();
    const recoveries: CodexFrontendRecovery[] = [];
    const initialInput = [{
      type: "text",
      text: "WIRE_PROMPT_746",
      text_elements: [],
    }];
    rpc.queue("thread/start", idleThread("thread-bootstrap"));
    rpc.queue("turn/start", {
      turn: {
        id: "turn-bootstrap",
        status: "inProgress",
        items: [{
          type: "userMessage",
          id: "user-bootstrap",
          clientId: null,
          content: initialInput,
        }],
      },
    });
    rpc.queue("thread/resume", idleThread("thread-bootstrap"));
    rpc.queue("thread/read", {
      thread: {
        id: "thread-bootstrap",
        status: { type: "active" },
        turns: [{
          id: "turn-bootstrap",
          status: "inProgress",
          items: [{
            type: "userMessage",
            id: "user-bootstrap",
            clientId: null,
            content: initialInput,
          }],
        }],
      },
    });
    const session = new CodexSessionController(rpc);
    session.onFrontendRecovery((event) => {
      recoveries.push(event);
    });

    await session.request("thread/start", {});
    await session.request("turn/start", {
      threadId: "thread-bootstrap",
      clientUserMessageId: null,
      input: initialInput,
    });
    rpc.disconnect();
    await rpc.reconnect();

    expect(recoveries).toEqual([{
      disposition: "resume",
      threadId: "thread-bootstrap",
      generation: 2,
    }]);
  });

  test("shellCommand owns the turn until authoritative completion before AgentParty starts", async () => {
    const rpc = new ScriptedCodexRpc();
    const shellAccepted = deferred<Record<string, never>>();
    rpc.queue("thread/start", idleThread("thread-shell"));
    rpc.queue("thread/shellCommand", () => shellAccepted.promise);
    rpc.queue("turn/start", { turn: { id: "turn-agentparty" } });
    const session = new CodexSessionController(rpc);

    await session.start();
    await session.request("thread/start", {});
    const shell = session.request("thread/shellCommand", {
      threadId: "thread-shell",
      command: "git status --short",
    });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/shellCommand"),
      "shellCommand did not reach the backend",
    );
    const submitted = session.submit({
      text: "must wait for the user shell command",
      clientUserMessageId: "agentparty:after-shell",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    shellAccepted.resolve({});
    await shell;
    await expect(submitted).resolves.toMatchObject({
      kind: "queued",
      reason: "shell",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    await rpc.emit({
      method: "turn/started",
      params: {
        threadId: "thread-shell",
        turn: { id: "turn-user-shell", status: "inProgress", items: [] },
      },
    });
    await rpc.emit({
      method: "item/started",
      params: {
        threadId: "thread-shell",
        turnId: "turn-user-shell",
        item: {
          id: "item-user-shell",
          type: "commandExecution",
          source: "userShell",
        },
      },
    });
    await rpc.emit({
      method: "item/completed",
      params: {
        threadId: "thread-shell",
        turnId: "turn-user-shell",
        item: {
          id: "item-user-shell",
          type: "commandExecution",
          source: "userShell",
        },
      },
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    await rpc.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-shell",
        turn: { id: "turn-user-shell", status: "completed", items: [] },
      },
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: "thread-shell",
          clientUserMessageId: "agentparty:after-shell",
        }),
      }),
    ]);
  });

  test("an after-write thread switch disconnect stays unknown while later submit restores the prior thread", async () => {
    const rpc = new ScriptedCodexRpc();
    const switchResponse = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-old"));
    rpc.queue("thread/start", () => switchResponse.promise);
    rpc.queue("thread/resume", idleThread("thread-old"));
    rpc.queue("thread/read", idleThread("thread-old"));
    rpc.queue("turn/start", {
      turn: { id: "turn-after-restore" },
    });
    const session = new CodexSessionController(rpc);

    await session.start();
    await session.request("thread/start", {});
    const switching = session.request("thread/start", {});
    await waitFor(
      () => rpc.calls.filter((call) => call.method === "thread/start").length === 2,
      "replacement thread/start did not take the session lane",
    );
    const expectedStartCalls = rpc.startCalls + 1;
    const submitted = session.submit({
      text: "must wait for reconnect restoration",
      clientUserMessageId: "agentparty:lane-disconnect",
    });
    await waitFor(
      () => rpc.startCalls >= expectedStartCalls,
      "submit did not pass its first readiness barrier",
    );

    rpc.connected = false;
    switchResponse.resolve(idleThread("thread-new"));
    await expect(switching).rejects.toBeInstanceOf(CodexRpcDisconnectedError);
    await expect(submitted).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-restore",
    });
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
        .map((call) => call.params),
    ).toEqual([
      expect.objectContaining({
        threadId: "thread-old",
        clientUserMessageId: "agentparty:lane-disconnect",
      }),
    ]);
    expect(rpc.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(rpc.calls.filter((call) => call.method === "thread/read")).toHaveLength(1);
  });

  test("overlapping reconnects run a distinct full recovery for the newest generation", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-recovery"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-recovery"));
    rpc.queue("thread/read", idleThread("thread-recovery"));
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 restore did not start",
    );
    const generationThree = rpc.reconnect();
    generationTwoResume.resolve(idleThread("thread-recovery"));
    await Promise.all([generationTwo, generationThree]);

    expect(
      rpc.calls
        .filter((call) => call.method === "thread/resume")
        .map((call) => call.generation),
    ).toEqual([2, 3]);
    expect(
      rpc.calls
        .filter((call) => call.method === "thread/read")
        .map((call) => call.generation),
    ).toEqual([3]);
  });

  test("a writer waiting on interrupted recovery drives the next generation without spinning", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-recovery-waiter"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-recovery-waiter"));
    rpc.queue("thread/read", idleThread("thread-recovery-waiter"));
    rpc.queue("turn/start", { turn: { id: "turn-after-recovery-waiter" } });
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 restore did not start",
    );
    const submission = session.submit({
      text: "resume only after generation 3 is authoritative",
      clientUserMessageId: "agentparty:recovery-waiter-generation-three",
    });

    rpc.disconnect();
    generationTwoResume.resolve(idleThread("thread-recovery-waiter"));
    await generationTwo;
    await expect(submission).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-recovery-waiter",
    });

    expect(
      rpc.calls
        .filter((call) => call.method === "thread/resume" || call.method === "thread/read")
        .map((call) => `${call.method}@${call.generation}`),
    ).toEqual([
      "thread/resume@2",
      "thread/resume@3",
      "thread/read@3",
    ]);
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
        .map((call) => call.generation),
    ).toEqual([3]);
    expect(rpc.startCalls).toBeGreaterThanOrEqual(2);
  });

  test("a partial restore cannot apply a stale snapshot or continue its read on a new generation", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<{
      thread: {
        id: string;
        status: { type: "active" };
        turns: Array<{
          id: string;
          status: "inProgress";
          items: Array<{ type: "userMessage"; clientId: string }>;
        }>;
      };
    }>();
    rpc.queue("thread/start", idleThread("thread-fenced"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-fenced"));
    rpc.queue("thread/read", idleThread("thread-fenced"));
    const session = new CodexSessionController(rpc);
    const recoveredClientIds: string[] = [];
    session.onDispatch((input) => {
      recoveredClientIds.push(input.clientUserMessageId);
    });

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 resume did not start",
    );
    generationTwoResume.resolve({
      thread: {
        id: "thread-fenced",
        status: { type: "active" },
        turns: [{
          id: "stale-turn",
          status: "inProgress",
          items: [{
            type: "userMessage",
            clientId: "agentparty:stale-generation-two",
          }],
        }],
      },
    });
    const generationThree = rpc.reconnect();
    await Promise.all([generationTwo, generationThree]);

    expect(
      rpc.calls
        .filter((call) => call.method === "thread/resume" || call.method === "thread/read")
        .map((call) => `${call.method}@${call.generation}`),
    ).toEqual([
      "thread/resume@2",
      "thread/resume@3",
      "thread/read@3",
    ]);
    expect(recoveredClientIds).not.toContain("agentparty:stale-generation-two");
  });

  test("a superseded restore failure cannot poison the healthy generation", async () => {
    const rpc = new ScriptedCodexRpc();
    const generationTwoResume = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-failure-fence"));
    rpc.queue("thread/resume", () => generationTwoResume.promise);
    rpc.queue("thread/resume", idleThread("thread-failure-fence"));
    rpc.queue("thread/read", idleThread("thread-failure-fence"));
    rpc.queue("turn/start", { turn: { id: "turn-after-healthy-recovery" } });
    const session = new CodexSessionController(rpc);

    await session.request("thread/start", {});
    const generationTwo = rpc.reconnect();
    await waitFor(
      () => rpc.calls.some((call) =>
        call.method === "thread/resume" && call.generation === 2
      ),
      "generation 2 resume did not start",
    );
    const generationThree = rpc.reconnect();
    generationTwoResume.reject(new Error("restore-generation-two-failed"));
    await Promise.all([generationTwo, generationThree]);

    await expect(session.submit({
      text: "healthy generation must remain usable",
      clientUserMessageId: "agentparty:healthy-generation",
    })).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-healthy-recovery",
    });
    expect(
      rpc.calls
        .filter((call) => call.method === "turn/start")
      .map((call) => call.generation),
    ).toEqual([3]);
  });

  test.each([
    ["missing", {}],
    ["mismatched", idleThread("thread-wrong-recovery-target")],
  ] as const)(
    "a %s full-history snapshot keeps recovery closed until the exact thread is readable",
    async (_kind, invalidRead) => {
      const threadId = "thread-strict-recovery";
      const validRead = deferred<ReturnType<typeof idleThread>>();
      const rpc = new ScriptedCodexRpc();
      rpc.queue("thread/start", idleThread(threadId));
      rpc.queue("thread/resume", idleThread(threadId));
      rpc.queue("thread/read", invalidRead);
      rpc.queue("thread/resume", idleThread(threadId));
      rpc.queue("thread/read", () => validRead.promise);
      rpc.queue("turn/start", { turn: { id: "turn-after-strict-recovery" } });
      const session = new CodexSessionController(rpc, {
        recoveryRetryDelayMs: 20,
      });

      await session.request("thread/start", {});
      const recovery = rpc.reconnect();
      const submission = session.submit({
        text: "must wait for an exact recovery snapshot",
        clientUserMessageId: `agentparty:strict-recovery-${_kind}`,
      });
      await waitFor(
        () => rpc.calls.filter((call) => call.method === "thread/read").length === 2,
        "invalid recovery snapshot was not retried on the same generation",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

      validRead.resolve(idleThread(threadId));
      await recovery;
      await expect(submission).resolves.toEqual({
        kind: "started",
        turnId: "turn-after-strict-recovery",
      });
      expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
      expect(
        rpc.calls
          .filter((call) => call.method === "thread/resume" || call.method === "thread/read")
          .map((call) => `${call.method}@${call.generation}`),
      ).toEqual([
        "thread/resume@2",
        "thread/read@2",
        "thread/resume@2",
        "thread/read@2",
      ]);
    },
  );

  test("a reconnect while submit waits on the arbiter cannot write before same-generation recovery", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-operation-fence"));
    rpc.queue("thread/resume", idleThread("thread-operation-fence"));
    rpc.queue("thread/read", idleThread("thread-operation-fence"));
    rpc.queue("turn/start", { turn: { id: "turn-after-operation-fence" } });
    const session = new CodexSessionController(rpc);
    await session.request("thread/start", {});

    const arbiter = (session as unknown as {
      arbiter: CodexTurnArbiter | null;
    }).arbiter!;
    const releaseArbiter = deferred<void>();
    const occupyingArbiter = arbiter.runInteractiveMutation(
      "turn/steer",
      { threadId: "thread-operation-fence", expectedTurnId: "turn-before-reconnect" },
      async () => {
        await releaseArbiter.promise;
        return { turnId: "turn-before-reconnect" };
      },
    );
    const expectedStartCalls = rpc.startCalls + 1;
    const submitted = session.submit({
      text: "must not write before generation recovery",
      clientUserMessageId: "agentparty:operation-generation-fence",
    });
    await waitFor(
      () => rpc.startCalls >= expectedStartCalls,
      "submit did not pass its initial readiness barrier",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const recovery = rpc.reconnect();
    releaseArbiter.resolve();
    await occupyingArbiter;
    await expect(submitted).resolves.toMatchObject({
      kind: "queued",
      reason: "steer_rejected",
    });
    await recovery;

    expect(
      rpc.calls
        .filter((call) =>
          call.method === "thread/resume" ||
          call.method === "thread/read" ||
          call.method === "turn/start" ||
          call.method === "turn/steer"
        )
        .map((call) => `${call.method}@${call.generation}`),
    ).toEqual([
      "thread/resume@2",
      "thread/read@2",
      "turn/start@2",
    ]);
  });

  test("thread/fork passes the switch guard and attaches the returned thread", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/start", idleThread("thread-old"));
    rpc.queue("thread/fork", idleThread("thread-forked"));
    rpc.queue("turn/start", (params: unknown) => {
      const threadId = (params as { threadId?: unknown }).threadId;
      return { turn: { id: `turn-for-${String(threadId)}` } };
    });
    const session = new CodexSessionController(rpc);
    const switchAttempts: Array<{
      method: string;
      currentThreadId: string;
      targetThreadId: string | null;
    }> = [];
    session.onThreadSwitch((attempt) => {
      switchAttempts.push(attempt);
    });

    await session.start();
    await session.request("thread/start", {});
    expect(session.activeThreadId).toBe("thread-old");

    await session.request("thread/fork", { threadId: "thread-old" });
    expect(switchAttempts).toEqual([{
      method: "thread/fork",
      currentThreadId: "thread-old",
      targetThreadId: null,
    }]);
    expect(session.activeThreadId).toBe("thread-forked");

    await expect(session.submit({
      text: "continue in the fork",
      clientUserMessageId: "agentparty:forked-thread",
    })).resolves.toEqual({
      kind: "started",
      turnId: "turn-for-thread-forked",
    });
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          threadId: "thread-forked",
          clientUserMessageId: "agentparty:forked-thread",
        }),
      }),
    ]);
  });

  test("thread/rollback serializes a concurrent AgentParty submit behind authoritative history", async () => {
    const rpc = new ScriptedCodexRpc();
    const rollbackResponse = deferred<ReturnType<typeof idleThread>>();
    rpc.queue("thread/start", idleThread("thread-rollback"));
    rpc.queue("thread/rollback", () => rollbackResponse.promise);
    rpc.queue("turn/start", { turn: { id: "turn-after-rollback" } });
    const session = new CodexSessionController(rpc);
    await session.start();
    await session.request("thread/start", {});

    const rollback = session.request("thread/rollback", {
      threadId: "thread-rollback",
      numTurns: 1,
    });
    await waitFor(
      () => rpc.calls.some((call) => call.method === "thread/rollback"),
      "rollback did not reach the backend",
    );
    const submitted = session.submit({
      text: "must see post-rollback history",
      clientUserMessageId: "agentparty:after-rollback",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(0);

    rollbackResponse.resolve(idleThread("thread-rollback"));
    await rollback;
    await expect(submitted).resolves.toEqual({
      kind: "started",
      turnId: "turn-after-rollback",
    });
  });

  test("thread/rollback rebuilds same-thread clientId affinity instead of retaining removed turns", async () => {
    const rpc = new ScriptedCodexRpc();
    rpc.queue("thread/resume", {
      thread: {
        id: "thread-rollback-affinity",
        status: { type: "idle" },
        turns: [{
          id: "source-turn",
          status: "completed",
          items: [{
            type: "userMessage",
            id: "source-user",
            clientId: "agentparty:source-delivery",
          }],
        }],
      },
    });
    rpc.queue("thread/rollback", idleThread("thread-rollback-affinity"));
    const session = new CodexSessionController(rpc);
    await session.start();
    await session.request("thread/resume", { threadId: "thread-rollback-affinity" });
    expect(session.turnForClientId("agentparty:source-delivery")?.id).toBe("source-turn");

    await session.request("thread/rollback", {
      threadId: "thread-rollback-affinity",
      numTurns: 1,
    });
    expect(session.turnForClientId("agentparty:source-delivery")).toBeNull();
  });

  test("a submit that triggers reconnect restores before taking the arbiter lane", async () => {
    const statePath = join(temp, "state.json");
    const logs: string[] = [];
    let spawns = 0;
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 1_000,
      maxReconnectDelayMs: 1_000,
      log: (line) => logs.push(line),
      spawnProxy: () => {
        spawns += 1;
        return spawn("bun", ["run", fixture], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
        });
      },
    });
    clients.push(rpc);
    const session = new CodexSessionController(rpc, {
      log: (line) => logs.push(line),
    });
    await session.start();
    await session.request("thread/start", {});
    await expect(rpc.request("mock/disconnect", {})).rejects.toThrow(
      "Codex app-server control connection closed",
    );

    const dispatch = await Promise.race([
      session.submit({
        text: "submit owns the reconnect",
        clientUserMessageId: "agentparty:submit-reconnect",
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("submit deadlocked during reconnect")), 2_000);
      }),
    ]);
    expect(dispatch).toEqual({ kind: "started", turnId: "turn-1" });
    expect(spawns).toBeGreaterThanOrEqual(2);
    expect(logs.some((line) => line.includes("restored thread thread-mock"))).toBe(true);
  }, 10_000);

  test("initializes real JSONL, resumes after an unknown write, and reconciles clientId without duplicate start", async () => {
    const statePath = join(temp, "state.json");
    let spawns = 0;
    const logs: string[] = [];
    const rpc = new CodexRpcClient({
      reconnectDelayMs: 5,
      maxReconnectDelayMs: 20,
      log: (line) => logs.push(line),
      spawnProxy: () => {
        spawns += 1;
        return spawn("bun", ["run", fixture], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
        });
      },
    });
    clients.push(rpc);
    const session = new CodexSessionController(rpc, {
      log: (line) => logs.push(line),
    });
    const completed: CodexTurn[] = [];
    session.onTurnCompleted((turn) => {
      completed.push(turn);
    });

    await session.start();
    expect(rpc.initializeResult).toMatchObject({
      userAgent: "mock-codex-app-server/0.144.4",
      platformFamily: "unix",
    });
    await session.request("thread/start", {});
    expect(session.activeThreadId).toBe("thread-mock");

    const input = {
      text: "__disconnect_after_accept__",
      clientUserMessageId: "agentparty:delivery-lost-response",
      metadata: { delivery_id: "delivery-lost-response" },
    };
    await expect(session.submit(input)).resolves.toEqual({
      kind: "uncertain",
      reason: "unknown_outcome",
    });

    await waitFor(
      () => session.turnForClientId(input.clientUserMessageId) !== null,
      "reconnected controller did not recover the accepted client id",
    );
    expect(spawns).toBeGreaterThanOrEqual(2);
    expect(await session.submit(input)).toEqual({
      kind: "duplicate",
    });

    const recovered = session.turnForClientId(input.clientUserMessageId)!;
    await rpc.request("mock/complete", {
      turnId: recovered.id,
      text: "linked answer after reconnect",
    });
    await waitFor(() => completed.some((turn) => turn.id === recovered.id), "completion notification not routed");
    expect(completed.find((turn) => turn.id === recovered.id)?.items).toContainEqual(
      expect.objectContaining({
        type: "agentMessage",
        text: "linked answer after reconnect",
      }),
    );

    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      generations: number;
      turns: unknown[];
    };
    expect(state.generations).toBeGreaterThanOrEqual(2);
    expect(state.turns).toHaveLength(1);
    expect(logs.some((line) => line.includes("restored thread thread-mock"))).toBe(true);
  }, 15_000);

  test("routes app-server requests to the frontend and sends the frontend response back", async () => {
    const statePath = join(temp, "state.json");
    const rpc = new CodexRpcClient({
      spawnProxy: () => spawn("bun", ["run", fixture], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MOCK_CODEX_STATE_PATH: statePath },
      }),
    });
    clients.push(rpc);
    const session = new CodexSessionController(rpc);
    const frontend: Array<{ method: string; id?: string | number | null }> = [];
    session.onFrontendMessage((message) => {
      frontend.push(message);
      if ("id" in message) session.respond(message.id, { decision: "accept" });
    });
    await session.start();
    await session.request("thread/start", {});
    await rpc.request("mock/serverRequest", {});
    await waitFor(
      () => frontend.some((message) => message.method === "item/commandExecution/requestApproval"),
      "server request was not forwarded",
    );
    expect(frontend).toContainEqual(expect.objectContaining({
      id: "server-approval-1",
      method: "item/commandExecution/requestApproval",
    }));
  });
});
