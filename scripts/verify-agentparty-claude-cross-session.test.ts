import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bridgeLaunchAddress,
  bridgeCommand,
  buildIntegrationAcceptanceFailure,
  classifyIntegrationChannelAccess,
  classifyIntegrationIdentity,
  classifyIntegrationPreflight,
  createSendMessageResultBarrier,
  hasPrivateArmReceiptForSession,
  integrationClaudeAuthState,
  integrationLifecycleActivityObserved,
  IntegrationPreflightFailure,
  integrationPreflightFailureResult,
  integrationPreflightBlockers,
  integrationTopologyRelation,
  inspectAgentPartyCrossSessionEvidence as inspectRawAgentPartyCrossSessionEvidence,
  normalizeServer,
  parseIntegrationArguments,
  probeIntegrationDeploymentMetadata,
  redactIntegrationEvidence,
  readPrivateArmReceipt,
  readPrivateAgentConfig,
  requiresVersionedWorkerDeployment,
  resolveIntegrationWorkingDirectory,
  unexpectedIntegrationAcceptanceFailure,
} from "./verify-agentparty-claude-cross-session";
import { RestError, RuntimePeerProtocolError, type Identity } from "../cli/src/rest";
import {
  AGENT_ACTIVITY_TTL_MS,
  type PresenceEntry,
  type RuntimePeerDiscovery,
  type RuntimeTopologyRelation,
} from "../shared/src/protocol";

const tempPaths: string[] = [];
afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const tool = (name: string, input: Record<string, unknown> = {}, id = `tool-${name}`) => JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (toolUseId: string, content = "ok", isError = false) => JSON.stringify({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      ...(isError ? { is_error: true } : {}),
    }],
  },
});

function recordMessageContent(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = event.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>).content;
  return Array.isArray(content)
    ? content.filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

const senderAgent = "sender-agent";
const receiverAgent = "receiver-agent";
const candidateRef = "candidate_1234567890abcdef";

const senderSessionId = "11111111-1111-4111-8111-111111111111";
const receiverSessionId = "22222222-2222-4222-8222-222222222222";

const init = (sessionId: string) => JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  messaging_socket_path: "/tmp/private.sock",
  tools: ["ListAgents", "SendMessage", "mcp__agentparty-channel__party_channel_peers", "mcp__agentparty-channel__party_channel_peer_check"],
});

function sessionStream(sessionId: string, lines: readonly string[]): string[] {
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const hasInit = parsed.some((event) => event.type === "system" && event.subtype === "init");
  return [
    ...(hasInit ? [] : [init(sessionId)]),
    ...parsed.map((event) => event.type === "system" && event.subtype === "init"
      ? JSON.stringify(event)
      : JSON.stringify({ ...event, session_id: sessionId })),
  ];
}

function senderStream(lines: readonly string[]): string[] {
  return sessionStream(senderSessionId, lines);
}

function inspectAgentPartyCrossSessionEvidence(
  senderLines: readonly string[],
  receiverLines: readonly string[],
  marker: string,
  expectedSenderAgent: string,
  expectedReceiverAgent: string,
  expectedDisplayName: string,
  senderBridgeLines: readonly string[] = [],
  receiverBridgeLines: readonly string[] = [],
  senderReceiptLines: readonly string[] = [],
  receiverReceiptLines: readonly string[] = [],
  expectedChannel: string | null = null,
  expectedRelation: RuntimeTopologyRelation = "same_worktree",
) {
  return inspectRawAgentPartyCrossSessionEvidence(
    senderStream(senderLines),
    receiverLines,
    marker,
    expectedSenderAgent,
    expectedReceiverAgent,
    expectedDisplayName,
    senderBridgeLines,
    receiverBridgeLines,
    senderReceiptLines,
    receiverReceiptLines,
    expectedChannel,
    null,
    null,
    expectedRelation,
  );
}

const launchLines = (address: string) => [
  `party bridge: launching Claude Code for #dev; channel=launching cross_session=enabled_for_launch mode=required reason=ready address=${address}. policy note`,
];

const receiptLines = (address: string, sessionId: string) => [
  JSON.stringify({
    schema: "agentparty.claude-session-start-armed.v1",
    address,
    session_id: sessionId,
    armed_at: 1234,
  }),
];

function readyHint(
  displayName: string,
  overrides: Record<string, unknown> = {},
  relation: RuntimeTopologyRelation = "same_worktree",
): string {
  const action = relation === "same_worktree"
    ? "negotiate_single_writer"
    : relation === "same_workspace"
      ? "exchange_change_summary"
      : "inspect_shared_resources";
  return JSON.stringify({
    version: 2,
    availability: "ready",
    topology_evidence: "client_asserted",
    channel: "dev",
    self: senderAgent,
    peers: [{
      agent: receiverAgent,
      same_identity: false,
      claude_sessions: [{
        display_name: displayName,
        relation,
        runtime_count: 1,
        candidate_ref: candidateRef,
        name_unique_among_hints: true,
        pre_send_check_required: true,
        coordination: { action },
      }],
    }],
    ...overrides,
  });
}

function confirmed(
  displayName: string,
  overrides: Record<string, unknown> = {},
  relation: RuntimeTopologyRelation = "same_worktree",
): string {
  return JSON.stringify({
    version: 1,
    availability: "confirmed",
    topology_evidence: "client_asserted",
    comparison: "server_rechecked_live_topology",
    channel: "dev",
    self: senderAgent,
    agent: receiverAgent,
    display_name: displayName,
    candidate_ref: candidateRef,
    send_to: `${displayName} [abc123]`,
    relation,
    ...overrides,
  });
}

