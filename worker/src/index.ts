// worker 入口 — rest 路由 + ws 升级转发
import type { ChannelKind, ChannelMode, RestErrorCode, TokenRole, WebhookFilter } from "@agentparty/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { getServerByName } from "partyserver";
import { extractBearer, lookupToken, randomToken, sha256Hex, type TokenIdentity } from "./auth";
import { ChannelDO } from "./do";
import { openapiDocument } from "./openapi";

export { ChannelDO };

type AppEnv = Env & { ADMIN_SECRET?: string };

type AppContext = {
  Bindings: AppEnv;
  Variables: { identity: TokenIdentity };
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROLES: readonly string[] = ["agent", "human", "readonly"] satisfies TokenRole[];
const KINDS: readonly string[] = ["standing", "temp"] satisfies ChannelKind[];
const MODES: readonly string[] = ["normal", "party"] satisfies ChannelMode[];
const WEBHOOK_FILTERS: readonly string[] = ["mentions", "all"] satisfies WebhookFilter[];
const WEBHOOK_URL_MAX = 2048;
const WEBHOOK_SECRET_MAX = 4096;
const HEADER_VALUE_RE = /^[\x21-\x7e]+$/;

function errorBody(code: RestErrorCode, message: string) {
  return { error: { code, message } };
}

const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const secret = c.env.ADMIN_SECRET;
  if (!secret || c.req.header("x-admin-secret") !== secret) {
    return c.json(errorBody("unauthorized", "invalid admin secret"), 401);
  }
  await next();
});

const requireBearer = createMiddleware<AppContext>(async (c, next) => {
  if (!c.get("identity")) {
    const bearer = extractBearer(c.req.raw, {
      allowQueryToken:
        c.req.method === "GET" &&
        c.req.path.endsWith("/ws") &&
        c.req.header("upgrade")?.toLowerCase() === "websocket",
    });
    const identity = bearer ? await lookupToken(c.env.DB, bearer.token) : null;
    if (!identity) {
      return c.json(errorBody("unauthorized", "invalid or revoked token"), 401);
    }
    if (bearer?.source === "query" && identity.role !== "readonly") {
      return c.json(errorBody("unauthorized", "query-string websocket tokens must be readonly"), 403);
    }
    c.set("identity", identity);
  }
  await next();
});

async function loadChannel(db: D1Database, slug: string) {
  return db
    .prepare("SELECT slug, kind, mode, archived_at FROM channels WHERE slug = ?")
    .bind(slug)
    .first<{ slug: string; kind: string; mode: string; archived_at: number | null }>();
}

// do 侧按 meta 缓存 mode/kind/host（loop guard 分档、temp 归档、webhook permalink 都要用）
function channelHeaders(channel: { kind: string; mode: string }, requestUrl: string) {
  return {
    "x-ap-mode": channel.mode,
    "x-ap-channel-kind": channel.kind,
    "x-ap-host": new URL(requestUrl).host,
  };
}

function isPrivateIpv4(host: string): boolean {
  const chunks = host.split(".");
  if (chunks.length !== 4) return false;
  const parts = chunks.map((p) => (p === "" ? NaN : Number(p)));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(host: string): string | null {
  if (!host.startsWith("::ffff:")) return null;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const parts = tail.split(":");
  if (parts.length !== 2) return null;
  const nums = parts.map((p) => Number.parseInt(p, 16));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  const [hi, lo] = nums as [number, number];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isIpv6LinkLocal(host: string): boolean {
  const first = host.split(":")[0] ?? "";
  const n = Number.parseInt(first, 16);
  return Number.isInteger(n) && n >= 0xfe80 && n <= 0xfebf;
}

function isBlockedWebhookHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  const isIpv6 = host.includes(":");
  const mapped = isIpv6 ? mappedIpv4FromIpv6(host) : null;
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::" ||
    host === "::1" ||
    (isIpv6 && isIpv6LinkLocal(host)) ||
    (isIpv6 && host.startsWith("fc")) ||
    (isIpv6 && host.startsWith("fd")) ||
    (mapped !== null && isPrivateIpv4(mapped)) ||
    isPrivateIpv4(host)
  );
}

const app = new Hono<AppContext>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.get("/openapi.json", (c) => c.json(openapiDocument));

