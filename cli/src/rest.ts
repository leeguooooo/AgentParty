// rest api 封装
import {
  type AgentLineage,
  type Attachment,
  type CaptureKind,
  type CaptureRecord,
  type ChannelDecisionRecord,
  type ChannelKind,
  type ChannelMode,
  type ChannelRoleAssignment,
  type ChannelSquad,
  type CollaborationRole,
  type CompletionGate,
  type CompletionReview,
  type CompletionReviewPolicy,
  type DecisionMode,
  type DecisionRequest,
  type DecisionResolution,
  type IdentityEraseSummary,
  type IdentityExportData,
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  EXIT_RATE_LIMITED,
  EXIT_WORKFLOW_GUARD,
  parseRuntimePeerDiscovery,
  type MsgFrame,
  type PresenceEntry,
  type PublicDirectedDelivery,
  type ReadCursor,
  type RuntimePeerDiscovery,
  type RuntimePeerPurpose,
  type RuntimeTopology,
  type SearchHit,
  type SendMessageFrame,
  type SendStatusFrame,
  type TaskAssigneeKind,
  type TaskLeaseGrantedResponse,
  type TaskLeaseReleasedResponse,
  type TaskRecord,
  type TaskState,
  type TokenRole,
  type WakeBlock,
  type WakeDelivery,
  type WebhookFilter,
} from "@agentparty/shared";
import pkg from "../package.json" with { type: "json" };
import { stripTerminalControls } from "./format";

export type { ChannelMode, WebhookFilter };
export type { CompletionGate, CompletionReview, CompletionReviewPolicy };
export type { CaptureKind, CaptureRecord };
export type { ChannelDecisionRecord };
export type { TaskAssigneeKind, TaskRecord, TaskState };
export type { ChannelSquad };

// 频道可见性：public = 任何鉴权身份可进；private（默认）= 仅 leo 的 ap_ token + 房主（spec §3.2）
export type ChannelVisibility = "public" | "private";

export class RestError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    /**
     * 已解析的响应体（非 JSON 响应为 null）。结构化错误常带 message 之外的可执行信息——
     * 任务租约冲突要告诉被拒方「谁持有、何时过期」（#936），把它塌缩成一句 message
     * 就只剩「你不被允许」，调用方既不知道等多久也不知道该不该 force。
     */
    public body: unknown = null,
  ) {
    super(message);
  }
}

export class RuntimePeerProtocolError extends Error {
  constructor(public version: unknown) {
    super(`runtime peer discovery requires protocol v3; received ${String(version)}`);
  }
}

export interface ChannelInfo {
  slug: string;
  title: string | null;
  kind: ChannelKind;
  mode?: ChannelMode;
  visibility?: ChannelVisibility;
  charter_rev?: number;
  archived_at: number | null;
  presence?: PresenceEntry[];
}

export interface ChannelCharter {
  charter: string | null;
  charter_rev: number;
  updated_at: number | null;
  updated_by: string | null;
  /** 旧 Worker 缺省；新版始终返回全部 active 决策（服务端限制最多 100 条）。 */
  active_decisions?: ChannelDecisionRecord[];
  permissions?: ChannelPerms;
}

export type HumanChannelPermPolicy = "owner" | "moderators" | "members";
export type HumanChannelListPolicy = HumanChannelPermPolicy | "off";
export type AgentChannelPermPolicy = "off" | "moderators" | "members" | "allowlist";

export interface ChannelPerms {
  charter_write: HumanChannelPermPolicy;
  charter_write_agents: AgentChannelPermPolicy;
  charter_write_agent_allowlist: string[];
  members_list: HumanChannelListPolicy;
  members_list_agents: AgentChannelPermPolicy;
  members_list_agent_allowlist: string[];
}

export type ChannelPermsUpdate = Partial<{
  charter_write: HumanChannelPermPolicy;
  charter_write_agents: AgentChannelPermPolicy;
  charter_write_agent_allowlist: string[];
  members_list: HumanChannelListPolicy;
  members_list_agents: AgentChannelPermPolicy;
  members_list_agent_allowlist: string[];
}>;

export interface WebhookInfo {
  name: string;
  url: string;
  filter: WebhookFilter;
  mode?: WebhookMode;
}

export type WebhookMode = "notify" | "agent";

export interface LarkNotifyStatus {
  enabled: boolean;
  channel_slug: string;
  target_name?: string;
  provider_id?: string;
  provider_kind?: string;
  created_at?: number;
  updated_at?: number;
}

export type ChannelRoleInfo = ChannelRoleAssignment;

export interface ChannelMemberInfo {
  account: string;
  added_by: string;
  added_at: number;
}

export interface JoinLinkInfo {
  code: string;
  url?: string;
  channel_slug: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
}

export type ProjectAgentRunner = "codex" | "claude" | "codex-sdk" | "shell";
export type ProjectAgentWorktreeStrategy = "branch" | "shared" | "none";
export type ProjectAgentInvitableBy = "owner" | "org" | "anyone";

export interface ProjectAgentProfile {
  owner_account: string;
  handle: string;
  name: string;
  runner: ProjectAgentRunner;
  repo_url: string | null;
  workdir: string | null;
  base_branch: string;
  worktree_strategy: ProjectAgentWorktreeStrategy;
  rules: string | null;
  invitable_by: ProjectAgentInvitableBy;
  created_at: number;
  updated_at: number;
}

export interface ChannelProjectAgentInvite {
  id: number;
  channel_slug: string;
  owner_account: string;
  profile_handle: string;
  invited_by: string;
  invited_at: number;
  already_invited?: boolean;
  profile: ProjectAgentProfile;
}

export interface ProjectAgentRuntime {
  token: string;
  profile: ProjectAgentProfile;
}

export interface ProjectAgentChannelRuntime {
  token: string;
  name: string;
  role: "agent";
  owner: string;
  channel_scope: string;
  lineage: AgentLineage;
  profile: ProjectAgentProfile;
}

function extractError(status: number, body: unknown, raw: string): RestError {
  let code: string | null = null;
  let message = raw || `http ${status}`;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const err = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : b;
    if (typeof err.code === "string") code = err.code;
    if (typeof err.message === "string") message = err.message;
    else if (typeof b.error === "string") message = b.error;
  }
  if (!code && status === 401) code = "unauthorized";
  return new RestError(status, code, message, body);
}

// 所有 REST 调用的默认超时（#116）。没有它，一次 TCP 半开就让 serve 永久挂在 await 上：
// ping 还在跑、presence 显示在线，实际不再处理任何 @——最坏的一种失败（假在线）。
// 调用方可用 init.signal 覆盖（例如 watch 的长轮询）。
const REQ_TIMEOUT_MS = 30_000;

