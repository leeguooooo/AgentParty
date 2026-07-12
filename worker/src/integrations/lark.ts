import type { MsgFrame } from "@agentparty/shared";

export type LarkProviderKind = "lark" | "feishu";
export type LarkReceiveIdType = "union_id" | "open_id" | "user_id" | "email";

export interface LarkProviderConfig {
  id: string;
  kind: LarkProviderKind;
  clientId: string;
  clientSecretEnv: string;
  tenantKey: string | null;
}

export interface LarkDirectoryUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export class LarkDirectoryError extends Error {
  constructor(
    readonly kind: "permission" | "invalid_cursor" | "not_found" | "rate_limited" | "upstream",
    message: string,
  ) {
    super(message);
  }
}

export interface LarkWebhookPayload extends MsgFrame {
  channel: string;
  permalink: string;
}

type EnvLike = {
  AUTH_PROVIDERS?: string;
  LARK_CLIENT_SECRET?: string;
  FEISHU_CLIENT_SECRET?: string;
};

const DEFAULT_SECRET_ENV: Record<LarkProviderKind, string> = {
  lark: "LARK_CLIENT_SECRET",
  feishu: "FEISHU_CLIENT_SECRET",
};
const TOKEN_SKEW_MS = 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function authProviderConfigs(env: EnvLike): LarkProviderConfig[] {
  const raw = env.AUTH_PROVIDERS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const providers: LarkProviderConfig[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const kind = item.kind === "feishu" ? "feishu" : item.kind === "lark" ? "lark" : null;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const clientId = typeof item.client_id === "string" ? item.client_id.trim() : "";
    if (kind === null || !id || !clientId) continue;
    providers.push({
      id,
      kind,
      clientId,
      clientSecretEnv:
        typeof item.client_secret_env === "string" && item.client_secret_env.trim()
          ? item.client_secret_env.trim()
          : DEFAULT_SECRET_ENV[kind],
      tenantKey: typeof item.tenant_key === "string" && item.tenant_key.trim() ? item.tenant_key.trim() : null,
    });
  }
  return providers;
}

function larkError(data: Record<string, unknown>, status: number): LarkDirectoryError | null {
  const code = Number(data.code ?? 0);
  if (status >= 200 && status < 300 && code === 0) return null;
  const message = typeof data.msg === "string" ? data.msg : `Lark request failed (${status})`;
  if (status === 429) return new LarkDirectoryError("rate_limited", message);
  if (code === 40012) return new LarkDirectoryError("invalid_cursor", message);
  if (code === 41012 || code === 99992352 || code === 99992363 || code === 99992364 || code === 99992381) {
    return new LarkDirectoryError("not_found", message);
  }
  if (code === 41050 || code === 40004 || /(?:permission|authority|scope)/i.test(message)) {
    return new LarkDirectoryError("permission", message);
  }
  return new LarkDirectoryError("upstream", message);
}

