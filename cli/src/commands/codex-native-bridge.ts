/**
 * AgentParty bridge into a thread already owned by ChatGPT Desktop.
 *
 * Unlike `party bridge codex`, this process does not start a second app-server
 * or TUI. It uses Desktop's first-party codex_app tools, so delivery becomes a
 * native cross-task user message in the existing visible task.
 */
import { CodexAgentPartyBridge } from "../codex-app-server-bridge";
import { CodexNativeSessionController } from "../codex-native-session";
import { connect, type Connection } from "../client";
import {
  loadCursor,
  loadCursorForConfig,
  saveCursor,
  saveCursorForConfig,
} from "../config";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
} from "../delivery-recovery-journal";
import { stripTerminalControls } from "../format";
import {
  acquireInstanceLock,
  defaultInstanceLockDir,
  instanceLockTarget,
  type InstanceLock,
} from "../instance-lock";
import { resolveAuthDetailed } from "../oidc-cli";
import { postMessage } from "../rest";
import { buildRuntimeTopology } from "../runtime-topology";
import {
  CodexDesktopIpcClient,
  validateCodexDesktopIpcRoute,
} from "../codex-desktop-ipc";

export interface CodexNativeBridgeRuntimeOptions {
  channel: string;
  sourceThreadId: string;
  targetThreadId: string;
  hostId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexNativeBridgeRuntimeDeps {
  resolveAuth?: typeof resolveAuthDetailed;
  connectAgentParty?: typeof connect;
  probeIpc?: (options: CodexNativeBridgeRuntimeOptions) => Promise<void>;
  createSession?: (options: CodexNativeBridgeRuntimeOptions) => CodexNativeSessionController;
  log?: (line: string) => void;
  installSignalHandlers?: (
    handler: (signal: "SIGINT" | "SIGTERM") => void,
  ) => () => void;
}

function defaultInstallSignalHandlers(
  handler: (signal: "SIGINT" | "SIGTERM") => void,
): () => void {
  const onInt = () => handler("SIGINT");
  const onTerm = () => handler("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return () => {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  };
}

export async function runCodexNativeBridge(
  options: CodexNativeBridgeRuntimeOptions,
  deps: CodexNativeBridgeRuntimeDeps = {},
): Promise<number> {
  const logSink = deps.log ?? ((line: string) => console.error(line));
  const log = (line: string) => logSink(stripTerminalControls(line));
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = env.AGENTPARTY_CONFIG?.trim() || null;
  let lock: InstanceLock | null = null;
  let connection: Connection | null = null;
  let delivery: CodexAgentPartyBridge | null = null;
  let session: CodexNativeSessionController | null = null;
  let resolveSignal!: (signal: "SIGINT" | "SIGTERM") => void;
  const signalled = new Promise<"SIGINT" | "SIGTERM">((resolve) => {
    resolveSignal = resolve;
  });
  let signalSeen: "SIGINT" | "SIGTERM" | null = null;
  const removeSignals = (deps.installSignalHandlers ?? defaultInstallSignalHandlers)((signal) => {
    if (signalSeen !== null) return;
    signalSeen = signal;
    resolveSignal(signal);
  });

  try {
    const auth = await (deps.resolveAuth ?? resolveAuthDetailed)();
    if (!auth.server || !auth.token) {
      log("codex-native: no config, run party login or party init first");
      return 1;
    }
    // Fail before claiming AgentParty delivery if the private Desktop IPC
    // cannot discover the exact target renderer.
    if (deps.probeIpc !== undefined) {
      await deps.probeIpc(options);
    } else {
      validateCodexDesktopIpcRoute({
        targetThreadId: options.targetThreadId,
        sourceThreadId: options.sourceThreadId,
      }, env);
      const probe = new CodexDesktopIpcClient({ env, clientType: "agentparty-native-preflight" });
      try {
        await probe.connect();
        await probe.discoverThreadOwner(options.targetThreadId, options.hostId ?? "local");
      } finally {
        probe.close();
      }
    }

    lock = acquireInstanceLock(
      "serve",
      instanceLockTarget(auth.server, auth.token, options.channel),
      defaultInstanceLockDir(),
    );
    if (!lock.ok) {
      log(
        `codex-native: another serve/session bridge already owns #${options.channel}` +
          (lock.heldByPid === undefined ? "" : ` (pid=${lock.heldByPid})`),
      );
      return 1;
    }

    session = deps.createSession?.(options) ?? new CodexNativeSessionController({
      sourceThreadId: options.sourceThreadId,
      targetThreadId: options.targetThreadId,
      hostId: options.hostId ?? "local",
      env,
      log,
    });
    connection = (deps.connectAgentParty ?? connect)(
      auth.server,
      auth.token,
      options.channel,
      configPath === null
        ? loadCursor(options.channel, cwd)
        : loadCursorForConfig(options.channel, configPath),
      {
        directedDelivery: "v1",
        deliveryRecovery: "v1",
        advertiseWakeKind: "daemon",
        runtimeTopology: buildRuntimeTopology(auth.server, cwd),
        onCursor: (cursor) => {
          if (configPath === null) saveCursor(options.channel, cursor, cwd);
          else saveCursorForConfig(options.channel, cursor, configPath);
        },
        onStatus: (status) => {
          if (status !== "open") delivery?.handleConnectionStatus(status);
        },
      },
    );
    const recoveryJournal = new DeliveryRecoveryJournal(
      deliveryRecoveryJournalPath("codex", auth.server, auth.token, options.channel),
      options.channel,
      "codex",
    );
    delivery = new CodexAgentPartyBridge({
      channel: options.channel,
      connection,
      session,
      recoveryJournal,
      requireDeliveryRecovery: true,
      postReply: async ({ body, mentions, replyTo, idempotencyKey }) => {
        const posted = await postMessage(auth.server!, auth.token!, options.channel, {
          kind: "message",
          body,
          mentions,
          reply_to: replyTo,
          idempotency_key: idempotencyKey,
        });
        return { seq: posted.seq };
      },
      log,
    });
    log(
      `codex-native: attached #${options.channel} to ChatGPT task ${options.targetThreadId} ` +
        `(source task ${options.sourceThreadId})`,
    );
    const deliveryRun = delivery.run();
    const terminal = await Promise.race([
      deliveryRun.then((code) => ({ type: "delivery" as const, code })),
      signalled.then((signal) => ({
        type: "signal" as const,
        code: signal === "SIGINT" ? 130 : 143,
      })),
    ]);
    if (terminal.type === "signal") {
      log(`codex-native: received ${signalSeen}; shutting down`);
    }
    return terminal.code;
  } finally {
    removeSignals();
    try { delivery?.close(); } catch { /* best effort */ }
    try { connection?.close(); } catch { /* best effort */ }
    try { session?.close(); } catch { /* best effort */ }
    try { lock?.release?.(); } catch { /* best effort */ }
  }
}