describe("AgentParty + Claude Cross-session integration evidence", () => {
  test("releases a process wait only for the matching direct singleton SendMessage result", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_barrier";
    let releases = 0;
    const observe = createSendMessageResultBarrier(marker, () => { releases += 1; });
    const event = (line: string, sessionId = senderSessionId): string => JSON.stringify({
      ...(JSON.parse(line) as Record<string, unknown>),
      session_id: sessionId,
    });
    observe(init(senderSessionId));
    observe(event(tool("SendMessage", { to: "peer", message: "wrong" }, "wrong-message")));
    observe(event(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", nested: {
        type: "tool_use",
        id: "nested",
        name: "SendMessage",
        input: { to: "peer", message: marker },
      } }] },
    })));
    observe(event(tool("SendMessage", { to: "peer", message: marker }, "send-1")));
    observe(event(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "other", content: "delivered" }] },
    })));
    expect(releases).toBe(0);
    observe(event(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "send-1", content: "delivered" }] },
    })));
    observe(event(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "send-1", content: "duplicate" }] },
    })));
    expect(releases).toBe(1);

    for (const invalidUse of [
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: "child",
        message: { content: [{
          type: "tool_use", id: "child-send", name: "SendMessage", input: { to: "peer", message: marker },
        }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "tool_use", id: "parallel-send", name: "SendMessage", input: { to: "peer", message: marker } },
          { type: "tool_use", id: "parallel-bash", name: "Bash", input: { command: "true" } },
        ] },
      }),
    ]) {
      let invalidReleases = 0;
      const invalid = createSendMessageResultBarrier(marker, () => { invalidReleases += 1; });
      invalid(init(senderSessionId));
      invalid(event(invalidUse));
      const useId = invalidUse.includes("parallel-send") ? "parallel-send" : "child-send";
      invalid(event(JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: useId, content: "delivered" }] },
      })));
      expect(invalidReleases).toBe(0);
    }

    let foreignReleases = 0;
    const foreign = createSendMessageResultBarrier(marker, () => { foreignReleases += 1; });
    foreign(init(senderSessionId));
    foreign(event(tool("SendMessage", { to: "peer", message: marker }, "foreign-send"), receiverSessionId));
    foreign(event(toolResult("foreign-send"), receiverSessionId));
    expect(foreignReleases).toBe(0);

    let errorReleases = 0;
    const failed = createSendMessageResultBarrier(marker, () => { errorReleases += 1; });
    failed(init(senderSessionId));
    failed(event(tool("SendMessage", { to: "peer", message: marker }, "failed-send")));
    failed(event(toolResult("failed-send", "failed", true)));
    expect(errorReleases).toBe(0);
  });

  test("round-trip acceptance asks the bridge, not raw Claude settings, to accept both inbound directions", () => {
    const receiver = bridgeCommand("dev", "prompt", "Bash", "accept");
    const receiverBoundary = receiver.indexOf("--");
    expect(receiver.slice(0, receiverBoundary)).toContain("--cross-session-inbound");
    expect(receiver.slice(0, receiverBoundary)).toContain("accept");
    expect(receiver.slice(receiverBoundary + 1)).not.toContain("--settings");

    const sender = bridgeCommand("dev", "prompt", "ListAgents,SendMessage", "accept");
    const senderBoundary = sender.indexOf("--");
    expect(sender.slice(0, senderBoundary)).toContain("--cross-session-inbound");
    expect(sender.slice(0, senderBoundary)).toContain("accept");
    expect(sender.slice(senderBoundary + 1)).not.toContain("--settings");
  });

  test("compiled verifier launches both sessions through the exact current party command", () => {
    const command = bridgeCommand(
      "dev",
      "prompt",
      "ListAgents,SendMessage",
      "accept",
      { command: "/opt/agentparty/party", args: ["--embedded-entry"] },
    );
    expect(command.slice(0, 5)).toEqual([
      "/opt/agentparty/party",
      "--embedded-entry",
      "bridge",
      "claude",
      "dev",
    ]);
  });

  test("extracts one generated receiver address only from an enabled launch receipt", () => {
    expect(bridgeLaunchAddress([
      "party bridge: launching Claude Code for #dev; channel=launching cross_session=enabled_for_launch mode=required reason=ready address=apcs-receiver-a1b2c3d4e5f6. policy note",
    ])).toBe("apcs-receiver-a1b2c3d4e5f6");
    expect(bridgeLaunchAddress([
      "cross_session=enabled_for_launch mode=required reason=ready address=receiver-a1b2c3d4.",
    ])).toBeNull();
    expect(bridgeLaunchAddress([
      "cross_session=enabled_for_launch mode=required reason=ready address=apcs-receiver-a1b2c3d4e5f.",
    ])).toBeNull();
    expect(bridgeLaunchAddress([
      "channel=launching cross_session=channel_only mode=auto reason=runtime_comparison_unavailable",
    ])).toBeNull();
    expect(bridgeLaunchAddress([
      "cross_session=enabled_for_launch mode=required reason=ready address=first-address.",
      "cross_session=enabled_for_launch mode=required reason=ready address=second-address.",
    ])).toBeNull();
  });
  test("requires the ordered MCP hint, ListAgents result, exact target send, and receiver observation", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    const hint = readyHint(displayName);
    const sender = [
      init(senderSessionId),
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `tool-mcp__agentparty-channel__party_channel_peers`, content: hint }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: `${displayName} [abc123]` }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check", content: confirmed(displayName) }] } }),
      tool("SendMessage", { to: `${displayName} [abc123]`, message: marker }),
    ];
    const receiver = [
      init(receiverSessionId),
      JSON.stringify({
        type: "user",
        session_id: receiverSessionId,
        message: { content: `cross-session: ${marker}` },
      }),
    ];
    expect(inspectAgentPartyCrossSessionEvidence(
      sender,
      receiver,
      marker,
      senderAgent,
      receiverAgent,
      displayName,
      launchLines("apcs-sender-agent-a1b2c3d4e5f6"),
      launchLines(displayName),
      receiptLines("apcs-sender-agent-a1b2c3d4e5f6", senderSessionId),
      receiptLines(displayName, receiverSessionId),
      "dev",
    )).toEqual({
      receiver_session_start_armed: true,
      sender_session_start_armed: true,
      distinct_claude_session_ids: true,
      distinct_bridge_addresses: true,
      receiver_initialized_with_agentparty_mcp: true,
      sender_used_party_channel_peers: true,
      sender_received_expected_ready_hint: true,
      sender_used_list_agents_after_hint: true,
      sender_rechecked_exact_candidate_before_send: true,
      sender_used_send_message_to_hint_with_marker: true,
      sender_send_message_result_observed: false,
      receiver_observed_marker: true,
      receiver_wait_boundary_before_marker: false,
      receiver_used_party_channel_peers_for_reply: false,
      receiver_received_expected_sender_hint: false,
      receiver_used_list_agents_after_hint_for_reply: false,
      receiver_rechecked_exact_candidate_before_reply: false,
      receiver_used_send_message_to_sender_with_reply_marker: false,
      receiver_reply_send_message_result_observed: false,
      sender_observed_reply_marker: false,
      sender_wait_boundary_before_reply_marker: false,
    });
  });

  test("binds evidence to the exact expected local topology relation", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_relation";
    const displayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    for (const relation of [
      "same_worktree",
      "same_workspace",
      "same_local_installation",
    ] as const) {
      const sender = [
        init(senderSessionId),
        tool("mcp__agentparty-channel__party_channel_peers"),
        toolResult(
          "tool-mcp__agentparty-channel__party_channel_peers",
          readyHint(displayName, {}, relation),
        ),
        tool("ListAgents"),
        toolResult("tool-ListAgents", `${displayName} [abc123]`),
        tool("mcp__agentparty-channel__party_channel_peer_check", {
          agent: receiverAgent,
          display_name: displayName,
          candidate_ref: candidateRef,
        }),
        toolResult(
          "tool-mcp__agentparty-channel__party_channel_peer_check",
          confirmed(displayName, {}, relation),
        ),
        tool("SendMessage", { to: `${displayName} [abc123]`, message: marker }),
      ];
      const evidence = inspectAgentPartyCrossSessionEvidence(
        sender,
        [init(receiverSessionId)],
        marker,
        senderAgent,
        receiverAgent,
        displayName,
        [],
        [],
        [],
        [],
        "dev",
        relation,
      );
      expect(evidence.sender_received_expected_ready_hint, relation).toBe(true);
      expect(evidence.sender_rechecked_exact_candidate_before_send, relation).toBe(true);
      expect(evidence.sender_used_send_message_to_hint_with_marker, relation).toBe(true);

      const wrongRelation = relation === "same_worktree" ? "same_workspace" : "same_worktree";
      expect(inspectAgentPartyCrossSessionEvidence(
        sender,
        [init(receiverSessionId)],
        marker,
        senderAgent,
        receiverAgent,
        displayName,
        [],
        [],
        [],
        [],
        "dev",
        wrongRelation,
      ).sender_received_expected_ready_hint, relation).toBe(false);
    }
  });

  test("requires the receiver to reacquire a fresh full chain before replying", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_round_trip";
    const replyMarker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_REPLY_round_trip";
    const senderDisplayName = "apcs-sender-agent-a1b2c3d4e5f6";
    const receiverDisplayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    const sender = sessionStream(senderSessionId, [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
        content: readyHint(receiverDisplayName),
      }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-ListAgents",
        content: `${receiverDisplayName} [receiver-ref]`,
      }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: receiverDisplayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
        content: confirmed(receiverDisplayName, { send_to: `${receiverDisplayName} [receiver-ref]` }),
      }] } }),
      tool("SendMessage", { to: `${receiverDisplayName} [receiver-ref]`, message: marker }),
      toolResult("tool-SendMessage", "delivered"),
      tool("Bash", { command: "wait for reply" }, "sender-wait"),
      toolResult("sender-wait", "released"),
      JSON.stringify({ type: "user", message: { content: `cross-session: ${replyMarker}` } }),
    ]);
    const reverseHint = readyHint(senderDisplayName, {
      self: receiverAgent,
      peers: [{
        agent: senderAgent,
        same_identity: false,
        claude_sessions: [{
          display_name: senderDisplayName,
          relation: "same_worktree",
          runtime_count: 1,
          candidate_ref: candidateRef,
          name_unique_among_hints: true,
          pre_send_check_required: true,
          coordination: { action: "negotiate_single_writer" },
        }],
      }],
    });
    const reverseConfirmation = confirmed(senderDisplayName, {
      self: receiverAgent,
      agent: senderAgent,
      send_to: `${senderDisplayName} [sender-ref]`,
    });
    const receiver = sessionStream(receiverSessionId, [
      tool("Bash", { command: "wait for marker" }, "receiver-wait"),
      toolResult("receiver-wait", "released"),
      JSON.stringify({ type: "user", message: { content: `cross-session: ${marker}` } }),
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
        content: reverseHint,
      }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-ListAgents",
        content: `${senderDisplayName} [sender-ref]`,
      }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: senderAgent,
        display_name: senderDisplayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
        content: reverseConfirmation,
      }] } }),
      tool("SendMessage", { to: `${senderDisplayName} [sender-ref]`, message: replyMarker }),
      toolResult("tool-SendMessage", "delivered"),
    ]);
    const inspect = (
      receiverLines: readonly string[],
      senderLines: readonly string[] = sender,
      senderLaunch: readonly string[] = launchLines(senderDisplayName),
      receiverLaunch: readonly string[] = launchLines(receiverDisplayName),
    ) => inspectRawAgentPartyCrossSessionEvidence(
      senderLines,
      receiverLines,
      marker,
      senderAgent,
      receiverAgent,
      receiverDisplayName,
      senderLaunch,
      receiverLaunch,
      receiptLines(senderDisplayName, senderSessionId),
      receiptLines(receiverDisplayName, receiverSessionId),
      "dev",
      senderDisplayName,
      replyMarker,
    );
    expect(inspect(receiver)).toEqual({
      receiver_session_start_armed: true,
      sender_session_start_armed: true,
      distinct_claude_session_ids: true,
      distinct_bridge_addresses: true,
      receiver_initialized_with_agentparty_mcp: true,
      sender_used_party_channel_peers: true,
      sender_received_expected_ready_hint: true,
      sender_used_list_agents_after_hint: true,
      sender_rechecked_exact_candidate_before_send: true,
      sender_used_send_message_to_hint_with_marker: true,
      sender_send_message_result_observed: true,
      receiver_observed_marker: true,
      receiver_wait_boundary_before_marker: true,
      receiver_used_party_channel_peers_for_reply: true,
      receiver_received_expected_sender_hint: true,
      receiver_used_list_agents_after_hint_for_reply: true,
      receiver_rechecked_exact_candidate_before_reply: true,
      receiver_used_send_message_to_sender_with_reply_marker: true,
      receiver_reply_send_message_result_observed: true,
      sender_observed_reply_marker: true,
      sender_wait_boundary_before_reply_marker: true,
    });

    const failedSenderResult = sender.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== "user" || !recordMessageContent(event).some((block) =>
        block.type === "tool_result" && block.tool_use_id === "tool-SendMessage"
      )) return line;
      return JSON.stringify({
        ...event,
        message: {
          ...(event.message as Record<string, unknown>),
          content: recordMessageContent(event).map((block) => ({ ...block, is_error: true })),
        },
      });
    });
    expect(inspect(receiver, failedSenderResult)).toMatchObject({
      sender_used_send_message_to_hint_with_marker: true,
      sender_send_message_result_observed: false,
      sender_wait_boundary_before_reply_marker: false,
    });

    const receiverMarkerIndex = receiver.findIndex((line) => line.includes(`cross-session: ${marker}`));
    const receiverWaitResultIndex = receiver.findIndex((line) => line.includes('"tool_use_id":"receiver-wait"'));
    const earlyReceiverMarker = [...receiver];
    [earlyReceiverMarker[receiverMarkerIndex], earlyReceiverMarker[receiverWaitResultIndex]] =
      [earlyReceiverMarker[receiverWaitResultIndex]!, earlyReceiverMarker[receiverMarkerIndex]!];
    expect(inspect(earlyReceiverMarker)).toMatchObject({
      receiver_observed_marker: true,
      receiver_wait_boundary_before_marker: false,
    });

    const senderReplyIndex = sender.findIndex((line) => line.includes(`cross-session: ${replyMarker}`));
    const senderWaitResultIndex = sender.findIndex((line) => line.includes('"tool_use_id":"sender-wait"'));
    const earlySenderReply = [...sender];
    [earlySenderReply[senderReplyIndex], earlySenderReply[senderWaitResultIndex]] =
      [earlySenderReply[senderWaitResultIndex]!, earlySenderReply[senderReplyIndex]!];
    expect(inspect(receiver, earlySenderReply).sender_wait_boundary_before_reply_marker).toBe(false);

    const childSenderReply = sender.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return event.type === "user" && JSON.stringify(event.message).includes(replyMarker)
        ? JSON.stringify({ ...event, agent_id: "subagent-reply" })
        : line;
    });
    expect(inspect(receiver, childSenderReply)).toMatchObject({
      sender_observed_reply_marker: false,
      sender_wait_boundary_before_reply_marker: false,
    });

    expect(inspect(
      receiver,
      sender,
      launchLines(senderDisplayName),
      launchLines(senderDisplayName),
    ).distinct_bridge_addresses).toBe(false);

    const directReplyOnly = sessionStream(receiverSessionId, [
      JSON.stringify({ type: "user", message: { content: `cross-session: ${marker}` } }),
      tool("SendMessage", { to: `${senderDisplayName} [sender-ref]`, message: replyMarker }),
    ]);
    expect(inspect(directReplyOnly)).toMatchObject({
      receiver_observed_marker: true,
      receiver_used_party_channel_peers_for_reply: false,
      receiver_rechecked_exact_candidate_before_reply: false,
      receiver_used_send_message_to_sender_with_reply_marker: false,
      sender_observed_reply_marker: true,
    });
  });

  test("requires two distinct Claude stream sessions", () => {
    const displayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    const evidence = inspectRawAgentPartyCrossSessionEvidence(
      [init(senderSessionId)],
      [init(senderSessionId)],
      "unused-marker",
      senderAgent,
      receiverAgent,
      displayName,
      launchLines("apcs-sender-agent-a1b2c3d4e5f6"),
      launchLines(displayName),
      receiptLines("apcs-sender-agent-a1b2c3d4e5f6", senderSessionId),
      receiptLines(displayName, senderSessionId),
    );
    expect(evidence).toMatchObject({
      sender_session_start_armed: true,
      receiver_session_start_armed: true,
      distinct_claude_session_ids: false,
      distinct_bridge_addresses: true,
    });
  });

  test("binds every sender tool and result to the unique armed stream session", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_sender_binding";
    const displayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    const valid = senderStream([
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
        content: readyHint(displayName),
      }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-ListAgents",
        content: `${displayName} [abc123]`,
      }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
        content: confirmed(displayName),
      }] } }),
      tool("SendMessage", { to: `${displayName} [abc123]`, message: marker }),
    ]);
    const inspect = (lines: readonly string[]) => inspectRawAgentPartyCrossSessionEvidence(
      lines,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    );
    expect(inspect(valid)).toMatchObject({
      sender_used_party_channel_peers: true,
      sender_received_expected_ready_hint: true,
      sender_used_list_agents_after_hint: true,
      sender_rechecked_exact_candidate_before_send: true,
      sender_used_send_message_to_hint_with_marker: true,
    });

    const rewrite = (
      lines: readonly string[],
      index: number,
      update: (event: Record<string, unknown>) => Record<string, unknown>,
    ) => lines.map((line, current) => current === index
      ? JSON.stringify(update(JSON.parse(line) as Record<string, unknown>))
      : line);
    const withoutSession = rewrite(valid, 1, (event) => {
      const { session_id: _ignored, ...rest } = event;
      return rest;
    });
    expect(inspect(withoutSession).sender_used_party_channel_peers).toBe(false);
    const foreignResult = rewrite(valid, 4, (event) => ({
      ...event,
      session_id: "33333333-3333-4333-8333-333333333333",
    }));
    expect(inspect(foreignResult).sender_used_list_agents_after_hint).toBe(false);
    expect(inspect([valid[1]!, valid[0]!, ...valid.slice(2)]).sender_used_party_channel_peers).toBe(false);
    expect(inspect([valid[0]!, valid[0]!, ...valid.slice(1)]).sender_used_party_channel_peers).toBe(false);
    const markResultError = (index: number) => rewrite(valid, index, (event) => ({
      ...event,
      message: {
        ...(event.message as Record<string, unknown>),
        content: recordMessageContent(event).map((block) => ({ ...block, is_error: true })),
      },
    }));
    expect(inspect(markResultError(2)).sender_received_expected_ready_hint).toBe(false);
    expect(inspect(markResultError(4)).sender_used_list_agents_after_hint).toBe(false);
    expect(inspect(markResultError(6)).sender_rechecked_exact_candidate_before_send).toBe(false);
    const foreignDuplicateHintResult = JSON.stringify({
      type: "user",
      session_id: "33333333-3333-4333-8333-333333333333",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
        content: readyHint(displayName),
      }] },
    });
    expect(inspect([...valid, foreignDuplicateHintResult]).sender_received_expected_ready_hint).toBe(false);
    const childDuplicateListResult = JSON.stringify({
      type: "user",
      session_id: senderSessionId,
      parent_tool_use_id: "subagent-duplicate",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-ListAgents",
        content: `${displayName} [abc123]`,
      }] },
    });
    expect(inspect([...valid, childDuplicateListResult]).sender_used_list_agents_after_hint).toBe(false);
    const foreignDuplicateSend = JSON.stringify({
      type: "assistant",
      session_id: "33333333-3333-4333-8333-333333333333",
      message: { content: [{
        type: "tool_use",
        name: "SendMessage",
        input: { to: `${displayName} [abc123]`, message: marker },
      }] },
    });
    expect(inspect([...valid, foreignDuplicateSend]).sender_used_send_message_to_hint_with_marker)
      .toBe(false);
  });

  test("requires the same top-level singleton envelopes and uninterrupted chain as the live gate", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_strict_envelope";
    const displayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    const peers = tool("mcp__agentparty-channel__party_channel_peers");
    const hintResult = JSON.stringify({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
        content: readyHint(displayName),
      }] },
    });
    const list = tool("ListAgents");
    const listResult = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: `${displayName} [abc123]` }] },
    });
    const check = tool("mcp__agentparty-channel__party_channel_peer_check", {
      agent: receiverAgent,
      display_name: displayName,
      candidate_ref: candidateRef,
    });
    const checkResult = JSON.stringify({
      type: "user",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
        content: confirmed(displayName),
      }] },
    });
    const send = tool("SendMessage", { to: `${displayName} [abc123]`, message: marker });
    const inspect = (lines: readonly string[]) => inspectAgentPartyCrossSessionEvidence(
      lines, [], marker, senderAgent, receiverAgent, displayName,
    );

    const nestedHint = JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "text",
        text: "decoy",
        nested: {
          type: "tool_result",
          tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
          content: readyHint(displayName),
        },
      }] },
    });
    expect(inspect([peers, nestedHint, list, listResult, check, checkResult, send])
      .sender_received_expected_ready_hint).toBe(false);

    const childHint = JSON.stringify({
      type: "user",
      parent_tool_use_id: "subagent-1",
      message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
        content: readyHint(displayName),
      }] },
    });
    expect(inspect([peers, childHint, list, listResult, check, checkResult, send])
      .sender_received_expected_ready_hint).toBe(false);

    const siblingHint = JSON.stringify({
      type: "user",
      message: { content: [
        {
          type: "tool_result",
          tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
          content: readyHint(displayName),
        },
        { type: "tool_result", tool_use_id: "bash-1", content: "unrelated" },
      ] },
    });
    expect(inspect([peers, siblingHint, list, listResult, check, checkResult, send])
      .sender_received_expected_ready_hint).toBe(false);

    const bash = tool("Bash", {}, "bash-1");
    expect(inspect([peers, hintResult, bash, list, listResult, check, checkResult, send])
      .sender_used_list_agents_after_hint).toBe(false);

    const parallelPeers = JSON.stringify({
      type: "assistant",
      message: { content: [
        {
          type: "tool_use",
          id: "tool-mcp__agentparty-channel__party_channel_peers",
          name: "mcp__agentparty-channel__party_channel_peers",
          input: {},
        },
        { type: "tool_use", id: "bash-1", name: "Bash", input: {} },
      ] },
    });
    expect(inspect([parallelPeers, hintResult, list, listResult, check, checkResult, send])
      .sender_used_party_channel_peers).toBe(false);
  });

  test("rejects a guessed send before ListAgents and a hint for the wrong session", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const expected = "expected-session";
    const wrongHint = readyHint("wrong-session");
    const sender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: { type: "tool_result", tool_use_id: `tool-mcp__agentparty-channel__party_channel_peers`, content: wrongHint } } }),
      tool("SendMessage", { to: expected, message: marker }),
      tool("ListAgents"),
    ];
    expect(inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      expected,
    )).toEqual({
      receiver_session_start_armed: false,
      sender_session_start_armed: false,
      distinct_claude_session_ids: false,
      distinct_bridge_addresses: false,
      receiver_initialized_with_agentparty_mcp: false,
      sender_used_party_channel_peers: true,
      sender_received_expected_ready_hint: false,
      sender_used_list_agents_after_hint: false,
      sender_rechecked_exact_candidate_before_send: false,
      sender_used_send_message_to_hint_with_marker: false,
      sender_send_message_result_observed: false,
      receiver_observed_marker: false,
      receiver_wait_boundary_before_marker: false,
      receiver_used_party_channel_peers_for_reply: false,
      receiver_received_expected_sender_hint: false,
      receiver_used_list_agents_after_hint_for_reply: false,
      receiver_rechecked_exact_candidate_before_reply: false,
      receiver_used_send_message_to_sender_with_reply_marker: false,
      receiver_reply_send_message_result_observed: false,
      sender_observed_reply_marker: false,
      sender_wait_boundary_before_reply_marker: false,
    });
  });

  test("binds each arm receipt to one exact launch address and stream session", () => {
    const displayName = "apcs-receiver-agent-a1b2c3d4e5f6";
    const receiver = [init(receiverSessionId)];
    const base = () => inspectAgentPartyCrossSessionEvidence(
      [init(senderSessionId)],
      receiver,
      "unused-marker",
      senderAgent,
      receiverAgent,
      displayName,
      launchLines("apcs-sender-agent-a1b2c3d4e5f6"),
      launchLines(displayName),
      receiptLines("apcs-sender-agent-a1b2c3d4e5f6", senderSessionId),
      receiptLines(displayName, receiverSessionId),
    );
    expect(base()).toMatchObject({
      sender_session_start_armed: true,
      receiver_session_start_armed: true,
    });

    const wrongSession = inspectAgentPartyCrossSessionEvidence(
      [init(senderSessionId)], receiver, "unused-marker", senderAgent, receiverAgent, displayName,
      launchLines("apcs-sender-agent-a1b2c3d4e5f6"),
      launchLines(displayName),
      receiptLines("apcs-sender-agent-a1b2c3d4e5f6", receiverSessionId),
      receiptLines(displayName, receiverSessionId),
    );
    expect(wrongSession.sender_session_start_armed).toBe(false);

    const wrongAddressReceipt = receiptLines("apcs-other-agent-a1b2c3d4e5f6", receiverSessionId);
    const wrongAddress = inspectAgentPartyCrossSessionEvidence(
      [init(senderSessionId)], receiver, "unused-marker", senderAgent, receiverAgent, displayName,
      launchLines("apcs-sender-agent-a1b2c3d4e5f6"), launchLines(displayName),
      receiptLines("apcs-sender-agent-a1b2c3d4e5f6", senderSessionId), wrongAddressReceipt,
    );
    expect(wrongAddress.receiver_session_start_armed).toBe(false);

    const duplicateReceipt = receiptLines(displayName, receiverSessionId);
    duplicateReceipt.push(duplicateReceipt[0]!);
    const duplicate = inspectAgentPartyCrossSessionEvidence(
      [init(senderSessionId)], receiver, "unused-marker", senderAgent, receiverAgent, displayName,
      launchLines("apcs-sender-agent-a1b2c3d4e5f6"), launchLines(displayName),
      receiptLines("apcs-sender-agent-a1b2c3d4e5f6", senderSessionId), duplicateReceipt,
    );
    expect(duplicate.receiver_session_start_armed).toBe(false);
  });

  test("does not accept ordinary assistant prose as a topology or ListAgents tool result", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const fake = readyHint(displayName);
    const sender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: fake }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: displayName }] } }),
      tool("SendMessage", { to: displayName, message: marker }),
    ];
    const evidence = inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    );
    expect(evidence.sender_received_expected_ready_hint).toBe(false);
    expect(evidence.sender_used_list_agents_after_hint).toBe(false);
    expect(evidence.sender_used_send_message_to_hint_with_marker).toBe(false);
  });

  test("does not accept a tool result belonging to another tool call", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const sender = [
      tool("mcp__agentparty-channel__party_channel_peers", {}, "peers-1"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "other-call", content: readyHint(displayName) }] },
      }),
      tool("ListAgents", {}, "list-1"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "other-call", content: `${displayName} [ref-a]` }] },
      }),
      tool("SendMessage", { to: `${displayName} [ref-a]`, message: marker }),
    ];
    expect(inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    )).toMatchObject({
      sender_received_expected_ready_hint: false,
      sender_used_list_agents_after_hint: false,
      sender_used_send_message_to_hint_with_marker: false,
    });
  });

  test("does not accept Cross-session tools from a lookalike MCP server", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const sender = [
      tool("mcp__lookalike__party_channel_peers", {}, "lookalike-peers"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "lookalike-peers",
        content: readyHint(displayName),
      }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: displayName }] } }),
      tool("mcp__lookalike__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }, "lookalike-check"),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "lookalike-check",
        content: confirmed(displayName, { send_to: displayName }),
      }] } }),
      tool("SendMessage", { to: displayName, message: marker }),
    ];
    expect(inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    )).toMatchObject({
      sender_used_party_channel_peers: false,
      sender_received_expected_ready_hint: false,
      sender_rechecked_exact_candidate_before_send: false,
      sender_used_send_message_to_hint_with_marker: false,
    });

    const receiverWithLookalikes = [JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: receiverSessionId,
      messaging_socket_path: "/tmp/private.sock",
      tools: [
        "ListAgents",
        "SendMessage",
        "mcp__lookalike__party_channel_peers",
        "mcp__lookalike__party_channel_peer_check",
      ],
    })];
    expect(inspectAgentPartyCrossSessionEvidence(
      [],
      receiverWithLookalikes,
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).receiver_initialized_with_agentparty_mcp).toBe(false);
  });

  test("rejects a send without an exact confirmed candidate or after an intervening tool", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const prefix = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers", content: readyHint(displayName) }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: `${displayName} [ref-a]` }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
    ];
    const stale = inspectAgentPartyCrossSessionEvidence([
      ...prefix,
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check", content: confirmed(displayName, { availability: "stale_or_ambiguous" }) }] } }),
      tool("SendMessage", { to: `${displayName} [ref-a]`, message: marker }),
    ], [], marker, senderAgent, receiverAgent, displayName);
    expect(stale.sender_rechecked_exact_candidate_before_send).toBe(false);
    expect(stale.sender_used_send_message_to_hint_with_marker).toBe(false);

    const intervening = inspectAgentPartyCrossSessionEvidence([
      ...prefix,
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check", content: confirmed(displayName) }] } }),
      tool("Bash", { command: "true" }),
      tool("SendMessage", { to: `${displayName} [ref-a]`, message: marker }),
    ], [], marker, senderAgent, receiverAgent, displayName);
    expect(intervening.sender_rechecked_exact_candidate_before_send).toBe(false);
    expect(intervening.sender_used_send_message_to_hint_with_marker).toBe(false);

    const parallelSend = inspectAgentPartyCrossSessionEvidence([
      ...prefix,
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check", content: confirmed(displayName) }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "tool_use", id: "send", name: "SendMessage", input: { to: `${displayName} [ref-a]`, message: marker } },
          { type: "tool_use", id: "other", name: "Bash", input: { command: "true" } },
        ] },
      }),
    ], [], marker, senderAgent, receiverAgent, displayName);
    expect(parallelSend.sender_rechecked_exact_candidate_before_send).toBe(false);
    expect(parallelSend.sender_used_send_message_to_hint_with_marker).toBe(false);
  });

  test("binds the confirmed candidate to the exact fresh ListAgents address", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const listAddress = `${displayName} [ref-a]`;
    const sender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers", content: readyHint(displayName) }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: listAddress }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
            content: confirmed(displayName, { send_to: `${displayName} [different-ref]` }),
          }],
        },
      }),
      tool("SendMessage", { to: listAddress, message: marker }),
    ];
    const evidence = inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    );
    expect(evidence.sender_used_list_agents_after_hint).toBe(true);
    expect(evidence.sender_rechecked_exact_candidate_before_send).toBe(false);
    expect(evidence.sender_used_send_message_to_hint_with_marker).toBe(false);

    const exactCheckButDecoratedSend = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers", content: readyHint(displayName) }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: listAddress }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check", content: confirmed(displayName) }] } }),
      tool("SendMessage", { to: `${listAddress} `, message: marker }),
    ];
    expect(inspectAgentPartyCrossSessionEvidence(
      exactCheckButDecoratedSend,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).sender_used_send_message_to_hint_with_marker).toBe(false);
  });

  test("rejects duplicate ListAgents rows and an overlong ref instead of falling back to a bare name", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const evidenceFor = (listResult: string) => inspectAgentPartyCrossSessionEvidence([
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers", content: readyHint(displayName) }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: listResult }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({ type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
        content: confirmed(displayName, { send_to: displayName }),
      }] } }),
      tool("SendMessage", { to: displayName, message: marker }),
    ], [], marker, senderAgent, receiverAgent, displayName);

    expect(evidenceFor(`${displayName} [ref-a]\n${displayName} [ref-a]`))
      .toMatchObject({ sender_used_list_agents_after_hint: false, sender_used_send_message_to_hint_with_marker: false });
    expect(evidenceFor(`${displayName} [${"x".repeat(65)}]`))
      .toMatchObject({ sender_used_list_agents_after_hint: false, sender_used_send_message_to_hint_with_marker: false });
    expect(evidenceFor(`${displayName} [ref-a] · on another machine (Remote Control)`))
      .toMatchObject({ sender_used_list_agents_after_hint: false, sender_used_send_message_to_hint_with_marker: false });
    expect(evidenceFor(`${displayName} [ref-a] · in the cloud`))
      .toMatchObject({ sender_used_list_agents_after_hint: false, sender_used_send_message_to_hint_with_marker: false });
  });

  test("rejects an otherwise valid candidate chain from another channel", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const listAddress = `${displayName} [abc123]`;
    const sender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers",
            content: readyHint(displayName, { channel: "other" }),
          }],
        },
      }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: listAddress }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: receiverAgent,
        display_name: displayName,
        candidate_ref: candidateRef,
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check",
            content: confirmed(displayName, { channel: "other" }),
          }],
        },
      }),
      tool("SendMessage", { to: listAddress, message: marker }),
    ];
    const evidence = inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
      [],
      [],
      [],
      [],
      "dev",
    );
    expect(evidence.sender_received_expected_ready_hint).toBe(false);
    expect(evidence.sender_rechecked_exact_candidate_before_send).toBe(false);
    expect(evidence.sender_used_send_message_to_hint_with_marker).toBe(false);
  });

  test("accepts the marker only as receiver user input and counts every tool block", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const twoCallsInOneEvent = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "mcp__agentparty-channel__party_channel_peers", input: {} },
          { type: "tool_use", name: "mcp__agentparty-channel__party_channel_peers", input: {} },
        ],
      },
    });
    expect(inspectAgentPartyCrossSessionEvidence(
      [twoCallsInOneEvent],
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).sender_used_party_channel_peers).toBe(false);

    for (const type of ["system", "assistant", "result"]) {
      expect(inspectAgentPartyCrossSessionEvidence(
        [],
        [
          init(receiverSessionId),
          JSON.stringify({ type, session_id: receiverSessionId, message: { content: marker } }),
        ],
        marker,
        senderAgent,
        receiverAgent,
        displayName,
      ).receiver_observed_marker).toBe(false);
    }
    expect(inspectAgentPartyCrossSessionEvidence(
      [],
      [
        init(receiverSessionId),
        JSON.stringify({ type: "user", session_id: receiverSessionId, message: { content: marker } }),
      ],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).receiver_observed_marker).toBe(true);
    expect(inspectAgentPartyCrossSessionEvidence(
      [],
      [
        init(receiverSessionId),
        JSON.stringify({
          type: "user",
          session_id: receiverSessionId,
          isReplay: false,
          message: { content: [{ type: "text", text: `peer: ${marker}` }] },
        }),
      ],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).receiver_observed_marker).toBe(true);
    expect(inspectAgentPartyCrossSessionEvidence(
      [],
      [
        init(receiverSessionId),
        JSON.stringify({
          type: "user",
          session_id: receiverSessionId,
          diagnostic: marker,
          message: { content: "unrelated" },
        }),
      ],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).receiver_observed_marker).toBe(false);
    for (const event of [
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: marker }] } },
      {
        type: "user",
        message: { content: [{ type: "text", text: marker }, { type: "tool_result", content: "mixed" }] },
      },
      { type: "user", isReplay: true, message: { content: marker } },
      { type: "user", isReplay: "true", message: { content: marker } },
      { type: "user", isReplay: 1, message: { content: marker } },
      { type: "user", isReplay: null, message: { content: marker } },
      { type: "user", tool_use_result: { stdout: marker }, message: { content: marker } },
      { type: "user", parent_tool_use_id: "subagent-1", message: { content: marker } },
      { type: "user", agent_id: "subagent-1", message: { content: marker } },
    ]) {
      expect(inspectAgentPartyCrossSessionEvidence(
        [],
        [init(receiverSessionId), JSON.stringify({ ...event, session_id: receiverSessionId })],
        marker,
        senderAgent,
        receiverAgent,
        displayName,
      ).receiver_observed_marker).toBe(false);
    }

    const matching = {
      type: "user",
      session_id: receiverSessionId,
      message: { content: marker },
    };
    const otherSessionId = "33333333-3333-4333-8333-333333333333";
    for (const receiverEvents of [
      [init(receiverSessionId), JSON.stringify({ type: "user", message: { content: marker } })],
      [init(receiverSessionId), JSON.stringify({ ...matching, session_id: otherSessionId })],
      [JSON.stringify(matching), init(receiverSessionId)],
      [init(receiverSessionId), JSON.stringify(matching), JSON.stringify(matching)],
      [init(receiverSessionId), init(receiverSessionId), JSON.stringify(matching)],
    ]) {
      expect(inspectAgentPartyCrossSessionEvidence(
        [],
        receiverEvents,
        marker,
        senderAgent,
        receiverAgent,
        displayName,
      ).receiver_observed_marker).toBe(false);
    }
  });

  test("requires semantic tool fields instead of matching decoy nested strings", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const listAddress = `${displayName} [abc123]`;
    const sender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peers", content: readyHint(displayName) }] } }),
      tool("ListAgents"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: listAddress }] } }),
      tool("mcp__agentparty-channel__party_channel_peer_check", {
        agent: "wrong-agent",
        display_name: "wrong-session",
        candidate_ref: "candidate_wrongcandidate01",
        decoy: { agent: receiverAgent, display_name: displayName, candidate_ref: candidateRef },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-mcp__agentparty-channel__party_channel_peer_check", content: confirmed(displayName) }] } }),
      tool("SendMessage", {
        to: "wrong-session [ref-z]",
        message: "wrong-marker",
        decoy: { to: listAddress, message: marker },
      }),
    ];
    const evidence = inspectAgentPartyCrossSessionEvidence(
      sender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    );
    expect(evidence.sender_rechecked_exact_candidate_before_send).toBe(false);
    expect(evidence.sender_used_send_message_to_hint_with_marker).toBe(false);
  });

  test("rejects a hint for the wrong authenticated identities or duplicate tool attempts", () => {
    const marker = "AGENTPARTY_INTEGRATED_CROSS_SESSION_fixture";
    const displayName = "expected-session";
    const wrongIdentitySender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: `tool-mcp__agentparty-channel__party_channel_peers`, content: readyHint(displayName, { self: "other-sender" }) }] },
      }),
    ];
    expect(inspectAgentPartyCrossSessionEvidence(
      wrongIdentitySender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    ).sender_received_expected_ready_hint).toBe(false);

    const duplicateSender = [
      tool("mcp__agentparty-channel__party_channel_peers"),
      tool("mcp__agentparty-channel__party_channel_peers"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: `tool-mcp__agentparty-channel__party_channel_peers`, content: readyHint(displayName) }] },
      }),
      tool("ListAgents"),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-ListAgents", content: displayName }] },
      }),
      tool("SendMessage", { to: displayName, message: marker }),
      tool("SendMessage", { to: displayName, message: marker }),
    ];
    const duplicateEvidence = inspectAgentPartyCrossSessionEvidence(
      duplicateSender,
      [],
      marker,
      senderAgent,
      receiverAgent,
      displayName,
    );
    expect(duplicateEvidence.sender_used_party_channel_peers).toBe(false);
    expect(duplicateEvidence.sender_used_send_message_to_hint_with_marker).toBe(false);
  });

  test("reads only an owned private regular config and rejects symlinks or public modes", () => {
    const root = mkdtempSync(join(tmpdir(), "agentparty-integration-config-test-"));
    tempPaths.push(root);
    const safe = join(root, "safe.json");
    writeFileSync(safe, JSON.stringify({ server: "https://party.example", token: "ap_secret" }), { mode: 0o600 });
    expect(readPrivateAgentConfig(safe, "receiver")).toEqual({
      server: "https://party.example",
      token: "ap_secret",
    });
    const publicConfig = join(root, "public.json");
    writeFileSync(publicConfig, JSON.stringify({ server: "https://party.example", token: "ap_secret" }), { mode: 0o644 });
    expect(() => readPrivateAgentConfig(publicConfig, "sender")).toThrow("mode 0600");
    chmodSync(publicConfig, 0o400);
    expect(() => readPrivateAgentConfig(publicConfig, "sender")).toThrow("mode 0600");
    chmodSync(publicConfig, 0o600);
    const linked = join(root, "linked.json");
    symlinkSync(publicConfig, linked);
    expect(() => readPrivateAgentConfig(linked, "sender")).toThrow("non-symlink");
  });

  test("redacts overlapping tokens without leaking the longer token suffix", () => {
    const receiverToken = "ap_shared";
    const senderToken = "ap_shared_longer_secret";
    const privateRoot = "/private/runtime";
    const receiverCwd = "/Users/private/project-receiver";
    const redacted = redactIntegrationEvidence([
      `receiver=${receiverToken}`,
      `sender=${senderToken}`,
      `path=${privateRoot}/sender.json`,
      `cwd=${receiverCwd}`,
    ], [receiverToken, senderToken], privateRoot, [receiverCwd]);
    expect(redacted).toContain("receiver=<receiver-token>");
    expect(redacted).toContain("sender=<sender-token>");
    expect(redacted).toContain("path=<private-runtime>/sender.json");
    expect(redacted).toContain("cwd=<private-cwd>");
    expect(redacted).not.toContain(receiverToken);
    expect(redacted).not.toContain("_longer_secret");
    expect(redacted).not.toContain(privateRoot);
    expect(redacted).not.toContain(receiverCwd);
    expect(redactIntegrationEvidence(
      ["path=/tmp/ordinary"],
      [receiverToken, senderToken],
      privateRoot,
      ["/"],
    )).toBe("path=/tmp/ordinary");
  });

  test("reads arm evidence only from one small owned 0600 regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "agentparty-arm-evidence-test-"));
    tempPaths.push(root);
    const safe = join(root, "arm.jsonl");
    expect(readPrivateArmReceipt(safe)).toEqual([]);
    writeFileSync(safe, `${receiptLines("apcs-receiver-agent-a1b2c3d4e5f6", receiverSessionId)[0]}\n`, { mode: 0o600 });
    expect(readPrivateArmReceipt(safe)).toHaveLength(1);
    expect(hasPrivateArmReceiptForSession(
      safe,
      "apcs-receiver-agent-a1b2c3d4e5f6",
      receiverSessionId,
    )).toBe(true);
    expect(() => hasPrivateArmReceiptForSession(
      safe,
      "apcs-other-agent-a1b2c3d4e5f6",
      receiverSessionId,
    )).toThrow("does not match");
    expect(hasPrivateArmReceiptForSession(
      join(root, "missing.jsonl"),
      "apcs-receiver-agent-a1b2c3d4e5f6",
      receiverSessionId,
    )).toBe(false);

    const publicReceipt = join(root, "public.jsonl");
    writeFileSync(publicReceipt, "{}\n", { mode: 0o644 });
    expect(() => readPrivateArmReceipt(publicReceipt)).toThrow("mode 0600");

    const linked = join(root, "linked.jsonl");
    symlinkSync(safe, linked);
    expect(() => readPrivateArmReceipt(linked)).toThrow("non-symlink");

    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(readPrivateArmReceipt(empty)).toEqual([]);
  });

  test("normalizes secure servers and permits plaintext only on loopback", () => {
    expect(normalizeServer("https://Party.Example/path/")).toEqual({
      url: "https://party.example/path",
      origin: "https://party.example",
    });
    expect(normalizeServer("http://127.0.0.1:8787/").url).toBe("http://127.0.0.1:8787");
    expect(() => normalizeServer("http://party.example")).toThrow("must use https");
    expect(() => normalizeServer("https://user:password@party.example")).toThrow("must not contain credentials");
  });

  test("reads one bounded, uncached Worker deployment identity for acceptance provenance", async () => {
    const requests: Request[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(request);
      return new Response(JSON.stringify({
        ok: true,
        version: "0.2.89",
        commit: "a".repeat(40),
        deployed_at: "2026-08-13T00:00:00.000Z",
      }), { status: 200 });
    });
    await expect(probeIntegrationDeploymentMetadata(
      "https://party.example",
      fetchImpl,
      50,
    )).resolves.toEqual({
      version: "0.2.89",
      commit: "a".repeat(40),
      deployed_at: "2026-08-13T00:00:00.000Z",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://party.example/api/health?deployment_metadata=1");
    expect(requests[0]!.headers.get("cache-control")).toBe("no-cache");
    expect(requests[0]!.signal.aborted).toBe(false);
    await expect(probeIntegrationDeploymentMetadata("https://party.example", fetchImpl, 0))
      .rejects.toThrow("deployment metadata timeout must be a positive integer");
    expect(requiresVersionedWorkerDeployment("https://party.example")).toBe(true);
    expect(requiresVersionedWorkerDeployment("http://127.0.0.1:8787")).toBe(false);
    expect(requiresVersionedWorkerDeployment("http://[::1]:8787")).toBe(false);
  });

  test("separates missing or explicitly old runtime-peer protocols from malformed availability failures", () => {
    const discovery: RuntimePeerDiscovery = {
      version: 3,
      topology_evidence: "client_asserted",
      self: "sender",
      comparison: "server_derived",
      caller_binding: "capability_probe",
      peers: [],
    };
    expect(classifyIntegrationPreflight(discovery, null, true)).toEqual({ status: "ready", exitCode: 0 });
    expect(integrationPreflightBlockers(discovery, null, true)).toEqual([]);
    const missingDeployment = new Error("deployment health unavailable");
    expect(classifyIntegrationPreflight(
      discovery,
      null,
      true,
      null,
      [],
      true,
      missingDeployment,
    )).toEqual({ status: "worker_upgrade_required", exitCode: 3 });
    expect(integrationPreflightBlockers(
      discovery,
      null,
      true,
      null,
      [],
      true,
      missingDeployment,
    )).toEqual(["worker_deployment_unavailable"]);
    expect(classifyIntegrationPreflight(discovery, null, false)).toEqual({
      status: "claude_auth_required",
      exitCode: 2,
    });
    expect(integrationPreflightBlockers(discovery, null, false)).toEqual(["claude_auth_required"]);
    const oldWorker = new RestError(404, null, "not found");
    expect(classifyIntegrationPreflight(null, oldWorker, false)).toEqual({
      status: "worker_upgrade_required",
      exitCode: 3,
    });
    expect(integrationPreflightBlockers(null, oldWorker, false)).toEqual([
      "claude_auth_required",
      "worker_upgrade_required",
    ]);
    const oldProtocol = new RuntimePeerProtocolError(1);
    expect(classifyIntegrationPreflight(null, oldProtocol, true)).toEqual({
      status: "worker_upgrade_required",
      exitCode: 3,
    });
    expect(integrationPreflightBlockers(null, oldProtocol, true)).toEqual(["worker_upgrade_required"]);
    const unavailable = new RestError(503, null, "unavailable");
    expect(classifyIntegrationPreflight(null, unavailable, true)).toEqual({
      status: "runtime_peer_unavailable",
      exitCode: 4,
    });
    expect(integrationPreflightBlockers(null, unavailable, false)).toEqual([
      "claude_auth_required",
      "runtime_peer_unavailable",
    ]);
    const malformed = new Error("invalid runtime-peer response");
    expect(classifyIntegrationPreflight(null, malformed, true)).toEqual({
      status: "runtime_peer_unavailable",
      exitCode: 4,
    });
    expect(integrationPreflightBlockers(null, malformed, true)).toEqual(["runtime_peer_unavailable"]);
  });

  test("separates verified logout, unavailable auth, and unsupported Claude environments", () => {
    const discovery: RuntimePeerDiscovery = {
      version: 3,
      topology_evidence: "client_asserted",
      self: "sender",
      comparison: "server_derived",
      caller_binding: "capability_probe",
      peers: [],
    };
    expect(integrationClaudeAuthState('{"loggedIn":false,"apiProvider":"firstParty"}')).toEqual({
      status: "logged_out",
      loggedIn: false,
      apiProvider: "firstParty",
    });
    expect(integrationClaudeAuthState("not-json")).toEqual({
      status: "unavailable",
      loggedIn: false,
    });
    expect(classifyIntegrationPreflight(discovery, null, "unavailable")).toEqual({
      status: "claude_auth_unavailable",
      exitCode: 5,
    });

    const unsupportedProvider = {
      reason: "unsupported_provider" as const,
      variables: [],
      apiProvider: "Bedrock",
    };
    expect(classifyIntegrationPreflight(discovery, null, "logged_in", unsupportedProvider)).toEqual({
      status: "unsupported_provider",
      exitCode: 6,
    });
    expect(integrationPreflightBlockers(discovery, null, "unavailable", unsupportedProvider)).toEqual([
      "claude_auth_unavailable",
      "unsupported_provider",
    ]);

    const flagsDisabled = {
      reason: "feature_flag_evaluation_disabled" as const,
      variables: ["DISABLE_TELEMETRY"],
    };
    expect(classifyIntegrationPreflight(discovery, null, "logged_in", flagsDisabled)).toEqual({
      status: "feature_flag_evaluation_disabled",
      exitCode: 7,
    });
    const oldWorker = new RestError(404, null, "not found");
    expect(classifyIntegrationPreflight(null, oldWorker, "unavailable", unsupportedProvider)).toEqual({
      status: "worker_upgrade_required",
      exitCode: 3,
    });
    expect(integrationPreflightBlockers(null, oldWorker, "unavailable", unsupportedProvider)).toEqual([
      "claude_auth_unavailable",
      "unsupported_provider",
      "worker_upgrade_required",
    ]);
  });

  test("keeps revoked AgentParty identities and channel failures inside the preflight contract", () => {
    const agent = (name: string, channelScope: string | null = "agentparty"): Identity => ({
      name,
      email: null,
      kind: "agent",
      role: "agent",
      owner: null,
      channel_scope: channelScope,
    });
    expect(classifyIntegrationIdentity(agent("receiver"), null, "agentparty")).toEqual({
      status: "confirmed",
      agent: "receiver",
    });
    expect(classifyIntegrationIdentity(null, new RestError(401, "unauthorized", "revoked"), "agentparty"))
      .toEqual({ status: "unauthorized", http_status: 401 });
    expect(classifyIntegrationIdentity(null, new RestError(503, null, "down"), "agentparty"))
      .toEqual({ status: "unavailable", http_status: 503 });
    expect(classifyIntegrationIdentity({ ...agent("human"), kind: "human" }, null, "agentparty"))
      .toEqual({ status: "invalid", invalid_reason: "not_named_agent" });
    expect(classifyIntegrationIdentity(agent("wrong-scope", "other"), null, "agentparty"))
      .toEqual({ status: "invalid", invalid_reason: "channel_scope_mismatch" });
    expect(classifyIntegrationChannelAccess(null)).toEqual({ status: "confirmed" });
    expect(classifyIntegrationChannelAccess(new RestError(403, "forbidden", "denied"))).toEqual({
      status: "unavailable",
      http_status: 403,
    });

    const agentPartyBlockers = [
      "receiver_agentparty_auth_required",
      "sender_agentparty_auth_required",
    ] as const;
    expect(classifyIntegrationPreflight(
      null,
      null,
      "logged_out",
      null,
      agentPartyBlockers,
      false,
    )).toEqual({ status: "agentparty_unavailable", exitCode: 8 });
    expect(integrationPreflightBlockers(
      null,
      null,
      "logged_out",
      null,
      agentPartyBlockers,
      false,
    )).toEqual([
      "claude_auth_required",
      "receiver_agentparty_auth_required",
      "sender_agentparty_auth_required",
    ]);

    const oldWorker = new RestError(404, null, "not found");
    expect(classifyIntegrationPreflight(
      null,
      oldWorker,
      "logged_out",
      null,
      ["receiver_agentparty_auth_required"],
      true,
    )).toEqual({ status: "worker_upgrade_required", exitCode: 3 });
    expect(classifyIntegrationPreflight(
      null,
      new RestError(401, "unauthorized", "revoked after identity probe"),
      "logged_in",
      null,
      ["sender_agentparty_auth_required"],
      true,
    )).toEqual({ status: "agentparty_unavailable", exitCode: 8 });

    expect(integrationPreflightBlockers(
      null,
      null,
      "logged_in",
      null,
      [],
      false,
      null,
      ["plugin_missing"],
    )).toEqual(["plugin_missing"]);
    expect(classifyIntegrationPreflight(
      null,
      null,
      "logged_in",
      null,
      [],
      false,
      null,
      ["plugin_missing"],
    )).toEqual({ status: "plugin_lifecycle_unavailable", exitCode: 11 });
  });

  test("classifies startup failures without exposing unexpected error text", () => {
    expect(parseIntegrationArguments([
      "--preflight-only",
      "--channel", "agentparty",
      "--receiver-config", "/receiver.json",
      "--sender-config", "/sender.json",
      "--receiver-cwd", "/receiver-worktree",
      "--sender-cwd", "/sender-worktree",
    ])).toEqual({
      channel: "agentparty",
      receiverConfigPath: "/receiver.json",
      senderConfigPath: "/sender.json",
      receiverCwd: "/receiver-worktree",
      senderCwd: "/sender-worktree",
      keepArtifacts: false,
      preflightOnly: true,
    });
    expect(() => parseIntegrationArguments([
      "--preflight-only",
      "--channel", "agentparty",
      "--channel", "other",
      "--receiver-config", "/receiver.json",
      "--sender-config", "/sender.json",
    ])).toThrow("duplicate argument");
    expect(() => parseIntegrationArguments([
      "--preflight-only",
      "--channel", "INVALID",
      "--receiver-config", "/receiver.json",
      "--sender-config", "/sender.json",
    ])).toThrow("valid AgentParty slug");

    expect(integrationPreflightFailureResult(new IntegrationPreflightFailure(
      "unsupported_platform",
      "environment_unavailable",
      10,
      "platform detail",
    ))).toEqual({
      status: "environment_unavailable",
      blockers: ["unsupported_platform"],
      error_code: "unsupported_platform",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
      exitCode: 10,
    });
    expect(integrationPreflightFailureResult(new Error("secret-bearing unexpected detail"))).toEqual({
      status: "internal_error",
      blockers: ["internal_error"],
      error_code: "internal_error",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
      exitCode: 1,
    });
    expect(buildIntegrationAcceptanceFailure({
      phase: "execution",
      code: "session_execution_failed",
      exitCode: 1,
      modelCallsStarted: true,
      claudeVersion: "2.1.228",
      server: "https://example.invalid",
      channel: "agentparty",
      receiverAgent: "receiver",
      senderAgent: "sender",
      artifacts: "/private/redacted-evidence",
    })).toEqual({
      exitCode: 1,
      report: {
        schema: "agentparty.claude-cross-session-integration-acceptance.v2",
        status: "failed",
        failure_phase: "execution",
        error_code: "session_execution_failed",
        cross_machine_policy_on_launch: "explicit_approval_required",
        model_calls_started: true,
        delivery_verified: false,
        claude_version: "2.1.228",
        server: "https://example.invalid",
        channel: "agentparty",
        receiver_agent: "receiver",
        sender_agent: "sender",
        artifacts: "/private/redacted-evidence",
      },
    });
    expect(buildIntegrationAcceptanceFailure({
      phase: "execution",
      code: "session_output_limit_exceeded",
      exitCode: 1,
      modelCallsStarted: true,
      sessionOutputLimit: {
        stream: "sender_stderr",
        kind: "total_bytes",
        limit: 8 * 1024 * 1024,
      },
    }).report).toMatchObject({
      error_code: "session_output_limit_exceeded",
      delivery_verified: false,
      session_output_limit: {
        stream: "sender_stderr",
        kind: "total_bytes",
        limit: 8 * 1024 * 1024,
      },
    });
    expect(unexpectedIntegrationAcceptanceFailure(new Error("secret-bearing unexpected detail")))
      .toEqual({
        exitCode: 1,
        report: {
          schema: "agentparty.claude-cross-session-integration-acceptance.v2",
          status: "failed",
          failure_phase: "internal",
          error_code: "internal_error",
          cross_machine_policy_on_launch: "explicit_approval_required",
          model_calls_started: "unknown",
          delivery_verified: false,
        },
      });
  });

  test("binds Marketplace lifecycle activity to the exact live bridge identity and launch window", () => {
    const now = 1_800_000_000_000;
    const launchedAt = now - 5_000;
    const active: PresenceEntry = {
      name: "receiver-agent",
      state: "working",
      note: null,
      ts: now,
      last_seen: now,
      live: true,
      residency: "daemon",
      wake: { kind: "daemon", verified_at: now },
      activity: { phase: "tool", tool: "Bash", ts: now - 1_000 },
    };
    expect(integrationLifecycleActivityObserved([active], "receiver-agent", launchedAt, now)).toBe(true);
    expect(integrationLifecycleActivityObserved([{ ...active, name: "other-agent" }], "receiver-agent", launchedAt, now)).toBe(false);
    expect(integrationLifecycleActivityObserved([{ ...active, live: false }], "receiver-agent", launchedAt, now)).toBe(false);
    expect(integrationLifecycleActivityObserved([{
      ...active,
      wake: { kind: "watch" },
      residency: "supervised",
    }], "receiver-agent", launchedAt, now)).toBe(false);
    expect(integrationLifecycleActivityObserved([{
      ...active,
      activity: { phase: "working", ts: launchedAt - 1 },
    }], "receiver-agent", launchedAt, now)).toBe(false);
    expect(integrationLifecycleActivityObserved([{
      ...active,
      activity: { phase: "working", ts: now - AGENT_ACTIVITY_TTL_MS - 1 },
    }], "receiver-agent", now - AGENT_ACTIVITY_TTL_MS - 2, now)).toBe(false);
    expect(integrationLifecycleActivityObserved([{
      ...active,
      activity: { phase: "working", ts: now + 60_001 },
    }], "receiver-agent", launchedAt, now)).toBe(false);
  });

  test("derives the strongest local relation and validates independent working directories", () => {
    const topology = (overrides: Record<string, string> = {}) => ({
      version: 1 as const,
      node_ref: "node_shared",
      runtime_ref: "runtime_sender",
      workspace_ref: "workspace_shared",
      worktree_ref: "worktree_shared",
      peer_scope: "local_installation" as const,
      evidence: "client_asserted" as const,
      ...overrides,
    });
    expect(integrationTopologyRelation(topology(), topology({ runtime_ref: "runtime_receiver" })))
      .toBe("same_worktree");
    expect(integrationTopologyRelation(
      topology(),
      topology({ runtime_ref: "runtime_receiver", worktree_ref: "worktree_other" }),
    )).toBe("same_workspace");
    expect(integrationTopologyRelation(
      topology(),
      topology({
        runtime_ref: "runtime_receiver",
        workspace_ref: "workspace_other",
        worktree_ref: "worktree_other",
      }),
    )).toBe("same_local_installation");
    expect(integrationTopologyRelation(
      topology(),
      topology({
        node_ref: "node_other",
        runtime_ref: "runtime_receiver",
        workspace_ref: "workspace_other",
        worktree_ref: "worktree_other",
      }),
    )).toBeNull();

    const root = mkdtempSync(join(tmpdir(), "agentparty-integration-cwds-"));
    tempPaths.push(root);
    const receiverCwd = join(root, "receiver");
    mkdirSync(receiverCwd);
    expect(resolveIntegrationWorkingDirectory(receiverCwd, "receiver")).toBe(realpathSync(receiverCwd));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "x");
    expect(() => resolveIntegrationWorkingDirectory(file, "sender"))
      .toThrow("sender cwd must be an existing directory");
  });

  test("prints v1 JSON for malformed preflight requests before reading configs or launching Claude", () => {
    const script = join(import.meta.dir, "verify-agentparty-claude-cross-session.ts");
    const run = (args: string[]) => Bun.spawnSync([process.execPath, script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const invalidChannel = run([
      "--preflight-only",
      "--channel", "INVALID",
      "--receiver-config", "/never-read-receiver.json",
      "--sender-config", "/never-read-sender.json",
    ]);
    expect(invalidChannel.exitCode).toBe(9);
    expect(new TextDecoder().decode(invalidChannel.stderr)).not.toContain("FAIL");
    expect(JSON.parse(new TextDecoder().decode(invalidChannel.stdout))).toEqual({
      schema: "agentparty.claude-cross-session-integration-preflight.v1",
      status: "invalid_request",
      blockers: ["invalid_channel"],
      error_code: "invalid_channel",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
    });

    const invalidCwd = run([
      "--preflight-only",
      "--channel", "agentparty",
      "--receiver-config", "/never-read-receiver.json",
      "--sender-config", "/never-read-sender.json",
      "--receiver-cwd", "/private/nonexistent-receiver-worktree",
    ]);
    const invalidCwdOutput = new TextDecoder().decode(invalidCwd.stdout);
    expect(invalidCwd.exitCode).toBe(9);
    expect(invalidCwdOutput).not.toContain("nonexistent-receiver-worktree");
    expect(JSON.parse(invalidCwdOutput)).toEqual({
      schema: "agentparty.claude-cross-session-integration-preflight.v1",
      status: "invalid_request",
      blockers: ["receiver_cwd_invalid"],
      error_code: "receiver_cwd_invalid",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
    });

    const root = mkdtempSync(join(tmpdir(), "agentparty-preflight-invalid-config-"));
    tempPaths.push(root);
    const missingConfig = join(root, "missing.json");
    const invalidConfig = run([
      "--preflight-only",
      "--channel", "agentparty",
      "--receiver-config", missingConfig,
      "--sender-config", missingConfig,
    ]);
    const output = new TextDecoder().decode(invalidConfig.stdout);
    expect(invalidConfig.exitCode).toBe(9);
    expect(new TextDecoder().decode(invalidConfig.stderr)).not.toContain("FAIL");
    expect(output).not.toContain(missingConfig);
    expect(JSON.parse(output)).toEqual({
      schema: "agentparty.claude-cross-session-integration-preflight.v1",
      status: "invalid_request",
      blockers: ["receiver_config_invalid"],
      error_code: "receiver_config_invalid",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
    });

    const invalidFull = run([
      "--channel", "INVALID",
      "--receiver-config", "/private/never-read-receiver.json",
      "--sender-config", "/private/never-read-sender.json",
    ]);
    const invalidFullStdout = new TextDecoder().decode(invalidFull.stdout);
    expect(invalidFull.exitCode).toBe(9);
    expect(new TextDecoder().decode(invalidFull.stderr)).toBe("");
    expect(invalidFullStdout).not.toContain("never-read");
    expect(JSON.parse(invalidFullStdout)).toEqual({
      schema: "agentparty.claude-cross-session-integration-acceptance.v2",
      status: "failed",
      failure_phase: "request",
      error_code: "invalid_channel",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
    });

    const malformedPreflightFlag = run(["--preflight-only=true"]);
    expect(malformedPreflightFlag.exitCode).toBe(9);
    expect(new TextDecoder().decode(malformedPreflightFlag.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(malformedPreflightFlag.stdout))).toEqual({
      schema: "agentparty.claude-cross-session-integration-preflight.v1",
      status: "invalid_request",
      blockers: ["invalid_arguments"],
      error_code: "invalid_arguments",
      cross_machine_policy_on_launch: "explicit_approval_required",
      model_calls_started: false,
      delivery_verified: false,
    });
  });
});
