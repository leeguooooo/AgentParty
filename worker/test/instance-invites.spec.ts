// #593 实例邀请制：外部协作者邀请码（生成/列表/撤销/预览/兑换）+ INSTANCE_INVITE_ONLY 准入闸。
import { env, SELF } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_HEADERS, api, createChannel, seedToken, uniq } from "./helpers";
import { fetchMock } from "./fetch-mock";

const LARK_ORIGIN = "https://open.larksuite.com";

async function enroll(account: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO instance_members (account, added_by, added_at) VALUES (?, 'test', ?)")
    .bind(account, Date.now())
    .run();
}

async function createInvite(
  token: string,
  slug: string,
  handle: string,
  expiresInSec?: number,
): Promise<{ code: string; url: string; preset_handle: string }> {
  const res = await api(`/api/channels/${slug}/external-invites`, token, {
    method: "POST",
    body: JSON.stringify({ handle, ...(expiresInSec === undefined ? {} : { expires_in_sec: expiresInSec }) }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { code: string; url: string; preset_handle: string };
}

describe("external invites (#593)", () => {
  it("moderator creates an invite; the url points at /invite/<code>", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: "owner@example.com" });
    const slug = await createChannel(owner.token);
    const handle = uniq("guest").replaceAll("-", "");
    const invite = await createInvite(owner.token, slug, handle);
    expect(invite.url).toContain(`/invite/${invite.code}`);
    expect(invite.preset_handle).toBe(handle);
  });

  it("rejects non-moderators, bad handles, and handles already taken or pending", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: "owner2@example.com" });
    const slug = await createChannel(owner.token);

    const stranger = await seedToken("human", uniq("stranger"), { owner: "stranger@example.com" });
    const forbidden = await api(`/api/channels/${slug}/external-invites`, stranger.token, {
      method: "POST",
      body: JSON.stringify({ handle: "whatever" }),
    });
    expect(forbidden.status).toBe(403);

    const badHandle = await api(`/api/channels/${slug}/external-invites`, owner.token, {
      method: "POST",
      body: JSON.stringify({ handle: "中文昵称" }),
    });
    expect(badHandle.status).toBe(400);

    // 撞已存在的人类 handle → 409
    const takenHandle = uniq("taken").replaceAll("-", "");
    await env.DB.prepare(
      "INSERT INTO account_profiles (account, handle, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
      .bind(uniq("acct"), takenHandle, Date.now(), Date.now())
      .run();
    const conflictTaken = await api(`/api/channels/${slug}/external-invites`, owner.token, {
      method: "POST",
      body: JSON.stringify({ handle: takenHandle }),
    });
    expect(conflictTaken.status).toBe(409);

    // pending 邀请占坑：同 handle 再发一张 → 409（invite_pending）
    const pendingHandle = uniq("pend").replaceAll("-", "");
    await createInvite(owner.token, slug, pendingHandle);
    const conflictPending = await api(`/api/channels/${slug}/external-invites`, owner.token, {
      method: "POST",
      body: JSON.stringify({ handle: pendingHandle }),
    });
    expect(conflictPending.status).toBe(409);
    const body = (await conflictPending.json()) as { error: { message: string } };
    expect(body.error.message).toContain("invite_pending");
  });

  it("previews without auth, lists for moderators, revokes, and blocks redeeming a revoked code", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: "owner3@example.com" });
    const slug = await createChannel(owner.token);
    const handle = uniq("prev").replaceAll("-", "");
    const invite = await createInvite(owner.token, slug, handle);

    const preview = await SELF.fetch(`http://ap.test/api/instance/invites/${invite.code}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ channel_slug: slug, preset_handle: handle, state: "pending" });

    const missing = await SELF.fetch("http://ap.test/api/instance/invites/nope");
    expect(missing.status).toBe(404);

    const list = await api(`/api/channels/${slug}/external-invites`, owner.token);
    expect(list.status).toBe(200);
    const { invites } = (await list.json()) as { invites: { code: string }[] };
    expect(invites.some((i) => i.code === invite.code)).toBe(true);

    const revoke = await api(`/api/channels/${slug}/external-invites/${invite.code}`, owner.token, { method: "DELETE" });
    expect(revoke.status).toBe(200);

    const guest = await seedToken("human", uniq("guest"), { owner: "revoked-guest@example.com" });
    const redeem = await api(`/api/instance/invites/${invite.code}/redeem`, guest.token, { method: "POST" });
    expect(redeem.status).toBe(410);
  });

  it("redeem = enroll + join channel + preset handle, idempotent for the same account, burned for others", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: "owner4@example.com" });
    const slug = await createChannel(owner.token);
    const handle = uniq("alice").replaceAll("-", "");
    const invite = await createInvite(owner.token, slug, handle);

    const guestAccount = "ext-alice@example.com";
    const guest = await seedToken("human", uniq("guest"), { owner: guestAccount });
    const redeem = await api(`/api/instance/invites/${invite.code}/redeem`, guest.token, { method: "POST" });
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toEqual({ channel_slug: slug, handle, joined: true });

    const member = await env.DB.prepare("SELECT added_by FROM channel_members WHERE channel_slug = ? AND account = ?")
      .bind(slug, guestAccount)
      .first<{ added_by: string }>();
    expect(member?.added_by).toBe(`external-invite:${invite.code.slice(0, 8)}`);
    const enrolled = await env.DB.prepare("SELECT added_by FROM instance_members WHERE account = ?")
      .bind(guestAccount)
      .first<{ added_by: string }>();
    expect(enrolled?.added_by).toBe(`invite:${invite.code.slice(0, 8)}`);
    const profile = await env.DB.prepare("SELECT handle FROM account_profiles WHERE account = ?")
      .bind(guestAccount)
      .first<{ handle: string }>();
    expect(profile?.handle).toBe(handle);

    // 同账号重放幂等（joined=false，handle 不变）
    const replay = await api(`/api/instance/invites/${invite.code}/redeem`, guest.token, { method: "POST" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ channel_slug: slug, handle, joined: false });

    // 别的账号用同一码 → 已烧
    const other = await seedToken("human", uniq("other"), { owner: "ext-bob@example.com" });
    const stolen = await api(`/api/instance/invites/${invite.code}/redeem`, other.token, { method: "POST" });
    expect(stolen.status).toBe(410);

    // 兑换后预览显示 redeemed
    const preview = await SELF.fetch(`http://ap.test/api/instance/invites/${invite.code}`);
    expect(((await preview.json()) as { state: string }).state).toBe("redeemed");

    // 已兑换的邀请不可撤销（撤销会破坏同账号重放幂等）→ 409，且预览态保持 redeemed
    const revoke = await api(`/api/channels/${slug}/external-invites/${invite.code}`, owner.token, { method: "DELETE" });
    expect(revoke.status).toBe(409);
    const preview2 = await SELF.fetch(`http://ap.test/api/instance/invites/${invite.code}`);
    expect(((await preview2.json()) as { state: string }).state).toBe("redeemed");
  });

  it("keeps concurrent same-account redeems idempotent and frees expired handles for re-invite", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: "owner6@example.com" });
    const slug = await createChannel(owner.token);

    // 并发同账号兑换：都成功（抢占失败方核对归属后继续），绝不 410
    const invite = await createInvite(owner.token, slug, uniq("race").replaceAll("-", ""));
    const guest = await seedToken("human", uniq("guest"), { owner: "race-guest@example.com" });
    const [a, b] = await Promise.all([
      api(`/api/instance/invites/${invite.code}/redeem`, guest.token, { method: "POST" }),
      api(`/api/instance/invites/${invite.code}/redeem`, guest.token, { method: "POST" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // 过期未兑换的邀请占着昵称：重发同昵称邀请时先被自动撤销释放（pending 唯一索引不拦重发）
    const handle = uniq("expire").replaceAll("-", "");
    const stale = await createInvite(owner.token, slug, handle);
    await env.DB.prepare("UPDATE instance_invites SET expires_at = ? WHERE code = ?")
      .bind(Date.now() - 1000, stale.code)
      .run();
    const reissued = await createInvite(owner.token, slug, handle);
    expect(reissued.code).not.toBe(stale.code);
    const staleRow = await env.DB.prepare("SELECT revoked_at FROM instance_invites WHERE code = ?")
      .bind(stale.code)
      .first<{ revoked_at: number | null }>();
    expect(staleRow?.revoked_at).not.toBeNull();
  });

  it("keeps an existing handle, rejects agents, and blocks expired codes", async () => {
    const owner = await seedToken("human", uniq("owner"), { owner: "owner5@example.com" });
    const slug = await createChannel(owner.token);

    // 已有 handle 的账号兑换：入频道但不覆盖昵称
    const veteranAccount = "veteran@example.com";
    const veteranHandle = uniq("vet").replaceAll("-", "");
    await env.DB.prepare("INSERT INTO account_profiles (account, handle, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(veteranAccount, veteranHandle, Date.now(), Date.now())
      .run();
    const invite = await createInvite(owner.token, slug, uniq("newnick").replaceAll("-", ""));
    const veteran = await seedToken("human", uniq("vet"), { owner: veteranAccount });
    const redeem = await api(`/api/instance/invites/${invite.code}/redeem`, veteran.token, { method: "POST" });
    expect(redeem.status).toBe(200);
    expect(((await redeem.json()) as { handle: string }).handle).toBe(veteranHandle);

    const agent = await seedToken("agent", uniq("bot"), { owner: "bot-owner" });
    const invite2 = await createInvite(owner.token, slug, uniq("nick2").replaceAll("-", ""));
    const agentRedeem = await api(`/api/instance/invites/${invite2.code}/redeem`, agent.token, { method: "POST" });
    expect(agentRedeem.status).toBe(403);

    await env.DB.prepare("UPDATE instance_invites SET expires_at = ? WHERE code = ?")
      .bind(Date.now() - 1000, invite2.code)
      .run();
    const guest = await seedToken("human", uniq("late"), { owner: "late@example.com" });
    const expired = await api(`/api/instance/invites/${invite2.code}/redeem`, guest.token, { method: "POST" });
    expect(expired.status).toBe(410);
  });
});

describe("INSTANCE_INVITE_ONLY gate (#593)", () => {
  beforeAll(() => {
    (env as unknown as Record<string, unknown>).INSTANCE_INVITE_ONLY = "true";
  });
  afterAll(() => {
    delete (env as unknown as Record<string, unknown>).INSTANCE_INVITE_ONLY;
  });

  it("blocks un-enrolled human accounts with invite_required, admits enrolled ones", async () => {
    const outsider = await seedToken("human", uniq("out"), { owner: "outsider@example.com" });
    const blocked = await api("/api/channels", outsider.token);
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invite_required");

    await enroll("outsider@example.com");
    const admitted = await api("/api/channels", outsider.token);
    expect(admitted.status).toBe(200);
  });

  it("does not gate agent tokens or legacy human tokens without an account", async () => {
    const agent = await seedToken("agent", uniq("bot"), { owner: "bot-owner" });
    expect((await api("/api/channels", agent.token)).status).toBe(200);

    const legacy = await seedToken("human", uniq("legacy"));
    expect((await api("/api/channels", legacy.token)).status).toBe(200);
  });

  it("keeps the redeem endpoint reachable for un-enrolled accounts (the whole point of the invite)", async () => {
    const ownerAccount = "gate-owner@example.com";
    await enroll(ownerAccount);
    const owner = await seedToken("human", uniq("owner"), { owner: ownerAccount });
    const slug = await createChannel(owner.token);
    const invite = await createInvite(owner.token, slug, uniq("gatenick").replaceAll("-", ""));

    const guest = await seedToken("human", uniq("guest"), { owner: "gate-guest@example.com" });
    expect((await api("/api/channels", guest.token)).status).toBe(403);
    const redeem = await api(`/api/instance/invites/${invite.code}/redeem`, guest.token, { method: "POST" });
    expect(redeem.status).toBe(200);
    expect((await api("/api/channels", guest.token)).status).toBe(200);
  });

  it("auto-enrolls the owner of admin-minted human tokens", async () => {
    const name = uniq("minted");
    const res = await SELF.fetch("http://ap.test/api/tokens", {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ name, role: "human", owner: "minted@example.com" }),
    });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT added_by FROM instance_members WHERE account = ?")
      .bind("minted@example.com")
      .first<{ added_by: string }>();
    expect(row?.added_by).toBe("admin-token");
  });
});

describe("Lark OAuth auto-enrollment (#593)", () => {
  beforeAll(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });
  afterEach(() => fetchMock.assertNoPendingInterceptors());
  afterAll(() => fetchMock.deactivate());

  it("enrolls the account on a successful provider code exchange", async () => {
    const openId = uniq("on_enroll");
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/authen/v2/oauth/token", method: "POST" })
      .reply(200, { code: 0, access_token: "oauth-user-token", expires_in: 3600 });
    fetchMock.get(LARK_ORIGIN)
      .intercept({ path: "/open-apis/authen/v1/user_info", method: "GET" })
      .reply(200, {
        code: 0,
        data: { open_id: openId, name: "Enroll Me", tenant_key: "tenant-test" },
      });

    const callback = await SELF.fetch("http://ap.test/api/auth/lark-main/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", redirect_uri: "https://app.example/callback" }),
    });
    expect(callback.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT added_by FROM instance_members WHERE account = (SELECT account FROM account_profiles WHERE provider_user_id = ?)",
    )
      .bind(openId)
      .first<{ added_by: string }>();
    expect(row?.added_by).toBe("oauth:lark-main");
  });
});
