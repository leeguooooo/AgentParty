import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearLarkTokenCache } from "../src/integrations/lark";
import { api, createChannel, seedToken, uniq } from "./helpers";
import { fetchMock } from "./fetch-mock";

const LARK_ORIGIN = "https://open.larksuite.com";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  clearLarkTokenCache();
  fetchMock.assertNoPendingInterceptors();
});

afterAll(() => fetchMock.deactivate());

async function larkHuman(tenantKey = "tenant-test") {
  const account = `lark-main:${uniq("on_owner")}`;
  const human = await seedToken("human", uniq("human"), { owner: account });
  await env.DB.prepare(
    `INSERT INTO account_profiles (
       account, handle, display_name, provider, provider_user_id, tenant_key, created_at, updated_at
     ) VALUES (?, ?, 'Owner', 'lark-main', ?, ?, ?, ?)`,
  )
    .bind(account, uniq("owner"), account.slice("lark-main:".length), tenantKey, Date.now(), Date.now())
    .run();
  return { ...human, account };
}

function mockTenantToken() {
  fetchMock.get(LARK_ORIGIN)
    .intercept({ path: "/open-apis/auth/v3/tenant_access_token/internal", method: "POST" })
    .reply(200, { code: 0, tenant_access_token: "tenant-secret-token", expire: 3600 });
}

function mockDirectoryPage(options: { permissionDenied?: boolean; persist?: boolean } = {}) {
  const interceptor = fetchMock.get(LARK_ORIGIN)
    .intercept({
      path: "/open-apis/contact/v1/department/user/detail/list?open_department_id=0&fetch_child=true&page_size=20",
      method: "GET",
    })
    .reply(200, options.permissionDenied
      ? { code: 41050, msg: "no user authority" }
      : {
          code: 0,
          data: {
            has_more: true,
            page_token: "next-page",
            user_list: [
              {
                union_id: "on_alice",
                name: "Alice Zhang",
                avatar: { avatar_72: "https://cdn.example/alice.png" },
                email: "must-not-leak@example.com",
                mobile: "+81000000000",
              },
              { union_id: "on_bob", name: "Bob" },
            ],
          },
        });
  if (options.persist) interceptor.persist();
}

describe("Lark organization member invitations (#358)", () => {
  it("publishes the moderator-only search and direct-invite contracts without any access token field", async () => {
    const response = await api("/openapi.json", "unused");
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, unknown> };
    expect(document.paths["/api/channels/{slug}/lark-directory"]).toBeDefined();
    expect(document.paths["/api/channels/{slug}/lark-members"]).toBeDefined();
    expect(JSON.stringify({
      search: document.paths["/api/channels/{slug}/lark-directory"],
      invite: document.paths["/api/channels/{slug}/lark-members"],
    })).not.toMatch(/access.?token/i);
  });

  it("lets a Lark human moderator search a same-tenant directory page without leaking tokens or sensitive fields", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    mockDirectoryPage();

    const response = await api(`/api/channels/${slug}/lark-directory?q=alice&limit=20`, owner.token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      users: [{ id: "on_alice", name: "Alice Zhang", avatar_url: "https://cdn.example/alice.png", already_member: false }],
      next_cursor: "next-page",
    });
    expect(JSON.stringify(body)).not.toMatch(/tenant-secret-token|must-not-leak|81000000000|access.?token/i);
  });

  it("directly adds the selected same-tenant Lark user idempotently and records management audit", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_alice?user_id_type=union_id", method: "GET" })
      .reply(200, {
        code: 0,
        data: { user: { union_id: "on_alice", name: "Alice Zhang", avatar: { avatar_72: "https://cdn.example/alice.png" } } },
      })
      .times(2);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const invited = await api(`/api/channels/${slug}/lark-members`, owner.token, {
        method: "POST",
        body: JSON.stringify({ user_id: "on_alice" }),
      });
      expect(invited.status).toBe(attempt === 0 ? 201 : 200);
      expect(await invited.json()).toMatchObject({ name: "Alice Zhang", already_member: attempt === 1 });
    }

    const members = await env.DB.prepare(
      "SELECT account, added_by FROM channel_members WHERE channel_slug = ? AND account = ?",
    ).bind(slug, "lark-main:on_alice").all<{ account: string; added_by: string }>();
    expect(members.results).toEqual([{ account: "lark-main:on_alice", added_by: owner.account }]);

    const audit = await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token);
    const entries = ((await audit.json()) as { audit: Array<{ action: string; resource: string }> }).audit;
    expect(entries.filter((entry) => entry.action === "channel.member.add" && entry.resource === `channel/${slug}/members/lark-main:on_alice`)).toHaveLength(1);
  });

  it("uses the stable contact-permission code for direct invite failures", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/contact/v3/users/on_alice?user_id_type=union_id", method: "GET" })
      .reply(200, { code: 41050, msg: "no user authority" });

    const response = await api(`/api/channels/${slug}/lark-members`, owner.token, {
      method: "POST",
      body: JSON.stringify({ user_id: "on_alice" }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "lark_contact_permission_required" },
    });
  });

  it("rejects non-moderators, agent moderators, and cross-tenant profiles before any directory request", async () => {
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    const outsider = await larkHuman();
    const agent = await seedToken("agent", uniq("agent"), { owner: owner.account });
    const wrongTenant = await larkHuman("tenant-other");
    const wrongTenantSlug = await createChannel(wrongTenant.token);

    expect((await api(`/api/channels/${slug}/lark-directory?q=alice`, outsider.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/lark-directory?q=alice`, agent.token)).status).toBe(403);
    const mismatch = await api(`/api/channels/${wrongTenantSlug}/lark-directory?q=alice`, wrongTenant.token);
    expect(mismatch.status).toBe(403);
    expect((await mismatch.json()) as object).toMatchObject({ error: { code: "forbidden" } });
  });

  it("surfaces missing Lark contact permission and applies a per-account search limit", async () => {
    const deniedOwner = await larkHuman();
    const deniedSlug = await createChannel(deniedOwner.token);
    mockTenantToken();
    mockDirectoryPage({ permissionDenied: true });
    const denied = await api(`/api/channels/${deniedSlug}/lark-directory?q=alice`, deniedOwner.token);
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({
      error: {
        code: "lark_contact_permission_required",
        message: expect.stringContaining("contact permission"),
      },
    });

    clearLarkTokenCache();
    const owner = await larkHuman();
    const slug = await createChannel(owner.token);
    mockTenantToken();
    mockDirectoryPage({ persist: true });
    for (let request = 1; request <= 11; request += 1) {
      const response = await api(`/api/channels/${slug}/lark-directory?q=alice`, owner.token);
      expect(response.status).toBe(request <= 10 ? 200 : 429);
      if (request === 11) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });
});