async function req(server: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const signal = init.signal ?? AbortSignal.timeout(REQ_TIMEOUT_MS);
  // 版本协商（#137）：每个 REST 调用都带上客户端版本，服务端据此做 min-version 护栏/建言。
  // 用 Headers 合并，既保留调用方的 authorization/content-type，又不覆盖显式已设的版本头。
  const headers = new Headers(init.headers);
  if (!headers.has("x-ap-client-version")) headers.set("x-ap-client-version", pkg.version);
  const res = await fetch(server.replace(/\/+$/, "") + path, { ...init, headers, signal });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // 非 json 响应
  }
  if (!res.ok) throw extractError(res.status, body, raw);
  return body;
}

function bearerJson(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

// 公开配置：oidc issuer + web client_id + cli client_id（供 party login 知道去哪授权、用哪个 client）
export interface PublicConfig {
  issuer: string;
  clientId: string;
}

export async function fetchPublicConfig(server: string): Promise<PublicConfig> {
  const body = (await req(server, "/api/config")) as {
    oidc?: { issuer?: string; client_id?: string } | null;
    cli_client_id?: string;
  } | null;
  const issuer = body?.oidc?.issuer;
  if (!issuer) throw new Error("server has no OIDC configured (cannot party login)");
  // cli_client_id 缺省回落到 web 的 client_id（老 worker 尚未返 cli_client_id 时仍可用）
  const clientId = body.cli_client_id ?? body.oidc?.client_id;
  if (!clientId) throw new Error("server did not advertise a cli client_id");
  return { issuer, clientId };
}

// 服务端版本协商信息（#137）：/api/version 暴露 version/commit + 声明的最低客户端版本 + 是否硬拒。
export interface ServerVersion {
  version: string;
  commit: string;
  deployed_at: string | null;
  min_client_version: string;
  min_client_enforced: boolean;
}

export async function fetchServerVersion(server: string): Promise<ServerVersion> {
  const body = (await req(server, "/api/version")) as Partial<ServerVersion> | null;
  return {
    version: typeof body?.version === "string" ? body.version : "unknown",
    commit: typeof body?.commit === "string" ? body.commit : "unknown",
    deployed_at: typeof body?.deployed_at === "string" ? body.deployed_at : null,
    // 老 worker 无 /api/version 时不会走到这（req 抛 404）；字段缺省则按最宽松处理，绝不误报过时。
    min_client_version: typeof body?.min_client_version === "string" ? body.min_client_version : "0.0.0",
    min_client_enforced: body?.min_client_enforced === true,
  };
}

export interface Identity {
  name: string;
  email: string | null;
  kind: string;
  role: string;
  owner: string | null;
  /** Human-readable owner profile for an account-owned Agent. Older servers omit both fields. */
  owner_handle?: string | null;
  owner_display_name?: string | null;
  // 权限自省（whoami --caps）：旧 server 无这些字段（可选）
  channel_scope?: string | null;
  lineage?: AgentLineage | null;
  // 会员骨架（#277）：旧 server 无这两个字段（可选）；缺失时按 free 处理（isMember 会兜底）。
  membership_tier?: "free" | "member" | null;
  member_since?: number | null;
  caps?: {
    send: boolean;
    create_channel: boolean;
    mint_agents: boolean;
    spawn_children?: boolean;
    scoped_to: string | null;
  };
}

export async function fetchMe(server: string, token: string, signal?: AbortSignal): Promise<Identity> {
  return (await req(server, "/api/me", {
    headers: bearerJson(token),
    ...(signal === undefined ? {} : { signal }),
  })) as Identity;
}

// #165：agent 设自己的全局唯一昵称（可被 @中文昵称 唤醒）。须 agent token 作 bearer。
export async function setNickname(server: string, token: string, nickname: string): Promise<{ nickname: string }> {
  return (await req(server, "/api/me/nickname", {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify({ nickname }),
  })) as { nickname: string };
}

// 账号自助铸 agent token（spec P3）：须账号会话作 bearer，owner 由 worker 从会话推导
export async function createAgent(
  server: string,
  token: string,
  name: string,
  channelScope?: string,
): Promise<{ token: string; name: string; owner?: string; channel_scope?: string }> {
  const body: Record<string, unknown> = { name };
  if (channelScope !== undefined) body.channel_scope = channelScope;
  return (await req(server, "/api/agents", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { token: string; name: string; owner?: string; channel_scope?: string };
}

export async function listProjectAgentProfiles(server: string, token: string): Promise<ProjectAgentProfile[]> {
  const body = await req(server, "/api/agent-profiles", { headers: bearerJson(token) });
  const profiles = (body as Record<string, unknown> | null)?.profiles;
  return Array.isArray(profiles) ? (profiles as ProjectAgentProfile[]) : [];
}

export async function createProjectAgentProfile(
  server: string,
  token: string,
  body: {
    handle: string;
    name?: string;
    runner: ProjectAgentRunner;
    repo_url?: string;
    workdir?: string;
    base_branch?: string;
    worktree_strategy?: ProjectAgentWorktreeStrategy;
    rules?: string;
    invitable_by?: ProjectAgentInvitableBy;
  },
): Promise<ProjectAgentProfile> {
  return (await req(server, "/api/agent-profiles", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ProjectAgentProfile;
}

export async function inviteProjectAgent(
  server: string,
  token: string,
  slug: string,
  ownerAccount: string,
  handle: string,
): Promise<ChannelProjectAgentInvite> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/project-agents`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ owner_account: ownerAccount, handle }),
  })) as ChannelProjectAgentInvite;
}

export async function removeProjectAgentInvite(
  server: string,
  token: string,
  slug: string,
  ownerAccount: string,
  handle: string,
): Promise<{ ok: true; channel_slug: string; owner_account: string; profile_handle: string; revoked_at: number }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/project-agents`, {
    method: "DELETE",
    headers: bearerJson(token),
    body: JSON.stringify({ owner_account: ownerAccount, handle }),
  })) as { ok: true; channel_slug: string; owner_account: string; profile_handle: string; revoked_at: number };
}

export async function mintProjectAgentRuntimeToken(
  server: string,
  token: string,
  handle: string,
  signal?: AbortSignal,
): Promise<ProjectAgentRuntime> {
  return (await req(server, `/api/agent-profiles/${encodeURIComponent(handle)}/runtime-token`, {
    method: "POST",
    headers: bearerJson(token),
    signal,
  })) as ProjectAgentRuntime;
}

export async function listProjectAgentInvites(
  server: string,
  token: string,
  handle?: string,
  signal?: AbortSignal,
): Promise<ChannelProjectAgentInvite[]> {
  const suffix = handle === undefined ? "" : `?handle=${encodeURIComponent(handle)}`;
  const body = await req(server, `/api/agent-profiles/invites${suffix}`, {
    headers: bearerJson(token),
    signal,
  });
  const invites = (body as Record<string, unknown> | null)?.invites;
  return Array.isArray(invites) ? (invites as ChannelProjectAgentInvite[]) : [];
}

export async function ensureProjectAgentChannelRuntime(
  server: string,
  token: string,
  slug: string,
  ownerAccount: string,
  handle: string,
  childName: string,
  signal?: AbortSignal,
): Promise<ProjectAgentChannelRuntime> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/project-agents/runtime-token`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ owner_account: ownerAccount, handle, name: childName }),
    signal,
  })) as ProjectAgentChannelRuntime;
}

export async function spawnAgent(
  server: string,
  token: string,
  name: string,
  channelScope: string,
  opts: { ttlSec?: number; teamId?: string } = {},
): Promise<{
  token: string;
  name: string;
  role: "agent";
  owner: string;
  channel_scope: string;
  lineage: AgentLineage;
  expires_at: number;
}> {
  const body: Record<string, unknown> = { name, channel_scope: channelScope };
  if (opts.ttlSec !== undefined) body.ttl_sec = opts.ttlSec;
  if (opts.teamId !== undefined) body.team_id = opts.teamId;
  return (await req(server, "/api/spawn", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as {
    token: string;
    name: string;
    role: "agent";
    owner: string;
    channel_scope: string;
    lineage: AgentLineage;
    expires_at: number;
  };
}

export async function createToken(
  server: string,
  adminSecret: string,
  name: string,
  role: TokenRole,
  owner?: string,
  channelScope?: string,
): Promise<{
  token: string;
  name: string;
  role: TokenRole;
  owner?: string;
  channel_scope?: string;
}> {
  // owner / channel_scope 仅在给出时进请求体，缺省不发，保持旧调用方的请求形状不变
  const body: Record<string, unknown> = { name, role };
  if (owner !== undefined) body.owner = owner;
  if (channelScope !== undefined) body.channel_scope = channelScope;
  return (await req(server, "/api/tokens", {
    method: "POST",
    headers: { "x-admin-secret": adminSecret, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as {
    token: string;
    name: string;
    role: TokenRole;
    owner?: string;
    channel_scope?: string;
  };
}

export async function revokeToken(server: string, adminSecret: string, name: string): Promise<void> {
  await req(server, `/api/tokens/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "x-admin-secret": adminSecret },
  });
}

