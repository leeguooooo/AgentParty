// rest 封装 + token 存取。
// 规则（spec §10 / M2 契约）：URL 带 ?t= 时优先用它，并立即从地址栏移除；
// share token 只放 sessionStorage，本次标签页可刷新，避免长期落 localStorage。
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import type { WebSession } from "./oidc";

const TOKEN_KEY = "ap_token";
const SHARE_TOKEN_KEY = "ap_share_token";
const SESSION_KEY = "ap_oidc_session";
let activeShareToken: string | null = null;

export class AuthError extends Error {}
// 私有频道 ACL 拒入（spec §3 访问规则矩阵）：worker 回 403 forbidden / WS 1008 forbidden。
// 与 AuthError 区分——token 有效，只是这个频道不让进，不该回登录闸。
export class ForbiddenError extends Error {}
// 铸 agent token 时同名已存在（worker 409）——上层据此换名重试。
export class ConflictError extends Error {}
// 名字非法 / 保留名 / scope 非法（worker 400）——文案层面走内联红字。
export class ValidationError extends Error {}

export function urlToken(): string | null {
  return new URLSearchParams(window.location.search).get("t");
}

export function storedToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function isShareMode(): boolean {
  return activeShareToken !== null;
}

export function currentShareToken(): string | null {
  return activeShareToken;
}

export function getToken(): string | null {
  const queryToken = urlToken();
  if (queryToken !== null) {
    activeShareToken = queryToken;
    sessionStorage.setItem(SHARE_TOKEN_KEY, queryToken);
    dropUrlToken();
    return queryToken;
  }
  const sessionShareToken = sessionStorage.getItem(SHARE_TOKEN_KEY);
  if (sessionShareToken !== null) {
    activeShareToken = sessionShareToken;
    return sessionShareToken;
  }
  return storedToken();
}

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
}

// OIDC 网页会话（access + refresh + 过期），用于静默续期。access_token 镜像到 ap_token，
// 故 getToken() 取到的仍是当前 access_token；续期后覆盖二者。
export function saveSession(sess: WebSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  localStorage.setItem(TOKEN_KEY, sess.accessToken);
}

export function readSession(): WebSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as WebSession) : null;
  } catch {
    return null;
  }
}

export function clearShareToken() {
  activeShareToken = null;
  sessionStorage.removeItem(SHARE_TOKEN_KEY);
}

// 分享 token 失效时退回粘贴登录：把 ?t= 从地址栏摘掉，避免 getToken 继续命中坏 token
export function dropUrlToken() {
  const url = new URL(window.location.href);
  url.searchParams.delete("t");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

// 频道列表页要「最近一条消息 + 参与者状态点」（spec §9 第 1 块），worker 聚合自各 do
export interface ChannelLastMessage {
  sender: string;
  kind: "message" | "status";
  body: string;
  ts: number;
}

export interface ChannelInfo {
  slug: string;
  title: string | null;
  topic: string | null;
  kind: "standing" | "temp";
  mode: "normal" | "party";
  // 公开/私有（spec §3.1）：默认 private，旧 worker 响应缺此字段时按私有处理（不显 PUBLIC 徽章）。
  visibility: "public" | "private";
  created_at: number;
  archived_at: number | null;
  last_message: ChannelLastMessage | null;
  presence: PresenceEntry[];
}

// 当前登录身份（spec §10）：topbar 显示 "signed in as <email 或 name>"
export interface MeInfo {
  name: string;
  email: string | null;
  kind: "agent" | "human";
  role: "agent" | "human" | "readonly";
  owner: string | null;
}

export async function fetchMe(token: string): Promise<MeInfo> {
  const res = await fetch("/api/me", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (!res.ok) throw new Error(`GET /api/me failed (${res.status})`);
  return (await res.json()) as MeInfo;
}

export async function listChannels(token: string): Promise<ChannelInfo[]> {
  const res = await fetch("/api/channels", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (!res.ok) throw new Error(`GET /api/channels failed (${res.status})`);
  const data = (await res.json()) as { channels: ChannelInfo[] };
  return data.channels;
}

// 频道页「让 agent 加入」：登录人类账号会话铸一枚 channel-scoped 的 agent token（spec §10）。
// owner 由服务端从会话推导，前端不传。明文 token 仅此一次返回，复制后即无法再取。
export interface ChannelAgent {
  token: string;
  name: string;
  channel_scope?: string;
}

export async function createChannelAgent(
  slug: string,
  name: string,
  token: string,
): Promise<ChannelAgent> {
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name, channel_scope: slug }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("no permission to mint agents here");
  if (res.status === 409) throw new ConflictError("agent name already exists");
  if (res.status === 400) throw new ValidationError("invalid agent name");
  if (!res.ok) throw new Error(`POST /api/agents failed (${res.status})`);
  return (await res.json()) as ChannelAgent;
}

// 页面建频道（spec §3.1）：登录人类账号可建公开/私有频道；scoped/readonly token 会被服务端 403。
// owner_account 由服务端从会话推导。201 只回 {slug,title,kind,mode,visibility}，列表随后刷新补全。
export interface NewChannel {
  slug: string;
  title?: string;
  mode?: "normal" | "party";
  visibility?: "public" | "private";
}

export async function createChannel(
  token: string,
  input: NewChannel,
): Promise<{ slug: string }> {
  const res = await fetch("/api/channels", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "standing", ...input }),
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("no permission to create channels");
  if (res.status === 409) throw new ConflictError("slug already exists");
  if (res.status === 400) throw new ValidationError("invalid channel");
  if (!res.ok) throw new Error(`POST /api/channels failed (${res.status})`);
  return (await res.json()) as { slug: string };
}

// 归档频道的 ws 会被 1008 直接踢掉、零补推；网页回看走这条 rest（spec §6）
export async function fetchMessages(token: string, slug: string, limit = 1000): Promise<MsgFrame[]> {
  const res = await fetch(`/api/channels/${encodeURIComponent(slug)}/messages?limit=${limit}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (res.status === 403) throw new ForbiddenError("forbidden");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/messages failed (${res.status})`);
  const data = (await res.json()) as { messages: MsgFrame[] };
  return data.messages;
}
