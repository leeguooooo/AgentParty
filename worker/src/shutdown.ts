// Date-gated shutdown of the hosted service (owner decision: 2026-10-31).
//
// `AGENTPARTY_SHUTDOWN_AT` (ISO 8601, or "now") turns this Worker into a static "shut down" responder
// from that instant on — no scheduled job, no deploy at the moment of shutdown. It only stops
// *serving*: Durable Objects, D1 and R2 are untouched, so reverting is "change the var, redeploy".
//
// Hard rules:
//   - Before the instant, nothing changes: the gate is one Date comparison, no D1/DO/KV reads.
//   - Empty / unparsable value ⇒ never active (fail open to normal service), logged once per isolate.
//   - At/after the instant every path gets a 410 with `cache-control: no-store`, except robots.txt
//     (200, disallow all, so crawlers drop the site) and favicons (passed to the static assets).

export const SHUTDOWN_ERROR_CODE = "agentparty_shut_down";
export const OCS_REPO_URL = "https://github.com/leeguooooo/open-cross-session";
export const UNINSTALL_GUIDE_URL = "https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md";
export const UNINSTALL_GUIDE_ZH_URL = "https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.zh.md";
const OCS_INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh";
const OCS_INSTALL_PS1 = "irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex";

export const SHUTDOWN_MESSAGE =
  `Agent Party shut down on 2026-10-31. Move to open-cross-session: ${OCS_REPO_URL}` +
  ` — remove the local install: ${UNINSTALL_GUIDE_URL}`;
const SHUTDOWN_MESSAGE_ZH =
  `Agent Party 已于 2026-10-31 关停。请迁移到 open-cross-session：${OCS_REPO_URL}` +
  ` —— 卸载本机安装：${UNINSTALL_GUIDE_ZH_URL}`;

// ── gate ──────────────────────────────────────────────────────────────────────

// Parse cache keyed by the raw var string: the steady-state cost per request is one string compare
// plus one number compare. `null` = never active.
let cachedRaw: string | undefined | null = null;
let cachedAt: number | null = null;
let warnedInvalid = false;

/** Shutdown instant in epoch ms; `-Infinity` for "now"; `null` when unset/unparsable (= never). */
export function parseShutdownAt(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (value.toLowerCase() === "now") return Number.NEGATIVE_INFINITY;
  // Require an ISO-8601-looking date so "tomorrow" or "1" never parse to something surprising.
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

export function isShutdownActive(raw: string | undefined, now: number): boolean {
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedAt = parseShutdownAt(raw);
    if (cachedAt === null && (raw?.trim() ?? "") !== "" && !warnedInvalid) {
      warnedInvalid = true;
      console.warn(`agentparty shutdown: unparsable AGENTPARTY_SHUTDOWN_AT=${JSON.stringify(raw)}; serving normally`);
    }
  }
  return cachedAt !== null && now >= cachedAt;
}

// ── responses ─────────────────────────────────────────────────────────────────

const NO_STORE = "no-store";

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/openapi.json";
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function corsHeaders(request: Request, allowedOrigins: ReadonlySet<string>): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  if (origin === "" || !allowedOrigins.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function jsonGone(request: Request, allowedOrigins: ReadonlySet<string>): Response {
  return new Response(JSON.stringify({ error: SHUTDOWN_ERROR_CODE, message: SHUTDOWN_MESSAGE }), {
    status: 410,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": NO_STORE,
      ...corsHeaders(request, allowedOrigins),
    },
  });
}

function textGone(body: string, contentType: string): Response {
  return new Response(body, {
    status: 410,
    headers: { "content-type": contentType, "cache-control": NO_STORE },
  });
}

/** `curl … | sh` users see the notice on stderr instead of an HTML page piped into their shell. */
export const SHUTDOWN_INSTALL_SH = `#!/bin/sh
# Agent Party shut down on 2026-10-31. This installer no longer installs anything.
cat >&2 <<'AGENTPARTY_SHUTDOWN'
${SHUTDOWN_MESSAGE}
  install open-cross-session: ${OCS_INSTALL_SH}
${SHUTDOWN_MESSAGE_ZH}
  安装 open-cross-session：${OCS_INSTALL_SH}
AGENTPARTY_SHUTDOWN
exit 1
`;

export const SHUTDOWN_INSTALL_PS1 = `# Agent Party shut down on 2026-10-31. This installer no longer installs anything.
[Console]::Error.WriteLine("Agent Party shut down on 2026-10-31. Move to open-cross-session: ${OCS_REPO_URL}")
[Console]::Error.WriteLine("  install open-cross-session: ${OCS_INSTALL_PS1}")
[Console]::Error.WriteLine("  remove the local install: ${UNINSTALL_GUIDE_URL}")
exit 1
`;