async function larkDirectoryRequest(
  env: EnvLike,
  provider: LarkProviderConfig,
  path: string,
): Promise<Record<string, unknown>> {
  const token = await getTenantAccessToken(env, provider);
  const res = await fetch(`${larkApiBase(provider.kind)}${path}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!isRecord(data)) throw new LarkDirectoryError("upstream", `Lark request failed (${res.status})`);
  const error = larkError(data, res.status);
  if (error !== null) throw error;
  return data;
}

function directoryUsers(data: Record<string, unknown>): LarkDirectoryUser[] {
  const payload = isRecord(data.data) ? data.data : {};
  const rows = Array.isArray(payload.user_list) ? payload.user_list : Array.isArray(payload.items) ? payload.items : [];
  const users: LarkDirectoryUser[] = [];
  for (const value of rows) {
    if (!isRecord(value)) continue;
    const id = typeof value.union_id === "string" ? value.union_id.trim() : "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!id || !name) continue;
    const avatar = isRecord(value.avatar) ? value.avatar : {};
    const avatarUrl = typeof avatar.avatar_72 === "string"
      ? avatar.avatar_72
      : typeof value.avatar_url === "string"
        ? value.avatar_url
        : null;
    users.push({ id, name, avatarUrl });
  }
  return users;
}

export async function searchLarkDirectory(
  env: EnvLike,
  provider: LarkProviderConfig,
  query: string,
  cursor: string | null,
  pageSize: number,
): Promise<{ users: LarkDirectoryUser[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ open_department_id: "0", fetch_child: "true", page_size: String(pageSize) });
  if (cursor !== null) params.set("page_token", cursor);
  const data = await larkDirectoryRequest(
    env,
    provider,
    `/open-apis/contact/v1/department/user/detail/list?${params.toString()}`,
  );
  const normalizedQuery = query.toLocaleLowerCase();
  const users = directoryUsers(data).filter((user) => user.name.toLocaleLowerCase().includes(normalizedQuery));
  const payload = isRecord(data.data) ? data.data : {};
  const hasMore = payload.has_more === true;
  const pageToken = typeof payload.page_token === "string" && payload.page_token ? payload.page_token : null;
  return { users, nextCursor: hasMore ? pageToken : null };
}

export async function getLarkDirectoryUser(
  env: EnvLike,
  provider: LarkProviderConfig,
  userId: string,
): Promise<LarkDirectoryUser> {
  const data = await larkDirectoryRequest(
    env,
    provider,
    `/open-apis/contact/v3/users/${encodeURIComponent(userId)}?user_id_type=union_id`,
  );
  const payload = isRecord(data.data) && isRecord(data.data.user) ? { data: { items: [data.data.user] } } : data;
  const user = directoryUsers(payload)[0];
  if (user === undefined || user.id !== userId) throw new LarkDirectoryError("not_found", "Lark user not found");
  return user;
}

export function resolveLarkProvider(env: EnvLike, preferredId?: string | null): LarkProviderConfig | null {
  const providers = authProviderConfigs(env);
  if (preferredId) {
    const matched = providers.find((provider) => provider.id === preferredId);
    if (matched) return matched;
  }
  return providers[0] ?? null;
}

export function larkApiBase(kind: LarkProviderKind): string {
  return kind === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}

export function clearLarkTokenCache(): void {
  tokenCache.clear();
}

export function inferReceiveIdType(providerUserId: string, email: string | null = null): LarkReceiveIdType {
  if (email !== null && providerUserId === email) return "email";
  if (providerUserId.startsWith("ou_")) return "open_id";
  if (providerUserId.startsWith("on_")) return "union_id";
  if (providerUserId.includes("@")) return "email";
  return "union_id";
}

export async function getTenantAccessToken(env: EnvLike, provider: LarkProviderConfig): Promise<string> {
  const secret = (env as Record<string, string | undefined>)[provider.clientSecretEnv]?.trim();
  if (!secret) throw new Error("lark provider secret is not configured");
  const cacheKey = `${provider.id}:${provider.kind}:${provider.clientId}:${secret}`;
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now + TOKEN_SKEW_MS) return cached.token;
  const res = await fetch(`${larkApiBase(provider.kind)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: provider.clientId, app_secret: secret }),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isRecord(data)) throw new Error(`tenant_access_token failed (${res.status})`);
  if (data.code !== undefined && Number(data.code) !== 0) {
    const msg = typeof data.msg === "string" ? data.msg : "tenant_access_token failed";
    throw new Error(msg);
  }
  const token = typeof data.tenant_access_token === "string" ? data.tenant_access_token : "";
  if (!token) throw new Error("tenant_access_token missing");
  const expire = typeof data.expire === "number" ? data.expire : 3600;
  tokenCache.set(cacheKey, { token, expiresAt: now + Math.max(60, expire) * 1000 });
  return token;
}

export async function sendLarkCard(
  env: EnvLike,
  provider: LarkProviderConfig,
  receiveId: string,
  idType: LarkReceiveIdType,
  card: Record<string, unknown>,
): Promise<void> {
  const token = await getTenantAccessToken(env, provider);
  const res = await fetch(`${larkApiBase(provider.kind)}/open-apis/im/v1/messages?receive_id_type=${idType}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isRecord(data) || (data.code !== undefined && Number(data.code) !== 0)) {
    const msg = isRecord(data) && typeof data.msg === "string" ? data.msg : `send message failed (${res.status})`;
    throw new Error(msg);
  }
}

export function buildMentionCard(payload: LarkWebhookPayload): Record<string, unknown> {
  const title = `AgentParty @${payload.mentions.join(", @")}`;
  const sender = payload.sender.display_name || payload.sender.handle || payload.sender.owner || payload.sender.name;
  const body = payload.kind === "status" ? payload.note || payload.body : payload.body;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: payload.kind === "status" ? "yellow" : "blue",
      title: { tag: "plain_text", content: title },
    },
    elements: [
      {
        tag: "markdown",
        content: `**${sender}** mentioned you in **#${payload.channel}**\n\n${body}`,
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "Open channel" },
            type: "primary",
            url: payload.permalink,
          },
        ],
      },
    ],
  };
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyWebhookSignature(secret: string, rawBody: string, header: string | null | undefined): Promise<boolean> {
  const prefix = "hmac-sha256=";
  if (!header?.startsWith(prefix)) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(header.slice(prefix.length).toLowerCase(), expected);
}
