// rest 封装 + token 存取。
// 规则（spec §10 / M2 契约）：URL 带 ?t= 时优先用它且不落 localStorage（readonly 分享模式）；
// 否则用 localStorage 里粘贴过的 token。
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";

const TOKEN_KEY = "ap_token";

export class AuthError extends Error {}

export function urlToken(): string | null {
  return new URLSearchParams(window.location.search).get("t");
}

export function isShareMode(): boolean {
  return urlToken() !== null;
}

export function getToken(): string | null {
  return urlToken() ?? localStorage.getItem(TOKEN_KEY);
}

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
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
