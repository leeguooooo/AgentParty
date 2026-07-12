import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

interface JoinRequest {
  id: string;
  slug: string;
  account: string;
  requester_display: string;
  requester_profile: Record<string, unknown>;
  state: "pending" | "approved" | "rejected";
  note: string | null;
  source_token_name: string;
  requested_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  review_reason: string | null;
}

async function createWatchLink(slug: string, moderatorToken: string): Promise<{ token: string; name: string }> {
  const response = await api(`/api/channels/${slug}/share-links`, moderatorToken, { method: "POST" });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: string; name: string };
}

async function submit(slug: string, token: string, watchToken: string, note?: string): Promise<Response> {
  return api(`/api/channels/${slug}/join-requests`, token, {
    method: "POST",
    body: JSON.stringify({ watch_token: watchToken, ...(note === undefined ? {} : { note }) }),
  });
}

describe("channel join requests (#366)", () => {
  it("creates a pending request from a valid scoped watch token and returns it from /me", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const watch = await createWatchLink(slug, owner.token);
    const account = `${uniq("applicant")}@example.com`;
    const applicant = await seedToken("human", uniq("applicant"), { owner: account });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO account_profiles (account, handle, display_name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(account, uniq("handle"), "Applicant Name", "https://example.com/avatar.png", now, now)
      .run();

    const created = await submit(slug, applicant.token, watch.token, "Please let me participate");
    expect(created.status).toBe(201);
    const request = (await created.json()) as JoinRequest;
    expect(request).toMatchObject({
      id: expect.stringMatching(/^jr_[0-9a-f]{32}$/),
      slug,
      account,
      requester_display: "Applicant Name",
      requester_profile: {
        display_name: "Applicant Name",
        avatar_url: "https://example.com/avatar.png",
      },
      state: "pending",
      note: "Please let me participate",
      source_token_name: watch.name,
      reviewed_at: null,
      reviewed_by: null,
      review_reason: null,
    });

    const mine = await api(`/api/channels/${slug}/join-requests/me`, applicant.token);
    expect(mine.status).toBe(200);
    expect((await mine.json()) as { request: JoinRequest }).toEqual({ request });

    const repeated = await submit(slug, applicant.token, watch.token, "ignored retry note");
    expect(repeated.status).toBe(200);
    const repeatedRequest = (await repeated.json()) as JoinRequest;
    expect(repeatedRequest.id).toBe(request.id);
    expect(repeatedRequest.note).not.toBe("ignored retry note");
  });

  it("requires a human account and a live readonly watch token scoped to the requested channel", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const otherSlug = await createChannel(owner.token);
    const account = `${uniq("applicant")}@example.com`;
    const applicant = await seedToken("human", uniq("applicant"), { owner: account });
    const agent = await seedToken("agent", uniq("agent"), { owner: account });
    const legacyHuman = await seedToken("human", uniq("legacy"));
    const validWatch = await seedToken("readonly", uniq("watch"), { channelScope: slug });
    const wrongScope = await seedToken("readonly", uniq("watch-other"), { channelScope: otherSlug });
    const writable = await seedToken("human", uniq("writable"), { owner: account, channelScope: slug });
    const expired = await seedToken("readonly", uniq("expired"), { channelScope: slug, childExpiresAt: Date.now() - 1 });
    const revoked = await seedToken("readonly", uniq("revoked"), { channelScope: slug });
    await env.DB.prepare("UPDATE tokens SET revoked_at = ? WHERE name = ?").bind(Date.now(), revoked.name).run();

    expect((await submit(slug, agent.token, validWatch.token)).status).toBe(403);
    expect((await submit(slug, legacyHuman.token, validWatch.token)).status).toBe(403);
    expect((await submit(slug, applicant.token, "not-a-token")).status).toBe(400);
    expect((await submit(slug, applicant.token, wrongScope.token)).status).toBe(400);
    expect((await submit(slug, applicant.token, writable.token)).status).toBe(400);
    expect((await submit(slug, applicant.token, expired.token)).status).toBe(400);
    expect((await submit(slug, applicant.token, revoked.token)).status).toBe(400);
  });

  it("lets moderators list pending requests and approve one exactly once", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const watch = await createWatchLink(slug, owner.token);
    const applicantAccount = `${uniq("applicant")}@example.com`;
    const applicant = await seedToken("human", uniq("applicant"), { owner: applicantAccount });
    const outsider = await seedToken("human", uniq("outsider"), { owner: `${uniq("outsider")}@example.com` });
    const request = (await (await submit(slug, applicant.token, watch.token)).json()) as JoinRequest;

    expect((await api(`/api/channels/${slug}/join-requests?state=pending`, outsider.token)).status).toBe(403);
    expect((await api(`/api/channels/${slug}/join-requests`, owner.token)).status).toBe(400);
    const listed = await api(`/api/channels/${slug}/join-requests?state=pending`, owner.token);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { requests: JoinRequest[] }).requests.map((row) => row.id)).toContain(request.id);

    const reviewed = await api(`/api/channels/${slug}/join-requests/${request.id}/review`, owner.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(reviewed.status).toBe(200);
    expect((await reviewed.json()) as JoinRequest).toMatchObject({
      id: request.id,
      state: "approved",
      reviewed_by: ownerAccount,
      review_reason: null,
    });
    const member = await env.DB.prepare(
      "SELECT added_by FROM channel_members WHERE channel_slug = ? AND account = ?",
    )
      .bind(slug, applicantAccount)
      .first<{ added_by: string }>();
    expect(member).toEqual({ added_by: ownerAccount });

    const repeated = await api(`/api/channels/${slug}/join-requests/${request.id}/review`, owner.token, {
      method: "POST",
      body: JSON.stringify({ action: "approve" }),
    });
    expect(repeated.status).toBe(409);
    const audit = await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token);
    const entries = ((await audit.json()) as { audit: { action: string; resource: string }[] }).audit;
    expect(entries.filter((entry) => entry.action === "channel.join_request.approve")).toEqual([
      expect.objectContaining({ resource: `channel/${slug}/join-requests/${request.id}` }),
    ]);
  });

  it("requires a rejection reason and lets a rejected account submit again", async () => {
    const ownerAccount = `${uniq("owner")}@example.com`;
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const firstWatch = await createWatchLink(slug, owner.token);
    const applicant = await seedToken("human", uniq("applicant"), { owner: `${uniq("applicant")}@example.com` });
    const request = (await (await submit(slug, applicant.token, firstWatch.token, "first attempt")).json()) as JoinRequest;

    expect(
      (
        await api(`/api/channels/${slug}/join-requests/${request.id}/review`, owner.token, {
          method: "POST",
          body: JSON.stringify({ action: "reject" }),
        })
      ).status,
    ).toBe(400);
    const rejected = await api(`/api/channels/${slug}/join-requests/${request.id}/review`, owner.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "Need a clearer purpose" }),
    });
    expect(rejected.status).toBe(200);
    expect((await rejected.json()) as JoinRequest).toMatchObject({
      state: "rejected",
      reviewed_by: ownerAccount,
      review_reason: "Need a clearer purpose",
    });
    expect(
      (
        await api(`/api/channels/${slug}/join-requests/${request.id}/review`, owner.token, {
          method: "POST",
          body: JSON.stringify({ action: "reject", reason: "again" }),
        })
      ).status,
    ).toBe(409);
    const audit = await api(`/api/channels/${slug}/management-audit?limit=100`, owner.token);
    const entries = ((await audit.json()) as { audit: { action: string; resource: string }[] }).audit;
    expect(entries.filter((entry) => entry.action === "channel.join_request.reject")).toEqual([
      expect.objectContaining({ resource: `channel/${slug}/join-requests/${request.id}` }),
    ]);

    const secondWatch = await createWatchLink(slug, owner.token);
    const reapplied = await submit(slug, applicant.token, secondWatch.token, "second attempt");
    expect(reapplied.status).toBe(201);
    expect((await reapplied.json()) as JoinRequest).toMatchObject({
      id: request.id,
      state: "pending",
      note: "second attempt",
      source_token_name: secondWatch.name,
      reviewed_at: null,
      reviewed_by: null,
      review_reason: null,
    });
  });

  it("returns already_member without creating a request", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: `${uniq("owner")}@example.com` });
    const slug = await createChannel(owner.token);
    const watch = await createWatchLink(slug, owner.token);
    const account = `${uniq("member")}@example.com`;
    const member = await seedToken("human", uniq("member"), { owner: account });
    await api(`/api/channels/${slug}/members/${encodeURIComponent(account)}`, owner.token, { method: "PUT" });

    const response = await submit(slug, member.token, watch.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "already_member" });
    expect(
      await env.DB.prepare("SELECT id FROM channel_join_requests WHERE slug = ? AND account = ?")
        .bind(slug, account)
        .first(),
    ).toBeNull();
  });
});
