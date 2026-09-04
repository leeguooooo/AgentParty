import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CANDIDATE_REF_RE = /^candidate_[A-Za-z0-9_-]{16,64}$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 10_000;
const LIVE_CONFLICT_RETRY_DELAYS_MS = [150, 500];

class RuntimeSmokeHttpError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RuntimeSmokeHttpError";
    this.status = status;
    this.body = body;
  }
}

function normalizedBase(raw) {
  const url = new URL(raw);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("runtime-peers smoke base must use HTTPS or loopback HTTP");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("runtime-peers smoke base must be an origin without path, credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

function requestTimeoutSignal(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("runtime-peers smoke request timeout must be a positive integer");
  }
  return AbortSignal.timeout(timeoutMs);
}

async function requestJson(fetchImpl, base, token, label, path, init = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const signal = init.signal ?? requestTimeoutSignal(timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  } catch (error) {
    if (signal.aborted) throw new Error(`${label}: request timed out after ${timeoutMs}ms`);
    throw error;
  }
  const text = await response.text();
  if (!response.ok) {
    let body = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // The status remains useful even when an old/misconfigured Worker returns text.
    }
    const matches = Number.isInteger(body?.matches) && body.matches >= 0
      ? ` (matches=${body.matches})`
      : "";
    throw new RuntimeSmokeHttpError(`${label}: expected 2xx, got ${response.status}${matches}`, response.status, body);
  }
  try {
    return text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`${label}: response is not JSON`);
  }
}

export function chooseRuntimeSmokeChannel(identity, channels, requestedChannel) {
  if (!Array.isArray(channels)) throw new Error("authenticated channels: missing channels array");
  const available = channels.filter(
    (channel) =>
      channel !== null &&
      typeof channel === "object" &&
      typeof channel.slug === "string" &&
      SLUG_RE.test(channel.slug) &&
      channel.archived_at == null,
  );
  const selected = requestedChannel ?? identity.channel_scope ?? available[0]?.slug;
  if (typeof selected !== "string" || !SLUG_RE.test(selected)) {
    throw new Error("runtime-peers smoke needs one accessible non-archived channel");
  }
  if (!available.some((channel) => channel.slug === selected)) {
    throw new Error("runtime-peers smoke channel is not accessible to the configured agent token");
  }
  return selected;
}

export function validateRuntimeCapabilityResponse(body, expectedSelf) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.version !== 3 ||
    body.topology_evidence !== "client_asserted" ||
    body.comparison !== "server_derived" ||
    body.caller_binding !== "capability_probe" ||
    body.self !== expectedSelf ||
    !Array.isArray(body.peers) ||
    body.peers.length !== 0
  ) {
    throw new Error("runtime-peers capability probe did not return the exact v3 no-peer contract");
  }
}

export function validateRuntimeLiveTopologyResponse(body, expectedSelf, expectedDisplayName) {
  const peer = Array.isArray(body?.peers) && body.peers.length === 1 ? body.peers[0] : null;
  const relation = Array.isArray(peer?.relations) && peer.relations.length === 1
    ? peer.relations[0]
    : null;
  const session = Array.isArray(peer?.claude_sessions) && peer.claude_sessions.length === 1
    ? peer.claude_sessions[0]
    : null;
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.version !== 3 ||
    body.topology_evidence !== "client_asserted" ||
    body.comparison !== "server_derived" ||
    body.caller_binding !== "live_socket" ||
    body.self !== expectedSelf ||
    peer === null ||
    peer.agent !== expectedSelf ||
    peer.same_identity !== true ||
    relation === null ||
    relation.relation !== "same_local_installation" ||
    relation.runtime_count !== 1 ||
    session === null ||
    session.display_name !== expectedDisplayName ||
    session.relation !== "same_local_installation" ||
    session.runtime_count !== 1 ||
    typeof session.candidate_ref !== "string" ||
    !CANDIDATE_REF_RE.test(session.candidate_ref)
  ) {
    throw new Error("runtime-peers live topology smoke did not return the exact same-local-installation contract");
  }
}

