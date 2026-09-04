import type { PresenceEntry, RuntimePeerDiscovery, RuntimeTopology } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import type { ChannelDO } from "../src/do";
import { WsClient, api, completeCapabilityHello, createChannel, seedToken } from "./helpers";

async function sendStatus(
  ws: WsClient,
  state: "working" | "waiting",
  note: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  ws.send({ type: "send", kind: "status", state, note, mentions: [], ...extra });
  await ws.nextOfType("sent");
  await ws.nextOfType("status");
}

async function presence(slug: string, token: string, name: string): Promise<PresenceEntry> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const rows = ((await res.json()) as { presence: PresenceEntry[] }).presence;
  return rows.find((row) => row.name === name)!;
}

describe("same-name websocket session isolation (#363)", () => {
  it("publishes the v3 purpose and caller-binding contract", async () => {
    const response = await api("/openapi.json", "unused");
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<string, {
        post?: {
          requestBody?: {
            content?: Record<string, { schema?: Record<string, unknown> }>;
          };
          responses?: Record<string, unknown>;
        };
      }>;
    };
    const operation = document.paths["/api/channels/{slug}/runtime-peers"]?.post;
    expect(operation).toBeDefined();
    const schema = operation?.requestBody?.content?.["application/json"]?.schema as {
      required?: string[];
      properties?: Record<string, { enum?: string[] }>;
    } | undefined;
    expect(schema?.required).toEqual(expect.arrayContaining(["topology", "purpose"]));
    expect(schema?.properties?.purpose?.enum).toEqual([
      "topology_advisory",
      "capability_probe",
      "claude_cross_session",
    ]);
    expect(operation?.responses).toHaveProperty("409");
  });

  it("rejects runtime peer discovery for humans and malformed topology", async () => {
    const human = await seedToken("human");
    const agent = await seedToken("agent");
    const slug = await createChannel(human.token);
    const agentSlug = await createChannel(agent.token);
    const malformed = { version: 1, node_ref: "node_raw-hostname" };
    const valid: RuntimeTopology = {
      version: 1,
      node_ref: "node_sameinstall",
      runtime_ref: "runtime_callerrt",
      workspace_ref: "workspace_samerepo",
      worktree_ref: "worktree_sharedtree",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    };
    expect((await api(`/api/channels/${slug}/runtime-peers`, human.token, {
      method: "POST",
      body: JSON.stringify({ topology: valid, purpose: "claude_cross_session" }),
    })).status).toBe(400);
    expect((await api(`/api/channels/${agentSlug}/runtime-peers`, agent.token, {
      method: "POST",
      body: JSON.stringify({ topology: malformed, purpose: "claude_cross_session" }),
    })).status).toBe(400);
  });

  it("compares topology only against live sockets without exposing opaque refs in presence", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const first = await WsClient.open(slug, agent.token);
    const second = await WsClient.open(slug, agent.token);
    await first.nextOfType("welcome");
    await second.nextOfType("welcome");
    const base = {
      version: 1 as const,
      node_ref: "node_sameinstall",
      workspace_ref: "workspace_samerepo",
      peer_scope: "local_installation" as const,
      evidence: "client_asserted" as const,
    };
    first.send({
      type: "hello",
      since: 0,
      runtime_topology: {
        ...base,
        runtime_ref: "runtime_firstone",
        worktree_ref: "worktree_sharedtree",
        harness_session: { harness: "claude", display_name: "first-session" },
      },
    });
    second.send({
      type: "hello",
      since: 0,
      runtime_topology: {
        ...base,
        runtime_ref: "runtime_secondone",
        worktree_ref: "worktree_sharedtree",
        harness_session: { harness: "claude", display_name: "second-session" },
      },
    });
    // The exact {"type":"ping"} frame can be answered by the hibernation
    // auto-response. This decorated ping reaches the per-connection queue, so
    // its pong proves the preceding topology hello has been processed.
    first.send({ type: "ping", barrier: "runtime_topology_hello" });
    second.send({ type: "ping", barrier: "runtime_topology_hello" });
    await first.nextOfType("pong");
    await second.nextOfType("pong");
    await sendStatus(first, "working", "runtime first");
    await sendStatus(second, "waiting", "runtime second");

    const publicPresence = await presence(slug, agent.token, agent.name);
    expect(publicPresence).toMatchObject({ connection_count: 2 });
    expect(publicPresence).not.toHaveProperty("runtime_topologies");
    expect(JSON.stringify(publicPresence)).not.toContain("node_sameinstall");

    const compare = await api(`/api/channels/${slug}/runtime-peers`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        topology: {
          ...base,
          runtime_ref: "runtime_firstone",
          worktree_ref: "worktree_sharedtree",
          harness_session: { harness: "claude", display_name: "first-session" },
        } satisfies RuntimeTopology,
        purpose: "claude_cross_session",
      }),
    });
    expect(compare.status).toBe(200);
    const discovery = (await compare.json()) as RuntimePeerDiscovery;
    expect(discovery).toEqual({
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "live_socket",
      self: agent.name,
      peers: [{
        agent: agent.name,
        same_identity: true,
        relations: [{ relation: "same_worktree", runtime_count: 1 }],
        claude_sessions: [{
          display_name: "second-session",
          relation: "same_worktree",
          runtime_count: 1,
          candidate_ref: expect.stringMatching(/^candidate_[A-Za-z0-9_-]{16,64}$/),
        }],
      }],
    });
    expect(JSON.stringify(discovery)).not.toContain("node_sameinstall");
    expect(JSON.stringify(discovery)).not.toContain("runtime_secondone");
    const firstCandidateRef = discovery.peers[0]!.claude_sessions[0]!.candidate_ref;
    expect(firstCandidateRef).toMatch(/^candidate_[A-Za-z0-9_-]{16,64}$/);

    // Republishing the same topology creates a new live snapshot. The old
    // candidate_ref must not survive and therefore cannot confirm a reused
    // same-name Claude session after ListAgents resolution.
    second.send({
      type: "hello",
      since: 0,
      runtime_topology: {
        ...base,
        runtime_ref: "runtime_secondone",
        worktree_ref: "worktree_sharedtree",
        harness_session: { harness: "claude", display_name: "second-session" },
      },
    });
    second.send({ type: "ping", barrier: "runtime_topology_hello" });
    await second.nextOfType("pong");
    const republished = await api(`/api/channels/${slug}/runtime-peers`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        topology: {
          ...base,
          runtime_ref: "runtime_firstone",
          worktree_ref: "worktree_sharedtree",
          harness_session: { harness: "claude", display_name: "first-session" },
        } satisfies RuntimeTopology,
        purpose: "claude_cross_session",
      }),
    });
    expect(republished.status).toBe(200);
    const republishedDiscovery = (await republished.json()) as RuntimePeerDiscovery;
    expect(republishedDiscovery.peers[0]!.claude_sessions[0]!.candidate_ref)
      .not.toBe(firstCandidateRef);

    second.send({ type: "hello", since: 0 });
    second.send({ type: "ping", barrier: "runtime_topology_hello" });
    await second.nextOfType("pong");
    const cleared = await api(`/api/channels/${slug}/runtime-peers`, agent.token, {
      method: "POST",
      body: JSON.stringify({
        topology: {
          ...base,
          runtime_ref: "runtime_firstone",
          worktree_ref: "worktree_sharedtree",
          harness_session: { harness: "claude", display_name: "first-session" },
        } satisfies RuntimeTopology,
        purpose: "claude_cross_session",
      }),
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as RuntimePeerDiscovery).peers).toEqual([]);

    second.send({
      type: "hello",
      since: 0,
      runtime_topology: {
        ...base,
        runtime_ref: "runtime_secondone",
        worktree_ref: "worktree_sharedtree",
        harness_session: { harness: "claude", display_name: "second-session" },
      },
    });
    second.send({ type: "ping", barrier: "runtime_topology_hello" });
    await second.nextOfType("pong");

    first.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await api(`/api/channels/${slug}/runtime-peers`, agent.token, {
        method: "POST",
        body: JSON.stringify({
          topology: {
            ...base,
            runtime_ref: "runtime_secondone",
            worktree_ref: "worktree_sharedtree",
            harness_session: { harness: "claude", display_name: "second-session" },
          } satisfies RuntimeTopology,
          purpose: "claude_cross_session",
        }),
      });
      const current = (await response.json()) as RuntimePeerDiscovery;
      if (current.peers.length === 0) {
        second.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    second.close();
    throw new Error("disconnected runtime topology remained comparable");
  });

  it("binds Claude session discovery to one exact live caller socket", async () => {
    const caller = await seedToken("agent");
    const peer = await seedToken("agent");
    const slug = await createChannel(caller.token);
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    const callerWs = await WsClient.open(slug, caller.token);
    const peerWs = await WsClient.open(slug, peer.token);
    await callerWs.nextOfType("welcome");
    await peerWs.nextOfType("welcome");
    const callerTopology: RuntimeTopology = {
      version: 1,
      node_ref: "node_callerbinding",
      runtime_ref: "runtime_boundcaller",
      workspace_ref: "workspace_callerbinding",
      worktree_ref: "worktree_callerbinding",
      peer_scope: "local_installation",
      evidence: "client_asserted",
      harness_session: { harness: "claude", display_name: "bound-caller" },
    };
    const peerTopology: RuntimeTopology = {
      ...callerTopology,
      runtime_ref: "runtime_boundpeer",
      harness_session: { harness: "claude", display_name: "bound-peer" },
    };
    callerWs.send({ type: "hello", since: 0, runtime_topology: callerTopology });
    peerWs.send({ type: "hello", since: 0, runtime_topology: peerTopology });
    callerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    peerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    await callerWs.nextOfType("pong");
    await peerWs.nextOfType("pong");

    const call = (topology: RuntimeTopology, purpose: string, token = caller.token) =>
      api(`/api/channels/${slug}/runtime-peers`, token, {
        method: "POST",
        body: JSON.stringify({ topology, purpose }),
      });
    const replayed = await call({ ...callerTopology, runtime_ref: "runtime_stalecaller" }, "claude_cross_session");
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({
      error: { code: "conflict", message: "runtime topology is not bound to one live caller socket" },
      matches: 0,
    });

    const otherToken = await seedToken("agent");
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    expect((await call(callerTopology, "claude_cross_session", otherToken.token)).status).toBe(409);

    const advisory = await call(
      { ...callerTopology, runtime_ref: "runtime_advisoryonly" },
      "topology_advisory",
    );
    expect(advisory.status).toBe(200);
    const advisoryBody = (await advisory.json()) as RuntimePeerDiscovery;
    expect(advisoryBody).toMatchObject({
      version: 3,
      caller_binding: "unbound_advisory",
    });
    expect(advisoryBody.peers.length).toBeGreaterThan(0);
    expect(advisoryBody.peers.every((candidate) => candidate.claude_sessions.length === 0)).toBe(true);

    const expectedProbe = {
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "capability_probe",
      self: caller.name,
      peers: [],
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const probe = await call(
        { ...callerTopology, runtime_ref: "runtime_probeonly" },
        "capability_probe",
      );
      expect(probe.status).toBe(200);
      expect(await probe.json()).toEqual(expectedProbe);
    }
    const liveAfterProbes = await call(callerTopology, "claude_cross_session");
    expect(liveAfterProbes.status).toBe(200);
    expect((await liveAfterProbes.json()) as RuntimePeerDiscovery).toMatchObject({
      caller_binding: "live_socket",
      peers: [{ agent: peer.name, claude_sessions: [{ display_name: "bound-peer" }] }],
    });

    const duplicatePeer = await WsClient.open(slug, peer.token);
    await duplicatePeer.nextOfType("welcome");
    duplicatePeer.send({ type: "hello", since: 0, runtime_topology: peerTopology });
    duplicatePeer.send({ type: "ping", barrier: "runtime_topology_hello" });
    await duplicatePeer.nextOfType("pong");
    const ambiguousTarget = await call(callerTopology, "claude_cross_session");
    expect(ambiguousTarget.status).toBe(200);
    expect((await ambiguousTarget.json()) as RuntimePeerDiscovery).toMatchObject({
      caller_binding: "live_socket",
      peers: [{
        agent: peer.name,
        claude_sessions: [{
          display_name: "bound-peer",
          runtime_count: 1,
          candidate_ref: null,
        }],
      }],
    });
    duplicatePeer.close();

    const duplicateCaller = await WsClient.open(slug, caller.token);
    await duplicateCaller.nextOfType("welcome");
    duplicateCaller.send({ type: "hello", since: 0, runtime_topology: callerTopology });
    duplicateCaller.send({ type: "ping", barrier: "runtime_topology_hello" });
    await duplicateCaller.nextOfType("pong");
    const duplicateCallerResponse = await call(callerTopology, "claude_cross_session");
    expect(duplicateCallerResponse.status).toBe(409);
    expect(await duplicateCallerResponse.json()).toEqual({
      error: { code: "conflict", message: "runtime topology is not bound to one live caller socket" },
      matches: 2,
    });

    callerWs.close();
    duplicateCaller.close();
    peerWs.close();
  });

  it("keeps a differently named agent visible when one resident process shares its runtime ref", async () => {
    const caller = await seedToken("agent");
    const peer = await seedToken("agent");
    const slug = await createChannel(caller.token);
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    const callerWs = await WsClient.open(slug, caller.token);
    const peerWs = await WsClient.open(slug, peer.token);
    await callerWs.nextOfType("welcome");
    await peerWs.nextOfType("welcome");
    const sharedProcessTopology: RuntimeTopology = {
      version: 1,
      node_ref: "node_sharedprocess",
      runtime_ref: "runtime_sharedprocess",
      workspace_ref: "workspace_sharedrepo",
      worktree_ref: "worktree_sharedtree",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    };
    callerWs.send({ type: "hello", since: 0, runtime_topology: sharedProcessTopology });
    peerWs.send({
      type: "hello",
      since: 0,
      runtime_topology: {
        ...sharedProcessTopology,
        harness_session: { harness: "claude", display_name: "resident-peer" },
      },
    });
    callerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    peerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    await callerWs.nextOfType("pong");
    await peerWs.nextOfType("pong");

    const response = await api(`/api/channels/${slug}/runtime-peers`, caller.token, {
      method: "POST",
      body: JSON.stringify({ topology: sharedProcessTopology, purpose: "claude_cross_session" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "live_socket",
      self: caller.name,
      peers: [{
        agent: peer.name,
        same_identity: false,
        relations: [{ relation: "same_worktree", runtime_count: 1 }],
        claude_sessions: [{
          display_name: "resident-peer",
          relation: "same_worktree",
          runtime_count: 1,
          candidate_ref: expect.stringMatching(/^candidate_[A-Za-z0-9_-]{16,64}$/),
        }],
      }],
    });
    callerWs.close();
    peerWs.close();
  });

  it("excludes topology snapshots from sockets that are no longer coordination-ready", async () => {
    const caller = await seedToken("agent");
    const peer = await seedToken("agent");
    const slug = await createChannel(caller.token);
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    const callerWs = await WsClient.open(slug, caller.token);
    const peerWs = await WsClient.open(slug, peer.token);
    await callerWs.nextOfType("welcome");
    await peerWs.nextOfType("welcome");
    const callerTopology: RuntimeTopology = {
      version: 1,
      node_ref: "node_closingpeer",
      runtime_ref: "runtime_livecaller",
      workspace_ref: "workspace_closingpeer",
      worktree_ref: "worktree_closingpeer",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    };
    const peerTopology: RuntimeTopology = {
      ...callerTopology,
      runtime_ref: "runtime_closingpeer",
      harness_session: { harness: "claude", display_name: "closing-peer" },
    };
    callerWs.send({ type: "hello", since: 0, runtime_topology: callerTopology });
    peerWs.send({ type: "hello", since: 0, runtime_topology: peerTopology });
    callerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    peerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    await callerWs.nextOfType("pong");
    await peerWs.nextOfType("pong");

    const compare = async (): Promise<RuntimePeerDiscovery> => {
      const response = await api(`/api/channels/${slug}/runtime-peers`, caller.token, {
        method: "POST",
        body: JSON.stringify({ topology: callerTopology, purpose: "claude_cross_session" }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as RuntimePeerDiscovery;
    };
    expect((await compare()).peers).toHaveLength(1);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    for (const terminalState of [
      { authorizationRevoked: true },
      { upgradeRequired: true },
      { helloExpired: true },
      { helloPending: true },
      { closing: true },
    ]) {
      await runInDurableObject(stub, async (instance: ChannelDO) => {
        for (const connection of instance.getConnections<Record<string, unknown>>()) {
          if (connection.state?.name !== peer.name) continue;
          connection.setState({
            ...connection.state,
            helloPending: false,
            helloExpired: false,
            authorizationRevoked: false,
            upgradeRequired: false,
            closing: false,
            ...terminalState,
          });
        }
      });
      expect((await compare()).peers).toEqual([]);
    }

    await runInDurableObject(stub, async (instance: ChannelDO) => {
      for (const connection of instance.getConnections<Record<string, unknown>>()) {
        if (connection.state?.name !== peer.name) continue;
        connection.setState({
          ...connection.state,
          helloPending: false,
          helloExpired: false,
          authorizationRevoked: false,
          upgradeRequired: false,
          closing: false,
        });
        (instance as unknown as {
          closeRevokedConnection(target: typeof connection): void;
        }).closeRevokedConnection(connection);
        expect(connection.state?.closing).toBe(true);
        expect(connection.state?.authorizationRevoked).toBe(false);
      }
    });

    callerWs.close();
    peerWs.close();
  });

  it("refreshes peer token authority at comparison time and fails closed when it is unknown", async () => {
    const caller = await seedToken("agent");
    const peer = await seedToken("agent");
    const slug = await createChannel(caller.token);
    await env.DB.prepare("UPDATE channels SET visibility = 'public' WHERE slug = ?").bind(slug).run();
    const callerWs = await WsClient.open(slug, caller.token);
    const peerWs = await WsClient.open(slug, peer.token);
    await callerWs.nextOfType("welcome");
    await peerWs.nextOfType("welcome");
    const callerTopology: RuntimeTopology = {
      version: 1,
      node_ref: "node_authorityrefresh",
      runtime_ref: "runtime_authoritycaller",
      workspace_ref: "workspace_authorityrefresh",
      worktree_ref: "worktree_authorityrefresh",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    };
    const peerTopology: RuntimeTopology = {
      ...callerTopology,
      runtime_ref: "runtime_authoritypeer",
      harness_session: { harness: "claude", display_name: "authority-peer" },
    };
    callerWs.send({ type: "hello", since: 0, runtime_topology: callerTopology });
    peerWs.send({ type: "hello", since: 0, runtime_topology: peerTopology });
    callerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    peerWs.send({ type: "ping", barrier: "runtime_topology_hello" });
    await callerWs.nextOfType("pong");
    await peerWs.nextOfType("pong");

    const compare = () => api(`/api/channels/${slug}/runtime-peers`, caller.token, {
      method: "POST",
      body: JSON.stringify({ topology: callerTopology, purpose: "claude_cross_session" }),
    });
    const before = await compare();
    expect(before.status).toBe(200);
    expect(((await before.json()) as RuntimePeerDiscovery).peers).toHaveLength(1);

    await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ?")
      .bind(Date.now(), peer.name)
      .run();
    const after = await compare();
    expect(after.status).toBe(200);
    expect(((await after.json()) as RuntimePeerDiscovery).peers).toEqual([]);
    expect((await peerWs.nextOfType("error")).code).toBe("unauthorized");

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    const unavailable = await runInDurableObject(stub, async (instance: ChannelDO) => {
      const runtime = instance as unknown as {
        tokenActivity(hash: string): Promise<boolean | null>;
      };
      runtime.tokenActivity = async () => null;
      return instance.onRequest(new Request("https://do/internal/runtime-peers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ap-name": caller.name,
          "x-ap-token-hash": await sha256Hex(caller.token),
        },
        body: JSON.stringify({ topology: callerTopology, purpose: "claude_cross_session" }),
      }));
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: { code: "unavailable", message: "runtime peer authorization is temporarily unavailable" },
    });

    callerWs.close();
    peerWs.close();
  });

  it("persists an agent-reported model session in presence for restart resume (#522)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    await sendStatus(ws, "waiting", "ready");

    ws.send({
      type: "heartbeat",
      current_task: null,
      task_started_at: null,
      heartbeat_at: null,
      agent_session: {
        harness: "codex",
        session_id: "019f35d9-0000-7000-8000-000000000522",
        updated_at: 1_700_000_000_000,
        cwd: "/workspace/agentparty",
        workdir: "/home/agent/.agentparty/runners/test",
      },
    });
    await ws.nextOfType("presence");

    expect(await presence(slug, agent.token, agent.name)).toMatchObject({
      agent_session: {
        harness: "codex",
        session_id: "019f35d9-0000-7000-8000-000000000522",
        updated_at: 1_700_000_000_000,
        cwd: "/workspace/agentparty",
        workdir: "/home/agent/.agentparty/runners/test",
      },
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const row = state.storage.sql
        .exec("SELECT agent_session_json FROM presence WHERE name = ?", agent.name)
        .one();
      expect(JSON.parse(String(row.agent_session_json))).toMatchObject({ harness: "codex" });
    });
    ws.close();
  });

  it("accepts an interactive agent session on a normal status frame (#522)", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const ws = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(ws);
    await sendStatus(ws, "working", "interactive session", {
      agent_session: {
        harness: "claude",
        session_id: "019f35d9-0000-7000-8000-000000000523",
        updated_at: 1_700_000_000_001,
        cwd: "/workspace/manual",
      },
    });

    expect(await presence(slug, agent.token, agent.name)).toMatchObject({
      state: "working",
      agent_session: {
        harness: "claude",
        session_id: "019f35d9-0000-7000-8000-000000000523",
        cwd: "/workspace/manual",
      },
    });
    ws.close();
  });

  it("keeps status, busy, and task state per connection while aggregating the active session", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const working = await WsClient.open(slug, agent.token);
    const waiting = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(working);
    await completeCapabilityHello(waiting);

    await sendStatus(working, "working", "reviewing do.ts", { busy: true, queue_depth: 2 });
    working.send({ type: "heartbeat", current_task: 363, task_started_at: 1000, heartbeat_at: 2000 });
    await working.nextOfType("presence");
    await sendStatus(waiting, "waiting", "idle");

    const aggregate = await presence(slug, agent.token, agent.name);
    expect(aggregate).toMatchObject({
      state: "working",
      note: "reviewing do.ts",
      busy: true,
      queue_depth: 2,
      current_task: 363,
      connection_count: 2,
    });

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const rows = state.storage.sql
        .exec(
          "SELECT session_id, state, note, busy, current_task FROM presence WHERE name = ? ORDER BY state",
          agent.name,
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => String(row.session_id))).size).toBe(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "waiting", note: "idle", busy: 0, current_task: null }),
          expect.objectContaining({ state: "working", note: "reviewing do.ts", busy: 1, current_task: 363 }),
        ]),
      );
    });

    working.close();
    waiting.close();
  });

  it("removes only the disconnected session and re-aggregates to the surviving session", async () => {
    const agent = await seedToken("agent");
    const observer = await seedToken("human");
    const slug = await createChannel(agent.token);
    const watcher = await WsClient.open(slug, observer.token);
    const working = await WsClient.open(slug, agent.token);
    const waiting = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(watcher);
    await completeCapabilityHello(working);
    await completeCapabilityHello(waiting);

    await sendStatus(working, "working", "session A", { busy: true });
    await sendStatus(waiting, "waiting", "session B");
    working.close();

    for (;;) {
      const frame = await watcher.nextOfType("presence");
      if (frame.name === agent.name && frame.note === "session B") {
        expect(frame.state).toBe("waiting");
        expect(frame).not.toHaveProperty("busy");
        expect(frame).not.toHaveProperty("current_task");
        break;
      }
    }

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const states = state.storage.sql
        .exec("SELECT state FROM presence WHERE name = ? ORDER BY state", agent.name)
        .toArray()
        .map((row) => String(row.state));
      expect(states).toEqual(["waiting"]);
    });

    waiting.close();
    watcher.close();
  });

  it("stores read cursors per connection and exposes the identity maximum", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    const first = await WsClient.open(slug, agent.token);
    const second = await WsClient.open(slug, agent.token);
    await completeCapabilityHello(first);
    await completeCapabilityHello(second);

    first.send({ type: "send", kind: "message", body: "m1", mentions: [], reply_to: null });
    const s1 = (await first.nextOfType("sent")).seq;
    first.send({ type: "send", kind: "message", body: "m2", mentions: [], reply_to: null });
    const s2 = (await first.nextOfType("sent")).seq;

    first.send({ type: "seen", seq: s2 });
    await first.nextOfType("read_cursor");
    second.send({ type: "seen", seq: s1 });

    const res = await api(`/api/channels/${slug}/read-cursors`, agent.token);
    const cursors = ((await res.json()) as { cursors: Array<{ name: string; last_seen_seq: number }> }).cursors;
    expect(cursors.filter((row) => row.name === agent.name)).toEqual([
      expect.objectContaining({ name: agent.name, last_seen_seq: s2 }),
    ]);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, async (_instance: ChannelDO, state) => {
      const rows = state.storage.sql
        .exec("SELECT session_id, last_seen_seq FROM read_cursor WHERE name = ? ORDER BY last_seen_seq", agent.name)
        .toArray();
      expect(rows.map((row) => Number(row.last_seen_seq))).toEqual([s1, s2]);
      expect(new Set(rows.map((row) => String(row.session_id))).size).toBe(2);
    });

    first.close();
    second.close();
  });
});

