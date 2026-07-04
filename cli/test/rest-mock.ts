// bun.serve 的 rest mock 服务器，测试 invite/webhook/channel 用
export interface RestRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface RestMock {
  url: string;
  requests: RestRequest[];
  stop(): void;
}

// handler 返回 Response 则覆盖默认行为，返回 undefined 走默认
export type RestHandler = (req: RestRequest) => Response | undefined;

export function startRestMock(handler?: RestHandler): RestMock {
  const requests: RestRequest[] = [];
  // 有状态 webhook 存储：add 后 list 能查到
  const webhooks = new Map<string, { name: string; url: string; filter: string }[]>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const raw = await req.text();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // 非 json
      }
      const r: RestRequest = {
        method: req.method,
        path: u.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      };
      requests.push(r);
      const custom = handler?.(r);
      if (custom) return custom;

      if (r.method === "POST" && r.path === "/api/tokens") {
        const b = body as { name: string; role: string };
        // 确定性明文 token，方便快照
        return Response.json({ token: `ap_${b.name}_secret`, name: b.name, role: b.role });
      }
      if (r.method === "DELETE" && r.path.startsWith("/api/tokens/")) {
        return new Response(null, { status: 204 });
      }
      if (r.method === "POST" && r.path === "/api/channels") {
        return Response.json({ ok: true });
      }
      if (r.method === "GET" && r.path === "/api/channels") {
        return Response.json({ channels: [] });
      }
      if (r.method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(r.path)) {
        return Response.json({ seq: 1 });
      }
      if (r.method === "GET" && r.path === "/api/me") {
        return Response.json({
          name: "agent",
          email: null,
          kind: "agent",
          role: "agent",
          owner: null,
          channel_scope: null,
          caps: { send: true, create_channel: false, mint_agents: false, scoped_to: null },
        });
      }
      if (r.method === "POST" && /^\/api\/channels\/[^/]+\/kick$/.test(r.path)) {
        return Response.json({ ok: true });
      }
      if (r.method === "GET" && /^\/api\/channels\/[^/]+\/messages$/.test(r.path)) {
        return Response.json({ messages: [] });
      }
      const wh = r.path.match(/^\/api\/channels\/([^/]+)\/webhooks(?:\/([^/]+))?$/);
      if (wh) {
        const slug = decodeURIComponent(wh[1]!);
        const list = webhooks.get(slug) ?? [];
        if (r.method === "POST" && !wh[2]) {
          const b = body as { name: string; url: string; filter: string };
          list.push({ name: b.name, url: b.url, filter: b.filter });
          webhooks.set(slug, list);
          return Response.json({ ok: true });
        }
        if (r.method === "GET" && !wh[2]) {
          return Response.json({ webhooks: list });
        }
        if (r.method === "DELETE" && wh[2]) {
          const name = decodeURIComponent(wh[2]);
          webhooks.set(
            slug,
            list.filter((w) => w.name !== name),
          );
          return new Response(null, { status: 204 });
        }
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}