export function assertRuntimeTopologyRefsRedacted(body, topologies) {
  const serialized = JSON.stringify(body);
  for (const topology of topologies) {
    for (const key of ["node_ref", "runtime_ref", "workspace_ref", "worktree_ref"]) {
      const value = topology?.[key];
      if (typeof value === "string" && value !== "" && serialized.includes(value)) {
        throw new Error("runtime-peers live topology smoke response exposed a private topology ref");
      }
    }
  }
}

function runtimeSocketUrl(base, channel) {
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/channels/${encodeURIComponent(channel)}/ws`;
  return url.toString();
}

function parseSocketFrame(data) {
  try {
    const value = JSON.parse(typeof data === "string" ? data : String(data));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function closeRuntimeTopologySocket(socket, timeoutMs, reason) {
  if (socket === undefined || socket?.readyState === 3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener?.("close", onClose);
      socket.removeEventListener?.("error", onError);
      if (error === null) resolve();
      else reject(error);
    };
    const onClose = () => finish(null);
    // A transport error normally precedes close. Keep waiting for the close
    // event so cleanup proof remains the same on graceful and failed sockets.
    const onError = () => {};
    const timer = setTimeout(
      () => finish(new Error(`runtime-peers live topology socket cleanup timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.addEventListener?.("close", onClose);
    socket.addEventListener?.("error", onError);
    try {
      socket.close(1000, reason);
      if (socket.readyState === 3) finish(null);
    } catch {
      finish(new Error("runtime-peers live topology socket cleanup failed"));
    }
  });
}

/**
 * Attach one authenticated runtime and wait for a server pong sent after its
 * hello. The Worker serializes frames per connection, so that pong is the
 * observable barrier proving the topology hello has been applied.
 */
export function openRuntimeTopologySocket({
  base,
  token,
  channel,
  topology,
  WebSocketImpl = globalThis.WebSocket,
  socketTimeoutMs = DEFAULT_SOCKET_TIMEOUT_MS,
}) {
  if (!Number.isInteger(socketTimeoutMs) || socketTimeoutMs <= 0) {
    return Promise.reject(new Error("runtime-peers smoke socket timeout must be a positive integer"));
  }
  if (typeof WebSocketImpl !== "function") {
    return Promise.reject(new Error("runtime-peers live topology smoke requires a WebSocket client"));
  }
  return new Promise((resolve, reject) => {
    let socket;
    let opened = false;
    let welcomed = false;
    let pongReceived = false;
    let settled = false;
    let closePromise = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.removeEventListener?.("open", onOpen);
      socket?.removeEventListener?.("message", onMessage);
      socket?.removeEventListener?.("error", onError);
      socket?.removeEventListener?.("close", onClose);
      if (error !== null) {
        closeRuntimeTopologySocket(socket, socketTimeoutMs, "runtime smoke failed").then(
          () => reject(error),
          (cleanupError) => reject(new Error(`${error.message}; ${cleanupError.message}`)),
        );
        return;
      }
      resolve({
        close() {
          closePromise ??= closeRuntimeTopologySocket(
            socket,
            socketTimeoutMs,
            "runtime smoke complete",
          );
          return closePromise;
        },
      });
    };
    const maybeReady = () => {
      if (opened && welcomed && pongReceived) finish(null);
    };
    const onOpen = () => {
      opened = true;
      try {
        socket.send(JSON.stringify({
          type: "hello",
          since: 0,
          since_rev: 0,
          runtime_topology: topology,
        }));
        // The Worker has an exact-byte auto-response for {"type":"ping"}.
        // An extra field deliberately misses that shortcut and reaches the
        // per-connection serial queue after the preceding topology hello.
        socket.send(JSON.stringify({ type: "ping", barrier: "runtime_topology_hello" }));
      } catch {
        finish(new Error("runtime-peers live topology socket could not send its handshake"));
      }
    };
    const onMessage = (event) => {
      const frame = parseSocketFrame(event.data);
      if (frame?.type === "welcome") welcomed = true;
      if (frame?.type === "pong") pongReceived = true;
      if (frame?.type === "error") {
        finish(new Error("runtime-peers live topology socket received an error frame"));
        return;
      }
      maybeReady();
    };
    const onError = () => finish(new Error("runtime-peers live topology socket failed"));
    const onClose = () => finish(new Error("runtime-peers live topology socket closed before handshake"));
    const timer = setTimeout(
      () => finish(new Error(`runtime-peers live topology socket timed out after ${socketTimeoutMs}ms`)),
      socketTimeoutMs,
    );
    try {
      // The token is a WebSocket subprotocol rather than a URL parameter, so
      // it never enters request paths, logs, or error messages.
      socket = new WebSocketImpl(runtimeSocketUrl(base, channel), ["agentparty", token]);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    } catch {
      finish(new Error("runtime-peers live topology socket could not be created"));
    }
  });
}

