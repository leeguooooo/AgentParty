import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CROSS_SESSION_GATE_DIR_ENV,
  CLAUDE_CROSS_SESSION_GATE_PERMIT_TTL_MS,
  CLAUDE_CROSS_SESSION_GATE_STATE_TTL_MS,
  listedClaudeCrossSessionAddress,
  runClaudeCrossSessionHook,
  uniqueClaudeListAgentsAddress,
  type ClaudeHookInput,
} from "../src/claude-cross-session-gate";

const displayName = "apcs-review-agent-a1b2c3d4e5f6";
const candidateRef = "candidate_1234567890abcdef";
const sendTo = `${displayName} [ref-a]`;
const sessionId = "11111111-1111-4111-8111-111111111111";

let directory: string;
let env: NodeJS.ProcessEnv;
let now: number;
let nextToolUseId: number;
let lastPreToolUse: { tool_name: string; tool_use_id: string } | null;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agentparty-cross-session-gate-test-"));
  chmodSync(directory, 0o700);
  env = {
    [CLAUDE_CROSS_SESSION_GATE_DIR_ENV]: directory,
    CLAUDE_CODE_SESSION_ID: sessionId,
  };
  now = 1_000_000;
  nextToolUseId = 1;
  lastPreToolUse = null;
  const arm = runClaudeCrossSessionHook({
    hook_event_name: "SessionStart",
    session_id: sessionId,
  }, env, now);
  expect(arm).toEqual({ exitCode: 0, stdout: "", stderr: "" });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function hook(input: ClaudeHookInput) {
  let correlated = input;
  if (input.hook_event_name === "PreToolUse" && typeof input.tool_name === "string") {
    const toolUseId = typeof input.tool_use_id === "string"
      ? input.tool_use_id
      : `toolu_test_${nextToolUseId++}`;
    correlated = { ...input, tool_use_id: toolUseId };
    lastPreToolUse = { tool_name: input.tool_name, tool_use_id: toolUseId };
  }
  return runClaudeCrossSessionHook({ session_id: sessionId, ...correlated }, env, now);
}

function batch(
  tool_name: string,
  tool_response: unknown,
  tool_input: unknown = {},
  correlatedToolUseId?: string,
) {
  if (correlatedToolUseId === undefined && lastPreToolUse?.tool_name !== tool_name) {
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input });
  }
  const toolUseId = correlatedToolUseId ?? (
    lastPreToolUse?.tool_name === tool_name
      ? lastPreToolUse.tool_use_id
      : `toolu_unmatched_${nextToolUseId++}`
  );
  const decision = hook({
    hook_event_name: "PostToolBatch",
    tool_calls: [{ tool_name, tool_use_id: toolUseId, tool_input, tool_response }],
  });
  if (lastPreToolUse?.tool_use_id === toolUseId) lastPreToolUse = null;
  return decision;
}

function peers() {
  batch("mcp__agentparty-channel__party_channel_peers", JSON.stringify({
    version: 2,
    availability: "ready",
    peers: [{
      agent: "reviewer",
      claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
    }],
  }));
}

function list() {
  hook({ hook_event_name: "PreToolUse", tool_name: "ListAgents", tool_input: {} });
  batch("ListAgents", `local sessions:\n- ${sendTo}`);
}

function check() {
  hook({
    hook_event_name: "PreToolUse",
    tool_name: "mcp__agentparty-channel__party_channel_peer_check",
    tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
  });
  batch("mcp__agentparty-channel__party_channel_peer_check", JSON.stringify({
    version: 1,
    availability: "confirmed",
    topology_evidence: "client_asserted",
    comparison: "server_rechecked_live_topology",
    agent: "reviewer",
    display_name: displayName,
    candidate_ref: candidateRef,
    send_to: sendTo,
  }));
}

function send(to = sendTo, message = "same worktree: I own protocol.ts") {
  return hook({ hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to, message } });
}

function denied(decision: ReturnType<typeof hook>): boolean {
  return decision.stdout.includes('"permissionDecision":"deny"');
}

