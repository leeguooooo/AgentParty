import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyBusyChannelWelcome,
  busyChannelModelCallState,
  busyChannelCleanupRequired,
  cleanupBusyChannelSource,
  inspectBusyChannelToolChain,
  inspectBusyChannelPreflight,
  parseBusyChannelArguments,
  probeBusyChannelProtocol,
  recoverBusyChannelSourceSeq,
  runBusyClaudeChannelAcceptance,
} from "./verify-agentparty-claude-channel";
import type { ClaudePluginShellInspection } from "../cli/src/commands/doctor";
import type { MsgFrame } from "../shared/src/protocol";

const sessionId = "44444444-4444-4444-8444-444444444444";
const prefix = "mcp__plugin_agentparty_agentparty-channel__";
const executionId = "55555555-5555-4555-8555-555555555555";
const receipt = "66666666-6666-4666-8666-666666666666";
const sourceMarker = "AGENTPARTY_BUSY_CHANNEL_fixture";
const replyMarker = "AGENTPARTY_BUSY_CHANNEL_REPLY_fixture";

const sourceFrame = (overrides: Partial<MsgFrame> = {}): MsgFrame => ({
  type: "msg",
  seq: 41,
  sender: { name: "sender", kind: "agent" },
  kind: "message",
  body: sourceMarker,
  mentions: ["receiver"],
  reply_to: null,
  state: null,
  note: null,
  status: null,
  ts: Date.now(),
  ...overrides,
});

const readyLifecycle = (): ClaudePluginShellInspection => ({
  status: "ready",
  blockers: [],
  runtime_version: "0.2.182",
  claude_version: "2.1.232 (Claude Code)",
  plugin: {
    installed: true,
    enabled: true,
    version: "0.2.182",
    bundle_valid: true,
    launcher_executable: true,
  },
  model_calls_started: false,
});

const event = (value: Record<string, unknown>) => JSON.stringify({ ...value, session_id: sessionId });
const use = (name: string, id: string, input: Record<string, unknown>) => event({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, id, input }] },
});
const result = (id: string, content: string, isError = false) => event({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: id,
      content,
      ...(isError ? { is_error: true } : {}),
    }],
  },
});

function validStream(): string[] {
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools: [
        "Bash",
        `${prefix}party_channel_claim`,
        `${prefix}party_channel_accept`,
        `${prefix}party_channel_reply`,
      ],
    }),
    use("Bash", "bash", {}),
    result("bash", "released"),
    use(`${prefix}party_channel_claim`, "claim", { execution_id: executionId }),
    result(
      "claim",
      `Claimed execution_id=${executionId} and claim_receipt=${receipt}.\n\n${sourceMarker}`,
    ),
    use(`${prefix}party_channel_accept`, "accept", {
      execution_id: executionId,
      claim_receipt: receipt,
    }),
    result("accept", "durably accepted"),
    use(`${prefix}party_channel_reply`, "reply", { seq: 41, text: replyMarker }),
    result("reply", "AgentParty reply persisted as seq=42 (reply_to=41)."),
  ];
}