export async function resolveRuntimeSmokeTarget({
  base: rawBase,
  token,
  channel,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  if (typeof rawBase !== "string" || rawBase === "") throw new Error("AGENTPARTY_SMOKE_BASE is required");
  if (typeof token !== "string" || token === "") throw new Error("an AgentParty runtime smoke token is required");
  if (channel !== undefined && (typeof channel !== "string" || !SLUG_RE.test(channel))) {
    throw new Error("AGENTPARTY_RUNTIME_SMOKE_CHANNEL must be a valid channel slug");
  }
  const base = normalizedBase(rawBase);
  const identity = await requestJson(
    fetchImpl,
    base,
    token,
    "runtime smoke identity",
    "/api/me",
    {},
    requestTimeoutMs,
  );
  if (
    identity === null ||
    typeof identity !== "object" ||
    identity.kind !== "agent" ||
    typeof identity.name !== "string" ||
    !NAME_RE.test(identity.name)
  ) {
    throw new Error("runtime-peers smoke token must resolve to one named AgentParty agent");
  }
  const channelList = await requestJson(
    fetchImpl,
    base,
    token,
    "authenticated channels",
    "/api/channels",
    {},
    requestTimeoutMs,
  );
  const selectedChannel = chooseRuntimeSmokeChannel(identity, channelList?.channels, channel);
  return { base, identityName: identity.name, channel: selectedChannel };
}

export async function verifyRuntimeSmokeCredentials(options) {
  const WebSocketImpl = options.WebSocketImpl === undefined
    ? globalThis.WebSocket
    : options.WebSocketImpl;
  if (typeof WebSocketImpl !== "function") {
    throw new Error("runtime-peers deploy preflight requires a WebSocket client");
  }
  await resolveRuntimeSmokeTarget(options);
  return {
    ok: true,
    mode: "credentials_only",
    identity_verified: true,
    channel_access_verified: true,
    websocket_client_available: true,
    protocol_checked: false,
  };
}

export async function verifyRuntimePeersCapability(options) {
  const {
    token,
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;
  const target = await resolveRuntimeSmokeTarget(options);
  const nonce = randomBytes(16).toString("hex");
  const topology = {
    version: 1,
    node_ref: `node_${nonce}`,
    runtime_ref: `runtime_${nonce}`,
    workspace_ref: `workspace_${nonce}`,
    worktree_ref: `worktree_${nonce}`,
    peer_scope: "local_installation",
    evidence: "client_asserted",
  };
  const response = await requestJson(
    fetchImpl,
    target.base,
    token,
    "runtime-peers capability probe",
    `/api/channels/${encodeURIComponent(target.channel)}/runtime-peers`,
    {
      method: "POST",
      body: JSON.stringify({ topology, purpose: "capability_probe" }),
    },
    requestTimeoutMs,
  );
  validateRuntimeCapabilityResponse(response, target.identityName);
  return {
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
  };
}

export async function verifyRuntimePeersLiveTopology(options) {
  const {
    token,
    fetchImpl = fetch,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    socketTimeoutMs = DEFAULT_SOCKET_TIMEOUT_MS,
    openSocketImpl = openRuntimeTopologySocket,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const target = await resolveRuntimeSmokeTarget(options);
  const nodeNonce = randomBytes(16).toString("hex");
  const callerNonce = randomBytes(16).toString("hex");
  const peerNonce = randomBytes(16).toString("hex");
  const displayName = `apcs-smoke-${peerNonce.slice(0, 12)}`;
  const baseTopology = {
    version: 1,
    node_ref: `node_${nodeNonce}`,
    peer_scope: "local_installation",
    evidence: "client_asserted",
  };
  const callerTopology = {
    ...baseTopology,
    runtime_ref: `runtime_${callerNonce}`,
    workspace_ref: `workspace_${callerNonce}`,
    worktree_ref: `worktree_${callerNonce}`,
  };
  const peerTopology = {
    ...baseTopology,
    runtime_ref: `runtime_${peerNonce}`,
    workspace_ref: `workspace_${peerNonce}`,
    worktree_ref: `worktree_${peerNonce}`,
    harness_session: { harness: "claude", display_name: displayName },
  };
  const sockets = [];
  try {
    sockets.push(await openSocketImpl({
      base: target.base,
      token,
      channel: target.channel,
      topology: callerTopology,
      socketTimeoutMs,
    }));
    sockets.push(await openSocketImpl({
      base: target.base,
      token,
      channel: target.channel,
      topology: peerTopology,
      socketTimeoutMs,
    }));
    let response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await requestJson(
          fetchImpl,
          target.base,
          token,
          "runtime-peers live topology smoke",
          `/api/channels/${encodeURIComponent(target.channel)}/runtime-peers`,
          {
            method: "POST",
            body: JSON.stringify({ topology: callerTopology, purpose: "claude_cross_session" }),
          },
          requestTimeoutMs,
        );
        break;
      } catch (error) {
        const delay = LIVE_CONFLICT_RETRY_DELAYS_MS[attempt];
        if (!(error instanceof RuntimeSmokeHttpError) || error.status !== 409 || delay === undefined) throw error;
        // A just-closed socket may remain visible briefly in the Durable Object connection set.
        // Retry only this explicit binding conflict; all auth/protocol/server failures still fail immediately.
        await sleepImpl(delay);
      }
    }
    assertRuntimeTopologyRefsRedacted(response, [callerTopology, peerTopology]);
    validateRuntimeLiveTopologyResponse(response, target.identityName, displayName);
    return {
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
    };
  } finally {
    const cleanup = await Promise.allSettled(sockets.reverse().map((socket) => socket.close()));
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);
  const allowed = new Set(["--credentials-only", "--capability-only"]);
  if (
    args.some((arg) => !allowed.has(arg)) ||
    new Set(args).size !== args.length ||
    args.length > 1
  ) {
    console.error("usage: node scripts/smoke-runtime-peers.mjs [--credentials-only|--capability-only]");
    process.exit(1);
  }
  const verify = args.includes("--credentials-only")
    ? verifyRuntimeSmokeCredentials
    : args.includes("--capability-only")
      ? verifyRuntimePeersCapability
      : verifyRuntimePeersLiveTopology;
  verify({
    base: process.env.AGENTPARTY_SMOKE_BASE,
    token: process.env.AGENTPARTY_RUNTIME_SMOKE_TOKEN ?? process.env.AGENTPARTY_SMOKE_TOKEN,
    channel: process.env.AGENTPARTY_RUNTIME_SMOKE_CHANNEL,
  }).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