// 会员骨架（#277）：owner 手动把账号翻成 member/free。走 ADMIN_SECRET（与铸 token 同一把钥匙）。
export async function setMembership(
  server: string,
  adminSecret: string,
  account: string,
  tier: "free" | "member",
): Promise<{ account: string; tier: "free" | "member"; member_since: number | null }> {
  return (await req(server, "/api/admin/membership", {
    method: "POST",
    headers: { "x-admin-secret": adminSecret, "content-type": "application/json" },
    body: JSON.stringify({ account, tier }),
  })) as { account: string; tier: "free" | "member"; member_since: number | null };
}

export async function listChannels(server: string, token: string): Promise<ChannelInfo[]> {
  const body = await req(server, "/api/channels", { headers: bearerJson(token) });
  if (Array.isArray(body)) return body as ChannelInfo[];
  const channels = (body as Record<string, unknown> | null)?.channels;
  return Array.isArray(channels) ? (channels as ChannelInfo[]) : [];
}

export async function fetchChannelCharter(
  server: string,
  token: string,
  slug: string,
  signal?: AbortSignal,
): Promise<ChannelCharter> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/charter`, {
    headers: bearerJson(token),
    signal,
  })) as ChannelCharter;
}

export async function setChannelCharter(
  server: string,
  token: string,
  slug: string,
  charter: string,
  expectedRev?: number,
): Promise<ChannelCharter> {
  const body: Record<string, unknown> = { charter };
  if (expectedRev !== undefined) body.expected_rev = expectedRev;
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/charter`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelCharter;
}

export async function fetchChannelPerms(server: string, token: string, slug: string): Promise<ChannelPerms> {
  const body = (await req(server, `/api/channels/${encodeURIComponent(slug)}/perms`, {
    headers: bearerJson(token),
  })) as { permissions?: ChannelPerms };
  if (!body.permissions) throw new Error("server did not return channel permissions");
  return body.permissions;
}

export async function setChannelPerms(
  server: string,
  token: string,
  slug: string,
  update: ChannelPermsUpdate,
): Promise<ChannelPerms> {
  const body = (await req(server, `/api/channels/${encodeURIComponent(slug)}/perms`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(update),
  })) as { permissions?: ChannelPerms };
  if (!body.permissions) throw new Error("server did not return channel permissions");
  return body.permissions;
}

export async function createChannel(
  server: string,
  token: string,
  body: {
    slug: string;
    title?: string;
    kind: ChannelKind;
    mode?: ChannelMode;
    visibility?: ChannelVisibility;
    // #695：撞名时让服务端自增后缀取下一个空位（slug → slug-2 …），返回真实建出的 slug。
    // 默认 false：init 的 create-or-join、invite 的 scoped 建频道都要精确 slug，不能被改名。
    auto_suffix?: boolean;
  },
): Promise<string> {
  const res = (await req(server, "/api/channels", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { slug?: unknown };
  // 服务端回真实 slug（auto_suffix 撞名时会与请求不同）；缺字段则回落请求值，兼容老服务端。
  return typeof res?.slug === "string" ? res.slug : body.slug;
}

export async function addWebhook(
  server: string,
  token: string,
  slug: string,
  body: { name: string; url: string; secret: string; filter: WebhookFilter; mode?: WebhookMode },
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/webhooks`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  });
}

export async function removeWebhook(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<void> {
  await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/webhooks/${encodeURIComponent(name)}`,
    { method: "DELETE", headers: bearerJson(token) },
  );
}

export async function listWebhooks(
  server: string,
  token: string,
  slug: string,
): Promise<WebhookInfo[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/webhooks`, {
    headers: bearerJson(token),
  });
  if (Array.isArray(body)) return body as WebhookInfo[];
  const webhooks = (body as Record<string, unknown> | null)?.webhooks;
  return Array.isArray(webhooks) ? (webhooks as WebhookInfo[]) : [];
}

export async function getLarkNotifyStatus(
  server: string,
  token: string,
  slug: string,
): Promise<LarkNotifyStatus> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/lark-notify`, {
    headers: bearerJson(token),
  })) as LarkNotifyStatus;
}