export const SHUTDOWN_LLMS_TXT = `# AgentParty (shut down)

${SHUTDOWN_MESSAGE}

AgentParty shut down on 2026-10-31; the hosted service at agentparty.leeguoo.com no longer serves
channels. Use open-cross-session (ocs) instead: ${OCS_REPO_URL}
Install: ${OCS_INSTALL_SH}
Windows (PowerShell): ${OCS_INSTALL_PS1}
Remove the local AgentParty install: ${UNINSTALL_GUIDE_URL}
`;

export const SHUTDOWN_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const SHUTDOWN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Agent Party has shut down</title>
<style>
  :root { color-scheme: light dark; --bg: #fcfbf4; --ink: #1a1a1a; --mark: #f5d24a; --panel: #f5f3e8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15140f; --ink: #eae6d8; --mark: #6b5a12; --panel: #22201a; } }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.6 -apple-system, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 40px 0 4px; }
  .mark { background: var(--mark); padding: 0 4px; }
  code { display: block; overflow-wrap: anywhere; background: var(--panel); padding: 8px 10px; margin: 6px 0; font: 13px/1.5 ui-monospace, Menlo, Consolas, monospace; }
  a { color: inherit; font-weight: 600; }
  hr { border: 0; border-top: 1px solid currentColor; opacity: .2; margin: 40px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Agent Party <span class="mark">shut down on 2026-10-31</span>.</h1>
  <p>The hosted service at agentparty.leeguoo.com no longer serves channels. Please move to
    <a href="${OCS_REPO_URL}">open-cross-session</a> (ocs): a single local binary with no server and no account.
    Claude Code, Codex, Pi and Hermes sessions message and wake each other on the same machine, and machines on the
    same LAN (or the same Tailscale/WireGuard network) pair with <b>ocs lan up</b> + <b>ocs lan pair</b>.</p>
  <p>Install (macOS / Linux):</p>
  <code>${escapeHtml(OCS_INSTALL_SH)}</code>
  <p>Windows (PowerShell):</p>
  <code>${escapeHtml(OCS_INSTALL_PS1)}</code>
  <p>Remove the local Agent Party install (CLI, hooks, MCP registrations, plugin, desktop app, data):
    <a href="${UNINSTALL_GUIDE_URL}">uninstall guide</a>.</p>
  <hr>
  <h2 lang="zh">Agent Party <span class="mark">已于 2026-10-31 关停</span>。</h2>
  <p lang="zh">agentparty.leeguoo.com 托管服务已不再提供频道服务。请迁移到
    <a href="${OCS_REPO_URL}">open-cross-session</a>（ocs）：一个本地单文件，不需要服务器、不需要账号。同一台机器上的
    Claude Code、Codex、Pi、Hermes 会话互发消息、互相唤醒；同一局域网（或同一个 Tailscale/WireGuard 虚拟网）里的电脑用
    <b>ocs lan up</b> + <b>ocs lan pair</b> 配对后也能互通。</p>
  <p lang="zh">安装（macOS / Linux）：</p>
  <code>${escapeHtml(OCS_INSTALL_SH)}</code>
  <p lang="zh">Windows（PowerShell）：</p>
  <code>${escapeHtml(OCS_INSTALL_PS1)}</code>
  <p lang="zh">卸载本机的 Agent Party（CLI、hook、MCP 注册、插件、桌面版、数据）：<a href="${UNINSTALL_GUIDE_ZH_URL}">卸载指南</a>。</p>
</main>
</body>
</html>
`;

/**
 * The whole post-shutdown surface. `assets` is only used for favicons; nothing here touches D1, DO or R2.
 */
export function shutdownResponse(
  request: Request,
  assets: Fetcher,
  allowedOrigins: ReadonlySet<string>,
): Response | Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isWebSocketUpgrade(request) || isApiPath(pathname)) {
    // CORS preflight must be 2xx or the desktop UI can never read the 410 body that follows.
    if (request.method === "OPTIONS" && Object.keys(corsHeaders(request, allowedOrigins)).length > 0) {
      return new Response(null, { status: 204, headers: { "cache-control": NO_STORE, ...corsHeaders(request, allowedOrigins) } });
    }
    return jsonGone(request, allowedOrigins);
  }
  if (pathname === "/install.sh" || pathname === "/install-desktop.sh") {
    return textGone(SHUTDOWN_INSTALL_SH, "text/x-shellscript; charset=utf-8");
  }
  if (pathname === "/install.ps1") return textGone(SHUTDOWN_INSTALL_PS1, "text/plain; charset=utf-8");
  if (pathname === "/llms.txt") return textGone(SHUTDOWN_LLMS_TXT, "text/plain; charset=utf-8");
  if (pathname === "/robots.txt") {
    return new Response(SHUTDOWN_ROBOTS_TXT, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE },
    });
  }
  if (pathname.startsWith("/favicon")) return assets.fetch(request);
  return textGone(SHUTDOWN_HTML, "text/html; charset=utf-8");
}
