import { describe, expect, test } from "bun:test";
import { CodexNativeSessionController } from "../src/codex-native-session";
import {
  CodexDesktopIpcRequestError,
  CodexDesktopIpcUnknownOutcomeError,
  type CodexDesktopIpcTransport,
  type CodexDesktopTurn,
} from "../src/codex-desktop-ipc";
import type { CodexBridgeInput } from "../src/codex-turn-arbiter";

const SOURCE = "01a04eb6-6349-7871-9c05-8eb15d68635f";
const TARGET = "01a0499f-2ce2-76e1-8734-733f8f169c28";

class MockTransport implements CodexDesktopIpcTransport {
  starts = 0;
  closed = false;
  calls: string[] = [];
  startError: Error | null = null;
  waitResult: Promise<CodexDesktopTurn> = Promise.resolve(completed("turn-1", "native final"));
  async connect() { this.calls.push("connect"); }
  async discoverThreadOwner() { return "owner"; }
  async followThread() { this.calls.push("followThread"); }
  async startDelegatedTurn() {
    this.calls.push("startDelegatedTurn");
    this.starts += 1;
    if (this.startError !== null) throw this.startError;
    return { turnId: "turn-1", ownerClientId: "owner" };
  }
  async waitForDelegation() { return this.waitResult; }
  close() { this.closed = true; }
}

function completed(turnId: string, text: string): CodexDesktopTurn {
  return {
    turnId,
    status: "completed",
    params: {},
    items: [{ type: "agentMessage", phase: "final_answer", text }],
  };
}

describe("CodexNativeSessionController", () => {
  test("IPC start creates a turn and persists the final answer", async () => {
    const transport = new MockTransport();
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
    });
    let beforeWrite = 0;
    let authorized = 0;
    const input: CodexBridgeInput = {
      text: "AgentParty body",
      clientUserMessageId: "agentparty:delivery-1",
      beforeWrite: () => { beforeWrite += 1; transport.calls.push("beforeWrite"); },
      checkWriteAuthorized: () => { authorized += 1; transport.calls.push("checkWriteAuthorized"); },
    };
    const completedText = new Promise<string>((resolve) => {
      controller.onTurnCompleted((turn) => {
        resolve(String(turn.items?.find((item) => item.type === "agentMessage")?.text));
      });
    });
    expect(await controller.submit(input)).toEqual({ kind: "started", turnId: "turn-1" });
    expect(beforeWrite).toBe(1);
    expect(authorized).toBe(1);
    expect(transport.calls.slice(0, 5)).toEqual([
      "connect", "followThread", "beforeWrite", "checkWriteAuthorized", "startDelegatedTurn",
    ]);
    expect(await completedText).toBe("native final");
    expect(controller.turnForClientId(input.clientUserMessageId)?.status).toBe("completed");
    expect(transport.closed).toBe(true);
  });

  test("duplicate client id never starts a second turn", async () => {
    const transport = new MockTransport();
    let release!: (turn: CodexDesktopTurn) => void;
    transport.waitResult = new Promise((resolve) => { release = resolve; });
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
    });
    const input = { text: "once", clientUserMessageId: "agentparty:duplicate" };
    const [first, duplicate] = await Promise.all([controller.submit(input), controller.submit(input)]);
    expect(duplicate).toEqual({ kind: "duplicate", turnId: "turn-1" });
    expect(transport.starts).toBe(1);
    release(completed("turn-1", "done"));
    expect(first).toEqual({ kind: "started", turnId: "turn-1" });
  });

  test("authorization rejection rolls back after beforeWrite and closes the client", async () => {
    const transport = new MockTransport();
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
    });
    let rejected = 0;
    await expect(controller.submit({
      text: "denied",
      clientUserMessageId: "agentparty:denied",
      beforeWrite: () => { transport.calls.push("beforeWrite"); },
      checkWriteAuthorized: () => { transport.calls.push("checkWriteAuthorized"); throw new Error("lease lost"); },
      onWriteRejected: () => { rejected += 1; transport.calls.push("onWriteRejected"); },
    })).rejects.toThrow("lease lost");
    expect(transport.starts).toBe(0);
    expect(transport.closed).toBe(true);
    expect(rejected).toBe(1);
    expect(transport.calls).toEqual([
      "connect", "followThread", "beforeWrite", "checkWriteAuthorized", "onWriteRejected",
    ]);
  });

  test("definitive IPC rejection rolls back the write boundary", async () => {
    const transport = new MockTransport();
    transport.startError = new CodexDesktopIpcRequestError("native rejected");
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
    });
    let rejected = 0;
    await expect(controller.submit({
      text: "fail",
      clientUserMessageId: "agentparty:fail",
      onWriteRejected: () => { rejected += 1; },
    })).rejects.toThrow("native rejected");
    expect(rejected).toBe(1);
  });

  test("lost start response remains uncertain until snapshot reconciliation", async () => {
    const transport = new MockTransport();
    transport.startError = new CodexDesktopIpcUnknownOutcomeError("lost response");
    transport.waitResult = Promise.resolve(completed("reconciled-turn", "reconciled final"));
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
    });
    const dispatches: string[] = [];
    let rejected = 0;
    controller.onDispatch((_input, dispatch) => { dispatches.push(dispatch.kind); });
    const done = new Promise<string>((resolve) => {
      controller.onTurnCompleted((turn) => resolve(String(turn.items?.[0]?.text)));
    });
    const input = {
      text: "uncertain",
      clientUserMessageId: "agentparty:unknown",
      onWriteRejected: () => { rejected += 1; },
    };
    expect(await controller.submit(input)).toEqual({ kind: "uncertain", reason: "unknown_outcome" });
    expect(await done).toBe("reconciled final");
    expect(rejected).toBe(0);
    expect(dispatches).toEqual(["uncertain", "started"]);
  });

  test("completed turn without final text remains completed", async () => {
    const transport = new MockTransport();
    transport.waitResult = Promise.resolve({ turnId: "turn-empty", status: "completed", params: {}, items: [] });
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
    });
    const done = new Promise<{ status: string; itemCount: number }>((resolve) => {
      controller.onTurnCompleted((turn) => resolve({ status: turn.status, itemCount: turn.items?.length ?? 0 }));
    });
    expect(await controller.submit({
      text: "empty",
      clientUserMessageId: "agentparty:empty",
    })).toEqual({ kind: "started", turnId: "turn-1" });
    expect(await done).toEqual({ status: "completed", itemCount: 0 });
  });

  test("unresolved unknown listeners are isolated", async () => {
    const transport = new MockTransport();
    transport.startError = new CodexDesktopIpcUnknownOutcomeError("lost response");
    transport.waitResult = Promise.reject(new CodexDesktopIpcRequestError("cannot reconcile"));
    const logs: string[] = [];
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      ipcFactory: () => transport,
      log: (line) => logs.push(line),
    });
    controller.onUnresolvedUnknown(() => { throw new Error("listener one failed"); });
    const notified = new Promise<void>((resolve) => {
      controller.onUnresolvedUnknown(() => { resolve(); });
    });
    expect(await controller.submit({
      text: "unknown",
      clientUserMessageId: "agentparty:listener-isolation",
    })).toEqual({ kind: "uncertain", reason: "unknown_outcome" });
    await notified;
    expect(logs.join("\n")).toContain("unresolved-unknown listener failed: listener one failed");
  });
});
