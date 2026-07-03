// rest api 封装
import {
  EXIT_ARCHIVED,
  EXIT_AUTH,
  EXIT_LOOP_GUARD,
  type ChannelKind,
  type ChannelMode,
  type MsgFrame,
  type SendMessageFrame,
  type SendStatusFrame,
  type TokenRole,
  type WebhookFilter,
} from "@agentparty/shared";

export type { ChannelMode, WebhookFilter };

export class RestError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export interface ChannelInfo {
  slug: string;
  title: string | null;
  kind: ChannelKind;
  mode?: ChannelMode;
  archived_at: number | null;
}

export interface WebhookInfo {
  name: string;
  url: string;
  filter: WebhookFilter;
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
  return new RestError(status, code, message);
}

async function req(server: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(server.replace(/\/+$/, "") + path, init);
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

export async function createToken(
  server: string,
  adminSecret: string,
  name: string,
  role: TokenRole,
  owner?: string,
): Promise<{ token: string; name: string; role: TokenRole; owner?: string }> {
  // owner 仅在给出时进请求体，缺省不发，保持旧调用方的请求形状不变
  const body = owner !== undefined ? { name, role, owner } : { name, role };
  return (await req(server, "/api/tokens", {
    method: "POST",
    headers: { "x-admin-secret": adminSecret, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as { token: string; name: string; role: TokenRole; owner?: string };
}

export async function revokeToken(server: string, adminSecret: string, name: string): Promise<void> {
  await req(server, `/api/tokens/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "x-admin-secret": adminSecret },
  });
}

export async function listChannels(server: string, token: string): Promise<ChannelInfo[]> {
  const body = await req(server, "/api/channels", { headers: bearerJson(token) });
  if (Array.isArray(body)) return body as ChannelInfo[];
  const channels = (body as Record<string, unknown> | null)?.channels;
  return Array.isArray(channels) ? (channels as ChannelInfo[]) : [];
}

export async function createChannel(
  server: string,
  token: string,
  body: { slug: string; title?: string; kind: ChannelKind; mode?: ChannelMode },
): Promise<void> {
  await req(server, "/api/channels", {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(body),
  });
}

export async function addWebhook(
  server: string,
  token: string,
  slug: string,
  body: { name: string; url: string; secret: string; filter: WebhookFilter },
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

export async function fetchMessages(
  server: string,
  token: string,
  slug: string,
  since = 0,
  limit = 100,
): Promise<MsgFrame[]> {
  const body = await req(
    server,
    `/api/channels/${encodeURIComponent(slug)}/messages?since=${since}&limit=${limit}`,
    { headers: bearerJson(token) },
  );
  const messages = (body as Record<string, unknown> | null)?.messages;
  return Array.isArray(messages) ? (messages as MsgFrame[]) : [];
}

export type MessagePayload = Omit<SendMessageFrame, "type"> | Omit<SendStatusFrame, "type">;

export async function postMessage(
  server: string,
  token: string,
  slug: string,
  payload: MessagePayload,
): Promise<{ seq: number }> {
  return (await req(server, `/api/channels/${encodeURIComponent(slug)}/messages`, {
    method: "POST",
    headers: bearerJson(token),
    body: JSON.stringify(payload),
  })) as { seq: number };
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

// rest 错误 → 契约退出码
export function handleRestError(e: unknown): number {
  if (e instanceof RestError) {
    console.error(`error: ${e.code ?? e.status} ${e.message}`);
    if (e.status === 401) return EXIT_AUTH;
    if (e.code === "loop_guard") return EXIT_LOOP_GUARD;
    if (e.code === "archived") return EXIT_ARCHIVED;
    return 1;
  }
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  return 1;
}
