export interface RuntimeSmokeIdentity {
  name?: unknown;
  kind?: unknown;
  channel_scope?: unknown;
}

export interface RuntimeSmokeChannel {
  slug?: unknown;
  archived_at?: unknown;
}

export interface RuntimeCapabilitySmokeResult {
  ok: true;
  mode: "capability_probe";
  protocol_version: 3;
  topology_evidence: "client_asserted";
  comparison: "server_derived";
  caller_binding: "capability_probe";
  identity_verified: true;
  channel_access_verified: true;
  protocol_checked: true;
  peers_returned: 0;
}

export interface RuntimeLiveTopologySmokeResult {
  ok: true;
  mode: "live_topology";
  protocol_version: 3;
  topology_evidence: "client_asserted";
  comparison: "server_derived";
  caller_binding: "live_socket";
  identity_verified: true;
  channel_access_verified: true;
  protocol_checked: true;
  live_socket_binding_verified: true;
  peer_relation: "same_local_installation";
  claude_session_projection_verified: true;
  candidate_ref_verified: true;
  raw_topology_refs_redacted: true;
  sockets_closed: true;
  messages_sent: 0;
}

export interface RuntimeCredentialSmokeResult {
  ok: true;
  mode: "credentials_only";
  identity_verified: true;
  channel_access_verified: true;
  websocket_client_available: true;
  protocol_checked: false;
}

export interface RuntimeSmokeTarget {
  base: string;
  identityName: string;
  channel: string;
}

export type RuntimeSmokeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RuntimeSmokeSocketHandle {
  close(): Promise<void>;
}

export type RuntimeSmokeSocketOpener = (options: {
  base: string;
  token: string;
  channel: string;
  topology: Record<string, unknown>;
  socketTimeoutMs?: number;
}) => Promise<RuntimeSmokeSocketHandle>;

export function chooseRuntimeSmokeChannel(
  identity: RuntimeSmokeIdentity,
  channels: RuntimeSmokeChannel[] | unknown,
  requestedChannel?: string,
): string;

export function validateRuntimeCapabilityResponse(body: unknown, expectedSelf: string): void;

export function validateRuntimeLiveTopologyResponse(
  body: unknown,
  expectedSelf: string,
  expectedDisplayName: string,
): void;

export function assertRuntimeTopologyRefsRedacted(
  body: unknown,
  topologies: Array<Record<string, unknown>>,
): void;

export function openRuntimeTopologySocket(options: {
  base: string;
  token: string;
  channel: string;
  topology: Record<string, unknown>;
  WebSocketImpl?: typeof WebSocket;
  socketTimeoutMs?: number;
}): Promise<RuntimeSmokeSocketHandle>;

export function resolveRuntimeSmokeTarget(options: {
  base: string;
  token: string;
  channel?: string;
  fetchImpl?: RuntimeSmokeFetch;
  requestTimeoutMs?: number;
}): Promise<RuntimeSmokeTarget>;

export function verifyRuntimeSmokeCredentials(options: {
  base: string;
  token: string;
  channel?: string;
  fetchImpl?: RuntimeSmokeFetch;
  requestTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
}): Promise<RuntimeCredentialSmokeResult>;

export function verifyRuntimePeersCapability(options: {
  base: string;
  token: string;
  channel?: string;
  fetchImpl?: RuntimeSmokeFetch;
  requestTimeoutMs?: number;
}): Promise<RuntimeCapabilitySmokeResult>;

export function verifyRuntimePeersLiveTopology(options: {
  base: string;
  token: string;
  channel?: string;
  fetchImpl?: RuntimeSmokeFetch;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
  openSocketImpl?: RuntimeSmokeSocketOpener;
}): Promise<RuntimeLiveTopologySmokeResult>;
