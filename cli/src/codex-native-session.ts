/** AgentParty delivery adapter backed by ChatGPT Desktop's follower IPC. */
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
  CodexDesktopIpcClient,
  CodexDesktopIpcRequestError,
  CodexDesktopIpcUnavailableError,
  CodexDesktopIpcUnknownOutcomeError,
  finalAgentText,
  type CodexDesktopIpcTransport,
  type CodexDesktopTurn,
} from "./codex-desktop-ipc";

export interface CodexNativeSessionOptions {
  sourceThreadId: string;
  targetThreadId: string;
  hostId?: string;
  env?: NodeJS.ProcessEnv;
  ipcFactory?: () => CodexDesktopIpcTransport;
  maxWaitMs?: number;
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
  private readonly uncertainClientIds = new Set<string>();
  private readonly clients = new Set<CodexDesktopIpcTransport>();
  private readonly log: (line: string) => void;
  private lane: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: CodexNativeSessionOptions) {
    this.log = options.log ?? (() => {});
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
    const result = new Promise<CodexDispatch>((res, rej) => { resolve = res; reject = rej; });
    const previous = this.lane;
    this.lane = previous.catch(() => {}).then(async () => {
      try { resolve(await this.submitExclusive(input)); } catch (error) { reject(error); }
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

    const client = this.createClient();
    await client.connect();
    await client.followThread(this.options.targetThreadId, this.options.hostId ?? "local");
    await input.beforeWrite?.();
    input.checkWriteAuthorized?.();

    let accepted: { turnId: string };
    try {
      accepted = await client.startDelegatedTurn({
        targetThreadId: this.options.targetThreadId,
        sourceThreadId: this.options.sourceThreadId,
        prompt: input.text,
        clientUserMessageId: input.clientUserMessageId,
        hostId: this.options.hostId ?? "local",
      });
    } catch (error) {
      if (error instanceof CodexDesktopIpcUnknownOutcomeError) {
        this.uncertainClientIds.add(input.clientUserMessageId);
        const dispatch: CodexDispatch = { kind: "uncertain", reason: "unknown_outcome" };
        for (const listener of this.dispatchListeners) await listener(input, dispatch);
        void this.followCompletion(input, undefined, client, true).catch(async (followError) => {
          this.log(`codex-native: unknown IPC delivery remains unresolved: ${errorText(followError)}`);
          await this.emitUnresolvedUnknown(input);
        });
        return dispatch;
      }
      client.close();
      this.clients.delete(client);
      await input.onWriteRejected?.();
      throw error;
    }

    const turn = inProgressTurn(input, accepted.turnId);
    this.turnsByClientId.set(input.clientUserMessageId, turn);
    const dispatch: CodexDispatch = { kind: "started", turnId: accepted.turnId };
    for (const listener of this.dispatchListeners) await listener(input, dispatch);
    void this.followCompletion(input, accepted.turnId, client, false).catch(async (error) => {
      this.log(`codex-native: IPC completion follow failed; preserving late reply: ${errorText(error)}`);
      await this.emitUnresolvedUnknown(input);
    });
    return dispatch;
  }

  private async followCompletion(
    input: CodexBridgeInput,
    turnId: string | undefined,
    initialClient: CodexDesktopIpcTransport,
    uncertain: boolean,
  ): Promise<void> {
    const deadline = Date.now() + (this.options.maxWaitMs ?? 30 * 60_000);
    let client = initialClient;
    for (;;) {
      if (this.closed) return;
      try {
        const ipcTurn = await client.waitForDelegation({
          targetThreadId: this.options.targetThreadId,
          sourceThreadId: this.options.sourceThreadId,
          prompt: input.text,
          clientUserMessageId: input.clientUserMessageId,
          ...(turnId === undefined ? {} : { turnId }),
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        turnId = ipcTurn.turnId;
        if (uncertain) {
          this.uncertainClientIds.delete(input.clientUserMessageId);
          this.turnsByClientId.set(input.clientUserMessageId, inProgressTurn(input, turnId));
          const dispatch: CodexDispatch = { kind: "started", turnId };
          for (const listener of this.dispatchListeners) await listener(input, dispatch);
          uncertain = false;
        }
        this.complete(input.clientUserMessageId, completedTurn(ipcTurn));
        client.close();
        this.clients.delete(client);
        return;
      } catch (error) {
        client.close();
        this.clients.delete(client);
        if (Date.now() >= deadline || error instanceof CodexDesktopIpcRequestError) throw error;
        if (
          !(error instanceof CodexDesktopIpcUnavailableError) &&
          !(error instanceof CodexDesktopIpcUnknownOutcomeError)
        ) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
        client = this.createClient();
        await client.connect();
        await client.followThread(this.options.targetThreadId, this.options.hostId ?? "local");
      }
    }
  }

  private createClient(): CodexDesktopIpcTransport {
    const client = this.options.ipcFactory?.() ?? new CodexDesktopIpcClient({ env: this.options.env });
    this.clients.add(client);
    return client;
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
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}

function inProgressTurn(input: CodexBridgeInput, turnId: string): CodexTurn {
  return {
    id: turnId,
    status: "inProgress",
    items: [{ type: "userMessage", clientId: input.clientUserMessageId, text: input.text }],
  };
}

function completedTurn(turn: CodexDesktopTurn): CodexTurn {
  if (turn.status === "completed") {
    const text = finalAgentText(turn);
    if (text !== null) {
      return {
        id: turn.turnId,
        status: "completed",
        items: [{ id: `ipc-final-${randomUUID()}`, type: "agentMessage", phase: "final_answer", text }],
      };
    }
  }
  return {
    id: turn.turnId,
    status: turn.status === "interrupted" ? "interrupted" : "failed",
    items: [],
  };
}