export async function enableLarkNotify(
  server: string,
  token: string,
  slug: string,
): Promise<LarkNotifyStatus> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/lark-notify`, {
    method: "POST",
    headers: bearerJson(token),
  })) as LarkNotifyStatus;
}

export async function disableLarkNotify(
  server: string,
  token: string,
  slug: string,
): Promise<LarkNotifyStatus> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/lark-notify`, {
    method: "DELETE",
    headers: bearerJson(token),
  })) as LarkNotifyStatus;
}

export async function listTasks(
  server: string,
  token: string,
  slug: string,
  opts: { state?: TaskState; assignee?: string; limit?: number } = {},
): Promise<TaskRecord[]> {
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set("state", opts.state);
  if (opts.assignee !== undefined) params.set("assignee", opts.assignee);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks${suffix}`, {
    headers: bearerJson(token),
  });
  const tasks = (body as Record<string, unknown> | null)?.tasks;
  return Array.isArray(tasks) ? (tasks as TaskRecord[]) : [];
}

export async function createTask(
  server: string,
  token: string,
  slug: string,
  body: {
    title: string;
    desc?: string;
    state?: TaskState;
    assignee?: { name: string; kind: TaskAssigneeKind } | null;
    priority?: number;
    labels?: string[];
    parent_id?: number;
    anchor_seqs?: number[];
    workflow_id?: string;
    scope?: string[];
    blocked_reason?: string | null;
    external_ref?: string;
    attachments?: Attachment[];
    solution?: Attachment;
  },
): Promise<TaskRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as TaskRecord;
}

// worker 的 `status --task N` 报的是「它自己这一端」的进度,不该把父任务的**全局** state 拉黑(#737):
// blocked → 返回 null = 不传播到任务全局 state(worker 的 blocked 仍在它的 status 帧 + task:N scope 里
// 可见;父任务是否 blocked 由 host 用 `party task block` 显式决定)。其余状态仍映射并传播。
// status.ts(CLI)与 mcp.ts(内置 runner 的 party_status 工具)共用这一份,免两处漂移。
export function taskStateFromReportedStatus(state: string): TaskState | null {
  if (state === "blocked") return null;
  if (state === "working") return "in_progress";
  if (state === "waiting") return "assigned";
  return state as TaskState;
}

export async function updateTask(
  server: string,
  token: string,
  slug: string,
  id: number,
  body: {
    title?: string;
    desc?: string | null;
    state?: TaskState;
    assignee?: { name: string; kind: TaskAssigneeKind } | null;
    priority?: number;
    labels?: string[];
    scope?: string[];
    blocked_reason?: string | null;
    solution?: Attachment | null;
  },
): Promise<TaskRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks/${id}`, {
    method: "PATCH",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as TaskRecord;
}

/**
 * 服务端任务租约（#936）。老服务端没有这条路由，`req` 会抛 404——调用方**必须**据此退回本机
 * 租约，而不是当成「没人持租」直接放行（放行比现在更糟：现在至少本机还挡得住）。
 * 判据见 `cli/src/task-lease-remote.ts` 的 `serverLeaseUnsupported`。
 */
export async function claimServerTaskLease(
  server: string,
  token: string,
  slug: string,
  id: number,
  body: { executor_id: string; ttl_ms?: number; force?: boolean },
): Promise<TaskLeaseGrantedResponse> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks/${id}/lease`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ op: "claim", ...body }),
  })) as TaskLeaseGrantedResponse;
}

export async function releaseServerTaskLease(
  server: string,
  token: string,
  slug: string,
  id: number,
  executorId: string,
): Promise<TaskLeaseReleasedResponse> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/tasks/${id}/lease`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ op: "release", executor_id: executorId }),
  })) as TaskLeaseReleasedResponse;
}

export async function listSquads(server: string, token: string, slug: string): Promise<ChannelSquad[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/squads`, {
    headers: bearerJson(token),
  });
  const squads = (body as Record<string, unknown> | null)?.squads;
  return Array.isArray(squads) ? (squads as ChannelSquad[]) : [];
}

export async function createSquad(
  server: string,
  token: string,
  slug: string,
  body: {
    name: string;
    title?: string;
    description?: string;
    leader?: string | null;
    members: string[];
  },
): Promise<ChannelSquad> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/squads`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelSquad;
}

export async function updateSquad(
  server: string,
  token: string,
  slug: string,
  name: string,
  body: {
    title?: string | null;
    description?: string | null;
    leader?: string | null;
    members?: string[];
  },
): Promise<ChannelSquad> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/squads/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelSquad;
}

export async function deleteSquad(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<{ ok: true; squad: ChannelSquad }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/squads/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  })) as { ok: true; squad: ChannelSquad };
}

/** 取「最近 N 条」用的哨兵 before：服务端 before>0 时返回 seq<before 的最近 limit 条。 */
export const TAIL_BEFORE = Number.MAX_SAFE_INTEGER;

/**
 * 消息查询串。before 与 since 互斥——服务端 before 优先，这里直接不发 since，避免歧义。
 * 不传 before 时保持原有 since 正向语义。
 */
export function messagesQuery(o: {
  since?: number;
  before?: number;
  limit: number;
  completion?: boolean;
}): string {
  const params = new URLSearchParams();
  if (o.before !== undefined && o.before > 0) params.set("before", String(o.before));
  else params.set("since", String(o.since ?? 0));
  params.set("limit", String(o.limit));
  if (o.completion === true) params.set("completion", "1");
  return params.toString();
}

export async function fetchMessages(
  server: string,
  token: string,
  slug: string,
  since = 0,
  limit = 100,
  opts: { completion?: boolean; before?: number } = {},
  signal?: AbortSignal,
): Promise<MsgFrame[]> {
  const query = messagesQuery({ since, limit, ...(opts.before === undefined ? {} : { before: opts.before }), ...(opts.completion === true ? { completion: true } : {}) });
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/messages?${query}`, {
    headers: bearerJson(token),
    ...(signal === undefined ? {} : { signal }),
  });
  const messages = (body as Record<string, unknown> | null)?.messages;
  return Array.isArray(messages) ? (messages as MsgFrame[]) : [];
}

/** 最近 limit 条（「补上下文」的正确默认语义）。 */
export async function fetchRecentMessages(
  server: string, token: string, slug: string, limit = 100,
  opts: { completion?: boolean } = {},
  signal?: AbortSignal,
): Promise<MsgFrame[]> {
  return fetchMessages(server, token, slug, 0, limit, { ...opts, before: TAIL_BEFORE }, signal);
}

export async function fetchPresence(
  server: string,
  token: string,
  slug: string,
  signal?: AbortSignal,
): Promise<PresenceEntry[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/presence`, {
    headers: bearerJson(token),
    ...(signal === undefined ? {} : { signal }),
  });
  const presence = (body as Record<string, unknown> | null)?.presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : [];
}

