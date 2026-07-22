// 桌面版「从外部工具直达频道」的 deep link：agentparty://channel/<slug>?server=<url-encoded-origin>。
// 来源是 claude-statusbar 的 `cs hud` 浮窗——列出 AgentParty channel，点某条 → "Open in AgentParty"
// 会 `open "agentparty://channel/<slug>?server=<server>"`。桌面壳（Tauri）已注册 agentparty scheme，
// onOpenUrl 收到后要跳到对应频道页。协议格式在 claude-statusbar 侧定死，这边只解析 + 分发。
//
// 三条 deep/邀请入口靠 scheme + hostname 天然分流、互不干扰：
//   · agentparty://pair/<code>     → 配对邀请（parsePairDeepLink，hostname=pair）
//   · agentparty://channel/<slug>  → 本文件，直达频道（hostname=channel）
//   · https://…/c|/join|/invite    → 网页邀请链接（inviteLink，http(s)）
// channel host 的链接 parsePairDeepLink 必回 null；pair host 的链接这里也必回 null——不会串。
//
// server 只是「选实例」提示，不是主键：解析成规范 origin 交给宿主，由宿主决定是否切服（未配对的
// 实例切不过去就忽略、只按 slug 在当前实例跳）。缺省或非法的 server 一律降级为 null，绝不阻断跳转。

export interface ChannelDeepLink {
  slug: string;
  serverOrigin: string | null;
}

function normalizeServerOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseChannelDeepLink(input: string): ChannelDeepLink | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "agentparty:" || url.hostname !== "channel" || url.username || url.password || url.hash) {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  // 频道 slug 用与通知投递 / matchChannel 同一套字符集，小写打头、只含 [a-z0-9-]，限长 64。
  const slug = segments[0] ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) return null;

  const rawServer = url.searchParams.get("server");
  const serverOrigin = rawServer === null ? null : normalizeServerOrigin(rawServer);
  return { slug, serverOrigin };
}
