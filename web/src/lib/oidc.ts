// 人类网页 OIDC 登录（spec §10 双轨）：授权码 + PKCE，public client（无 secret，S256）。
// 拿到的 access_token 存 localStorage('ap_token') 当 bearer 用，与机器 ap_ token 同一存取路径。
export interface OidcConfig {
  issuer: string;
  clientId: string;
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
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("code_challenge", await challengeOf(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  window.location.assign(url.toString());
}

// 回调：校验 state → 用 code + code_verifier 换 token（public client，无 secret）→ 返回 access_token
export async function completeLogin(config: OidcConfig): Promise<string> {
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
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("no access_token in token response");
  return data.access_token;
}
