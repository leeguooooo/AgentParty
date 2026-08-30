/**
 * CodexAgentPartyBridge session adapter backed by ChatGPT Desktop's native
 * codex_app tools. It sends into the app-server already owned by Desktop,
 * then follows the target thread with wait_threads and positively reconciles
 * the exact delegation through read_thread before persisting a linked reply.
 */
import { randomUUID } from "node:crypto";
import type {
  CodexAgentPartySession,
  CodexTurn,
  CompletedTurnListener,
  DispatchListener,
  SessionMutationGuard,
  ThreadSwitchGuard,
  UnresolvedUnknownListener,
} from "./codex-app-server-bridge";
import type { CodexBridgeInput, CodexDispatch } from "./codex-turn-arbiter";
import {
  callCodexAppNativeTool,
  CodexAppNativeToolError,
  CodexAppNativeUnknownOutcomeError,
  isNativeSendThreadResult,
  isNativeReadThreadResult,
  isNativeWaitThreadResult,
  nativeReadThreadMatchesDelegation,
  nativeToolTextJson,
  resolveCodexAppNativeRuntime,
  type CodexAppNativeToolResult,
} from "./codex-app-native";

export type CodexNativeToolCall = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<CodexAppNativeToolResult>;

export interface CodexNativeSessionOptions {
  sourceThreadId: string;
  targetThreadId: string;
  hostId?: string;
  env?: NodeJS.ProcessEnv;
  callTool?: CodexNativeToolCall;
  maxWaitMs?: number;
  waitSliceMs?: number;
  log?: (line: string) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function noOpSubscription(): () => void {
  return () => {};
}

export class CodexNativeSessionController implements CodexAgentPartySession {
  private readonly dispatchListeners = new Set<DispatchListener>();
  private readonly completedListeners = new Set<CompletedTurnListener>();
  private readonly unresolvedUnknownListeners = new Set<UnresolvedUnknownListener>();
  private readonly turnsByClientId = new Map<string, CodexTurn>();
  private readonly turnIdsByClientId = new Map<string, string>();
  private readonly uncertainClientIds = new Set<string>();
  private readonly callTool: CodexNativeToolCall;
  private readonly log: (line: string) => void;
  private lane: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: CodexNativeSessionOptions) {
    this.log = options.log ?? (() => {});
    this.callTool = options.callTool ?? (async (tool, args, signal) => {
      const runtime = resolveCodexAppNativeRuntime(
        options.targetThreadId,
        options.env ?? process.env,
      );
      return callCodexAppNativeTool(
        {
          runtime,
          sourceThreadId: options.sourceThreadId,
          tool,
          arguments: args,
        },
        { signal },
      );
    });
  }

  get activeThreadId(): string {
    return this.options.targetThreadId;
  }

  onDispatch(listener: DispatchListener): () => void {
    this.dispatchListeners.add(listener);
    return () => this.dispatchListeners.delete(listener);
  }

  onTurnCompleted(listener: CompletedTurnListener): () => void {
    this.completedListeners.add(listener);
    return () => this.completedListeners.delete(listener);
  }

  onThreadSwitch(_listener: ThreadSwitchGuard): () => void {
    return noOpSubscription();
  }

  onSessionMutation(_listener: SessionMutationGuard): () => void {
    return noOpSubscription();
  }

  onUnresolvedUnknown(listener: UnresolvedUnknownListener): () => void {
    this.unresolvedUnknownListeners.add(listener);
    return () => this.unresolvedUnknownListeners.delete(listener);
  }

  async abandonUnknownOutcome(
    _threadId: string,
    input: CodexBridgeInput,
  ): Promise<CodexDispatch> {
    const turn = this.turnForClientId(input.clientUserMessageId);
    return turn === null
      ? { kind: "uncertain", reason: "unknown_outcome" }
      : { kind: "duplicate", turnId: turn.id };
  }

  async cancelQueued(_clientUserMessageId: string): Promise<boolean> {
    return false;
  }

  turnForClientId(clientId: string): CodexTurn | null {
    return this.turnsByClientId.get(clientId) ?? null;
  }

  async submit(input: CodexBridgeInput): Promise<CodexDispatch> {
    let resolve!: (value: CodexDispatch) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<CodexDispatch>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const previous = this.lane;
    this.lane = previous
      .catch(() => {})
      .then(async () => {
        try {
          resolve(await this.submitExclusive(input));
        } catch (error) {
          reject(error);
        }
      });
    return result;
  }

