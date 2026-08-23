// bun.serve 模拟 account.leeguoo.com(OIDC issuer) + agentparty worker，登录/刷新/铸 agent 测试用
export interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
  tokenParams?: Record<string, string>;
}

export interface OidcMock {
  url: string;
  requests: RecordedReq[];
  tokenCalls: Record<string, string>[];
  stop(): void;
}

export function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
}

export interface MockOptions {
  cliClientId?: string | null; // null → 不返回 cli_client_id（模拟老 worker，回落 web client_id）
  /** false → 没有 /tasks/:id/lease 路由（老服务端，#936 前）：回**裸 404**，与真实 Hono 未命中路由同形。 */
  taskLease?: boolean;
  // 覆盖 /token 响应；默认按 grant_type 给确定性 token
  tokenResponse?: (params: Record<string, string>) => Record<string, unknown>;
}

export function startOidcMock(opts: MockOptions = {}): OidcMock {
  const requests: RecordedReq[] = [];
  const tokenCalls: Record<string, string>[] = [];
  const profiles: Record<string, unknown>[] = [];
  const invites: Record<string, unknown>[] = [];
  const wakeBudgets = new Map<string, { limit: number; window_ms: number }>();
  // 服务端任务租约台账（#936）。按 (token, 频道, task) 分格——同一个 mock 被两个
  // AGENTPARTY_HOME 共用时，它就代表「两台机器连的是同一台服务端」。
  const taskLeases = new Map<string, {
    executor_id: string;
    channel: string;
    task_id: number;
    acquired_at: number;
    renewed_at: number;
    expires_at: number;
    taken_over_from?: string;
  }>();
  let retention = { message_retention_ms: null as number | null, audit_retention_ms: null as number | null };
  let base = "";

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const raw = await req.text();
      const auth = req.headers.get("authorization");
      const rec: RecordedReq = { method: req.method, path: u.pathname, auth, body: null };

      if (req.method === "POST" && u.pathname === "/token") {
        const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
        rec.tokenParams = params;
        tokenCalls.push(params);
        requests.push(rec);
        if (opts.tokenResponse) return Response.json(opts.tokenResponse(params));
        const grant = params.grant_type;
        if (grant === "authorization_code") {
          return Response.json({
            access_token: "acc-authcode",
            refresh_token: "ref-1",
            id_token: makeJwt({ sub: "user-123", email: "fan@example.com" }),
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (grant === "refresh_token") {
          return Response.json({
            access_token: "acc-refreshed",
            refresh_token: "ref-2",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      try {
        rec.body = raw ? JSON.parse(raw) : null;
      } catch {
        // 非 json
      }
      requests.push(rec);

      if (req.method === "GET" && u.pathname === "/api/config") {
        const oidc = { issuer: base, client_id: "agentparty-web" };
        const body: Record<string, unknown> = { oidc };
        if (opts.cliClientId !== null) body.cli_client_id = opts.cliClientId ?? "agentparty-cli";
        return Response.json(body);
      }
      if (req.method === "GET" && u.pathname === "/api/me") {
        return Response.json({
          name: "fan@example.com",
          email: "fan@example.com",
          kind: "human",
          role: "human",
          owner: null,
          channel_scope: null,
          caps: { send: true, create_channel: true, mint_agents: true, scoped_to: null },
        });
      }
      if (req.method === "POST" && u.pathname === "/api/agents") {
        const b = rec.body as { name?: string; channel_scope?: string } | null;
        return Response.json({
          token: `ap_${b?.name ?? "x"}_secret`,
          name: b?.name ?? "x",
          owner: "fan@example.com",
          ...(b?.channel_scope ? { channel_scope: b.channel_scope } : {}),
        });
      }
      if (req.method === "GET" && u.pathname === "/api/agent-profiles") {
        return Response.json({ profiles });
      }
      if (req.method === "POST" && u.pathname === "/api/agent-profiles") {
        const b = rec.body as Record<string, unknown> | null;
        const now = Date.now();
        const profile = {
          owner_account: "fan@example.com",
          handle: b?.handle ?? "x",
          name: b?.name ?? b?.handle ?? "x",
          runner: b?.runner ?? "codex",
          repo_url: b?.repo_url ?? null,
          workdir: b?.workdir ?? null,
          base_branch: b?.base_branch ?? "main",
          worktree_strategy: b?.worktree_strategy ?? "branch",
          rules: b?.rules ?? null,
          invitable_by: b?.invitable_by ?? "owner",
          created_at: now,
          updated_at: now,
        };
        profiles.push(profile);
        return Response.json(profile, { status: 201 });
      }
      if (req.method === "POST" && /^\/api\/agent-profiles\/[^/]+\/runtime-token$/.test(u.pathname)) {
        const handle = decodeURIComponent(u.pathname.split("/")[3] ?? "x");
        const profile = profiles.find((p) => p.handle === handle) ?? {
          owner_account: "fan@example.com",
          handle,
          name: handle,
          runner: "codex-sdk",
          repo_url: "git@example.com:repo.git",
          workdir: "/tmp/project",
          base_branch: "main",
          worktree_strategy: "branch",
          rules: null,
          invitable_by: "owner",
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        return Response.json({ token: `ap_${handle}_runtime`, profile }, { status: 201 });
      }
      if (req.method === "GET" && u.pathname === "/api/agent-profiles/invites") {
        const handle = u.searchParams.get("handle");
        const filtered = handle ? invites.filter((i) => i.profile_handle === handle) : invites;
        return Response.json({ invites: filtered });
      }
      if (req.method === "GET" && /^\/api\/channels\/[^/]+\/loop-guard$/.test(u.pathname)) {
        // #174 loop guard 读路径 mock
        return Response.json({ enabled: true, limit: 30, streak: 27, remaining: 3, resets_on: "human" });
      }
      if (/^\/api\/channels\/[^/]+\/retention$/.test(u.pathname)) {
        if (req.method === "PUT") {
          const b = rec.body as Partial<typeof retention> | null;
          retention = { ...retention, ...(b ?? {}) };
        }
        return Response.json(retention);
      }
      // #108 per-agent wake 预算 set/inspect mock（内存态）
      const wbMatch = u.pathname.match(/^\/api\/channels\/[^/]+\/wake-budget\/([^/]+)$/);
      if (wbMatch) {
        const name = decodeURIComponent(wbMatch[1] ?? "");
        if (req.method === "PUT") {
          const b = rec.body as { enabled?: boolean; limit?: number; window_ms?: number } | null;
          if (b?.enabled === false) {
            wakeBudgets.delete(name);
          } else {
            wakeBudgets.set(name, { limit: b?.limit ?? 0, window_ms: b?.window_ms ?? 3_600_000 });
          }
        }
        const cfg = wakeBudgets.get(name);
        if (!cfg) {
          return Response.json({ name, enabled: false, limit: null, window_ms: null, used: 0, remaining: null, window_resets_at: null });
        }
        return Response.json({
          name,
          enabled: true,
          limit: cfg.limit,
          window_ms: cfg.window_ms,
          used: 0,
          remaining: cfg.limit,
          window_resets_at: null,
        });
      }
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/project-agents$/.test(u.pathname)) {
        const slug = u.pathname.split("/")[3] ?? "dev";
        const b = rec.body as { owner_account?: string; handle?: string } | null;
        const profile = {
          owner_account: b?.owner_account ?? "fan@example.com",
          handle: b?.handle ?? "x",
          name: b?.handle ?? "x",
          runner: "codex",
          repo_url: null,
          workdir: null,
          base_branch: "main",
          worktree_strategy: "branch",
          rules: null,
          invitable_by: "owner",
          created_at: Date.now(),
          updated_at: Date.now(),
        };
        const invite = {
          id: invites.length + 1,
          channel_slug: slug,
          owner_account: b?.owner_account ?? "fan@example.com",
          profile_handle: b?.handle ?? "x",
          invited_by: "fan@example.com",
          invited_at: Date.now(),
          already_invited: false,
          profile,
        };
        invites.push(invite);
        return Response.json(invite, { status: 201 });
      }
      if (req.method === "DELETE" && /^\/api\/channels\/[^/]+\/project-agents$/.test(u.pathname)) {
        const slug = u.pathname.split("/")[3] ?? "dev";
        const b = rec.body as { owner_account?: string; handle?: string } | null;
        return Response.json({
          ok: true,
          channel_slug: slug,
          owner_account: b?.owner_account ?? "fan@example.com",
          profile_handle: b?.handle ?? "x",
          revoked_at: Date.now(),
        });
      }
      if (req.method === "POST" && u.pathname === "/api/spawn") {
        const b = rec.body as { name?: string; channel_scope?: string; ttl_sec?: number; team_id?: string } | null;
        const expiresAt = Date.now() + (b?.ttl_sec ?? 7200) * 1000;
        return Response.json(
          {
            token: `ap_${b?.name ?? "x"}_secret`,
            name: b?.name ?? "x",
            role: "agent",
            owner: "fan@example.com",
            channel_scope: b?.channel_scope ?? "ops",
            lineage: {
              parent_agent: "parent",
              root_agent: "parent",
              team_id: b?.team_id ?? "parent",
              depth: 1,
              expires_at: expiresAt,
            },
            expires_at: expiresAt,
          },
          { status: 201 },
        );
      }
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/messages$/.test(u.pathname)) {
        return Response.json({ seq: 7 });
      }
      if (req.method === "POST" && /^\/api\/channels\/[^/]+\/tasks\/\d+\/lease$/.test(u.pathname)) {
        // 老服务端：路由压根不存在 → Hono 的默认 404 是**纯文本**，没有 error.code。
        // 客户端正是靠这个形状把「老服务端」与「频道/任务不存在」分开的，所以这里必须逐字同形。
        if (opts.taskLease === false) return new Response("404 Not Found", { status: 404 });
        const parts = u.pathname.split("/");
        const channel = parts[3]!;
        const taskId = Number(parts[5]);
        const b = rec.body as { op?: string; executor_id?: string; ttl_ms?: number; force?: boolean } | null;
        const executorId = b?.executor_id;
        if (typeof executorId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(executorId)) {
          return Response.json({ error: { code: "bad_request", message: "executor_id" } }, { status: 400 });
        }
        const key = `${auth ?? ""}|${channel}|${taskId}`;
        const now = Date.now();
        const existing = taskLeases.get(key);
        if (b?.op === "release") {
          if (existing !== undefined && existing.executor_id === executorId) taskLeases.delete(key);
          return Response.json({
            type: "task_lease",
            state: "released",
            scope: "server",
            released: existing?.executor_id === executorId,
          });
        }
        const mine = existing !== undefined && existing.executor_id === executorId;
        const live = existing !== undefined && existing.expires_at > now;
        if (existing !== undefined && live && !mine && b?.force !== true) {
          return Response.json(
            {
              error: { code: "task_lease_held", message: `held by ${existing.executor_id}` },
              type: "task_lease",
              state: "denied",
              scope: "server",
              reason: "held_by_other",
              holder: existing,
              task_untouched: true,
              server_time: now,
            },
            { status: 409 },
          );
        }
        const state = mine ? "renewed" : existing !== undefined && live ? "forced" : "acquired";
        const ttl = Math.min(60 * 60_000, Math.max(1, b?.ttl_ms ?? 30 * 60_000));
        const holder = {
          executor_id: executorId,
          channel,
          task_id: taskId,
          acquired_at: mine && existing !== undefined ? existing.acquired_at : now,
          renewed_at: now,
          expires_at: now + ttl,
          ...(state === "forced" && existing !== undefined ? { taken_over_from: existing.executor_id } : {}),
        };
        taskLeases.set(key, holder);
        return Response.json({
          type: "task_lease",
          state,
          scope: "server",
          holder,
          ...(state === "forced" ? { reason: "taken_over" } : {}),
          ttl_ms: ttl,
          server_time: now,
        });
      }
      if (req.method === "PATCH" && /^\/api\/channels\/[^/]+\/tasks\/\d+$/.test(u.pathname)) {
        const id = Number(u.pathname.split("/").pop());
        const b = rec.body as { state?: string } | null;
        return Response.json({ id, title: "t", state: b?.state ?? "in_progress" });
      }
      return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  });

  base = `http://127.0.0.1:${server.port}`;
  return {
    url: base,
    requests,
    tokenCalls,
    stop() {
      server.stop(true);
    },
  };
}