export async function fetchRuntimePeers(
  server: string,
  token: string,
  slug: string,
  topology: RuntimeTopology,
  purpose: RuntimePeerPurpose,
  signal?: AbortSignal,
): Promise<RuntimePeerDiscovery> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/runtime-peers`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ topology, purpose }),
    ...(signal === undefined ? {} : { signal }),
  });
  const result = parseRuntimePeerDiscovery(body);
  if (
    result === undefined &&
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    (body as Record<string, unknown>).version !== 3
  ) {
    throw new RuntimePeerProtocolError((body as Record<string, unknown>).version);
  }
  if (result === undefined) throw new Error("runtime peer discovery returned an invalid response");
  const expectedBinding = purpose === "topology_advisory"
    ? "unbound_advisory"
    : purpose === "capability_probe"
      ? "capability_probe"
      : "live_socket";
  if (result.caller_binding !== expectedBinding) {
    throw new Error(
      `runtime peer discovery returned caller_binding=${result.caller_binding} for purpose=${purpose}`,
    );
  }
  return result;
}

// 已读游标快照 + 频道最新 seq（Phase 2 · CLI）：给 `party who` 标注每个身份读到第几条 / 落后多少。
export async function fetchReadCursors(
  server: string,
  token: string,
  slug: string,
): Promise<{ cursors: ReadCursor[]; last_seq: number }> {
  const body = (await req(server, `/api/channels/${encodeURIComponent(slug)}/read-cursors`, {
    headers: bearerJson(token),
  })) as Record<string, unknown> | null;
  const cursors = Array.isArray(body?.cursors) ? (body.cursors as ReadCursor[]) : [];
  const last_seq = typeof body?.last_seq === "number" ? body.last_seq : 0;
  return { cursors, last_seq };
}

export async function reviseMessage(
  server: string,
  token: string,
  slug: string,
  seq: number,
  action: "edit" | "retract" | "supersede",
  body?: { body: string; mentions?: string[] },
  signal?: AbortSignal,
): Promise<{ message: MsgFrame; superseded?: MsgFrame }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages/${seq}/${action}`, {
    method: "POST",
    headers: bearerJson(token),
    body: action === "retract" ? undefined : JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })) as { message: MsgFrame; superseded?: MsgFrame };
}

export async function reviewCompletion(
  server: string,
  token: string,
  slug: string,
  seq: number,
  body: { action: "approve" | "reject"; reason?: string },
): Promise<{ message: MsgFrame; reply: MsgFrame }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages/${seq}/review`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { message: MsgFrame; reply: MsgFrame };
}

/**
 * 回执（#828）：告诉频道「seq N 我收到了，但我现在不在轮次里」。
 *
 * seq 走 URL 路径、由服务端从路由取，调用方没有能拼错的 seq 字段——手搓回执发出 `（seq ）` 那类
 * 残缺文案在这条路径上不可能发生。返回的是**被回执的那条消息**（带上回执元数据），不是新消息：
 * 回执不占 seq、不进正文流、不触发 delivery。
 */
export async function postReceipt(
  server: string,
  token: string,
  slug: string,
  seq: number,
  body: { reason: "not_in_turn" | "queued" | "seen"; note?: string },
): Promise<{ message: MsgFrame }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages/${seq}/receipt`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { message: MsgFrame };
}

/**
 * 「已读不回」的服务端终态（#875）：结清一条 @ 而不发消息，记为
 * `terminal_reason=acknowledged_no_reply`——**不是** failed / unknown_outcome。
 *
 * ref 传 delivery id 或那条 @ 消息的 seq（服务端把纯数字解析成「我在那条消息上的那条 @」，
 * 因为调用方手上通常只有 `who --json` 报的 pending_mention_seqs）。
 */
export async function ackDelivery(
  server: string,
  token: string,
  slug: string,
  ref: string | number,
): Promise<{ ok: true; delivery: PublicDirectedDelivery; deduped?: boolean }> {
  return (await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/deliveries/${encodeURIComponent(String(ref))}/ack`,
    { method: "POST", headers: bearerJson(token) },
  )) as { ok: true; delivery: PublicDirectedDelivery; deduped?: boolean };
}

/**
 * 拍板的产物（#929）：除了 resolve 后的原消息 + decision_response 回复，服务端还会把这次拍板
 * **额外**落进决策账本（`ask:` topic）。recorded=false 时带 reason（forbidden / already_recorded /
 * ledger_full / conflict / archived / write_failed），决策本身仍然成立。
 */
export interface DecisionRespondResult {
  message: MsgFrame;
  reply: MsgFrame;
  decision_ledger?: { recorded: boolean; decision?: ChannelDecisionRecord; reason?: string };
}

// 人类决策回应（#284）：人类/moderator 对某条 decision_request 点选项/审批。
// approval 用 { action }；choice 用 { option }（下标或选项文本）。
export async function respondDecision(
  server: string,
  token: string,
  slug: string,
  seq: number,
  body: { action?: "approve" | "reject"; option?: number | string; reason?: string },
): Promise<DecisionRespondResult> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages/${seq}/decision`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as DecisionRespondResult;
}

// 频道决策模式（#284）：approval（人类审批）↔ unattended（无人值守）。moderator only。
export async function setDecisionMode(
  server: string,
  token: string,
  slug: string,
  mode: DecisionMode,
): Promise<{ mode: DecisionMode }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/decision-mode`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify({ mode }),
  })) as { mode: DecisionMode };
}

export async function listChannelDecisions(
  server: string,
  token: string,
  slug: string,
  status: "active" | "all" = "active",
): Promise<{ decisions: ChannelDecisionRecord[]; truncated: boolean }> {
  const body = (await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/decisions?status=${status}&limit=${status === "active" ? 100 : 200}`,
    { headers: bearerJson(token) },
  )) as { decisions?: ChannelDecisionRecord[]; truncated?: boolean };
  return {
    decisions: Array.isArray(body.decisions) ? body.decisions : [],
    truncated: body.truncated === true,
  };
}