  private async submitExclusive(input: CodexBridgeInput): Promise<CodexDispatch> {
    if (this.closed) throw new Error(`Native Codex session controller is closed`);
    const existing = this.turnForClientId(input.clientUserMessageId);
    if (existing !== null) return { kind: "duplicate", turnId: existing.id };
    if (this.uncertainClientIds.has(input.clientUserMessageId)) {
      return { kind: "uncertain", reason: "unknown_outcome" };
    }

    // Capture an exact pre-send cursor before crossing the delivery WAL write
    // boundary. A prior completed turn must never be mistaken for this send.
    const baselineCursor = await this.captureBaselineCursor();
    await input.beforeWrite?.();
    input.checkWriteAuthorized?.();
    let sent: { threadId: string };
    try {
      const raw = await this.callTool(
          "send_message_to_thread",
          {
            threadId: this.options.targetThreadId,
            hostId: this.options.hostId ?? "local",
            prompt: input.text,
          },
        );
      try {
        sent = nativeToolTextJson(raw, isNativeSendThreadResult);
      } catch (error) {
        if (error instanceof CodexAppNativeToolError) throw error;
        throw new CodexAppNativeUnknownOutcomeError(
          `ChatGPT native send returned an unprovable success result: ${errorText(error)}`,
        );
      }
    } catch (error) {
      if (error instanceof CodexAppNativeUnknownOutcomeError) {
        this.uncertainClientIds.add(input.clientUserMessageId);
        const syntheticTurnId = `native-${randomUUID()}`;
        const dispatch: CodexDispatch = { kind: "uncertain", reason: "unknown_outcome" };
        for (const listener of this.dispatchListeners) await listener(input, dispatch);
        void this.followCompletion(
          input,
          syntheticTurnId,
          baselineCursor,
          true,
        ).catch((followError) => {
          this.log(`codex-native: unknown completion follow failed: ${errorText(followError)}`);
          void this.emitUnresolvedUnknown(input);
        });
        return dispatch;
      }
      await input.onWriteRejected?.();
      throw error;
    }
    if (sent.threadId !== this.options.targetThreadId) {
      const error = new CodexAppNativeUnknownOutcomeError(
        `ChatGPT native send targeted ${sent.threadId}, expected ${this.options.targetThreadId}`,
      );
      const syntheticTurnId = `native-${randomUUID()}`;
      this.uncertainClientIds.add(input.clientUserMessageId);
      const dispatch: CodexDispatch = { kind: "uncertain", reason: "unknown_outcome" };
      for (const listener of this.dispatchListeners) await listener(input, dispatch);
      void this.followCompletion(input, syntheticTurnId, baselineCursor, true).catch(() => {
        this.log(`codex-native: mismatched-target send remains unknown: ${error.message}`);
        void this.emitUnresolvedUnknown(input);
      });
      return dispatch;
    }

    const syntheticTurnId = `native-${randomUUID()}`;
    const turn = this.inProgressTurn(input, syntheticTurnId);
    this.turnsByClientId.set(input.clientUserMessageId, turn);
    this.turnIdsByClientId.set(input.clientUserMessageId, syntheticTurnId);
    const dispatch: CodexDispatch = { kind: "started", turnId: syntheticTurnId };
    for (const listener of this.dispatchListeners) {
      await listener(input, dispatch);
    }
    void this.followCompletion(input, syntheticTurnId, baselineCursor, false).catch((error) => {
      this.log(`codex-native: completion follow failed; preserving late reply: ${errorText(error)}`);
      void this.emitUnresolvedUnknown(input);
    });
    return dispatch;
  }

  private inProgressTurn(input: CodexBridgeInput, syntheticTurnId: string): CodexTurn {
    return {
      id: syntheticTurnId,
      status: "inProgress",
      items: [{
        type: "userMessage",
        clientId: input.clientUserMessageId,
        text: input.text,
      }],
    };
  }

  private async captureBaselineCursor(): Promise<string> {
    const snapshot = nativeToolTextJson(
      await this.callTool("wait_threads", {
        targets: [{
          threadId: this.options.targetThreadId,
          hostId: this.options.hostId ?? "local",
        }],
        timeoutMs: 0,
      }),
      isNativeWaitThreadResult,
    );
    const poll = snapshot.polls.find(
      (entry) => entry.thread?.id === this.options.targetThreadId,
    ) ?? snapshot.polls[0];
    if (typeof poll?.cursor !== "string" || poll.cursor === "") {
      throw new Error(
        `ChatGPT native wait returned no baseline cursor for ${this.options.targetThreadId}`,
      );
    }
    return poll.cursor;
  }

