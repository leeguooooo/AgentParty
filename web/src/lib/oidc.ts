// 人类网页 OIDC 登录（spec §10 双轨）：授权码 + PKCE，public client（无 secret，S256）。
// access_token 当 bearer 用；SSO 的 access_token 仅 ~10min，故一并存 refresh_token，到期前静默续期
// （之前只存 access_token 不续期，每 10 分钟必掉登录）。
export interface OidcConfig {
  issuer: string;
  clientId: string;
}

// 网页会话：access_token + refresh_token + 绝对过期秒（epoch），供静默续期用
export interface WebSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null; // epoch 秒；null 表示未知（保守当已过期处理）
}

const nowSec = () => Math.floor(Date.now() / 1000);

function toSession(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}): WebSession {
  if (!data.access_token) throw new Error("no access_token in token response");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: typeof data.expires_in === "number" ? nowSec() + data.expires_in : null,
  };
}

const VERIFIER_KEY = "ap_oidc_verifier";
const STATE_KEY = "ap_oidc_state";
export const CALLBACK_PATH = "/auth/callback";

// worker 暴露的公开配置：未配 OIDC 时 oidc:null → 不显示 SSO 按钮（降级到纯粘贴 token）
export async function fetchOidcConfig(): Promise<OidcConfig | null> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return null;
    const data = (await res.json()) as { oidc: { issuer?: string; client_id?: string } | null };
    if (!data.oidc?.issuer || !data.oidc?.client_id) return null;
    return { issuer: data.oidc.issuer.replace(/\/+$/, ""), clientId: data.oidc.client_id };
  } catch {
    return null;
  }
}

export function isCallbackPath(): boolean {
  return window.location.pathname === CALLBACK_PATH;
}

function base64Url(bytes: ArrayBuffer): string {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLen = 48): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(digest);
}

// 生成 verifier/challenge 存 sessionStorage，跳 issuer/authorize
export async function beginLogin(config: OidcConfig): Promise<void> {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const url = new URL(`${config.issuer}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", window.location.origin + CALLBACK_PATH);
  // offline_access：显式索要长效 refresh_token 以便静默续期（SSO 实际无条件下发，这里表意）
  url.searchParams.set("scope", "openid profile email offline_access");
  url.searchParams.set("code_challenge", await challengeOf(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
}

// 回调：校验 state → 用 code + code_verifier 换 token（public client，无 secret）→ 返回整段会话
export async function completeLogin(config: OidcConfig): Promise<WebSession> {
  const params = new URLSearchParams(window.location.search);
  const providerError = params.get("error");
  if (providerError) {
    throw new Error(params.get("error_description") ?? providerError);
  }
  const code = params.get("code");
  const state = params.get("state");
  const savedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!code || !state || !verifier || state !== savedState) {
    throw new Error("invalid sign-in callback");
  }
  const res = await fetch(`${config.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: window.location.origin + CALLBACK_PATH,
      client_id: config.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
  return toSession((await res.json()) as Record<string, never>);
}

// 静默续期：用 refresh_token 换一枚新 access_token（SSO 会轮换 refresh_token，回传新的则替换）。
// 失败（refresh 过期/被撤/client 不符）抛错，上层据此清会话回登录闸。
export async function refreshSession(config: OidcConfig, refreshToken: string): Promise<WebSession> {
  const res = await fetch(`${config.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.clientId,
    }).toString(),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const next = toSession((await res.json()) as Record<string, never>);
  // 轮换：token 端点未回新 refresh_token 时沿用旧的
  if (next.refreshToken === null) next.refreshToken = refreshToken;
  return next;
}