describe("busy Marketplace Channel acceptance", () => {
  test("parses explicit two-agent config arguments without accepting token argv", () => {
    expect(parseBusyChannelArguments([
      "--channel", "dev",
      "--receiver-config", "/receiver.json",
      "--sender-config", "/sender.json",
      "--receiver-cwd", "/repo",
      "--preflight-only",
    ])).toEqual({
      channel: "dev",
      receiverConfigPath: "/receiver.json",
      senderConfigPath: "/sender.json",
      receiverCwd: "/repo",
      preflightOnly: true,
      live: false,
      keepArtifacts: false,
    });
    expect(() => parseBusyChannelArguments([])).toThrow("invalid_arguments");
    expect(() => parseBusyChannelArguments([
      "--channel", "INVALID",
      "--receiver-config", "a",
      "--sender-config", "b",
    ])).toThrow("invalid_channel");
    expect(() => parseBusyChannelArguments([
      "--channel", "dev",
      "--channel", "other",
      "--receiver-config", "a",
      "--sender-config", "b",
    ])).toThrow("invalid_arguments");
    expect(() => parseBusyChannelArguments([
      "--channel", "dev",
      "--receiver-config", "a",
      "--sender-config", "b",
      "--token", "secret",
    ])).toThrow("invalid_arguments");
    expect(() => parseBusyChannelArguments([
      "--channel", "dev",
      "--receiver-config", "a",
      "--sender-config", "b",
    ])).toThrow("invalid_arguments");
    expect(() => parseBusyChannelArguments([
      "--channel", "dev",
      "--receiver-config", "a",
      "--sender-config", "b",
      "--preflight-only",
      "--live",
    ])).toThrow("invalid_arguments");
    expect(parseBusyChannelArguments([
      "--channel", "dev",
      "--receiver-config", "a",
      "--sender-config", "b",
      "--live",
    ])).toMatchObject({ preflightOnly: false, live: true });
  });

  test("runs a complete two-config preflight to ready without model or Channel writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentparty-busy-preflight-test-"));
    chmodSync(root, 0o700);
    const receiverConfig = join(root, "receiver.json");
    const senderConfig = join(root, "sender.json");
    writeFileSync(receiverConfig, JSON.stringify({
      server: "https://agentparty.example",
      token: "receiver-token",
    }), { mode: 0o600 });
    writeFileSync(senderConfig, JSON.stringify({
      server: "https://agentparty.example",
      token: "sender-token",
    }), { mode: 0o600 });
    const outputs: string[] = [];
    const oldLog = console.log;
    console.log = (...args: unknown[]) => outputs.push(args.map(String).join(" "));
    try {
      const options = {
        workspacePath: root,
        selfCommand: { command: "must-not-spawn", args: [] },
        probeClaudeVersion: async () => ({ stdout: "2.1.232 (Claude Code)\n", stderr: "", code: 0 }),
        probeClaudeAuth: async () => ({
          stdout: JSON.stringify({ loggedIn: true, apiProvider: "firstParty" }),
          stderr: "",
          code: 0,
        }),
        probePluginLifecycle: async () => readyLifecycle(),
        probeChannelProtocol: async () => "confirmed" as const,
        loadIdentity: async (_server: string, token: string) => ({
          name: token === "receiver-token" ? "receiver" : "sender",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "owner",
          channel_scope: "dev",
        }),
        loadPresence: async () => [],
      };
      expect(await runBusyClaudeChannelAcceptance([
        "--channel", "dev",
        "--receiver-config", receiverConfig,
        "--sender-config", senderConfig,
        "--receiver-cwd", root,
        "--preflight-only",
      ], options)).toBe(0);
      const ready = JSON.parse(outputs.pop()!) as Record<string, unknown>;
      expect(ready).toMatchObject({
        schema: "agentparty.claude-channel-busy-preflight.v1",
        status: "ready",
        blockers: [],
        receiver_agent: "receiver",
        sender_agent: "sender",
        channel_protocol: "confirmed",
        model_calls_started: false,
        channel_writes_started: false,
        delivery_verified: false,
      });
      expect(JSON.stringify(ready)).not.toContain("receiver-token");
      expect(JSON.stringify(ready)).not.toContain(root);

      expect(await runBusyClaudeChannelAcceptance([
        "--channel", "dev",
        "--receiver-config", receiverConfig,
        "--sender-config", senderConfig,
        "--receiver-cwd", root,
        "--preflight-only",
      ], {
        ...options,
        loadIdentity: async (_server: string, token: string) => {
          if (token === "sender-token") throw new Error("revoked private token detail");
          return options.loadIdentity(_server, token);
        },
        loadPresence: async (_server: string, token: string) => {
          if (token === "sender-token") throw new Error("private channel detail");
          return [];
        },
      })).toBe(8);
      const blocked = JSON.parse(outputs.pop()!) as Record<string, unknown>;
      expect(blocked).toMatchObject({
        status: "agentparty_unavailable",
        blockers: ["sender_identity_invalid", "sender_channel_unavailable"],
        model_calls_started: false,
        channel_writes_started: false,
        delivery_verified: false,
      });
      expect(JSON.stringify(blocked)).not.toContain("revoked private token detail");
      expect(JSON.stringify(blocked)).not.toContain("private channel detail");
    } finally {
      console.log = oldLog;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aggregates every preflight blocker and never represents a failed gate as model-started", () => {
    const ready = inspectBusyChannelPreflight({
      channel: "dev",
      serverOrigin: "https://agentparty.example",
      parsedVersion: [2, 1, 232],
      rawClaudeVersion: "2.1.232 (Claude Code)",
      claudeLoggedIn: true,
      lifecycle: readyLifecycle(),
      receiverAgent: "receiver",
      senderAgent: "sender",
      receiverChannelAccess: true,
      senderChannelAccess: true,
      receiverListenerActive: false,
      channelProtocol: "confirmed",
    });
    expect(ready.exitCode).toBe(0);
    expect(ready.report).toMatchObject({
      status: "ready",
      blockers: [],
      receiver_identity: "confirmed",
      sender_identity: "confirmed",
      receiver_channel_access: "confirmed",
      sender_channel_access: "confirmed",
      model_calls_started: false,
      channel_writes_started: false,
      delivery_verified: false,
    });

    const missingLifecycle = readyLifecycle();
    missingLifecycle.status = "plugin_missing";
    missingLifecycle.blockers = ["plugin_missing"];
    missingLifecycle.plugin = {
      installed: false,
      enabled: false,
      bundle_valid: false,
      launcher_executable: false,
    };
    const blocked = inspectBusyChannelPreflight({
      channel: "dev",
      serverOrigin: "https://agentparty.example",
      parsedVersion: [2, 1, 79],
      rawClaudeVersion: "2.1.79 (Claude Code)",
      claudeLoggedIn: false,
      lifecycle: missingLifecycle,
      receiverAgent: null,
      senderAgent: "sender",
      receiverChannelAccess: false,
      senderChannelAccess: false,
      receiverListenerActive: true,
      channelProtocol: "confirmed",
    });
    expect(blocked.exitCode).toBe(11);
    expect(blocked.report).toMatchObject({
      status: "plugin_lifecycle_unavailable",
      blockers: [
        "claude_version_unsupported",
        "claude_auth_required",
        "plugin_missing",
        "receiver_identity_invalid",
        "receiver_channel_unavailable",
        "sender_channel_unavailable",
        "receiver_listener_already_active",
      ],
      model_calls_started: false,
      channel_writes_started: false,
      delivery_verified: false,
    });

    const agentPartyBlocked = inspectBusyChannelPreflight({
      channel: "dev",
      serverOrigin: "https://agentparty.example",
      parsedVersion: [2, 1, 232],
      rawClaudeVersion: "2.1.232 (Claude Code)",
      claudeLoggedIn: true,
      lifecycle: readyLifecycle(),
      receiverAgent: "same-agent",
      senderAgent: "same-agent",
      receiverChannelAccess: true,
      senderChannelAccess: true,
      receiverListenerActive: true,
      channelProtocol: "confirmed",
    });
    expect(agentPartyBlocked.exitCode).toBe(8);
    expect(agentPartyBlocked.report).toMatchObject({
      status: "agentparty_unavailable",
      blockers: ["agent_identity_conflict", "receiver_listener_already_active"],
      model_calls_started: false,
    });

    const authBlocked = inspectBusyChannelPreflight({
      channel: "dev",
      serverOrigin: "https://agentparty.example",
      parsedVersion: [2, 1, 232],
      rawClaudeVersion: "2.1.232 (Claude Code)",
      claudeLoggedIn: false,
      lifecycle: readyLifecycle(),
      receiverAgent: "receiver",
      senderAgent: "sender",
      receiverChannelAccess: true,
      senderChannelAccess: true,
      receiverListenerActive: false,
      channelProtocol: "confirmed",
    });
    expect(authBlocked).toMatchObject({
      exitCode: 2,
      report: { status: "claude_auth_required", model_calls_started: false },
    });

    const versionBlocked = inspectBusyChannelPreflight({
      channel: "dev",
      serverOrigin: "https://agentparty.example",
      parsedVersion: [2, 1, 79],
      rawClaudeVersion: "2.1.79 (Claude Code)",
      claudeLoggedIn: true,
      lifecycle: readyLifecycle(),
      receiverAgent: "receiver",
      senderAgent: "sender",
      receiverChannelAccess: true,
      senderChannelAccess: true,
      receiverListenerActive: false,
      channelProtocol: "confirmed",
    });
    expect(versionBlocked).toMatchObject({
      exitCode: 10,
      report: { status: "environment_unavailable", model_calls_started: false },
    });

    const workerBlocked = inspectBusyChannelPreflight({
      channel: "dev",
      serverOrigin: "https://agentparty.example",
      parsedVersion: [2, 1, 232],
      rawClaudeVersion: "2.1.232 (Claude Code)",
      claudeLoggedIn: true,
      lifecycle: readyLifecycle(),
      receiverAgent: "receiver",
      senderAgent: "sender",
      receiverChannelAccess: true,
      senderChannelAccess: true,
      receiverListenerActive: false,
      channelProtocol: "worker_upgrade_required",
    });
    expect(workerBlocked).toMatchObject({
      exitCode: 3,
      report: {
        status: "worker_upgrade_required",
        blockers: ["worker_upgrade_required"],
        channel_protocol: "worker_upgrade_required",
        model_calls_started: false,
      },
    });
  });

  test("accepts only a welcome advertising both durable delivery capabilities", async () => {
    const welcome = {
      type: "welcome" as const,
      channel: "dev",
      self: "receiver",
      participants: [],
      last_seq: 0,
      directed_delivery: "v1" as const,
      delivery_recovery: "v1" as const,
      presence: [],
    };
    expect(classifyBusyChannelWelcome(welcome)).toBe("confirmed");
    expect(classifyBusyChannelWelcome({ ...welcome, delivery_recovery: undefined }))
      .toBe("worker_upgrade_required");
    expect(classifyBusyChannelWelcome({ type: "pong" })).toBe("unavailable");

    let sends = 0;
    let acks = 0;
    let closes = 0;
    expect(await probeBusyChannelProtocol(
      "https://agentparty.example",
      "token",
      "dev",
      () => ({
        frames: (async function* () {
          yield welcome;
        })(),
        send: () => {
          sends += 1;
          return true;
        },
        ack: () => {
          acks += 1;
        },
        close: () => {
          closes += 1;
        },
        pendingFrames: () => [],
        replayUnacked: () => 0,
        cursor: 0,
        revCursor: 0,
      }),
    )).toBe("confirmed");
    expect({ sends, acks, closes }).toEqual({ sends: 0, acks: 0, closes: 1 });
  });

  test("does not equate spawning the outer launcher with a proven model call", () => {
    expect(busyChannelModelCallState(null)).toBe(false);
    expect(busyChannelModelCallState({ stdout: ["launcher failed before Claude"] })).toBe("unknown");
    expect(busyChannelModelCallState({ stdout: validStream() })).toBe(true);
    expect(busyChannelModelCallState({
      stdout: [
        ...validStream(),
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "77777777-7777-4777-8777-777777777777",
        }),
      ],
    })).toBe("unknown");
  });

  test("recovers a lost source POST response and verifies terminal retract cleanup", async () => {
    expect([
      busyChannelCleanupRequired("not_needed"),
      busyChannelCleanupRequired("retracted"),
      busyChannelCleanupRequired("not_found_or_unconfirmed"),
      busyChannelCleanupRequired("failed"),
    ]).toEqual([false, false, true, true]);
    expect(await recoverBusyChannelSourceSeq(
      "https://agentparty.example",
      "sender-token",
      "dev",
      "sender",
      sourceMarker,
      async () => [sourceFrame()],
      0,
    )).toBe(41);
    expect(await recoverBusyChannelSourceSeq(
      "https://agentparty.example",
      "sender-token",
      "dev",
      "sender",
      sourceMarker,
      async () => [sourceFrame(), sourceFrame({ seq: 42 })],
      0,
    )).toBeNull();
    expect(await recoverBusyChannelSourceSeq(
      "https://agentparty.example",
      "sender-token",
      "dev",
      "sender",
      sourceMarker,
      async () => [sourceFrame({ sender: { name: "other", kind: "agent" } })],
      0,
    )).toBeNull();

    let recoveryReads = 0;
    expect(await recoverBusyChannelSourceSeq(
      "https://agentparty.example",
      "sender-token",
      "dev",
      "sender",
      sourceMarker,
      async () => {
        recoveryReads += 1;
        if (recoveryReads === 1) return [];
        if (recoveryReads === 2) throw new Error("history temporarily unavailable");
        return [sourceFrame()];
      },
      1_000,
      async () => {},
    )).toBe(41);
    expect(recoveryReads).toBe(3);

    expect(await cleanupBusyChannelSource(
      "https://agentparty.example",
      "sender-token",
      "dev",
      null,
    )).toBe("not_found_or_unconfirmed");
    expect(await cleanupBusyChannelSource(
      "https://agentparty.example",
      "sender-token",
      "dev",
      41,
      async () => ({
        message: sourceFrame({
          body: "[retracted]",
          mentions: [],
          retracted: true,
          retracted_at: Date.now(),
          retracted_by: "sender",
        }),
      }),
    )).toBe("retracted");

    let attempts = 0;
    expect(await cleanupBusyChannelSource(
      "https://agentparty.example",
      "sender-token",
      "dev",
      41,
      async () => {
        attempts += 1;
        throw new Error("lost retract response");
      },
      async () => [sourceFrame({
        body: "[retracted]",
        mentions: [],
        retracted: true,
        retracted_at: Date.now(),
        retracted_by: "sender",
      })],
    )).toBe("retracted");
    expect(attempts).toBe(1);

    expect(await cleanupBusyChannelSource(
      "https://agentparty.example",
      "sender-token",
      "dev",
      41,
      async () => ({ message: sourceFrame() }),
    )).toBe("failed");
  });

  test("requires one exact plugin-scoped claim -> accept -> linked reply chain", () => {
    expect(inspectBusyChannelToolChain(validStream(), 41, 42, replyMarker, sourceMarker)).toBe(true);

    const wrongReceipt = validStream().map((line) => line.replace(
      `claim_receipt\":\"${receipt}`,
      "claim_receipt\":\"77777777-7777-4777-8777-777777777777",
    ));
    expect(inspectBusyChannelToolChain(wrongReceipt, 41, 42, replyMarker, sourceMarker)).toBe(false);
    expect(inspectBusyChannelToolChain(validStream(), 99, 42, replyMarker, sourceMarker)).toBe(false);
    expect(inspectBusyChannelToolChain(validStream(), 41, 99, replyMarker, sourceMarker)).toBe(false);
    expect(inspectBusyChannelToolChain(validStream(), 41, 42, "wrong reply", sourceMarker)).toBe(false);

    const lookalike = validStream().map((line) => line.replaceAll(prefix, "mcp__lookalike__"));
    expect(inspectBusyChannelToolChain(lookalike, 41, 42, replyMarker, sourceMarker)).toBe(false);

    const extra = [...validStream(), use("Read", "extra", {})];
    expect(inspectBusyChannelToolChain(extra, 41, 42, replyMarker, sourceMarker)).toBe(false);

    const error = validStream().map((line) => line.includes('"tool_use_id":"reply"')
      ? line.replace('"content":"AgentParty', '"is_error":true,"content":"AgentParty')
      : line);
    expect(inspectBusyChannelToolChain(error, 41, 42, replyMarker, sourceMarker)).toBe(false);
  });
});
