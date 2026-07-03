// bearer/token 工具 — worker 侧鉴权唯一入口
import type { SenderKind, TokenRole } from "@agentparty/shared";

export interface TokenIdentity {
  name: string;
  role: TokenRole;
  kind: SenderKind;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ap_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// cli 走 Authorization: Bearer，浏览器走 ?t=
export function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return new URL(request.url).searchParams.get("t");
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
  return { name: row.name, role, kind: role === "agent" ? "agent" : "human" };
}