describe("Claude Cross-session one-time send gate", () => {
  test("accepts exactly one complete ListAgents address and rejects ambiguous or malformed refs", () => {
    expect(uniqueClaudeListAgentsAddress(`- ${sendTo}`, displayName)).toBe(sendTo);
    expect(uniqueClaudeListAgentsAddress(`- ${sendTo} · on this machine`, displayName)).toBe(sendTo);
    expect(uniqueClaudeListAgentsAddress(`${sendTo}\n${sendTo}`, displayName)).toBeNull();
    expect(uniqueClaudeListAgentsAddress(`${displayName} [${"x".repeat(65)}]`, displayName)).toBeNull();
    expect(uniqueClaudeListAgentsAddress(`${displayName} [unterminated`, displayName)).toBeNull();
  });

  test("rejects Remote Control and cloud rows without treating unrelated remote rows as the target", () => {
    expect(uniqueClaudeListAgentsAddress(
      `- ${sendTo} · on another machine (Remote Control)`,
      displayName,
    )).toBeNull();
    expect(uniqueClaudeListAgentsAddress(`- ${sendTo} · in the cloud`, displayName)).toBeNull();
    expect(uniqueClaudeListAgentsAddress(
      `- ${sendTo} · Claude Code on the web`,
      displayName,
    )).toBeNull();
    expect(uniqueClaudeListAgentsAddress(
      `- ${sendTo} · on this machine\n- other-session · on another machine (Remote Control)`,
      displayName,
    )).toBe(sendTo);
    expect(uniqueClaudeListAgentsAddress({
      agents: [{ address: sendTo, kind: "bridge-session", location: "remote" }],
    }, displayName)).toBeNull();
    expect(uniqueClaudeListAgentsAddress({
      agents: [{ address: sendTo, kind: "session", location: "this-machine" }],
    }, displayName)).toBe(sendTo);

    peers();
    hook({ hook_event_name: "PreToolUse", tool_name: "ListAgents", tool_input: {} });
    batch("ListAgents", `local and remote sessions:\n- ${sendTo} · on another machine (Remote Control)`);
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
    check();
    expect(denied(send())).toBe(true);
  });

  test("binds one exact ListAgents address and consumes one fresh permit", () => {
    peers();
    list();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBe(sendTo);
    check();
    expect(denied(send())).toBe(false);
    const replay = send();
    expect(denied(replay)).toBe(true);
    expect(replay.exitCode).toBe(2);
  });

  test("binds every result to the exact pending tool_use_id and ignores delayed batches", () => {
    const peersResult = JSON.stringify({
      version: 2,
      availability: "ready",
      peers: [{
        agent: "reviewer",
        claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
      }],
    });
    const confirmation = JSON.stringify({
      version: 1,
      availability: "confirmed",
      topology_evidence: "client_asserted",
      comparison: "server_rechecked_live_topology",
      agent: "reviewer",
      display_name: displayName,
      candidate_ref: candidateRef,
      send_to: sendTo,
    });

    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peers",
      tool_input: {},
    });
    const oldPeersId = lastPreToolUse!.tool_use_id;
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peers",
      tool_input: {},
    });
    const livePeersId = lastPreToolUse!.tool_use_id;
    batch("mcp__agentparty-channel__party_channel_peers", peersResult, {}, oldPeersId);
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();

    batch("mcp__agentparty-channel__party_channel_peers", peersResult, {}, livePeersId);
    hook({ hook_event_name: "PreToolUse", tool_name: "ListAgents", tool_input: {} });
    const oldListId = lastPreToolUse!.tool_use_id;
    hook({ hook_event_name: "PreToolUse", tool_name: "ListAgents", tool_input: {} });
    const liveListId = lastPreToolUse!.tool_use_id;
    batch("ListAgents", `local sessions:\n- ${sendTo}`, {}, oldListId);
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
    batch("ListAgents", `local sessions:\n- ${sendTo}`, {}, liveListId);
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBe(sendTo);

    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peer_check",
      tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
    });
    const oldCheckId = lastPreToolUse!.tool_use_id;
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peer_check",
      tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
    });
    batch("mcp__agentparty-channel__party_channel_peer_check", confirmation, {}, oldCheckId);
    expect(denied(send())).toBe(true);

    peers();
    list();
    check();
    expect(denied(send())).toBe(false);
  });

  test("denies a chain step whose PreToolUse envelope lacks tool_use_id", () => {
    const decision = runClaudeCrossSessionHook({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "mcp__agentparty-channel__party_channel_peers",
      tool_input: {},
    }, env, now);
    expect(denied(decision)).toBe(true);
    expect(decision.exitCode).toBe(2);
    expect(decision.stdout).toContain("tool_use_id");
  });

  test("discards a candidate ref bound to conflicting peer identities", () => {
    batch("mcp__agentparty-channel__party_channel_peers", JSON.stringify({
      version: 2,
      availability: "ready",
      peers: [
        {
          agent: "reviewer",
          claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
        },
        {
          agent: "impostor",
          claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
        },
      ],
    }));
    list();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
    expect(listedClaudeCrossSessionAddress("impostor", displayName, candidateRef, env, now)).toBeNull();
    check();
    expect(denied(send())).toBe(true);
  });

  test("deduplicates identical peer confirmations but rejects conflicting confirmed results", () => {
    const confirmation = {
      version: 1,
      availability: "confirmed",
      topology_evidence: "client_asserted",
      comparison: "server_rechecked_live_topology",
      agent: "reviewer",
      display_name: displayName,
      candidate_ref: candidateRef,
      send_to: sendTo,
    };
    const observeConfirmations = (confirmations: unknown[]) => {
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agentparty-channel__party_channel_peer_check",
        tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
      });
      batch("mcp__agentparty-channel__party_channel_peer_check", confirmations);
    };

    peers();
    list();
    observeConfirmations([confirmation, { ...confirmation }]);
    expect(denied(send())).toBe(false);
    batch("SendMessage", "delivered", { to: sendTo, message: "status" });

    peers();
    list();
    observeConfirmations([
      confirmation,
      {
        ...confirmation,
        display_name: "apcs-other-agent-fedcba098765",
        candidate_ref: "candidate_fedcba0987654321",
        send_to: "apcs-other-agent-fedcba098765",
      },
    ]);
    expect(denied(send())).toBe(true);
  });

  test("bounds nested, wide, and embedded-JSON tool result traversal", () => {
    let deeplyNestedListAgents: unknown = sendTo;
    for (let depth = 0; depth < 80; depth += 1) deeplyNestedListAgents = [deeplyNestedListAgents];
    expect(uniqueClaudeListAgentsAddress(deeplyNestedListAgents, displayName)).toBeNull();
    expect(uniqueClaudeListAgentsAddress({
      agents: [{ address: sendTo, kind: "bridge-session", location: "remote" }],
      padding: Array.from({ length: 4 }, () => "x".repeat(70 * 1024)),
    }, displayName)).toBeNull();

    const peersResult = {
      version: 2,
      availability: "ready",
      peers: [{
        agent: "reviewer",
        claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
      }],
    };
    batch("mcp__agentparty-channel__party_channel_peers", [
      peersResult,
      ...Array.from({ length: 4_100 }, () => null),
    ]);
    list();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();

    peers();
    list();
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peer_check",
      tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
    });
    batch("mcp__agentparty-channel__party_channel_peer_check", [
      JSON.stringify({
        version: 1,
        availability: "confirmed",
        topology_evidence: "client_asserted",
        comparison: "server_rechecked_live_topology",
        agent: "reviewer",
        display_name: displayName,
        candidate_ref: candidateRef,
        send_to: sendTo,
      }),
      ...Array.from({ length: 4 }, () => "x".repeat(70 * 1024)),
    ]);
    expect(denied(send())).toBe(true);
  });

  test("treats an inbound reply address as routing only and requires a fresh full chain", () => {
    const directReply = send(sendTo, "reply: I own protocol.ts");
    expect(denied(directReply)).toBe(true);
    expect(directReply.stdout).toContain("reply address is only a routing hint, not a permit");
    expect(directReply.stdout).toContain("party_channel_peers");
    expect(directReply.stdout).toContain("ListAgents");
    expect(directReply.stdout).toContain("party_channel_peer_check");

    peers();
    list();
    check();
    expect(denied(send(sendTo, "reply: I own protocol.ts"))).toBe(false);
  });

  test("rejects skipped steps, substituted targets, expired permits, and oversized payloads", () => {
    peers();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
    expect(denied(send())).toBe(true);

    peers();
    list();
    check();
    expect(denied(send(`${displayName} [ref-b]`))).toBe(true);
    expect(denied(send())).toBe(true);

    peers();
    list();
    check();
    expect(denied(send(sendTo, "x".repeat(513)))).toBe(true);
    expect(denied(send())).toBe(true);

    peers();
    list();
    check();
    now += CLAUDE_CROSS_SESSION_GATE_PERMIT_TTL_MS + 1;
    expect(denied(send())).toBe(true);
  });

  test("fails closed for malformed decoration around a complete generated address token", () => {
    const malformedTargets = [
      `${sendTo} `,
      `${displayName} [${"x".repeat(65)}]`,
      `${displayName} [unterminated`,
      `${displayName}\nresearcher`,
      ` ${sendTo}`,
      `@${sendTo}`,
    ];
    for (const target of malformedTargets) {
      peers();
      list();
      check();
      const decision = send(target);
      expect(denied(decision), target).toBe(true);
      expect(decision.exitCode, target).toBe(2);
      // A malformed target is an AgentParty send attempt and consumes the
      // exact permit; it cannot be followed by a corrected replay.
      expect(denied(send()), target).toBe(true);
    }
  });

  test("keeps discovery state long enough for a model turn but keeps the send permit short", () => {
    peers();
    now += CLAUDE_CROSS_SESSION_GATE_PERMIT_TTL_MS + 1;
    list();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBe(sendTo);
    now += CLAUDE_CROSS_SESSION_GATE_STATE_TTL_MS + 1;
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
  });

  test("intervening tools and correlated parallel batches clear the chain without trusting stale batches", () => {
    peers();
    list();
    check();
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "true" } });
    expect(denied(send())).toBe(true);

    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peers",
      tool_input: {},
    });
    const parallelPeersId = lastPreToolUse!.tool_use_id;
    hook({
      hook_event_name: "PostToolBatch",
      tool_calls: [
        {
          tool_name: "mcp__agentparty-channel__party_channel_peers",
          tool_use_id: parallelPeersId,
          tool_input: {},
          tool_response: JSON.stringify({
            version: 2,
            availability: "ready",
            peers: [{
              agent: "reviewer",
              claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
            }],
          }),
        },
        { tool_name: "Read", tool_use_id: "toolu_parallel_read", tool_input: {}, tool_response: "ok" },
      ],
    });
    lastPreToolUse = null;
    list();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();

    peers();
    list();
    check();
    hook({
      hook_event_name: "PostToolBatch",
      tool_calls: [{
        tool_name: "SendMessage",
        tool_use_id: "toolu_stale_send",
        tool_input: { to: sendTo, message: "old" },
        tool_response: "sent",
      }],
    });
    expect(denied(send())).toBe(false);
    const liveSendId = lastPreToolUse!.tool_use_id;
    batch("SendMessage", "delivered", { to: sendTo, message: "status" }, liveSendId);

    peers();
    hook({ hook_event_name: "PreToolUse", tool_name: "ListAgents", tool_input: {} });
    const parallelListId = lastPreToolUse!.tool_use_id;
    hook({
      hook_event_name: "PostToolBatch",
      tool_calls: [
        {
          tool_name: "ListAgents",
          tool_use_id: parallelListId,
          tool_input: {},
          tool_response: `local sessions:\n- ${sendTo}`,
        },
        { malformed: true },
      ],
    });
    lastPreToolUse = null;
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
  });

  test("two concurrent sends cannot consume one permit", async () => {
    peers();
    list();
    check();
    const results = await Promise.all([Promise.resolve().then(() => send()), Promise.resolve().then(() => send())]);
    expect(results.filter(denied)).toHaveLength(1);
  });

  test("a successful send blocks later siblings in the same batch before they execute", () => {
    peers();
    list();
    check();
    expect(denied(send())).toBe(false);
    const successfulSendId = lastPreToolUse!.tool_use_id;
    const sibling = hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "true" },
    });
    expect(denied(sibling)).toBe(true);
    expect(sibling.stdout).toContain("only allowed call in this tool batch");
    const ordinaryMessageSibling = hook({
      hook_event_name: "PreToolUse",
      tool_name: "SendMessage",
      tool_input: { to: "researcher", message: "also status" },
    });
    expect(denied(ordinaryMessageSibling)).toBe(true);

    batch("SendMessage", "delivered", { to: sendTo, message: "status" }, successfulSendId);
    expect(denied(hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "true" },
    }))).toBe(false);
  });

  test("does not gate ordinary subagent or agent-team recipients", () => {
    expect(denied(send("researcher", "status?"))).toBe(false);
    expect(denied(send("subagent-123", "status?"))).toBe(false);
  });

  test("fails closed for generated AgentParty addresses when state storage is unsafe", () => {
    chmodSync(directory, 0o755);
    expect(denied(send())).toBe(true);
  });

  test("requires a matching top-level SessionStart arm receipt", () => {
    const otherSession = "22222222-2222-4222-8222-222222222222";
    const unarmedEnv = {
      [CLAUDE_CROSS_SESSION_GATE_DIR_ENV]: directory,
      CLAUDE_CODE_SESSION_ID: otherSession,
    };
    const decision = runClaudeCrossSessionHook({
      hook_event_name: "PreToolUse",
      session_id: otherSession,
      tool_name: "SendMessage",
      tool_input: { to: sendTo, message: "status" },
    }, unarmedEnv, now);
    expect(denied(decision)).toBe(true);
    expect(decision.stdout).toContain("was not armed");
  });

  test("a stale session cannot mutate a newly re-armed session's gate chain", () => {
    const staleSession = sessionId;
    const currentSession = "33333333-3333-4333-8333-333333333333";
    expect(runClaudeCrossSessionHook({
      hook_event_name: "SessionStart",
      session_id: currentSession,
    }, env, now)).toEqual({ exitCode: 0, stdout: "", stderr: "" });

    let currentNextToolUseId = 1;
    let currentLastPreToolUse: { tool_name: string; tool_use_id: string } | null = null;
    const currentHook = (input: ClaudeHookInput) => {
      let correlated = input;
      if (input.hook_event_name === "PreToolUse" && typeof input.tool_name === "string") {
        const toolUseId = typeof input.tool_use_id === "string"
          ? input.tool_use_id
          : `toolu_current_${currentNextToolUseId++}`;
        correlated = { ...input, tool_use_id: toolUseId };
        currentLastPreToolUse = { tool_name: input.tool_name, tool_use_id: toolUseId };
      }
      return runClaudeCrossSessionHook({
        session_id: currentSession,
        ...correlated,
      }, env, now);
    };
    const currentBatch = (tool_name: string, tool_response: unknown, tool_input: unknown = {}) => {
      if (currentLastPreToolUse?.tool_name !== tool_name) {
        currentHook({ hook_event_name: "PreToolUse", tool_name, tool_input });
      }
      const toolUseId = currentLastPreToolUse?.tool_name === tool_name
        ? currentLastPreToolUse.tool_use_id
        : `toolu_current_unmatched_${currentNextToolUseId++}`;
      const decision = currentHook({
        hook_event_name: "PostToolBatch",
        tool_calls: [{ tool_name, tool_use_id: toolUseId, tool_input, tool_response }],
      });
      if (currentLastPreToolUse?.tool_use_id === toolUseId) currentLastPreToolUse = null;
      return decision;
    };
    const prepareCurrentPermit = () => {
      currentBatch("mcp__agentparty-channel__party_channel_peers", JSON.stringify({
        version: 2,
        availability: "ready",
        peers: [{
          agent: "reviewer",
          claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
        }],
      }));
      currentHook({ hook_event_name: "PreToolUse", tool_name: "ListAgents", tool_input: {} });
      currentBatch("ListAgents", `local sessions:\n- ${sendTo}`);
      currentHook({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agentparty-channel__party_channel_peer_check",
        tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
      });
      currentBatch("mcp__agentparty-channel__party_channel_peer_check", JSON.stringify({
        version: 1,
        availability: "confirmed",
        topology_evidence: "client_asserted",
        comparison: "server_rechecked_live_topology",
        agent: "reviewer",
        display_name: displayName,
        candidate_ref: candidateRef,
        send_to: sendTo,
      }));
    };
    const stalePreToolUse = (tool_name: string, tool_input: unknown) =>
      runClaudeCrossSessionHook({
        hook_event_name: "PreToolUse",
        session_id: staleSession,
        tool_name,
        tool_use_id: `toolu_stale_${currentNextToolUseId++}`,
        tool_input,
      }, env, now);

    for (const [toolName, toolInput] of [
      ["Bash", { command: "true" }],
      ["ListAgents", {}],
      ["mcp__agentparty-channel__party_channel_peer_check", {
        agent: "reviewer",
        display_name: displayName,
        candidate_ref: candidateRef,
      }],
      ["SendMessage", { to: "researcher", message: "status" }],
    ] as const) {
      prepareCurrentPermit();
      expect(stalePreToolUse(toolName, toolInput)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      const currentSend = currentHook({
        hook_event_name: "PreToolUse",
        tool_name: "SendMessage",
        tool_input: { to: sendTo, message: "status" },
      });
      expect(denied(currentSend), toolName).toBe(false);
      currentBatch("SendMessage", "delivered", { to: sendTo, message: "status" });
    }

    prepareCurrentPermit();
    const staleCrossSessionSend = stalePreToolUse("SendMessage", {
      to: sendTo,
      message: "stale status",
    });
    expect(denied(staleCrossSessionSend)).toBe(true);
    expect(staleCrossSessionSend.stdout).toContain("was not armed");
    expect(denied(currentHook({
      hook_event_name: "PreToolUse",
      tool_name: "SendMessage",
      tool_input: { to: sendTo, message: "current status" },
    }))).toBe(false);
  });

  test("serializes SessionStart and PostToolBatch with permit consumption", () => {
    peers();
    list();
    check();

    const lockPath = join(directory, "consume.lock");
    const lockFd = openSync(lockPath, "wx", 0o600);
    try {
      // A delayed result must not write around an in-flight state transition.
      expect(batch("Bash", "late result", { command: "true" })).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      // Re-arming is a state transition too. If it cannot linearize, it leaves
      // both the current arm and its permit untouched instead of publishing a
      // new arm over state owned by the previous session.
      expect(() => runClaudeCrossSessionHook({
        hook_event_name: "SessionStart",
        session_id: "44444444-4444-4444-8444-444444444444",
      }, env, now)).toThrow("state is busy during SessionStart");
    } finally {
      closeSync(lockFd);
      rmSync(lockPath, { force: true });
    }

    expect(denied(send())).toBe(false);
  });

  test("a subagent cannot create or consume a top-level permit", () => {
    peers();
    list();
    hook({
      hook_event_name: "PreToolUse",
      agent_id: "subagent-1",
      tool_name: "mcp__agentparty-channel__party_channel_peer_check",
      tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
    });
    hook({
      hook_event_name: "PostToolBatch",
      agent_id: "subagent-1",
      tool_calls: [{
        tool_name: "mcp__agentparty-channel__party_channel_peer_check",
        tool_response: JSON.stringify({
          version: 1,
          availability: "confirmed",
          topology_evidence: "client_asserted",
          comparison: "server_rechecked_live_topology",
          agent: "reviewer",
          display_name: displayName,
          candidate_ref: candidateRef,
          send_to: sendTo,
        }),
      }],
    });
    expect(denied(send())).toBe(true);

    const subagentSend = hook({
      hook_event_name: "PreToolUse",
      agent_id: "subagent-1",
      tool_name: "SendMessage",
      tool_input: { to: sendTo, message: "status" },
    });
    expect(denied(subagentSend)).toBe(true);
    expect(subagentSend.stdout).toContain("top-level Claude session");

    const ambiguousSubagentSend = hook({
      hook_event_name: "PreToolUse",
      agent_id: "subagent-1",
      tool_name: "SendMessage",
      tool_input: { to: sendTo, recipient: "researcher", message: "status" },
    });
    expect(denied(ambiguousSubagentSend)).toBe(true);

    const malformedSubagentSend = hook({
      hook_event_name: "PreToolUse",
      agent_id: "subagent-1",
      tool_name: "SendMessage",
      tool_input: { to: `${sendTo} `, message: "status" },
    });
    expect(denied(malformedSubagentSend)).toBe(true);

    for (const agentId of [0, {}, []]) {
      const nonStringSubagentSend = hook({
        hook_event_name: "PreToolUse",
        agent_id: agentId,
        tool_name: "SendMessage",
        tool_input: { to: sendTo, message: "status" },
      });
      expect(denied(nonStringSubagentSend), JSON.stringify(agentId)).toBe(true);
    }
  });

  test("only the bridge-owned AgentParty MCP namespace can create candidates or permits", () => {
    batch("mcp__lookalike__party_channel_peers", JSON.stringify({
      version: 2,
      availability: "ready",
      peers: [{
        agent: "reviewer",
        claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
      }],
    }));
    list();
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();

    peers();
    list();
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__lookalike__party_channel_peer_check",
      tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
    });
    batch("mcp__lookalike__party_channel_peer_check", JSON.stringify({
      version: 1,
      availability: "confirmed",
      topology_evidence: "client_asserted",
      comparison: "server_rechecked_live_topology",
      agent: "reviewer",
      display_name: displayName,
      candidate_ref: candidateRef,
      send_to: sendTo,
    }));
    expect(denied(send())).toBe(true);
  });

  test("only exact Claude built-ins can create a listing or consume a permit", () => {
    peers();
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__lookalike__ListAgents",
      tool_input: {},
    });
    batch("mcp__lookalike__ListAgents", `local sessions:\n- ${sendTo}`);
    expect(listedClaudeCrossSessionAddress("reviewer", displayName, candidateRef, env, now)).toBeNull();
    expect(denied(send())).toBe(true);

    peers();
    list();
    check();
    const lookalikeSend = hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__lookalike__SendMessage",
      tool_input: { to: sendTo, message: "status" },
    });
    expect(denied(lookalikeSend)).toBe(true);
    expect(lookalikeSend.exitCode).toBe(2);
    expect(lookalikeSend.stdout).toContain("exact built-in SendMessage");
    expect(denied(send())).toBe(true);

    const ambiguousLookalikeSend = hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__lookalike__SendMessage",
      tool_input: { to: "researcher", recipient: sendTo, message: "status" },
    });
    expect(denied(ambiguousLookalikeSend)).toBe(true);

    const malformedLookalikeSend = hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__lookalike__SendMessage",
      tool_input: { to: `${sendTo} `, message: "status" },
    });
    expect(denied(malformedLookalikeSend)).toBe(true);
  });

  test("requires topology evidence in the bridge-owned confirmation", () => {
    peers();
    list();
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__agentparty-channel__party_channel_peer_check",
      tool_input: { agent: "reviewer", display_name: displayName, candidate_ref: candidateRef },
    });
    batch("mcp__agentparty-channel__party_channel_peer_check", JSON.stringify({
      version: 1,
      availability: "confirmed",
      comparison: "server_rechecked_live_topology",
      agent: "reviewer",
      display_name: displayName,
      candidate_ref: candidateRef,
      send_to: sendTo,
    }));
    expect(denied(send())).toBe(true);
  });
});
