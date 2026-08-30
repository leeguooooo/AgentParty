import { describe, expect, test } from "bun:test";
import { CodexNativeSessionController } from "../src/codex-native-session";
import {
  CodexAppNativeToolError,
  CodexAppNativeUnknownOutcomeError,
  nativeDelegationEnvelope,
  type CodexAppNativeToolResult,
} from "../src/codex-app-native";
import type { CodexBridgeInput } from "../src/codex-turn-arbiter";

const SOURCE = "01a04eb6-6349-7871-9c05-8eb15d68635f";
const TARGET = "01a0499f-2ce2-76e1-8734-733f8f169c28";

function textResult(value: unknown): CodexAppNativeToolResult {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

describe("CodexNativeSessionController", () => {
  test("native send starts a synthetic turn and wait_threads completes it with the final answer", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "send_message_to_thread") return textResult({ threadId: TARGET });
        if (tool === "read_thread") return textResult({
          turns: [{
            id: "real-turn",
            status: "completed",
            items: [{
              type: "functionCallOutput",
              name: "send_message_to_thread",
              namespace: "codex_app",
              output: {
                text: nativeDelegationEnvelope(SOURCE, "AgentParty body"),
                truncated: false,
              },
            }],
          }],
        });
        const afterCursor = (args.targets as Array<{ afterCursor?: string }>)[0]?.afterCursor;
        return textResult(afterCursor === undefined ? {
          timedOut: true,
          polls: [{ cursor: "cursor-0", thread: { id: TARGET } }],
        } : {
          timedOut: false,
          wake: { reason: "turnCompleted", threadId: TARGET, turnId: "real-turn" },
          polls: [{
            cursor: "cursor-1",
            thread: { id: TARGET, status: { type: "idle" } },
            latestTurn: { id: "real-turn", status: "completed" },
            latestAssistantMessage: { text: "native final", phase: "final_answer" },
          }],
        });
      },
    });
    let beforeWrite = 0;
    const input: CodexBridgeInput = {
      text: "AgentParty body",
      clientUserMessageId: "agentparty:delivery-1",
      beforeWrite: () => { beforeWrite += 1; },
    };
    const completed = new Promise<string>((resolve) => {
      controller.onTurnCompleted((turn) => {
        const final = turn.items?.find((item) => item.type === "agentMessage")?.text;
        resolve(String(final));
      });
    });

    const dispatch = await controller.submit(input);
    expect(dispatch.kind).toBe("started");
    expect(dispatch.turnId).toMatch(/^native-/);
    expect(beforeWrite).toBe(1);
    expect(await completed).toBe("native final");
    expect(calls).toEqual([
      {
        tool: "wait_threads",
        args: {
          targets: [{ threadId: TARGET, hostId: "local" }],
          timeoutMs: 0,
        },
      },
      {
        tool: "send_message_to_thread",
        args: { threadId: TARGET, hostId: "local", prompt: "AgentParty body" },
      },
      {
        tool: "wait_threads",
        args: {
          targets: [{ threadId: TARGET, hostId: "local", afterCursor: "cursor-0" }],
          timeoutMs: 120_000,
        },
      },
      {
        tool: "read_thread",
        args: {
          threadId: TARGET,
          hostId: "local",
          includeOutputs: true,
          maxOutputCharsPerItem: 128_000,
          turnLimit: 4,
        },
      },
    ]);
    expect(controller.turnForClientId(input.clientUserMessageId)?.status).toBe("completed");
  });

  test("duplicate client id returns the original turn without sending twice", async () => {
    let sends = 0;
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      callTool: async (tool, args) => {
        if (tool === "send_message_to_thread") {
          sends += 1;
          return textResult({ threadId: TARGET });
        }
        if (tool === "wait_threads" &&
            (args.targets as Array<{ afterCursor?: string }>)[0]?.afterCursor === undefined) {
          return textResult({ timedOut: true, polls: [{ cursor: "baseline", thread: { id: TARGET } }] });
        }
        return new Promise(() => {});
      },
    });
    const input: CodexBridgeInput = {
      text: "once",
      clientUserMessageId: "agentparty:delivery-duplicate",
    };
    const first = await controller.submit(input);
    const second = await controller.submit(input);
    expect(first.kind).toBe("started");
    expect(second).toEqual({ kind: "duplicate", turnId: first.turnId });
    expect(sends).toBe(1);
    controller.close();
  });

  test("definitive native send failure rolls back the delivery write boundary", async () => {
    let rejected = 0;
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      callTool: async (tool) => {
        if (tool === "wait_threads") {
          return textResult({ timedOut: true, polls: [{ cursor: "baseline", thread: { id: TARGET } }] });
        }
        throw new CodexAppNativeToolError(-32_000, "native rejected");
      },
    });
    await expect(controller.submit({
      text: "will fail",
      clientUserMessageId: "agentparty:delivery-fail",
      onWriteRejected: () => { rejected += 1; },
    })).rejects.toThrow("native rejected");
    expect(rejected).toBe(1);
    expect(controller.turnForClientId("agentparty:delivery-fail")).toBeNull();
  });

  test("post-write transport loss stays uncertain until exact read_thread reconciliation", async () => {
    let sends = 0;
    let rejected = 0;
    const dispatches: string[] = [];
    let releaseFollow!: () => void;
    const followGate = new Promise<void>((resolve) => { releaseFollow = resolve; });
    const controller = new CodexNativeSessionController({
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      callTool: async (tool, args) => {
        if (tool === "send_message_to_thread") {
          sends += 1;
          throw new CodexAppNativeUnknownOutcomeError("lost after broker acceptance");
        }
        if (tool === "read_thread") {
          return textResult({
            turns: [{
              id: "accepted-turn",
              status: "completed",
              items: [{
                type: "functionCallOutput",
                name: "send_message_to_thread",
                namespace: "codex_app",
                output: {
                  text: nativeDelegationEnvelope(SOURCE, "uncertain body"),
                  truncated: false,
                },
              }],
            }],
          });
        }
        const afterCursor = (args.targets as Array<{ afterCursor?: string }>)[0]?.afterCursor;
        if (afterCursor !== undefined) await followGate;
        return textResult(afterCursor === undefined
          ? { timedOut: true, polls: [{ cursor: "before", thread: { id: TARGET } }] }
          : {
              timedOut: false,
              wake: { reason: "turnCompleted", threadId: TARGET, turnId: "accepted-turn" },
              polls: [{
                cursor: "after",
                thread: { id: TARGET },
                latestTurn: { id: "accepted-turn", status: "completed" },
                latestAssistantMessage: { text: "reconciled final" },
              }],
            });
      },
    });
    controller.onDispatch((_input, dispatch) => { dispatches.push(dispatch.kind); });
    const completed = new Promise<string>((resolve) => {
      controller.onTurnCompleted((turn) => {
        resolve(String(turn.items?.find((item) => item.type === "agentMessage")?.text));
      });
    });
    const input: CodexBridgeInput = {
      text: "uncertain body",
      clientUserMessageId: "agentparty:delivery-unknown",
      onWriteRejected: () => { rejected += 1; },
    };
    expect(await controller.submit(input)).toEqual({ kind: "uncertain", reason: "unknown_outcome" });
    expect(await controller.submit(input)).toEqual({ kind: "uncertain", reason: "unknown_outcome" });
    releaseFollow();
    expect(await completed).toBe("reconciled final");
    expect(sends).toBe(1);
    expect(rejected).toBe(0);
    expect(dispatches).toEqual(["uncertain", "started"]);
  });
});
