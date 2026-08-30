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
  startError: Error | null = null;
  waitResult: Promise<CodexDesktopTurn> = Promise.resolve(completed("turn-1", "native final"));
  async connect() {}
  async discoverThreadOwner() { return "owner"; }
  async followThread() {}
  async startDelegatedTurn() {
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
    const input: CodexBridgeInput = {
      text: "AgentParty body",
      clientUserMessageId: "agentparty:delivery-1",
      beforeWrite: () => { beforeWrite += 1; },
    };
    const completedText = new Promise<string>((resolve) => {
      controller.onTurnCompleted((turn) => {
        resolve(String(turn.items?.find((item) => item.type === "agentMessage")?.text));
      });
    });
    expect(await controller.submit(input)).toEqual({ kind: "started", turnId: "turn-1" });
    expect(beforeWrite).toBe(1);
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
    const first = await controller.submit(input);
    expect(await controller.submit(input)).toEqual({ kind: "duplicate", turnId: "turn-1" });
    expect(transport.starts).toBe(1);
    release(completed("turn-1", "done"));
    expect(first).toEqual({ kind: "started", turnId: "turn-1" });
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
});
