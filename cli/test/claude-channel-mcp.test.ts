import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientFrame } from "@agentparty/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryFrame, welcomeDirectedFrame } from "./mock-server";
import { CLAUDE_CROSS_SESSION_GATE_DIR_ENV, runClaudeCrossSessionHook } from "../src/claude-cross-session-gate";
import { CLAUDE_LIFECYCLE_OPT_IN_ENV } from "../src/commands/claude-launch";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

let home: string;
let backend: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-claude-channel-mcp-"));
});

afterEach(() => {
  backend?.stop(true);
  backend = null;
  rmSync(home, { recursive: true, force: true });
});

describe("claude-channel stdio MCP adapter", () => {
  test("stays dormant without explicit Marketplace launch opt-in", async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "AGENTPARTY_CLAUDE_CHANNEL_OPT_IN") env[key] = value;
    }
    env.AGENTPARTY_HOME = home;
    // `party bridge claude` arms lifecycle hooks but owns a separate Channel
    // MCP. Lifecycle opt-in alone must never wake the Marketplace listener.
    env[CLAUDE_LIFECYCLE_OPT_IN_ENV] = "1";
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", indexPath, "claude-channel", "--require-launch-opt-in"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "dormant-channel-test", version: "1.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerCapabilities()?.experimental).toBeUndefined();
      expect(client.getInstructions()).toBeUndefined();
      expect(existsSync(join(home, "instances"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("declares the dedicated capability, emits a channel notification, and persists a linked reply", async () => {
    const clientFrames: ClientFrame[] = [];
    const posts: unknown[] = [];
    const deliveryAcks: string[] = [];
    const runtimePeerRequests: unknown[] = [];
    let comparisonUnavailable = false;
    let presenceUnavailable = false;
    const directed = deliveryFrame(12, "same-session work", {
      id: "delivery-12",
      target_name: "me",
      sender: { name: "alice", kind: "human" },
    });
    const noReplyDirected = deliveryFrame(13, "confirmation needs no response", {
      id: "delivery-13",
      target_name: "me",
      sender: { name: "bob", kind: "agent" },
    });
    let sentNoReplyDelivery = false;
    backend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, server) {
        const url = new URL(request.url);
        if (url.pathname === "/api/channels/dev/ws" && server.upgrade(request, { data: undefined })) return;
        if (url.pathname === "/api/channels/dev/messages" && request.method === "POST") {
          posts.push(await request.json());
          return Response.json({ seq: 99 });
        }
        if (url.pathname === "/api/channels/dev/deliveries/delivery-13/ack" && request.method === "POST") {
          deliveryAcks.push("delivery-13");
          return Response.json({
            ok: true,
            delivery: { ...noReplyDirected.delivery, state: "replied", reply_seq: null },
          });
        }
        if (url.pathname === "/api/channels/dev/runtime-peers" && request.method === "POST") {
          runtimePeerRequests.push(await request.clone().json());
          if (comparisonUnavailable) {
            return Response.json(
              { error: { code: "temporarily_unavailable", message: "upstream detail must not leak" } },
              { status: 503 },
            );
          }
          return Response.json({
            version: 3,
            topology_evidence: "client_asserted",
            comparison: "server_derived",
            caller_binding: "live_socket",
            self: "me",
            peers: [{
              agent: "reviewer",
              same_identity: false,
              relations: [{ relation: "same_worktree", runtime_count: 1 }],
              claude_sessions: [{
                display_name: "apcs-review-session-a1b2c3d4e5f6",
                relation: "same_worktree",
                runtime_count: 1,
                candidate_ref: "candidate_1234567890abcdef",
              }],
            }],
          });
        }
        if (url.pathname === "/api/channels/dev/presence" && request.method === "GET") {
          if (presenceUnavailable) {
            return Response.json(
              { error: { code: "temporarily_unavailable", message: "presence detail must not leak" } },
              { status: 503 },
            );
          }
          return Response.json({
            presence: [
              { name: "me", kind: "agent", state: "working", note: null, ts: Date.now(), live: true },
              { name: "reviewer", kind: "agent", state: "working", note: "checking API", ts: Date.now(), live: true },
              { name: "remote", kind: "agent", state: "working", note: null, ts: Date.now(), live: true },
              { name: "member", kind: "human", state: "working", note: null, ts: Date.now(), live: true },
            ],
          });
        }
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      },
      websocket: {
        message(socket, raw) {
          const frame = JSON.parse(String(raw)) as ClientFrame;
          clientFrames.push(frame);
          if (frame.type === "hello") {
            socket.send(JSON.stringify(welcomeDirectedFrame(0, "me")));
          } else if (frame.type === "delivery_adapter") {
            socket.send(JSON.stringify({ type: "delivery_adapter", adapter: "watch", registered: true }));
            socket.send(JSON.stringify(directed));
          } else if (frame.type === "delivery_update" && frame.request_id) {
            const delivery = frame.delivery_id === "delivery-13"
              ? noReplyDirected.delivery
              : directed.delivery;
            socket.send(JSON.stringify({
              type: "delivery_state",
              request_id: frame.request_id,
              delivery: {
                ...delivery,
                state: frame.state,
                reply_seq: frame.reply_seq ?? delivery.reply_seq,
              },
            }));
            if (
              frame.delivery_id === "delivery-12" &&
              frame.state === "replied" &&
              !sentNoReplyDelivery
            ) {
              sentNoReplyDelivery = true;
              socket.send(JSON.stringify(noReplyDirected));
            }
          }
        },
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ server: `http://127.0.0.1:${backend.port}`, token: "ap_tok" }),
    );

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "AGENTPARTY_CONFIG") env[key] = value;
    }
    env.AGENTPARTY_HOME = home;
    const gateDirectory = join(home, "cross-session-gate");
    mkdirSync(gateDirectory, { mode: 0o700 });
    env[CLAUDE_CROSS_SESSION_GATE_DIR_ENV] = gateDirectory;
    const sessionId = "33333333-3333-4333-8333-333333333333";
    env.CLAUDE_CODE_SESSION_ID = sessionId;
    const transport = new StdioClientTransport({
      command: "bun",
      args: [
        "run", indexPath, "claude-channel", "--channel", "dev",
        "--claude-session-name", "apcs-me-session-f1e2d3c4b5a6",
      ],
      env,
      stderr: "pipe",
    });
    const notifications: Array<{ method: string; params?: unknown }> = [];
    let notify!: (value: void) => void;
    const received = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const client = new Client({ name: "claude-channel-contract-test", version: "1.0.0" });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
      if (notification.method === "notifications/claude/channel") notify();
    };

    await client.connect(transport);
    try {
      expect(client.getServerCapabilities()?.experimental).toMatchObject({
        "claude/channel": {},
      });
      expect(client.getInstructions()).toContain("party_channel_claim");
      expect(client.getInstructions()).toContain("party_channel_accept");
      expect(client.getInstructions()).toContain("party_channel_reply");
      expect(client.getInstructions()).toContain("party_channel_peers");
      expect(client.getInstructions()).toContain("party_channel_peer_check");
      expect(client.getInstructions()).toContain("ListAgents");
      expect(client.getInstructions()).toContain("SendMessage");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "party_channel_claim",
        "party_channel_accept",
        "party_channel_peers",
        "party_channel_peer_check",
        "party_channel_reply",
      ]);

      await Promise.race([
        received,
        new Promise((_, reject) => setTimeout(() => reject(new Error("channel notification timeout")), 3_000)),
      ]);
      const channelEvent = notifications.find((entry) => entry.method === "notifications/claude/channel");
      expect(channelEvent?.params).toMatchObject({
        content: expect.stringContaining("execution_id=delivery-12"),
        meta: {
          source: "agentparty",
          channel: "dev",
          seq: "12",
          sender: "alice",
          sender_kind: "human",
          delivery_id: "delivery-12",
          execution_id: "delivery-12",
        },
      });
      expect(JSON.stringify(channelEvent?.params)).not.toContain("same-session work");

      const unarmedPeers = await client.callTool({
        name: "party_channel_peers",
        arguments: {},
      });
      expect(JSON.stringify(unarmedPeers.content)).toContain('\\"availability\\":\\"local_gate_unarmed\\"');
      expect(runtimePeerRequests).toHaveLength(0);

      runClaudeCrossSessionHook({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }, env);

      const hookEnv = {
        [CLAUDE_CROSS_SESSION_GATE_DIR_ENV]: gateDirectory,
        CLAUDE_CODE_SESSION_ID: sessionId,
      };
      runClaudeCrossSessionHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "mcp__agentparty-channel__party_channel_peers",
        tool_use_id: "toolu_mcp_peers",
        tool_input: {},
      }, hookEnv);
      const peers = await client.callTool({
        name: "party_channel_peers",
        arguments: {},
      });
      expect(peers.isError).not.toBe(true);
      const peerItems = Array.isArray(peers.content)
        ? peers.content as Array<{ type?: unknown; text?: unknown }>
        : [];
      const peerContent = peerItems
        .flatMap((item) => item.type === "text" && typeof item.text === "string" ? [item.text] : [])
        .join("\n");
      expect(peerContent).toContain('"self":"me"');
      expect(peerContent).toContain('"availability":"ready"');
      expect(peerContent).toContain('"topology_evidence":"client_asserted"');
      expect(peerContent).toContain('"enforcement":"advisory"');
      expect(peerContent).toContain('"max_utf8_bytes":512');
      expect(peerContent).toContain('"agent":"reviewer"');
      expect(peerContent).toContain('"same_identity":false');
      expect(peerContent).toContain('"coordination":{"risk":"write_collision","urgency":"immediate","action":"negotiate_single_writer"}');
      expect(peerContent).toContain('"claude_sessions":[{"display_name":"apcs-review-session-a1b2c3d4e5f6","relation":"same_worktree","runtime_count":1,"candidate_ref":"candidate_1234567890abcdef","name_unique_among_hints":true,"pre_send_check_required":true,"coordination":{"risk":"write_collision","urgency":"immediate","action":"negotiate_single_writer"}}]');
      // The earlier unarmed lookup must not consume the one bounded startup
      // settling window. Once armed and identified, the first eligible peers
      // call takes four snapshots (0/100/350/850 ms).
      expect(runtimePeerRequests).toHaveLength(4);
      expect(runtimePeerRequests.every((body) => (
        typeof body === "object" && body !== null &&
        (body as { purpose?: unknown }).purpose === "claude_cross_session"
      ))).toBe(true);

      runClaudeCrossSessionHook({
        hook_event_name: "PostToolBatch",
        session_id: sessionId,
        tool_calls: [{
          tool_name: "mcp__agentparty-channel__party_channel_peers",
          tool_use_id: "toolu_mcp_peers",
          tool_response: peerContent,
        }],
      }, hookEnv);
      runClaudeCrossSessionHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "ListAgents",
        tool_use_id: "toolu_mcp_list",
        tool_input: {},
      }, hookEnv);
      runClaudeCrossSessionHook({
        hook_event_name: "PostToolBatch",
        session_id: sessionId,
        tool_calls: [{
          tool_name: "ListAgents",
          tool_use_id: "toolu_mcp_list",
          tool_response: "apcs-review-session-a1b2c3d4e5f6 [ref-a]",
        }],
      }, hookEnv);

      runClaudeCrossSessionHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "mcp__agentparty-channel__party_channel_peer_check",
        tool_use_id: "toolu_mcp_check",
        tool_input: {
          agent: "reviewer",
          display_name: "apcs-review-session-a1b2c3d4e5f6",
          candidate_ref: "candidate_1234567890abcdef",
        },
      }, hookEnv);
      const confirmedPeer = await client.callTool({
        name: "party_channel_peer_check",
        arguments: {
          agent: "reviewer",
          display_name: "apcs-review-session-a1b2c3d4e5f6",
          candidate_ref: "candidate_1234567890abcdef",
        },
      });
      expect(JSON.stringify(confirmedPeer.content)).toContain('\\\"availability\\\":\\\"confirmed\\\"');
      expect(JSON.stringify(confirmedPeer.content)).toContain('\\\"send_to\\\":\\\"apcs-review-session-a1b2c3d4e5f6 [ref-a]\\\"');
      expect(runtimePeerRequests).toHaveLength(5);
      expect(runtimePeerRequests[4]).toMatchObject({ purpose: "claude_cross_session" });

      runClaudeCrossSessionHook({
        hook_event_name: "PostToolBatch",
        session_id: sessionId,
        tool_calls: [{
          tool_name: "mcp__agentparty-channel__party_channel_peer_check",
          tool_use_id: "toolu_mcp_check",
          tool_response: confirmedPeer.content,
        }],
      }, hookEnv);

      runClaudeCrossSessionHook({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "mcp__agentparty-channel__party_channel_peer_check",
        tool_use_id: "toolu_mcp_stale_check",
        tool_input: {
          agent: "reviewer",
          display_name: "apcs-review-session-a1b2c3d4e5f6",
          candidate_ref: "candidate_abcdefghijklmnop",
        },
      }, hookEnv);
      const stalePeer = await client.callTool({
        name: "party_channel_peer_check",
        arguments: {
          agent: "reviewer",
          display_name: "apcs-review-session-a1b2c3d4e5f6",
          candidate_ref: "candidate_abcdefghijklmnop",
        },
      });
      expect(JSON.stringify(stalePeer.content)).toContain('\\\"availability\\\":\\\"stale_or_ambiguous\\\"');
      expect(runtimePeerRequests).toHaveLength(6);
      expect(peerContent).toContain('"relation":"same_worktree"');
      expect(peerContent).not.toContain('"agent":"remote"');
      expect(peerContent).not.toContain('"agent":"member"');
      expect(peerContent).not.toContain("node_sharednode");

      comparisonUnavailable = true;
      const unavailablePeers = await client.callTool({
        name: "party_channel_peers",
        arguments: {},
      });
      expect(unavailablePeers.isError).not.toBe(true);
      const unavailableContent = JSON.stringify(unavailablePeers.content);
      expect(unavailableContent).toContain('\\"availability\\":\\"comparison_unavailable\\"');
      expect(unavailableContent).toContain('\\"peers\\":[]');
      expect(unavailableContent).not.toContain("upstream detail must not leak");
      expect(runtimePeerRequests).toHaveLength(7);

      comparisonUnavailable = false;
      presenceUnavailable = true;
      const noPresencePeers = await client.callTool({
        name: "party_channel_peers",
        arguments: {},
      });
      const noPresenceContent = JSON.stringify(noPresencePeers.content);
      expect(noPresenceContent).toContain('\\"availability\\":\\"presence_unavailable\\"');
      expect(noPresenceContent).toContain('\\"peers\\":[]');
      expect(noPresenceContent).not.toContain("presence detail must not leak");
      expect(runtimePeerRequests).toHaveLength(8);

      const unclaimedReply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 12, text: "must not persist before claim" },
      });
      expect(unclaimedReply.isError).toBe(true);
      expect(posts).toEqual([]);

      const claim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-12" },
      });
      expect(claim.isError).not.toBe(true);
      const claimContent = JSON.stringify(claim.content);
      expect(claimContent).toContain("same-session work");
      const receipt = /AgentParty claim receipt: ([0-9a-f-]+)/.exec(claimContent)?.[1];
      expect(typeof receipt).toBe("string");

      // Model an MCP response lost after the claim WAL commit. Until accept,
      // an equivalent retry must return the exact same receipt and body.
      const duplicateClaim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-12" },
      });
      expect(duplicateClaim.isError).not.toBe(true);
      expect(duplicateClaim.content).toEqual(claim.content);

      const preAcceptReply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 12, text: "must not persist before accept" },
      });
      expect(preAcceptReply.isError).toBe(true);
      expect(JSON.stringify(preAcceptReply.content)).toContain("accepted");
      expect(posts).toEqual([]);

      const wrongReceipt = await client.callTool({
        name: "party_channel_accept",
        arguments: {
          execution_id: "delivery-12",
          claim_receipt: "receipt-from-an-old-generation",
        },
      });
      expect(wrongReceipt.isError).toBe(true);
      expect(JSON.stringify(wrongReceipt.content)).toContain(
        "invalid or belongs to an old ownership generation",
      );

      const accept = await client.callTool({
        name: "party_channel_accept",
        arguments: { execution_id: "delivery-12", claim_receipt: receipt! },
      });
      expect(accept.isError).not.toBe(true);
      expect(JSON.stringify(accept.content)).toContain("durably accepted");

      // Model the accept ACK being lost after its WAL commit. The exact retry
      // is a successful no-op, and a later claim cannot release the body again.
      const duplicateAccept = await client.callTool({
        name: "party_channel_accept",
        arguments: { execution_id: "delivery-12", claim_receipt: receipt! },
      });
      expect(duplicateAccept.isError).not.toBe(true);
      expect(JSON.stringify(duplicateAccept.content)).toContain("already durably accepted");
      const postAcceptClaim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-12" },
      });
      expect(postAcceptClaim.isError).toBe(true);
      expect(JSON.stringify(postAcceptClaim.content)).toContain("already accepted");
      expect(JSON.stringify(postAcceptClaim.content)).not.toContain("same-session work");

      const reply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 12, text: "linked response" },
      });
      expect(reply.isError).not.toBe(true);
      expect(posts).toEqual([expect.objectContaining({
        kind: "message",
        body: "linked response",
        mentions: ["alice"],
        reply_to: 12,
        idempotency_key: "claude-channel-reply:delivery-12",
      })]);
      expect(clientFrames).toContainEqual(expect.objectContaining({
        type: "delivery_update",
        delivery_id: "delivery-12",
        state: "running",
      }));
      expect(clientFrames).toContainEqual(expect.objectContaining({
        type: "delivery_update",
        delivery_id: "delivery-12",
        state: "replied",
        reply_seq: 99,
      }));

      for (let attempt = 0; attempt < 50 && notifications.length < 2; attempt += 1) {
        await Bun.sleep(20);
      }
      expect(notifications).toHaveLength(2);
      const noReplyClaim = await client.callTool({
        name: "party_channel_claim",
        arguments: { execution_id: "delivery-13" },
      });
      const noReplyReceipt = /AgentParty claim receipt: ([0-9a-f-]+)/
        .exec(JSON.stringify(noReplyClaim.content))?.[1];
      expect(typeof noReplyReceipt).toBe("string");
      expect((await client.callTool({
        name: "party_channel_accept",
        arguments: { execution_id: "delivery-13", claim_receipt: noReplyReceipt! },
      })).isError).not.toBe(true);

      // The legacy marker is normalized into a terminal delivery ACK. It must
      // not become another channel message that wakes bob and starts a loop.
      const noReply = await client.callTool({
        name: "party_channel_reply",
        arguments: { seq: 13, text: "NO_REPLY" },
      });
      expect(noReply.isError).not.toBe(true);
      expect(JSON.stringify(noReply.content)).toContain("acknowledged_no_reply");
      expect(deliveryAcks).toEqual(["delivery-13"]);
      expect(posts).toHaveLength(1);
      expect(clientFrames).not.toContainEqual(expect.objectContaining({
        type: "delivery_update",
        delivery_id: "delivery-13",
        state: "replied",
      }));

      const stopGuard = Bun.spawn(["bun", "run", indexPath, "hook", "stop-guard"], {
        env: {
          ...env,
          AGENTPARTY_CHANNEL: "dev",
          [CLAUDE_LIFECYCLE_OPT_IN_ENV]: "1",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      stopGuard.stdin.write(JSON.stringify({
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "no-reply-stop",
        cwd: process.cwd(),
      }));
      stopGuard.stdin.end();
      const [stopCode, stopOutput] = await Promise.all([
        stopGuard.exited,
        new Response(stopGuard.stdout).text(),
      ]);
      expect(stopCode).toBe(0);
      expect(stopOutput).toBe("{}\n");
    } finally {
      await client.close();
    }
  }, 10_000);
});