  private async followCompletion(
    input: CodexBridgeInput,
    syntheticTurnId: string,
    baselineCursor: string,
    uncertain: boolean,
  ): Promise<void> {
    const maxWaitMs = this.options.maxWaitMs ?? 30 * 60_000;
    const waitSliceMs = Math.min(120_000, this.options.waitSliceMs ?? 120_000);
    const deadline = Date.now() + maxWaitMs;
    let cursor = baselineCursor;
    while (!this.closed && Date.now() < deadline) {
      let wait;
      try {
        wait = nativeToolTextJson(
          await this.callTool("wait_threads", {
            targets: [{
              threadId: this.options.targetThreadId,
              hostId: this.options.hostId ?? "local",
              afterCursor: cursor,
            }],
            timeoutMs: waitSliceMs,
          }),
          isNativeWaitThreadResult,
        );
      } catch (error) {
        this.log(`codex-native: wait_threads retry after error: ${errorText(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const poll = wait.polls.find(
        (entry) => entry.thread?.id === this.options.targetThreadId,
      ) ?? wait.polls[0];
      const nextCursor = typeof poll?.cursor === "string" && poll.cursor !== ""
        ? poll.cursor
        : cursor;
      const actualTurnId = poll?.latestTurn?.id;
      if (nextCursor === cursor || typeof actualTurnId !== "string") {
        continue;
      }
      const reconciliation = await this.reconcilesExactDelegation(actualTurnId, input.text);
      if (reconciliation !== true) {
        // A definitive mismatch belongs to another user/bridge turn and can be
        // skipped. A read failure is inconclusive, so retry the same cursor.
        if (reconciliation === false) cursor = nextCursor;
        continue;
      }
      cursor = nextCursor;
      if (uncertain) {
        this.uncertainClientIds.delete(input.clientUserMessageId);
        const turn = this.inProgressTurn(input, syntheticTurnId);
        this.turnsByClientId.set(input.clientUserMessageId, turn);
        this.turnIdsByClientId.set(input.clientUserMessageId, syntheticTurnId);
        const accepted: CodexDispatch = { kind: "started", turnId: syntheticTurnId };
        for (const listener of this.dispatchListeners) await listener(input, accepted);
        uncertain = false;
      }
      const status = poll?.latestTurn?.status;
      if (status === "completed") {
        const text = poll.latestAssistantMessage?.text?.trim() ?? "";
        if (text === "") {
          this.complete(input.clientUserMessageId, { id: syntheticTurnId, status: "failed", items: [] });
        } else {
          this.complete(input.clientUserMessageId, {
            id: syntheticTurnId,
            status: "completed",
            items: [
              {
                id: `native-final-${randomUUID()}`,
                type: "agentMessage",
                phase: "final_answer",
                text,
              },
            ],
          });
        }
        return;
      }
      if (status === "failed" || status === "interrupted") {
        this.complete(input.clientUserMessageId, {
          id: syntheticTurnId,
          status: status === "failed" ? "failed" : "interrupted",
          items: [],
        });
        return;
      }
      if (!wait.timedOut && wait.wake?.reason === "needsAttention") {
        this.complete(input.clientUserMessageId, {
          id: syntheticTurnId,
          status: "completed",
          items: [
            {
              id: `native-attention-${randomUUID()}`,
              type: "agentMessage",
              phase: "final_answer",
              text:
                `Codex task ${this.options.targetThreadId} needs user attention before it can finish. ` +
                `Open that task in ChatGPT to continue.`,
            },
          ],
        });
        return;
      }
    }
    throw new Error(
      `Timed out waiting for native Codex thread ${this.options.targetThreadId}`,
    );
  }

  private async reconcilesExactDelegation(turnId: string, prompt: string): Promise<boolean | null> {
    try {
      const read = nativeToolTextJson(
        await this.callTool("read_thread", {
          threadId: this.options.targetThreadId,
          hostId: this.options.hostId ?? "local",
          includeOutputs: true,
          maxOutputCharsPerItem: 128_000,
          turnLimit: 4,
        }),
        isNativeReadThreadResult,
      );
      return nativeReadThreadMatchesDelegation(read, {
        turnId,
        sourceThreadId: this.options.sourceThreadId,
        prompt,
      });
    } catch (error) {
      this.log(`codex-native: read_thread reconciliation retry after error: ${errorText(error)}`);
      return null;
    }
  }

  private async emitUnresolvedUnknown(input: CodexBridgeInput): Promise<void> {
    for (const listener of this.unresolvedUnknownListeners) {
      await listener({ threadId: this.options.targetThreadId, input });
    }
  }

  private complete(clientId: string, turn: CodexTurn): void {
    if (this.closed) return;
    this.turnsByClientId.set(clientId, turn);
    for (const listener of this.completedListeners) {
      void Promise.resolve(listener(turn)).catch((error) => {
        this.log(`codex-native: completion listener failed: ${errorText(error)}`);
      });
    }
  }

  close(): void {
    this.closed = true;
    this.uncertainClientIds.clear();
  }
}