export async function recordChannelDecision(
  server: string,
  token: string,
  slug: string,
  input: { topic: string; summary: string; source_seq?: number; supersedes_id?: string },
): Promise<ChannelDecisionRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/decisions`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(input),
  })) as ChannelDecisionRecord;
}

export async function fetchWakeDeliveries(
  server: string,
  token: string,
  slug: string,
  opts: { since?: number; target?: string; limit?: number } = {},
): Promise<WakeDelivery[]> {
  const params = new URLSearchParams();
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.target !== undefined) params.set("target", opts.target);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/wake-deliveries${suffix}`, {
    headers: bearerJson(token),
  });
  const deliveries = (body as Record<string, unknown> | null)?.deliveries;
  return Array.isArray(deliveries) ? (deliveries as WakeDelivery[]) : [];
}

/**
 * 「> since 的消息里，第一条 @ 到我的是第几条」——只回 seq，不拉正文（#903）。
 *
 * 为 codex Stop hook 而生：它没有 serve/watch 落下的本地欠账可读（它存在的意义正是顶替
 * 那条通道），又只有 ~10s 预算，所以需要一次尽可能便宜、可独立设超时的问询。正文仍旧
 * 由会话自己去 `party history` 读。
 */
/**
 * `next-mention` 的回答（#958 起不止一个 seq）。
 *
 * `seqs` 是 since 之后**全部** @ 我的 seq（升序，队首恒为 `seq`），供调用方说出「这是第 1/N 条」
 * 和一次排空；老服务端只回 `seq`，此时 `seqs` 为 null＝「不知道队列多深」，调用方不许把它当 1。
 * `truncated` 为真时列表只是下限（服务端扫描窗口被打满）。
 */
export interface NextMention {
  seq: number;
  seqs: number[] | null;
  truncated: boolean;
}

export async function fetchNextMention(
  server: string,
  token: string,
  slug: string,
  since: number,
  signal?: AbortSignal,
): Promise<NextMention | null> {
  const body = (await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/next-mention?since=${encodeURIComponent(String(Math.max(0, Math.trunc(since))))}`,
    { headers: bearerJson(token), ...(signal === undefined ? {} : { signal }) },
  )) as Record<string, unknown> | null;
  const seq = body?.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) return null;
  const raw = body?.seqs;
  const seqs = Array.isArray(raw)
    ? raw.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
    : null;
  // 服务端契约是 seqs[0] === seq；列表里没有队首就当它不可信（老服务端 / 形状不对），退回「不知道」。
  return {
    seq,
    seqs: seqs !== null && seqs[0] === seq ? seqs : null,
    truncated: body?.truncated === true,
  };
}

export async function createCapture(
  server: string,
  token: string,
  slug: string,
  body: { seq: number; kind: CaptureKind; note?: string },
): Promise<CaptureRecord> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/captures`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as CaptureRecord;
}

export async function listCaptures(
  server: string,
  token: string,
  slug: string,
  opts: { kind?: CaptureKind; since?: number; limit?: number } = {},
): Promise<CaptureRecord[]> {
  const params = new URLSearchParams();
  if (opts.kind !== undefined) params.set("kind", opts.kind);
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/captures${suffix}`, {
    headers: bearerJson(token),
  });
  const captures = (body as Record<string, unknown> | null)?.captures;
  return Array.isArray(captures) ? (captures as CaptureRecord[]) : [];
}

export async function listChannelRoles(
  server: string,
  token: string,
  slug: string,
): Promise<ChannelRoleInfo[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/roles`, {
    headers: bearerJson(token),
  });
  const roles = (body as Record<string, unknown> | null)?.roles;
  return Array.isArray(roles) ? (roles as ChannelRoleInfo[]) : [];
}

export async function setChannelRole(
  server: string,
  token: string,
  slug: string,
  name: string,
  role: CollaborationRole,
  responsibility?: string,
  // #370：向谁汇报（可跨 owner）。undefined=不改；空串=清空（顶层）；否则 agent 名。
  reportsTo?: string,
): Promise<ChannelRoleInfo> {
  const payload: Record<string, unknown> = { role };
  if (responsibility !== undefined) payload.responsibility = responsibility;
  if (reportsTo !== undefined) payload.reports_to = reportsTo === "" ? null : reportsTo;
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/roles/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(payload),
  })) as ChannelRoleInfo;
}

export async function clearChannelRole(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/roles/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  });
}

export async function setCompletionGate(
  server: string,
  token: string,
  slug: string,
  body: { gate: CompletionGate; policy?: CompletionReviewPolicy },
): Promise<{ gate: CompletionGate; policy: CompletionReviewPolicy }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/completion-gate`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { gate: CompletionGate; policy: CompletionReviewPolicy };
}

export async function setLoopGuard(
  server: string,
  token: string,
  slug: string,
  body: { enabled: boolean; limit?: number },
): Promise<{ enabled: boolean; limit: number | null }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/loop-guard`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { enabled: boolean; limit: number | null };
}

export interface LoopGuardState {
  enabled: boolean;
  limit: number;
  streak: number;
  remaining: number;
  resets_on: string;
  // #815：调用方自己的 fair-share 名额。agent 撞的通常是这道墙而不是全局 streak，
  // 所以 self.remaining 才是「我还能发几条」的答案。人类调用方/旧 worker 无此字段。
  self?: { name: string; limit: number; used: number; remaining: number };
}

// #174 loop guard 读路径：熔断前就能读到 limit/streak/remaining，agent 据此自我节流。
export async function getLoopGuard(server: string, token: string, slug: string): Promise<LoopGuardState> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/loop-guard`, {
    headers: bearerJson(token),
  })) as LoopGuardState;
}

// #108 per-agent wake 预算：窗口内 wake 硬上限，超额 @ 不再投 webhook（不烧订阅）。
export interface WakeBudgetState {
  name: string;
  enabled: boolean;
  limit: number | null;
  window_ms: number | null;
  used: number;
  remaining: number | null;
  window_resets_at: number | null;
}

export async function getWakeBudget(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<WakeBudgetState> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/wake-budget/${encodeURIComponent(name)}`, {
    headers: bearerJson(token),
  })) as WakeBudgetState;
}

export async function setWakeBudget(
  server: string,
  token: string,
  slug: string,
  name: string,
  body: { enabled: boolean; limit?: number; window_ms?: number },
): Promise<WakeBudgetState> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/wake-budget/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as WakeBudgetState;
}

