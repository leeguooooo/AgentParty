// bearer/token 工具 — worker 侧鉴权唯一入口
import type { SenderKind, TokenRole } from "@agentparty/shared";

export interface TokenIdentity {
  name: string;
  role: TokenRole;
  kind: SenderKind;
  hash: string;
}

export type BearerSource = "authorization" | "protocol" | "query";

export interface ExtractedBearer {
  token: string;
  source: BearerSource;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ap_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// REST 写路径必须走 Authorization；浏览器 WebSocket 个人 token 走 Sec-WebSocket-Protocol，
// 分享链接为了可复制仍额外允许 ?t=。
export function extractBearer(request: Request, options: { allowQueryToken?: boolean } = {}): ExtractedBearer | null {
  const header = request.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return { token: header.slice(7).trim(), source: "authorization" };
  }
  if (options.allowQueryToken === true) {
    const protocolToken = request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((part) => part.trim())
      .find((part) => part.startsWith("ap_"));
    if (protocolToken) return { token: protocolToken, source: "protocol" };
  }
  const queryToken = options.allowQueryToken === true ? new URL(request.url).searchParams.get("t") : null;
  return queryToken === null ? null : { token: queryToken, source: "query" };
}

export async function lookupToken(db: D1Database, token: string): Promise<TokenIdentity | null> {
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT name, role FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ name: string; role: string }>();
  if (!row) return null;
  const role = row.role as TokenRole;
  return { name: row.name, role, kind: role === "agent" ? "agent" : "human", hash };
}
