import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_HEADERS, api, createChannel, seedToken, uniq } from "./helpers";

interface AuditEntry {
  actor_account: string | null;
  actor_kind: "admin" | "human" | "agent";
  action: string;
  resource: string;
  channel: string | null;
  result: "success";
  timestamp: number;
  metadata: Record<string, unknown>;
}

interface AuditPage {
  audit: AuditEntry[];
  next_cursor: string | null;
}

function adminAudit(path = "/api/management-audit"): Promise<Response> {
  return SELF.fetch(`http://ap.test${path}`, { headers: ADMIN_HEADERS });
}

async function readPage(res: Response): Promise<AuditPage> {
  expect(res.status).toBe(200);
  return (await res.json()) as AuditPage;
}

describe("management audit", () => {
  it("best-effort recorder never throws and logs only a sanitized marker", async () => {
    const auditModule = (await import("../src/management-audit")) as unknown as {
      bestEffortRecordManagementAudit?: (
        db: D1Database,
        event: {
          actor: { account: string | null; kind: "human" };
          action: "channel.webhook.add";
          resource: string;
          channel: string;
          metadata: Record<string, unknown>;
        },
      ) => Promise<void>;
    };
    expect(auditModule.bestEffortRecordManagementAudit).toBeTypeOf("function");
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("db failure containing secret=https://hooks.test/private");
          },
        }),
      }),
    } as unknown as D1Database;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      auditModule.bestEffortRecordManagementAudit?.(db, {
        actor: { account: "owner@example.com", kind: "human" },
        action: "channel.webhook.add",
        resource: "channel/safe/webhooks/dispatcher",
        channel: "safe",
        metadata: { secret: "never-log-me", url: "https://hooks.test/private", body: "private body" },
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "management_audit_write_failed",
      JSON.stringify({ action: "channel.webhook.add", channel: "safe" }),
    );
    const marker = JSON.stringify(error.mock.calls);
    expect(marker).not.toContain("never-log-me");
    expect(marker).not.toContain("hooks.test");
    expect(marker).not.toContain("private body");
    error.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    await expect(
      auditModule.bestEffortRecordManagementAudit?.(db, {
        actor: { account: "owner@example.com", kind: "human" },
        action: "channel.webhook.add",
        resource: "channel/safe/webhooks/dispatcher",
        channel: "safe",
        metadata: {},
      }),
    ).resolves.toBeUndefined();
    error.mockRestore();
  });

  it("keeps a committed management operation successful when audit insert fails", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const account = `${uniq("member")}@example.com`;
    await env.DB.prepare(
      `CREATE TRIGGER management_audit_test_failure
       BEFORE INSERT ON management_audit
       BEGIN
         SELECT RAISE(FAIL, 'forced audit failure');
       END`,
    ).run();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await api(`/api/channels/${slug}/members/${encodeURIComponent(account)}`, owner.token, {
        method: "PUT",
      });
      expect(response.status).toBe(200);
      const member = await env.DB.prepare(
        "SELECT account FROM channel_members WHERE channel_slug = ? AND account = ?",
      )
        .bind(slug, account)
        .first<{ account: string }>();
      expect(member?.account).toBe(account);
      expect(error).toHaveBeenCalledWith(
        "management_audit_write_failed",
        JSON.stringify({ action: "channel.member.add", channel: slug }),
      );
    } finally {
      await env.DB.prepare("DROP TRIGGER management_audit_test_failure").run();
      error.mockRestore();
    }
  });

  it("records token issue and revocation without exposing credentials", async () => {
    const name = uniq("audited-token");
    const owner = `${uniq("owner")}@example.com`;
    const issued = await SELF.fetch("http://ap.test/api/tokens", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ name, role: "agent", owner }),
    });
    expect(issued.status).toBe(201);
    const { token } = (await issued.json()) as { token: string };

    const revoked = await SELF.fetch(`http://ap.test/api/tokens/${name}`, {
      method: "DELETE",
      headers: ADMIN_HEADERS,
    });
    expect(revoked.status).toBe(200);

    const page = await readPage(await adminAudit("/api/management-audit?limit=100"));
    const entries = page.audit.filter((entry) => entry.resource === `token/${name}`);
    expect(entries.map((entry) => entry.action).sort()).toEqual(["token.issue", "token.revoke"]);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_account: null,
          actor_kind: "admin",
          channel: null,
          result: "success",
        }),
      ]),
    );
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "action",
        "actor_account",
        "actor_kind",
        "channel",
        "metadata",
        "resource",
        "result",
        "timestamp",
      ]);
    }
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(ADMIN_HEADERS["x-admin-secret"]);
    expect(serialized).not.toContain(owner);
  });

  it("keeps scoped token revocation visible in that channel audit", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const name = uniq("scoped-token");
    const issued = await SELF.fetch("http://ap.test/api/tokens", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ name, role: "agent", owner: ownerAccount, channel_scope: slug }),
    });
    expect(issued.status).toBe(201);
    expect(
      (
        await SELF.fetch(`http://ap.test/api/tokens/${name}`, {
          method: "DELETE",
          headers: ADMIN_HEADERS,
        })
      ).status,
    ).toBe(200);

    const page = await readPage(await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token));
    const entries = page.audit.filter((entry) => entry.resource === `token/${name}`);
    expect(entries.map((entry) => entry.action).sort()).toEqual(["token.issue", "token.revoke"]);
    expect(entries.every((entry) => entry.channel === slug)).toBe(true);
  });

  it("records the scoped channel management operations with allowlisted metadata", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const memberAccount = `${uniq("member")}@example.com`;
    const webhookSecret = `secret-${crypto.randomUUID()}`;
    const webhookUrl = `https://hooks.test/${crypto.randomUUID()}`;

    expect(
      (
        await api(`/api/channels/${slug}/perms`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ members_list: "owner" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/visibility`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ visibility: "public", confirm: true }),
        })
      ).status,
    ).toBe(200);
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "PUT" })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "DELETE" })).status).toBe(200);
    expect(
      (
        await api(`/api/channels/${slug}/webhooks`, owner.token, {
          method: "POST",
          body: JSON.stringify({ name: "dispatcher", url: webhookUrl, secret: webhookSecret, filter: "mentions" }),
        })
      ).status,
    ).toBe(201);
    expect((await api(`/api/channels/${slug}/webhooks/dispatcher`, owner.token, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/archive`, owner.token, { method: "POST" })).status).toBe(200);

    const res = await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token);
    const page = await readPage(res);
    expect(page.audit.map((entry) => entry.action)).toEqual([
      "channel.archive",
      "channel.webhook.remove",
      "channel.webhook.add",
      "channel.member.remove",
      "channel.member.add",
      "channel.visibility.update",
      "channel.permissions.update",
    ]);
    expect(page.audit.every((entry) => entry.channel === slug)).toBe(true);
    expect(page.audit.every((entry) => entry.actor_account === ownerAccount && entry.actor_kind === "human")).toBe(true);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(webhookSecret);
    expect(serialized).not.toContain(webhookUrl);
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("exception");
  });

  it("enforces global and channel query ACLs", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const outsider = await seedToken("human", uniq("outsider-token"), { owner: `${uniq("outsider")}@example.com` });
    const memberAccount = `${uniq("member")}@example.com`;
    const member = await seedToken("human", uniq("member-token"), { owner: memberAccount });
    const slug = await createChannel(owner.token);
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(memberAccount)}`, owner.token, { method: "PUT" })).status).toBe(200);

    expect((await adminAudit()).status).toBe(200);
    expect((await SELF.fetch("http://ap.test/api/management-audit", { headers: { "x-admin-secret": "wrong" } })).status).toBe(401);
    expect((await api("/api/management-audit", owner.token)).status).toBe(401);
    expect((await api(`/api/channels/${slug}/management-audit`, owner.token)).status).toBe(200);
    expect((await api(`/api/channels/${slug}/management-audit`, outsider.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/management-audit`, member.token)).status).toBe(403);
    expect((await api("/api/channels/no-such-channel/management-audit", owner.token)).status).toBe(404);
  });

  it("uses bounded cursor pagination without duplicates", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    for (const account of ["one@example.com", "two@example.com", "three@example.com"]) {
      expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(account)}`, owner.token, { method: "PUT" })).status).toBe(200);
    }

    const first = await readPage(await api(`/api/channels/${slug}/management-audit?limit=2`, owner.token));
    expect(first.audit).toHaveLength(2);
    expect(first.next_cursor).toBeTypeOf("string");
    const second = await readPage(
      await api(`/api/channels/${slug}/management-audit?limit=2&cursor=${encodeURIComponent(first.next_cursor ?? "")}`, owner.token),
    );
    expect(second.audit).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.audit, ...second.audit].map((entry) => entry.resource)).size).toBe(3);

    expect((await api(`/api/channels/${slug}/management-audit?limit=0`, owner.token)).status).toBe(400);
    expect((await api(`/api/channels/${slug}/management-audit?limit=101`, owner.token)).status).toBe(400);
    expect((await api(`/api/channels/${slug}/management-audit?cursor=not-a-cursor`, owner.token)).status).toBe(400);
  });

  it("uses opaque channel-scoped cursors", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const channelA = await createChannel(owner.token);
    const channelB = await createChannel(owner.token);
    for (const account of ["one@example.com", "two@example.com"]) {
      expect((await api(`/api/channels/${channelA}/members/${encodeURIComponent(account)}`, owner.token, { method: "PUT" })).status).toBe(200);
    }
    expect((await api(`/api/channels/${channelB}/members/other%40example.com`, owner.token, { method: "PUT" })).status).toBe(200);

    const first = await readPage(await api(`/api/channels/${channelA}/management-audit?limit=1`, owner.token));
    expect(first.next_cursor).toBeTypeOf("string");
    expect(first.next_cursor).toMatch(/^mc_[0-9a-f]{32}$/);
    let decoded: unknown = null;
    try {
      const raw = first.next_cursor ?? "";
      const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
      decoded = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))) as unknown;
    } catch {
      decoded = null;
    }
    expect(decoded).toBeNull();
    expect(
      (
        await api(
          `/api/channels/${channelB}/management-audit?limit=1&cursor=${encodeURIComponent(first.next_cursor ?? "")}`,
          owner.token,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          `/api/channels/${channelA}/management-audit?limit=1&cursor=mc_${"0".repeat(32)}`,
          owner.token,
        )
      ).status,
    ).toBe(400);
  });

  it("does not audit a no-op member removal", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const absent = "absent@example.com";
    expect((await api(`/api/channels/${slug}/members/${encodeURIComponent(absent)}`, owner.token, { method: "DELETE" })).status).toBe(200);
    const page = await readPage(await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token));
    expect(page.audit.some((entry) => entry.resource === `channel/${slug}/members/${absent}`)).toBe(false);
  });

  it("audits spawn, kick removal, and project-agent token revocation", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);

    const parent = await seedToken("agent", uniq("parent"), { owner: ownerAccount, channelScope: slug });
    const childName = uniq("spawned-child");
    expect(
      (
        await api("/api/spawn", parent.token, {
          method: "POST",
          body: JSON.stringify({ name: childName, channel_scope: slug, ttl_sec: 3600 }),
        })
      ).status,
    ).toBe(201);

    const kicked = await seedToken("agent", uniq("kicked"), { owner: `${uniq("external")}@example.com`, channelScope: slug });
    expect(
      (
        await api(`/api/channels/${slug}/kick`, owner.token, {
          method: "POST",
          body: JSON.stringify({ name: kicked.name, mode: "remove" }),
        })
      ).status,
    ).toBe(200);

    const handle = uniq("profile");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO agent_profiles (
         owner_account, handle, name, runner, base_branch, worktree_strategy, invitable_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'codex', 'main', 'branch', 'owner', ?, ?)`,
    )
      .bind(ownerAccount, handle, handle, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO channel_agent_invites (
         channel_slug, owner_account, profile_handle, invited_by, invited_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    )
      .bind(slug, ownerAccount, handle, ownerAccount, now)
      .run();
    const projectChild = await seedToken("agent", uniq("project-child"), {
      owner: ownerAccount,
      channelScope: slug,
      parentAgent: handle,
      rootAgent: handle,
      teamId: handle,
      spawnDepth: 1,
    });
    expect(
      (
        await api(`/api/channels/${slug}/project-agents`, owner.token, {
          method: "DELETE",
          body: JSON.stringify({ owner_account: ownerAccount, handle }),
        })
      ).status,
    ).toBe(200);

    const page = await readPage(await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token));
    expect(page.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "token.issue", resource: `token/${childName}`, channel: slug }),
        expect.objectContaining({ action: "token.revoke", resource: `token/${kicked.name}`, channel: slug }),
        expect.objectContaining({ action: "token.revoke", resource: `token/${projectChild.name}`, channel: slug }),
      ]),
    );
  });

  it("audits profile runtime, project-channel runtime, and token rotation", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const handle = uniq("runtime-profile");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO agent_profiles (
         owner_account, handle, name, runner, base_branch, worktree_strategy, invitable_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'codex', 'main', 'branch', 'owner', ?, ?)`,
    )
      .bind(ownerAccount, handle, handle, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO channel_agent_invites (
         channel_slug, owner_account, profile_handle, invited_by, invited_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    )
      .bind(slug, ownerAccount, handle, ownerAccount, now)
      .run();

    const runtime = await api(`/api/agent-profiles/${handle}/runtime-token`, owner.token, { method: "POST" });
    expect(runtime.status).toBe(201);
    const runtimeToken = ((await runtime.json()) as { token: string }).token;
    const projectChildName = uniq("runtime-child");
    expect(
      (
        await api(`/api/channels/${slug}/project-agents/runtime-token`, runtimeToken, {
          method: "POST",
          body: JSON.stringify({ owner_account: ownerAccount, handle, name: projectChildName }),
        })
      ).status,
    ).toBe(201);

    const rotated = await seedToken("agent", uniq("rotated"), { owner: ownerAccount, channelScope: slug });
    expect((await api(`/api/channels/${slug}/agents/${rotated.name}/rotate`, owner.token, { method: "POST" })).status).toBe(200);
    const selfMintedName = uniq("self-minted");
    expect(
      (
        await api("/api/agents", owner.token, {
          method: "POST",
          body: JSON.stringify({ name: selfMintedName, channel_scope: slug }),
        })
      ).status,
    ).toBe(201);

    const global = await readPage(await adminAudit("/api/management-audit?limit=100"));
    expect(global.audit).toContainEqual(
      expect.objectContaining({ action: "token.issue", resource: `token/${handle}`, channel: null }),
    );
    const channel = await readPage(await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token));
    expect(channel.audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "token.issue", resource: `token/${projectChildName}`, channel: slug }),
        expect.objectContaining({ action: "token.issue", resource: `token/${rotated.name}`, channel: slug }),
        expect.objectContaining({ action: "token.issue", resource: `token/${selfMintedName}`, channel: slug }),
      ]),
    );
  });
});