export async function setWorkflowGuard(
  server: string,
  token: string,
  slug: string,
  body: { enabled: boolean; limit?: number },
): Promise<{ enabled: boolean; limit: number | null }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/workflow-guard`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { enabled: boolean; limit: number | null };
}

export interface ChannelRetentionPolicy {
  message_retention_ms: number | null;
  audit_retention_ms: number | null;
}

export async function getChannelRetention(
  server: string,
  token: string,
  slug: string,
): Promise<ChannelRetentionPolicy> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/retention`, {
    headers: bearerJson(token),
  })) as ChannelRetentionPolicy;
}

export async function setChannelRetention(
  server: string,
  token: string,
  slug: string,
  body: Partial<ChannelRetentionPolicy>,
): Promise<ChannelRetentionPolicy> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/retention`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as ChannelRetentionPolicy;
}

export async function setChannelVisibility(
  server: string,
  token: string,
  slug: string,
  body: { visibility: ChannelVisibility; confirm?: true },
): Promise<{ visibility: ChannelVisibility }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/visibility`, {
    method: "PUT",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as { visibility: ChannelVisibility };
}

export async function listChannelMembers(
  server: string,
  token: string,
  slug: string,
): Promise<ChannelMemberInfo[]> {
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/members`, {
    headers: bearerJson(token),
  });
  const members = (body as Record<string, unknown> | null)?.members;
  return Array.isArray(members) ? (members as ChannelMemberInfo[]) : [];
}

export async function addChannelMember(
  server: string,
  token: string,
  slug: string,
  account: string,
): Promise<ChannelMemberInfo> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(account)}`, {
    method: "PUT",
    headers: bearerJson(token),
  })) as ChannelMemberInfo;
}

export async function removeChannelMember(
  server: string,
  token: string,
  slug: string,
  account: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/members/${encodeURIComponent(account)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  });
}

export async function createJoinLink(
  server: string,
  token: string,
  slug: string,
  body: { expires_in_sec?: number; max_uses?: number },
): Promise<JoinLinkInfo> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/join-links`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  })) as JoinLinkInfo;
}

export async function revokeJoinLink(
  server: string,
  token: string,
  slug: string,
  code: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/join-links/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: bearerJson(token),
  });
}

export async function searchMessages(
  server: string,
  token: string,
  slug: string,
  opts: { query: string; since?: number; limit?: number; from?: string },
): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: opts.query });
  if (opts.since !== undefined) params.set("since", String(opts.since));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.from !== undefined) params.set("from", opts.from);
  const body = await req(server, `/api/channels/${encodeURIComponent(slug)}/search?${params.toString()}`, {
    headers: bearerJson(token),
  });
  const hits = (body as Record<string, unknown> | null)?.hits;
  return Array.isArray(hits) ? (hits as SearchHit[]) : [];
}

export type MessagePayload = Omit<SendMessageFrame, "type"> | Omit<SendStatusFrame, "type">;

const ULID_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// ULID（#98）：48-bit 毫秒时间戳 + 80-bit 随机，时间有序、无依赖。仅需唯一性即可满足幂等，
// 时间有序还让服务端 (sender, key) 索引对最近消息更友好。crypto.getRandomValues 在 node/bun/浏览器均有。
function newIdempotencyKey(): string {
  let ts = Date.now();
  const time: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    time.unshift(ULID_CROCKFORD[ts % 32]!);
    ts = Math.floor(ts / 32);
  }
  const rnd = new Uint8Array(16);
  crypto.getRandomValues(rnd);
  const rand: string[] = [];
  for (let i = 0; i < 16; i += 1) rand.push(ULID_CROCKFORD[rnd[i]! % 32]!);
  return time.join("") + rand.join("");
}

export type { Attachment };

export async function postMessage(
  server: string,
  token: string,
  slug: string,
  payload: MessagePayload,
  signal?: AbortSignal,
): Promise<{
  seq: number;
  /** 正文便利提取里服务端未能路由、已降级为文本的 token（#663）；空/缺省=无。 */
  unresolved_mentions?: string[];
  /** self-host 与 owner 指派 host 冲突；发送成功但应直接展示给调用者。 */
  role_warning?: string;
  completion_review?: CompletionReview;
  decision_request?: DecisionRequest;
  decision_resolution?: DecisionResolution;
}> {
  // 每次发送生成一个新的幂等键：调用方不必操心；重试（客户端超时重发 / 服务端 DO-reset clone 重发）
  // 携带同一 body 即同一 key，服务端据此去重。调用方若已带 key（少见）则尊重之。
  const body: MessagePayload = "idempotency_key" in payload && payload.idempotency_key !== undefined
    ? payload
    : { ...payload, idempotency_key: newIdempotencyKey() };
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
    signal,
  })) as {
    seq: number;
    unresolved_mentions?: string[];
    role_warning?: string;
    completion_review?: CompletionReview;
    decision_request?: DecisionRequest;
    decision_resolution?: DecisionResolution;
  };
}

// 附件上传（#176/#109）：blob 进 R2，返回引用元数据；随消息带在 attachments 字段里。
// serve 交付物（[attach] 文件 / 超过 BODY_LIMIT 的正文）走这里，绝不再 inline 进消息正文撞 413。
// content-type 直接透传给 worker（它会 split(";")[0] 归一化）；content-length 由 fetch 依 body 自动补。
export async function uploadAttachment(
  server: string,
  token: string,
  slug: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<Attachment> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/attachments?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
    },
    // typed array 是合法 BodyInit；不能走 bearerJson（它会把 content-type 钉成 application/json）
    body: bytes,
  })) as Attachment;
}

/** Download through the worker's authenticated route without leaking credentials to another origin/channel. */
export async function downloadAttachment(
  server: string,
  token: string,
  slug: string,
  attachment: Attachment,
): Promise<Uint8Array> {
  const base = new URL(server.replace(/\/+$/, "") + "/");
  const expectedPrefix = `/api/channels/${encodeURIComponent(slug)}/attachments/`;
  if (!attachment.url.startsWith(expectedPrefix)) throw new Error(`attachment URL is outside channel ${slug}`);
  const url = new URL(attachment.url, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(expectedPrefix) || url.search !== "" || url.hash !== "") {
    throw new Error(`attachment URL is outside channel ${slug}`);
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  headers.set("x-ap-client-version", pkg.version);
  const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  if (!res.ok) {
    const raw = await res.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // Older deployments may return plain-text attachment errors.
    }
    throw extractError(res.status, body, raw);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function archiveChannel(server: string, token: string, slug: string): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/archive`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