describe("session schema compatibility migration (#363)", () => {
  it("migrates legacy name-keyed presence and read_cursor rows without data loss", async () => {
    const agent = await seedToken("agent");
    const slug = await createChannel(agent.token);
    expect((await api(`/api/channels/${slug}/presence`, agent.token)).status).toBe(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    await runInDurableObject(stub, async (instance: ChannelDO, state) => {
      state.storage.sql.exec("DROP TABLE presence");
      state.storage.sql.exec(`CREATE TABLE presence (
        name TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        note TEXT,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        "INSERT INTO presence (name, state, note, updated_at) VALUES (?, 'working', 'legacy task', 1234)",
        agent.name,
      );
      state.storage.sql.exec("DROP TABLE read_cursor");
      state.storage.sql.exec(`CREATE TABLE read_cursor (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        last_seen_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec(
        "INSERT INTO read_cursor (name, kind, last_seen_seq, updated_at) VALUES (?, 'agent', 7, 1234)",
        agent.name,
      );

      instance.onStart();

      const presenceRows = state.storage.sql
        .exec("SELECT name, session_id, state, note, updated_at FROM presence WHERE name = ?", agent.name)
        .toArray();
      expect(presenceRows).toEqual([
        expect.objectContaining({ name: agent.name, state: "working", note: "legacy task", updated_at: 1234 }),
      ]);
      expect(String(presenceRows[0]!.session_id)).not.toBe("");

      const cursorRows = state.storage.sql
        .exec("SELECT name, session_id, kind, last_seen_seq, updated_at FROM read_cursor WHERE name = ?", agent.name)
        .toArray();
      expect(cursorRows).toEqual([
        expect.objectContaining({ name: agent.name, kind: "agent", last_seen_seq: 7, updated_at: 1234 }),
      ]);

      const presencePk = state.storage.sql
        .exec("PRAGMA table_info(presence)")
        .toArray()
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name));
      expect(presencePk).toEqual(["name", "session_id"]);
      const cursorPk = state.storage.sql
        .exec("PRAGMA table_info(read_cursor)")
        .toArray()
        .filter((row) => Number(row.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((row) => String(row.name));
      expect(cursorPk).toEqual(["name", "session_id"]);
    });

    const migratedPresence = await presence(slug, agent.token, agent.name);
    expect(migratedPresence).toMatchObject({ state: "working", note: "legacy task", ts: 1234 });
    const cursorRes = await api(`/api/channels/${slug}/read-cursors`, agent.token);
    const cursorBody = (await cursorRes.json()) as { cursors: Array<{ name: string; last_seen_seq: number }> };
    expect(cursorBody.cursors).toContainEqual(expect.objectContaining({ name: agent.name, last_seen_seq: 7 }));
  });
});
