import { describe, expect, test } from "bun:test";

import {
  assertRuntimeTopologyRefsRedacted,
  chooseRuntimeSmokeChannel,
  openRuntimeTopologySocket,
  resolveRuntimeSmokeTarget,
  validateRuntimeCapabilityResponse,
  validateRuntimeLiveTopologyResponse,
  verifyRuntimePeersCapability,
  verifyRuntimePeersLiveTopology,
  verifyRuntimeSmokeCredentials,
} from "../worker/scripts/smoke-runtime-peers.mjs";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function liveTopologyResponse(displayName: string) {
  return {
    version: 3,
    topology_evidence: "client_asserted",
    comparison: "server_derived",
    caller_binding: "live_socket",
    self: "smoke-agent",
    peers: [{
      agent: "smoke-agent",
      same_identity: true,
      relations: [{ relation: "same_local_installation", runtime_count: 1 }],
      claude_sessions: [{
        display_name: displayName,
        relation: "same_local_installation",
        runtime_count: 1,
        candidate_ref: "candidate_1234567890abcdef",
      }],
    }],
  };
}

describe("runtime-peers production smoke", () => {
  test("uses an agent-scoped accessible channel and proves the exact v3 no-peer contract", async () => {
    const requests: Request[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(request);
      if (request.url.endsWith("/api/me")) {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (request.url.endsWith("/api/channels")) {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      if (request.url.endsWith("/api/channels/dev/runtime-peers")) {
        return jsonResponse({
          version: 3,
          topology_evidence: "client_asserted",
          comparison: "server_derived",
          caller_binding: "capability_probe",
          self: "smoke-agent",
          peers: [],
        });
      }
      return jsonResponse({ error: "not_found" }, 404);
    };

    await expect(verifyRuntimePeersCapability({
      base: "https://party.example/",
      token: "secret-token",
      fetchImpl,
    })).resolves.toEqual({
      ok: true,
      mode: "capability_probe",
      protocol_version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "capability_probe",
      identity_verified: true,
      channel_access_verified: true,
      protocol_checked: true,
      peers_returned: 0,
    });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer secret-token")).toBe(true);
    const payload = await requests[2]!.json() as {
      purpose: string;
      topology: Record<string, unknown>;
    };
    expect(payload.purpose).toBe("capability_probe");
    expect(payload.topology).toMatchObject({
      version: 1,
      peer_scope: "local_installation",
      evidence: "client_asserted",
    });
    expect(payload.topology).not.toHaveProperty("harness_session");
    for (const [key, prefix] of [
      ["node_ref", "node_"],
      ["runtime_ref", "runtime_"],
      ["workspace_ref", "workspace_"],
      ["worktree_ref", "worktree_"],
    ] as const) {
      expect(payload.topology[key]).toMatch(new RegExp(`^${prefix}[a-f0-9]{32}$`));
    }
  });

  test("credentials-only mode proves agent identity and channel access without calling runtime-peers", async () => {
    const paths: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      paths.push(url.pathname);
      if (url.pathname === "/api/me") {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (url.pathname === "/api/channels") {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      return jsonResponse({ error: "unexpected" }, 500);
    };
    const options = {
      base: "https://party.example",
      token: "secret-token",
      fetchImpl,
    };
    await expect(resolveRuntimeSmokeTarget(options)).resolves.toEqual({
      base: "https://party.example",
      identityName: "smoke-agent",
      channel: "dev",
    });
    paths.length = 0;
    await expect(verifyRuntimeSmokeCredentials(options)).resolves.toEqual({
      ok: true,
      mode: "credentials_only",
      identity_verified: true,
      channel_access_verified: true,
      websocket_client_available: true,
      protocol_checked: false,
    });
    expect(paths).toEqual(["/api/me", "/api/channels"]);
  });

  test("rejects a deploy environment without a WebSocket client before credential requests", async () => {
    let calls = 0;
    await expect(verifyRuntimeSmokeCredentials({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
      WebSocketImpl: null as unknown as typeof WebSocket,
    })).rejects.toThrow("deploy preflight requires a WebSocket client");
    expect(calls).toBe(0);
  });

  test("requires an agent identity before probing a channel", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ name: "human", kind: "human" });
    };
    await expect(verifyRuntimePeersCapability({
      base: "https://party.example",
      token: "human-token",
      fetchImpl,
    })).rejects.toThrow("must resolve to one named AgentParty agent");
    expect(calls).toBe(1);
  });

  test("bounds every deployment smoke request instead of hanging the release indefinitely", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      if (!(init?.signal instanceof AbortSignal)) throw new Error("missing abort signal");
      signals.push(init.signal);
      return jsonResponse({ name: "human", kind: "human" });
    };
    await expect(verifyRuntimeSmokeCredentials({
      base: "https://party.example",
      token: "human-token",
      fetchImpl,
      requestTimeoutMs: 25,
    })).rejects.toThrow("must resolve to one named AgentParty agent");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);

    await expect(verifyRuntimeSmokeCredentials({
      base: "https://party.example",
      token: "human-token",
      fetchImpl,
      requestTimeoutMs: 0,
    })).rejects.toThrow("request timeout must be a positive integer");

    const hangingFetch: FetchLike = async (_input, init) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("missing abort signal");
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      });
    };
    await expect(verifyRuntimeSmokeCredentials({
      base: "https://party.example",
      token: "human-token",
      fetchImpl: hangingFetch,
      requestTimeoutMs: 5,
    })).rejects.toThrow("runtime smoke identity: request timed out after 5ms");
  });

  test("rejects a non-origin or insecure remote smoke base before using the token", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({});
    };
    await expect(verifyRuntimePeersCapability({
      base: "https://party.example/path",
      token: "secret-token",
      fetchImpl,
    })).rejects.toThrow("must be an origin");
    await expect(verifyRuntimePeersCapability({
      base: "http://party.example",
      token: "secret-token",
      fetchImpl,
    })).rejects.toThrow("must use HTTPS");
    expect(calls).toBe(0);
  });

  test("does not probe an inaccessible, archived, or mismatched channel", () => {
    const identity = { name: "agent", kind: "agent", channel_scope: "scoped" };
    expect(() => chooseRuntimeSmokeChannel(identity, [
      { slug: "scoped", archived_at: 123 },
      { slug: "other", archived_at: null },
    ], undefined)).toThrow("not accessible");
    expect(() => chooseRuntimeSmokeChannel(identity, [
      { slug: "scoped", archived_at: null },
    ], "other")).toThrow("not accessible");
  });

  test("rejects old, peer-bearing, or identity-mismatched capability responses", () => {
    const valid = {
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "capability_probe",
      self: "smoke-agent",
      peers: [],
    };
    expect(() => validateRuntimeCapabilityResponse(valid, "smoke-agent")).not.toThrow();
    expect(() => validateRuntimeCapabilityResponse({ ...valid, version: 2 }, "smoke-agent")).toThrow();
    expect(() => validateRuntimeCapabilityResponse({ ...valid, self: "other" }, "smoke-agent")).toThrow();
    expect(() => validateRuntimeCapabilityResponse({ ...valid, peers: [{ agent: "other" }] }, "smoke-agent"))
      .toThrow();
  });

  test("waits for welcome and a post-hello pong without placing the token in the URL", async () => {
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventTarget {
      sent: string[] = [];
      closed = false;
      constructor(readonly url: string, readonly protocols: string[]) {
        super();
        sockets.push(this);
        queueMicrotask(() => {
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "welcome" }),
          }));
        });
      }
      send(value: string) {
        this.sent.push(value);
        if ((JSON.parse(value) as { type?: string }).type === "ping") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "pong" }),
          })));
        }
      }
      close() {
        this.closed = true;
        this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      }
    }
    const topology = {
      version: 1,
      node_ref: "node_12345678",
      runtime_ref: "runtime_12345678",
      workspace_ref: "workspace_12345678",
      worktree_ref: "worktree_12345678",
      peer_scope: "local_installation",
      evidence: "client_asserted",
    };
    const handle = await openRuntimeTopologySocket({
      base: "https://party.example",
      token: "secret-token",
      channel: "dev",
      topology,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      socketTimeoutMs: 100,
    });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe("wss://party.example/api/channels/dev/ws");
    expect(sockets[0]!.url).not.toContain("secret-token");
    expect(sockets[0]!.protocols).toEqual(["agentparty", "secret-token"]);
    expect(sockets[0]!.sent.map((item) => JSON.parse(item))).toEqual([
      { type: "hello", since: 0, since_rev: 0, runtime_topology: topology },
      { type: "ping", barrier: "runtime_topology_hello" },
    ]);
    await handle.close();
    expect(sockets[0]!.closed).toBe(true);
  });

  test("bounds and reports a close handshake that never completes", async () => {
    class StuckCloseWebSocket extends EventTarget {
      readyState = 0;
      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = 1;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "welcome" }),
          }));
        });
      }
      send(value: string) {
        if ((JSON.parse(value) as { type?: string }).type === "ping") {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({ type: "pong" }),
          })));
        }
      }
      close() {
        // Deliberately leave readyState open and emit no close event.
      }
    }
    const handle = await openRuntimeTopologySocket({
      base: "https://party.example",
      token: "secret-token",
      channel: "dev",
      topology: {
        version: 1,
        node_ref: "node_12345678",
        runtime_ref: "runtime_12345678",
        workspace_ref: "workspace_12345678",
        worktree_ref: "worktree_12345678",
        peer_scope: "local_installation",
        evidence: "client_asserted",
      },
      WebSocketImpl: StuckCloseWebSocket as unknown as typeof WebSocket,
      socketTimeoutMs: 5,
    });
    const firstClose = handle.close();
    expect(handle.close()).toBe(firstClose);
    await expect(firstClose).rejects.toThrow("socket cleanup timed out after 5ms");
  });

  test("proves a bound caller and one different-workspace peer through two live sockets", async () => {
    const topologies: Record<string, unknown>[] = [];
    let closed = 0;
    const requests: Request[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
      requests.push(request);
      if (request.url.endsWith("/api/me")) {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (request.url.endsWith("/api/channels")) {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      const peer = topologies[1] as {
        harness_session: { display_name: string };
      };
      return jsonResponse(liveTopologyResponse(peer.harness_session.display_name));
    };

    await expect(verifyRuntimePeersLiveTopology({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl,
      openSocketImpl: async ({ topology }) => {
        topologies.push(topology);
        return { close: async () => { closed += 1; } };
      },
    })).resolves.toEqual({
      ok: true,
      mode: "live_topology",
      protocol_version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "live_socket",
      identity_verified: true,
      channel_access_verified: true,
      protocol_checked: true,
      live_socket_binding_verified: true,
      peer_relation: "same_local_installation",
      claude_session_projection_verified: true,
      candidate_ref_verified: true,
      raw_topology_refs_redacted: true,
      sockets_closed: true,
      messages_sent: 0,
    });

    expect(topologies).toHaveLength(2);
    expect(topologies[0]!.node_ref).toBe(topologies[1]!.node_ref);
    expect(topologies[0]!.runtime_ref).not.toBe(topologies[1]!.runtime_ref);
    expect(topologies[0]!.workspace_ref).not.toBe(topologies[1]!.workspace_ref);
    expect(topologies[0]!.worktree_ref).not.toBe(topologies[1]!.worktree_ref);
    expect(topologies[0]).not.toHaveProperty("harness_session");
    expect(topologies[1]).toMatchObject({ harness_session: { harness: "claude" } });
    expect(closed).toBe(2);

    const runtimeRequest = requests.at(-1)!;
    expect(runtimeRequest.url).toEndWith("/api/channels/dev/runtime-peers");
    expect(runtimeRequest.headers.get("authorization")).toBe("Bearer secret-token");
    const payload = await runtimeRequest.json() as {
      purpose: string;
      topology: Record<string, unknown>;
    };
    expect(payload).toEqual({ topology: topologies[0], purpose: "claude_cross_session" });
  });

  test("retries transient 409 binding conflicts and exposes the server match count", async () => {
    const topologies: Record<string, unknown>[] = [];
    const delays: number[] = [];
    let liveAttempts = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/me") {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (url.pathname === "/api/channels") {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      liveAttempts += 1;
      if (liveAttempts < 3) {
        return jsonResponse({
          error: { code: "conflict", message: "runtime topology is not bound to one live caller socket" },
          matches: liveAttempts === 1 ? 0 : 2,
        }, 409);
      }
      const peer = topologies[1] as { harness_session: { display_name: string } };
      return jsonResponse(liveTopologyResponse(peer.harness_session.display_name));
    };

    await expect(verifyRuntimePeersLiveTopology({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl,
      openSocketImpl: async ({ topology }) => {
        topologies.push(topology);
        return { close: async () => {} };
      },
      sleepImpl: async (ms: number) => { delays.push(ms); },
    })).resolves.toMatchObject({ ok: true, mode: "live_topology", sockets_closed: true });
    expect(liveAttempts).toBe(3);
    expect(delays).toEqual([150, 500]);

    liveAttempts = 0;
    await expect(verifyRuntimePeersLiveTopology({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === "/api/me") return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
        if (url.pathname === "/api/channels") return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
        liveAttempts += 1;
        return jsonResponse({ error: { code: "conflict", message: "conflict" }, matches: 2 }, 409);
      },
      openSocketImpl: async () => ({ close: async () => {} }),
      sleepImpl: async () => {},
    })).rejects.toThrow("expected 2xx, got 409 (matches=2)");
    expect(liveAttempts).toBe(3);
  });

  test("does not report live topology success before both close handshakes finish", async () => {
    const topologies: Record<string, unknown>[] = [];
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const bothClosing = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let closeCalls = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/me") {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (url.pathname === "/api/channels") {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      const peer = topologies[1] as { harness_session: { display_name: string } };
      return jsonResponse(liveTopologyResponse(peer.harness_session.display_name));
    };
    const verification = verifyRuntimePeersLiveTopology({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl,
      openSocketImpl: async ({ topology }) => {
        topologies.push(topology);
        return {
          close: async () => {
            closeCalls += 1;
            if (closeCalls === 2) cleanupStarted();
            await cleanupGate;
          },
        };
      },
    });
    await bothClosing;
    let settled = false;
    void verification.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup();
    await expect(verification).resolves.toMatchObject({ mode: "live_topology" });
    expect(closeCalls).toBe(2);
  });

  test("waits for the other close handshake before reporting one cleanup failure", async () => {
    const topologies: Record<string, unknown>[] = [];
    let secondCloseStarted!: () => void;
    let releaseSecondClose!: () => void;
    const secondClosing = new Promise<void>((resolve) => { secondCloseStarted = resolve; });
    const secondCloseGate = new Promise<void>((resolve) => { releaseSecondClose = resolve; });
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/me") {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (url.pathname === "/api/channels") {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      const peer = topologies[1] as { harness_session: { display_name: string } };
      return jsonResponse(liveTopologyResponse(peer.harness_session.display_name));
    };
    const verification = verifyRuntimePeersLiveTopology({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl,
      openSocketImpl: async ({ topology }) => {
        const index = topologies.length;
        topologies.push(topology);
        return {
          close: index === 0
            ? async () => { throw new Error("fixture first cleanup failed"); }
            : async () => {
                secondCloseStarted();
                await secondCloseGate;
              },
        };
      },
    });
    let settled = false;
    const observed = verification.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await secondClosing;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseSecondClose();
    await expect(verification).rejects.toThrow("fixture first cleanup failed");
    await observed;
  });

  test("closes every attached socket when the live topology response is not exact", async () => {
    let closed = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/me") {
        return jsonResponse({ name: "smoke-agent", kind: "agent", channel_scope: "dev" });
      }
      if (url.pathname === "/api/channels") {
        return jsonResponse({ channels: [{ slug: "dev", archived_at: null }] });
      }
      return jsonResponse({
        version: 3,
        topology_evidence: "client_asserted",
        comparison: "server_derived",
        caller_binding: "capability_probe",
        self: "smoke-agent",
        peers: [],
      });
    };
    await expect(verifyRuntimePeersLiveTopology({
      base: "https://party.example",
      token: "secret-token",
      fetchImpl,
      openSocketImpl: async () => ({ close: async () => { closed += 1; } }),
    })).rejects.toThrow("exact same-local-installation contract");
    expect(closed).toBe(2);
  });

  test("rejects an ambiguous, wrong-relation, or unaddressable live topology projection", () => {
    const valid = {
      version: 3,
      topology_evidence: "client_asserted",
      comparison: "server_derived",
      caller_binding: "live_socket",
      self: "smoke-agent",
      peers: [{
        agent: "smoke-agent",
        same_identity: true,
        relations: [{ relation: "same_local_installation", runtime_count: 1 }],
        claude_sessions: [{
          display_name: "apcs-smoke-a1b2c3d4e5f6",
          relation: "same_local_installation",
          runtime_count: 1,
          candidate_ref: "candidate_1234567890abcdef",
        }],
      }],
    };
    expect(() => validateRuntimeLiveTopologyResponse(
      valid,
      "smoke-agent",
      "apcs-smoke-a1b2c3d4e5f6",
    )).not.toThrow();
    expect(() => validateRuntimeLiveTopologyResponse(
      { ...valid, caller_binding: "capability_probe" },
      "smoke-agent",
      "apcs-smoke-a1b2c3d4e5f6",
    )).toThrow();
    expect(() => validateRuntimeLiveTopologyResponse(
      {
        ...valid,
        peers: [{
          ...valid.peers[0],
          relations: [{ relation: "same_workspace", runtime_count: 1 }],
        }],
      },
      "smoke-agent",
      "apcs-smoke-a1b2c3d4e5f6",
    )).toThrow();
    expect(() => validateRuntimeLiveTopologyResponse(
      {
        ...valid,
        peers: [{
          ...valid.peers[0],
          claude_sessions: [{ ...valid.peers[0]!.claude_sessions[0], candidate_ref: null }],
        }],
      },
      "smoke-agent",
      "apcs-smoke-a1b2c3d4e5f6",
    )).toThrow();
  });

  test("rejects any request-side topology ref echoed by the live response", () => {
    const topology = {
      node_ref: "node_private123",
      runtime_ref: "runtime_private123",
      workspace_ref: "workspace_private123",
      worktree_ref: "worktree_private123",
    };
    expect(() => assertRuntimeTopologyRefsRedacted({
      version: 3,
      peers: [{ relation: "same_local_installation" }],
    }, [topology])).not.toThrow();
    for (const key of Object.keys(topology) as Array<keyof typeof topology>) {
      expect(() => assertRuntimeTopologyRefsRedacted({
        version: 3,
        leaked: topology[key],
      }, [topology])).toThrow("exposed a private topology ref");
    }
  });
});