export async function resetGuard(server: string, token: string, slug: string): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/reset-guard`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

// #422 频道级备份：拉取合并后的频道存档 JSON（D1 channels 行 + roles/tasks/members + DO 持久表）。
// moderator-only；原样返回服务端 JSON 交由 CLI 写盘/打印，作为离线备份物。
export async function exportChannel(server: string, token: string, slug: string): Promise<unknown> {
  return req(server, `/api/channels/${encodeURIComponent(slug)}/export`, { headers: bearerJson(token) });
}

// #422 DO↔D1 对账报告：只读比对双写字段，返回 { ok, divergences[], durable_object }。
export interface ReconcileReport {
  ok: boolean;
  checked_at: number;
  channel: string;
  divergences: { field: string; d1: unknown; durable_object: unknown }[];
  durable_object: Record<string, unknown>;
}

export async function reconcileChannel(server: string, token: string, slug: string): Promise<ReconcileReport> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/reconcile`, {
    headers: bearerJson(token),
  })) as ReconcileReport;
}

// 重置某个 workflow 的 no-progress 熔断（与 loop guard 的 reset-guard 分属两套熔断器）。
// human-only + moderator/host，服务端 /api/channels/:slug/workflows/:workflow_id/reset-guard 强制。
export async function resetWorkflowGuard(
  server: string,
  token: string,
  slug: string,
  workflowId: string,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/workflows/${encodeURIComponent(workflowId)}/reset-guard`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

// 房主踢人：按参与者/token 名字踢出频道（防滥用 MVP，spec §5）
export async function kickParticipant(
  server: string,
  token: string,
  slug: string,
  name: string,
  mode: "disconnect" | "remove" = "disconnect",
): Promise<void> {
  const body = mode === "remove" ? { name, mode } : { name };
  await req(server, `/api/channels/${encodeURIComponent(slug)}/kick`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  });
}

/**
 * 本机唤醒自检直报（issue #926）。`block === null` ＝ 自检通过，清除既有判定。
 *
 * 调用方一律 fire-and-forget：这条上报**绝不允许影响它挂靠的那个进程**（MCP 的 stdio）。
 * 失败就是没这条提示，不是故障。
 */
export async function reportWakeBlock(
  server: string,
  token: string,
  slug: string,
  name: string,
  block: WakeBlock | null,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/wake-block`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify({ wake_block: block }),
  });
}

// 人为暂停某 agent 的接待（issue #180）。resumeAt = 定时恢复时刻（epoch ms），省略则只能手动恢复。
export async function pauseAgent(
  server: string,
  token: string,
  slug: string,
  name: string,
  resumeAt?: number,
): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/pause`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(resumeAt === undefined ? {} : { resume_at: resumeAt }),
  });
}

// 恢复某 agent 的接待（issue #180）。
export async function resumeAgent(server: string, token: string, slug: string, name: string): Promise<void> {
  await req(server, `/api/channels/${encodeURIComponent(slug)}/presence/${encodeURIComponent(name)}/resume`, {
    method: "POST",
    headers: bearerJson(token),
  });
}

// GDPR 按身份数据擦除（#421）。物理删除该身份在频道 message_audit/wake 账本/读游标/presence 的可识别行，
// 并把其消息正文 + 归属 PII 抹成 [erased]。返回各表命中数。仅频道 moderator（房主 / ap_ token）可调。
export async function eraseIdentityData(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<IdentityEraseSummary> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/identity/${encodeURIComponent(name)}/data`, {
    method: "DELETE",
    headers: bearerJson(token),
  })) as IdentityEraseSummary;
}

// GDPR 按身份数据导出（#421，只读）。返回该身份在频道可归因的全部数据，供数据可携 / 出境审查。
export async function exportIdentityData(
  server: string,
  token: string,
  slug: string,
  name: string,
): Promise<IdentityExportData> {
  const merged: IdentityExportData = {
    name, exported_at: Date.now(), messages: [], audit: [], wake_deliveries: [],
    read_cursor: null, presence: [], next: { messages: 0, audit: 0, wake_deliveries: 0 },
  };
  while (merged.next.messages !== null || merged.next.audit !== null || merged.next.wake_deliveries !== null) {
    const query = new URLSearchParams({
      message_after: String(merged.next.messages ?? -1),
      audit_after: String(merged.next.audit ?? -1),
      wake_after: String(merged.next.wake_deliveries ?? -1),
    });
    const page = (await req(server,
      `/api/channels/${encodeURIComponent(slug)}/identity/${encodeURIComponent(name)}/data?${query}`,
      { headers: bearerJson(token) })) as IdentityExportData;
    merged.exported_at = page.exported_at;
    merged.messages.push(...page.messages);
    merged.audit.push(...page.audit);
    merged.wake_deliveries.push(...page.wake_deliveries);
    merged.read_cursor ??= page.read_cursor;
    if (merged.presence.length === 0) merged.presence = page.presence;
    merged.next = page.next;
  }
  return merged;
}

// rest 错误 → 契约退出码
export function handleRestError(e: unknown): number {
  if (e instanceof RestError) {
    console.error(stripTerminalControls(`error: ${e.code ?? e.status} ${e.message}`));
    if (e.status === 401) {
      // #2：旧版 CLI 会把「需升级」误报成 unauthorized，看着像 token 失效。附版本 + 升级指引降低误诊。
      console.error(
        `hint: 若确认 token 未撤销，多半是 CLI 过旧（当前 party v${pkg.version}）——旧版曾把「需升级」误报成本条。\n` +
          `      升级后重试：curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
      );
      return EXIT_AUTH;
    }
    if (e.code === "loop_guard") return EXIT_LOOP_GUARD;
    // workflow guard 与 loop guard 同类：停手等人类，别换个措辞重试（#122）
    if (e.code === "workflow_guard") {
      console.error(
        "hint: workflow guard tripped — stop, report status blocked, wait for a human. Do not rephrase and retry.\n" +
          "      a human clears it with: party channel reset-workflow-guard <workflow_id> [slug]\n" +
          "      (the blocked workflow_id is named in the error above; plain `reset-guard` only clears the loop guard, not this)",
      );
      return EXIT_WORKFLOW_GUARD;
    }
    if (e.code === "archived") return EXIT_ARCHIVED;
    // 429：退避后再试，别立刻连打（#122）
    if (e.status === 429 || e.code === "rate_limited") {
      console.error("hint: rate limited — back off (exponential, start ~30s) before retrying. Do not hammer.");
      return EXIT_RATE_LIMITED;
    }
    return 1;
  }
  console.error(stripTerminalControls(`error: ${e instanceof Error ? e.message : String(e)}`));
  return 1;
}
