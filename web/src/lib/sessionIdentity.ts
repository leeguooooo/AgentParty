// #126 follow-up 安全修复：OIDC session 存在共享的 localStorage 里，另一个标签登录别的账号
// 会把它整个换掉。#170 的 adopt 只看新鲜度，会跨身份采纳；而锁内的 refresh() 同样会拿别人的
// refresh_token 去换。两条路都必须按身份闸住——本模块是那道闸的纯状态机。
import { sessionStillFresh } from "./refreshLock";

/** base64url → utf8 文本。失败返回 null。 */
function decodeSegment(seg: string): string | null {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * 从 JWT 解出 `sub`。非 JWT / 解析失败 / 无 sub 一律返回 null——调用方按「身份未知」保守处理。
 * 仅用于本地相等比较（判断共享 session 是不是本标签这个身份），不做任何鉴权判断；
 * token 的真伪照旧由服务端验签。
 */
export function jwtSub(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const json = decodeSegment(parts[1]!);
  if (json === null) return null;
  try {
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch {
    return null;
  }
}

export interface IdentityBoundSession {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  /** 旧 session（本修复之前写入 localStorage 的）没有这个字段 → undefined */
  identity?: string | null;
}

/** 旧 session 无此字段 → null（=身份未知），调用方据此禁止 adopt。 */
export function sessionIdentityOf(sess: IdentityBoundSession | null | undefined): string | null {
  return sess?.identity ?? null;
}

/**
 * 共享 session 的处置判定（纯状态机）：
 * - `adopt`   同身份且仍新鲜 → 直接复用，一次请求都不发
 * - `refresh` 允许拿它的 refresh_token 去 IdP 换（同身份但不新鲜；或旧 session 身份未知）
 * - `foreign` 明确属于**另一个身份** → 既不 adopt 也不 refresh，一步都不能碰
 * - `none`    没有可用 session
 */
export type SessionGate = "adopt" | "refresh" | "foreign" | "none";

export function gateSession(
  sess: IdentityBoundSession | null | undefined,
  currentIdentity: string | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): SessionGate {
  if (sess == null || sess.accessToken == null) return "none";
  const sessIdentity = sessionIdentityOf(sess);
  // 旧 session 无 identity：无法证明同身份 → 禁止 adopt，但允许正常 refresh（换回来就带 identity 了）
  if (sessIdentity === null) return sess.refreshToken != null ? "refresh" : "none";
  // 本标签身份解不出（例如粘贴的机器 ap_ token）：无法证明同身份 → 一步都不碰
  if (currentIdentity === null) return "foreign";
  if (sessIdentity !== currentIdentity) return "foreign";
  if (sessionStillFresh(sess, nowSec)) return "adopt";
  return sess.refreshToken != null ? "refresh" : "none";
}