app.post("/api/tokens", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; role?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const role = typeof body?.role === "string" ? body.role : "";
  if (!NAME_RE.test(name) || !ROLES.includes(role)) {
    return c.json(errorBody("bad_request", "valid name and role (agent|human|readonly) required"), 400);
  }
  const existing = await c.env.DB.prepare("SELECT id, revoked_at FROM tokens WHERE name = ?")
    .bind(name)
    .first<{ id: number; revoked_at: number | null }>();
  if (existing && existing.revoked_at === null) {
    return c.json(errorBody("conflict", "token name already exists, revoke it first"), 409);
  }
  const token = randomToken();
  const hash = await sha256Hex(token);
  const now = Date.now();
  if (existing) {
    // 已吊销的同名 token 允许重铸，复用行
    await c.env.DB.prepare(
      "UPDATE tokens SET hash = ?, role = ?, created_at = ?, revoked_at = NULL WHERE id = ?",
    )
      .bind(hash, role, now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare("INSERT INTO tokens (hash, name, role, created_at) VALUES (?, ?, ?, ?)")
      .bind(hash, name, role, now)
      .run();
  }
  return c.json({ token, name, role }, 201);
});

app.delete("/api/tokens/:name", requireAdmin, async (c) => {
  const name = c.req.param("name");
  const result = await c.env.DB.prepare(
    "UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), name)
    .run();
  if (result.meta.changes === 0) {
    return c.json(errorBody("not_found", "no active token with that name"), 404);
  }
  // 吊销即时生效：踢掉所有未归档频道里该 name 的存活 ws（spec §12）
  const { results } = await c.env.DB.prepare("SELECT slug FROM channels").all<{ slug: string }>();
  await Promise.all(
    results.map(async ({ slug }) => {
      try {
        const stub = await getServerByName(c.env.CHANNELS, slug);
        await stub.fetch(
          new Request("https://do/internal/kick", {
            method: "POST",
            body: JSON.stringify({ name }),
            headers: { "content-type": "application/json", "x-partykit-room": slug },
          }),
        );
      } catch {
        // do 实例被重置时连接已随之消失，踢线是尽力而为
      }
    }),
  );
  return c.json({ ok: true });
});

app.use("/api/channels", requireBearer);
app.use("/api/channels/*", requireBearer);

// 频道列表页要「最近一条消息 + 参与者状态点」（spec §9 第 1 块），逐 do 聚合 summary
interface ChannelSummary {
  last: { sender: string; kind: string; body: string; ts: number } | null;
  presence: { name: string; state: string; note: string | null; ts: number }[];
}

app.get("/api/channels", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, topic, kind, mode, created_at, archived_at FROM channels ORDER BY created_at, id",
  ).all<{ slug: string }>();
  const channels = await Promise.all(
    results.map(async (row) => {
      let summary: ChannelSummary = { last: null, presence: [] };
      try {
        const stub = await getServerByName(c.env.CHANNELS, row.slug);
        const res = await stub.fetch(
          new Request("https://do/internal/summary", { headers: { "x-partykit-room": row.slug } }),
        );
        if (res.ok) summary = (await res.json()) as ChannelSummary;
      } catch {
        // do 不可达时列表仍可用，摘要降级为空
      }
      return { ...row, last_message: summary.last, presence: summary.presence };
    }),
  );
  return c.json({ channels });
});

app.post("/api/channels", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { slug?: unknown; title?: unknown; kind?: unknown; mode?: unknown }
    | null;
  const slug = typeof body?.slug === "string" ? body.slug : "";
  const kind = body?.kind === undefined ? "standing" : body.kind;
  const mode = body?.mode === undefined ? "normal" : body.mode;
  const title = typeof body?.title === "string" ? body.title : null;
  if (!SLUG_RE.test(slug) || typeof kind !== "string" || !KINDS.includes(kind)) {
    return c.json(errorBody("bad_request", "valid slug and kind (standing|temp) required"), 400);
  }
  if (typeof mode !== "string" || !MODES.includes(mode)) {
    return c.json(errorBody("bad_request", "mode must be normal or party"), 400);
  }
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot create channels"), 403);
  }
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO channels (slug, title, kind, mode, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(slug, title, kind, mode, c.get("identity").name, now)
      .run();
  } catch {
    return c.json(errorBody("conflict", "slug already exists"), 409);
  }
  if (kind === "temp") {
    try {
      const stub = await getServerByName(c.env.CHANNELS, slug);
      await stub.fetch(
        new Request("https://do/internal/init", {
          method: "POST",
          headers: {
            "x-partykit-room": slug,
            ...channelHeaders({ kind, mode }, c.req.url),
          },
        }),
      );
    } catch {
      await c.env.DB.prepare("DELETE FROM channels WHERE slug = ? AND created_at = ?")
        .bind(slug, now)
        .run()
        .catch(() => null);
      return c.json(errorBody("unavailable", "temp channel initialization failed"), 503);
    }
  }
  return c.json({ slug, title, kind, mode }, 201);
});

