// 桌面版「贴网页邀请链接进入频道」（#297）。桌面壳（Tauri）是网页版的 vite 产物套壳，
// 没有地址栏——用户无法像浏览器那样直接打开一条 /join 或 /c 链接。这里把网页版铸出来的
// **同一条**邀请链接（#186/#38，不另造 desktop scheme）解析成结构化动作，交给桌面 UI 兑换：
//   · /join/<code>        → participate：登录态下 POST /api/join/<code> 加入为成员
//   · /c/<slug>?t=<token> → watch：只读围观 token（复用 ?t= 分享机制）
//   · /c/<slug>           → open：直接打开频道（已是成员时）
// server 一并解析出来供宿主校验：桌面当前会话只对应一台已配对服务器，跨服邀请必须先切服。
import { matchChannel, matchJoin } from "../router";

export type InviteAction =
  | { kind: "participate"; server: string; code: string }
  | { kind: "watch"; server: string; slug: string; token: string }
  | { kind: "open"; server: string; slug: string };

export type InviteParseReason = "empty" | "malformed" | "unsupported";

export type ParsedInvite =
  | { ok: true; action: InviteAction }
  | { ok: false; reason: InviteParseReason };

export function parseInviteUrl(raw: string): ParsedInvite {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // 只认网页版真正用的 http(s)。agentparty://（配对 deep-link）、javascript: 等一律拒——
  // 邀请入口不做 scheme 分流，避免把桌面私有协议和网页链接搅在一起。
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "unsupported" };
  }
  const server = url.origin;

  const code = matchJoin(url.pathname);
  if (code !== null) return { ok: true, action: { kind: "participate", server, code } };

  const slug = matchChannel(url.pathname);
  if (slug !== null) {
    const token = url.searchParams.get("t");
    if (token !== null && token !== "") {
      return { ok: true, action: { kind: "watch", server, slug, token } };
    }
    return { ok: true, action: { kind: "open", server, slug } };
  }

  return { ok: false, reason: "unsupported" };
}

export type InviteResolution =
  | { ok: true; action: InviteAction }
  | {
      ok: false;
      reason: InviteParseReason | "wrong-host";
      expectedHost?: string;
      actualHost?: string;
    };

// 桌面宿主校验：邀请链接的 origin 必须与当前配对的服务器一致。桌面每个会话只持有一台
// 服务器的凭据/分享 token，跨服链接直接兑换只会 401 或落到错误的 API base——与其静默出错，
// 不如在这里明确回 wrong-host，并带上两边 host 供 UI 提示「先切到 <host> 再粘贴」。
export function resolveInviteForServer(raw: string, activeOrigin: string): InviteResolution {
  const parsed = parseInviteUrl(raw);
  if (!parsed.ok) return parsed;

  const actualHost = hostOf(parsed.action.server);
  let expectedOrigin: string;
  let expectedHost: string;
  try {
    const active = new URL(activeOrigin);
    expectedOrigin = active.origin;
    expectedHost = active.host;
  } catch {
    return { ok: false, reason: "wrong-host", actualHost };
  }

  if (parsed.action.server !== expectedOrigin) {
    return { ok: false, reason: "wrong-host", expectedHost, actualHost };
  }
  return { ok: true, action: parsed.action };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
