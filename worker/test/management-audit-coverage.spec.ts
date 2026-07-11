import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

async function channelAudit(slug: string, token: string): Promise<AuditEntry[]> {
  const res = await api(`/api/channels/${slug}/management-audit?limit=100`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as AuditPage).audit;
}

async function globalAudit(): Promise<AuditEntry[]> {
  const res = await SELF.fetch("http://ap.test/api/management-audit?limit=100", { headers: ADMIN_HEADERS });
  expect(res.status).toBe(200);
  return ((await res.json()) as AuditPage).audit;
}

describe("management audit coverage (#137)", () => {
  it("records channel creation channel-scoped with sanitized metadata", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = uniq("ch");
    expect(
      (
        await api("/api/channels", owner.token, {
          method: "POST",
          body: JSON.stringify({ slug, kind: "standing", mode: "party", visibility: "public" }),
        })
      ).status,
    ).toBe(201);

    const entry = (await channelAudit(slug, owner.token)).find((e) => e.action === "channel.create");
    expect(entry).toBeDefined();
    expect(entry?.resource).toBe(`channel/${slug}`);
    expect(entry?.channel).toBe(slug);
    expect(entry?.actor_account).toBe(ownerAccount);
    expect(entry?.actor_kind).toBe("human");
    expect(entry?.metadata).toEqual({ kind: "standing", mode: "party", visibility: "public" });
  });

  it("records paid membership changes globally with only the tier in metadata", async () => {
    const account = `${uniq("member")}@example.com`;
    expect(
      (
        await SELF.fetch("http://ap.test/api/admin/membership", {
          method: "POST",
          headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
          body: JSON.stringify({ account, tier: "member" }),
        })
      ).status,
    ).toBe(200);

    const entry = (await globalAudit()).find(
      (e) => e.action === "membership.set" && e.resource === `account/${account}`,
    );
    expect(entry).toBeDefined();
    expect(entry?.actor_kind).toBe("admin");
    expect(entry?.actor_account).toBeNull();
    expect(entry?.channel).toBeNull();
    expect(entry?.metadata).toEqual({ tier: "member" });
  });

  it("records role assignment and removal with the collaboration role", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const name = uniq("worker-agent");

    expect(
      (
        await api(`/api/channels/${slug}/roles/${name}`, owner.token, {
          method: "PUT",
          body: JSON.stringify({ role: "reviewer" }),
        })
      ).status,
    ).toBe(200);
    expect((await api(`/api/channels/${slug}/roles/${name}`, owner.token, { method: "DELETE" })).status).toBe(200);

    const audit = await channelAudit(slug, owner.token);
    const assign = audit.find((e) => e.action === "channel.role.assign" && e.resource === `channel/${slug}/roles/${name}`);
    const remove = audit.find((e) => e.action === "channel.role.remove" && e.resource === `channel/${slug}/roles/${name}`);
    expect(assign).toBeDefined();
    expect(assign?.metadata).toEqual({ role: "reviewer" });
    expect(assign?.channel).toBe(slug);
    expect(remove).toBeDefined();
    expect(remove?.channel).toBe(slug);
  });

  it("records join-link creation and revocation", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);

    const created = await api(`/api/channels/${slug}/join-links`, owner.token, {
      method: "POST",
      body: JSON.stringify({ max_uses: 5 }),
    });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };

    expect((await api(`/api/channels/${slug}/join-links/${code}`, owner.token, { method: "DELETE" })).status).toBe(200);

    const audit = await channelAudit(slug, owner.token);
    expect(audit.some((e) => e.action === "channel.join_link.create" && e.resource === `channel/${slug}/join-links/${code}`)).toBe(true);
    expect(audit.some((e) => e.action === "channel.join_link.revoke" && e.resource === `channel/${slug}/join-links/${code}`)).toBe(true);
    // The revoke of a code that does not exist must not be audited.
    expect((await api(`/api/channels/${slug}/join-links/NOPE1234`, owner.token, { method: "DELETE" })).status).toBe(404);
    expect((await channelAudit(slug, owner.token)).some((e) => e.resource === `channel/${slug}/join-links/NOPE1234`)).toBe(false);
  });

  it("records a human accepting a join link as a member add", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const created = await api(`/api/channels/${slug}/join-links`, owner.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };

    const joinerAccount = `${uniq("joiner")}@example.com`;
    const joiner = await seedToken("human", uniq("joiner-token"), { owner: joinerAccount });
    const joined = await api(`/api/join/${code}`, joiner.token, { method: "POST" });
    expect(joined.status).toBe(200);
    expect((await joined.json()) as { joined: boolean }).toEqual(expect.objectContaining({ joined: true }));

    const entry = (await channelAudit(slug, owner.token)).find(
      (e) => e.action === "channel.member.add" && e.resource === `channel/${slug}/members/${joinerAccount}`,
    );
    expect(entry).toBeDefined();
    expect(entry?.actor_account).toBe(joinerAccount);
    expect(entry?.actor_kind).toBe("human");
    expect(entry?.channel).toBe(slug);
  });

  it("records project-agent invitation and revocation", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner-token"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const handle = uniq("proj");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO agent_profiles (
         owner_account, handle, name, runner, base_branch, worktree_strategy, invitable_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'codex', 'main', 'branch', 'owner', ?, ?)`,
    )
      .bind(ownerAccount, handle, handle, now, now)
      .run();

    expect(
      (
        await api(`/api/channels/${slug}/project-agents`, owner.token, {
          method: "POST",
          body: JSON.stringify({ owner_account: ownerAccount, handle }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api(`/api/channels/${slug}/project-agents`, owner.token, {
          method: "DELETE",
          body: JSON.stringify({ owner_account: ownerAccount, handle }),
        })
      ).status,
    ).toBe(200);

    const audit = await channelAudit(slug, owner.token);
    const resource = `channel/${slug}/project-agents/${ownerAccount}/${handle}`;
    expect(audit.some((e) => e.action === "channel.project_agent.invite" && e.resource === resource)).toBe(true);
    expect(audit.some((e) => e.action === "channel.project_agent.remove" && e.resource === resource)).toBe(true);
  });

  it("records every guard configuration change with the guard name", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);

    expect((await api(`/api/channels/${slug}/completion-gate`, owner.token, { method: "PUT", body: JSON.stringify({ gate: "reviewer" }) })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/decision-mode`, owner.token, { method: "PUT", body: JSON.stringify({ mode: "unattended" }) })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/loop-guard`, owner.token, { method: "PUT", body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    expect((await api(`/api/channels/${slug}/workflow-guard`, owner.token, { method: "PUT", body: JSON.stringify({ enabled: true, limit: 5 }) })).status).toBe(200);

    const audit = await channelAudit(slug, owner.token);
    const updates = audit.filter((e) => e.action === "channel.guard.update");
    const guards = updates.map((e) => (e.metadata as { guard?: string }).guard).sort();
    expect(guards).toEqual(["completion_gate", "decision_mode", "loop_guard", "workflow_guard"]);
    for (const e of updates) {
      expect(e.resource).toBe(`channel/${slug}/guards/${(e.metadata as { guard: string }).guard}`);
      expect(e.channel).toBe(slug);
    }
  });

  it("records loop and workflow guard resets", async () => {
    const owner = await seedToken("human", uniq("owner-token"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);

    expect((await api(`/api/channels/${slug}/reset-guard`, owner.token, { method: "POST" })).status).toBe(200);
    expect(
      (await api(`/api/channels/${slug}/workflows/wf-1/reset-guard`, owner.token, { method: "POST" })).status,
    ).toBe(200);

    const audit = await channelAudit(slug, owner.token);
    expect(audit.some((e) => e.action === "channel.guard.reset" && (e.metadata as { guard?: string }).guard === "loop" && e.resource === `channel/${slug}/guards/loop`)).toBe(true);
    expect(audit.some((e) => e.action === "channel.guard.reset" && (e.metadata as { guard?: string }).guard === "workflow" && e.resource === `channel/${slug}/guards/workflow/wf-1`)).toBe(true);
  });
});