app.get("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const search = new URL(c.req.url).search;
  return stub.fetch(
    new Request(`https://do/internal/messages${search}`, {
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.post("/api/channels/:slug/messages", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  const identity = c.get("identity");
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/messages", {
      method: "POST",
      body: await c.req.text(),
      headers: {
        "content-type": "application/json",
        "x-partykit-room": slug,
        "x-ap-name": identity.name,
        "x-ap-kind": identity.kind,
        "x-ap-role": identity.role,
        "x-ap-token-hash": identity.hash,
        ...channelHeaders(channel, c.req.url),
      },
    }),
  );
});

// outbound webhook 注册 / 列表 / 删除（spec §7/§15），存储在频道 do 里
app.post("/api/channels/:slug/webhooks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot manage webhooks"), 403);
  }
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; url?: unknown; secret?: unknown; filter?: unknown }
    | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const url = typeof body?.url === "string" ? body.url : "";
  const secret = typeof body?.secret === "string" ? body.secret : "";
  const filter = body?.filter === undefined ? "mentions" : body.filter;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (
    !NAME_RE.test(name) ||
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    url.length > WEBHOOK_URL_MAX ||
    secret.length === 0 ||
    secret.length > WEBHOOK_SECRET_MAX ||
    !HEADER_VALUE_RE.test(secret) ||
    isBlockedWebhookHost(parsed.hostname) ||
    typeof filter !== "string" ||
    !WEBHOOK_FILTERS.includes(filter)
  ) {
    return c.json(
      errorBody("bad_request", "name, https url, secret and filter (mentions|all) required"),
      400,
    );
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/webhooks", {
      method: "POST",
      body: JSON.stringify({ name, url, secret, filter }),
      headers: { "content-type": "application/json", "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/webhooks", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot manage webhooks"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/webhooks", { headers: { "x-partykit-room": slug } }),
  );
});

app.delete("/api/channels/:slug/webhooks/:name", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (channel.archived_at !== null) {
    return c.json(errorBody("archived", "channel is archived"), 410);
  }
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot manage webhooks"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request(`https://do/internal/webhooks?name=${encodeURIComponent(c.req.param("name"))}`, {
      method: "DELETE",
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.post("/api/channels/:slug/archive", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot archive"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  const archivedAt = Date.now();
  const res = await stub.fetch(
    new Request("https://do/internal/archive", {
      method: "POST",
      headers: {
        "x-partykit-room": slug,
        "x-ap-archive-at": String(channel.archived_at ?? archivedAt),
        ...channelHeaders(channel, c.req.url),
      },
    }),
  );
  if (!res.ok) return c.json(errorBody("unavailable", "archive coordination failed"), 503);
  return c.json({ ok: true });
});

app.post("/api/channels/:slug/reset-guard", async (c) => {
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  if (c.get("identity").role === "readonly") {
    return c.json(errorBody("unauthorized", "readonly token cannot reset guard"), 403);
  }
  if (c.get("identity").kind !== "human") {
    return c.json(errorBody("unauthorized", "only human tokens can reset loop guard"), 403);
  }
  const stub = await getServerByName(c.env.CHANNELS, slug);
  return stub.fetch(
    new Request("https://do/internal/reset-guard", {
      method: "POST",
      headers: { "x-partykit-room": slug },
    }),
  );
});

app.get("/api/channels/:slug/ws", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json(errorBody("bad_request", "websocket upgrade required"), 426);
  }
  const slug = c.req.param("slug");
  const channel = await loadChannel(c.env.DB, slug);
  if (!channel) return c.json(errorBody("not_found", "channel not found"), 404);
  const identity = c.get("identity");
  const stub = await getServerByName(c.env.CHANNELS, slug);
  // do 无条件信任 x-ap-*，只有 worker 能构造到达 do 的请求
  const fwd = new Request(c.req.raw);
  fwd.headers.set("x-partykit-room", slug);
  fwd.headers.set("x-ap-name", identity.name);
  fwd.headers.set("x-ap-kind", identity.kind);
  fwd.headers.set("x-ap-role", identity.role);
  fwd.headers.set("x-ap-token-hash", identity.hash);
  fwd.headers.set("x-ap-mode", channel.mode);
  fwd.headers.set("x-ap-channel-kind", channel.kind);
  if (channel.archived_at !== null) fwd.headers.set("x-ap-archived", "1");
  const upgrade = await stub.fetch(fwd);
  const requestedProtocols = c.req
    .header("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim());
  if (upgrade.status === 101 && upgrade.webSocket && requestedProtocols?.includes("agentparty")) {
    const headers = new Headers(upgrade.headers);
    headers.set("Sec-WebSocket-Protocol", "agentparty");
    return new Response(null, { status: 101, webSocket: upgrade.webSocket, headers });
  }
  return upgrade;
});

export default app;
