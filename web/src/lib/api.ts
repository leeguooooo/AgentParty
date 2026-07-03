// rest 封装 + token 存取。
// 规则（spec §10 / M2 契约）：URL 带 ?t= 时优先用它，并立即从地址栏移除；
// share token 只放 sessionStorage，本次标签页可刷新，避免长期落 localStorage。
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";

const TOKEN_KEY = "ap_token";
const SHARE_TOKEN_KEY = "ap_share_token";
let activeShareToken: string | null = null;

export class AuthError extends Error {}

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

// 归档频道的 ws 会被 1008 直接踢掉、零补推；网页回看走这条 rest（spec §6）
export async function fetchMessages(token: string, slug: string, limit = 1000): Promise<MsgFrame[]> {
  const res = await fetch(`/api/channels/${encodeURIComponent(slug)}/messages?limit=${limit}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new AuthError("invalid or revoked token");
  if (!res.ok) throw new Error(`GET /api/channels/${slug}/messages failed (${res.status})`);
  const data = (await res.json()) as { messages: MsgFrame[] };
  return data.messages;
}
