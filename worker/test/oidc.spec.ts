// 人类网页 OIDC 登录（spec §10 双轨）：ap_ token 走 D1，OIDC access token（RS256 JWT）走 issuer/jwks.json 验签
import { SELF, env } from "cloudflare:test";
import { fetchMock } from "./fetch-mock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { lookupToken, oidcConfigFromEnv } from "../src/auth";
import { api, createChannel, seedToken, uniq } from "./helpers";

const CLIENT_ID = "ap-web";
const CONFIGURED_ISSUER = "https://oidc.test"; // 与 vitest.config 的静态绑定一致

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey & { kid?: string };

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & { kid?: string };
  jwk.kid = "test-key-1";
});

afterEach(() => fetchMock.assertNoPendingInterceptors());
afterAll(() => fetchMock.deactivate());

function mockJwks(issuer: string) {
  fetchMock.get(issuer).intercept({ path: "/jwks.json", method: "GET" }).reply(200, { keys: [jwk] });
}

async function signJwt(claims: Record<string, unknown>, opts: { kid?: string; tamper?: boolean } = {}): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: opts.kid ?? "test-key-1" };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keyPair.privateKey,
    new TextEncoder().encode(signingInput),
  );
  const bytes = new Uint8Array(sig);
  if (opts.tamper) bytes[0] ^= 0xff;
  return `${signingInput}.${b64url(bytes)}`;
}

function claims(issuer: string, over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  // email_verified: true = 正常 IdP 的姿态（#100）。未验证的场景在专门的用例里显式覆盖。
  return { iss: issuer, aud: CLIENT_ID, sub: "user-abc", email: "u@leeguoo.com", email_verified: true, exp: now + 3600, iat: now, ...over };
}

// 每个需要验签的单元用例用独立 issuer，避开 JWKS 内存缓存，让 interceptor 恰好消费一次
function freshIssuer(): string {
  return `https://${uniq("oidc")}.example`;
}

const oidc = (issuer: string) => oidcConfigFromEnv({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID });

describe("oidcConfigFromEnv", () => {
  it("returns null unless both issuer and client_id are set", () => {
    expect(oidcConfigFromEnv({})).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://x" })).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_CLIENT_ID: "c" })).toBeNull();
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://x/", OIDC_CLIENT_ID: "c" })).toEqual({
      issuer: "https://x",
      clientId: "c",
      acceptedClientIds: ["c"],
    });
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://x/", OIDC_CLIENT_ID: "web" }, ["cli"])).toEqual({
      issuer: "https://x",
      clientId: "web",
      acceptedClientIds: ["web", "cli"],
    });
  });
});

describe("lookupToken OIDC verification", () => {
  it("verifies a valid RS256 JWT into a human identity", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(env.DB, await signJwt(claims(issuer)), oidc(issuer));
    expect(id).toEqual({
      name: "user-abc",
      email: "u@leeguoo.com",
      role: "human",
      kind: "human",
      hash: "oidc:user-abc",
      // 所属人：有 email 用 email
      owner: "u@leeguoo.com",
      // 账号锚点（spec §5.1）：OIDC 人类 account = email ?? sub
      account: "u@leeguoo.com",
    });
  });

  it("reads name as a display-only claim and falls back to preferred_username", async () => {
    const namedIssuer = freshIssuer();
    mockJwks(namedIssuer);
    const named = await lookupToken(
      env.DB,
      await signJwt(claims(namedIssuer, { name: "  Jane Zhang  ", preferred_username: "jzhang" })),
      oidc(namedIssuer),
    );
    expect(named).toMatchObject({
      name: "user-abc",
      account: "u@leeguoo.com",
      displayName: "Jane Zhang",
    });

    const preferredIssuer = freshIssuer();
    mockJwks(preferredIssuer);
    const preferred = await lookupToken(
      env.DB,
      await signJwt(claims(preferredIssuer, { name: "   ", preferred_username: "jzhang" })),
      oidc(preferredIssuer),
    );
    expect(preferred?.displayName).toBe("jzhang");

    const emptyIssuer = freshIssuer();
    mockJwks(emptyIssuer);
    const empty = await lookupToken(
      env.DB,
      await signJwt(claims(emptyIssuer, { name: " ", preferred_username: "" })),
      oidc(emptyIssuer),
    );
    expect(empty?.displayName).toBeUndefined();

    const sanitizedIssuer = freshIssuer();
    mockJwks(sanitizedIssuer);
    const sanitized = await lookupToken(
      env.DB,
      await signJwt(claims(sanitizedIssuer, { name: `\u0000Jane\ud800${"界".repeat(140)}` })),
      oidc(sanitizedIssuer),
    );
    expect(sanitized?.displayName).toBe(`Jane\ufffd${"界".repeat(123)}`);
    expect([...(sanitized?.displayName ?? "")]).toHaveLength(128);
  });

  it("falls back owner to sub when the JWT has no email", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(env.DB, await signJwt(claims(issuer, { email: undefined })), oidc(issuer));
    expect(id).toMatchObject({ name: "user-abc", email: undefined, owner: "user-abc" });
  });

  it("rejects an expired JWT (no JWKS fetch)", async () => {
    const issuer = freshIssuer();
    const now = Math.floor(Date.now() / 1000);
    expect(await lookupToken(env.DB, await signJwt(claims(issuer, { exp: now - 10 })), oidc(issuer))).toBeNull();
  });

  it("rejects a JWT whose aud is not the client_id", async () => {
    const issuer = freshIssuer();
    expect(await lookupToken(env.DB, await signJwt(claims(issuer, { aud: "other" })), oidc(issuer))).toBeNull();
  });

  it("accepts a JWT whose aud is an extra trusted client_id", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const config = oidcConfigFromEnv({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: CLIENT_ID }, ["agentparty-cli"]);
    const id = await lookupToken(env.DB, await signJwt(claims(issuer, { aud: "agentparty-cli" })), config);
    expect(id).toMatchObject({ role: "human", account: "u@leeguoo.com" });
  });

  it("rejects a JWT whose iss mismatches the configured issuer", async () => {
    const issuer = freshIssuer();
    expect(await lookupToken(env.DB, await signJwt(claims("https://evil.example")), oidc(issuer))).toBeNull();
  });

  it("rejects a JWT with a tampered signature", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    expect(await lookupToken(env.DB, await signJwt(claims(issuer), { tamper: true }), oidc(issuer))).toBeNull();
  });

  it("rejects a JWT signed with an unknown kid", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer); // 只有 test-key-1，kid 不匹配且强制刷新后仍找不到
    expect(await lookupToken(env.DB, await signJwt(claims(issuer), { kid: "ghost" }), oidc(issuer))).toBeNull();
  });

  it("degrades to D1 (returns null) when OIDC is not configured", async () => {
    const issuer = freshIssuer();
    // oidc=null：JWT 不走验证，落 D1 hash 查询 → 未命中 → null（保持机器 token 现状）
    expect(await lookupToken(env.DB, await signJwt(claims(issuer)), null)).toBeNull();
  });

  // #100：email 是私有频道 ACL 的唯一账号锚点。允许自设未验证 email 的 IdP 下，
  // 攻击者以 email=victim@corp.com 登录即可接管受害者的全部私有频道。
  it("ignores an unverified email and falls back to sub as the account anchor", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(
      env.DB,
      await signJwt(claims(issuer, { email: "victim@corp.com", email_verified: false })),
      oidc(issuer),
    );
    expect(id).not.toBeNull();
    expect(id?.email).toBeUndefined();
    expect(id?.account).toBe("user-abc"); // sub，不是被冒充的 email
    expect(id?.owner).toBe("user-abc");
  });

  it("ignores an email when email_verified is absent entirely", async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(
      env.DB,
      await signJwt(claims(issuer, { email: "victim@corp.com", email_verified: undefined })),
      oidc(issuer),
    );
    expect(id?.account).toBe("user-abc");
  });

  it('accepts the string "true" form some IdPs emit', async () => {
    const issuer = freshIssuer();
    mockJwks(issuer);
    const id = await lookupToken(
      env.DB,
      await signJwt(claims(issuer, { email: "u@leeguoo.com", email_verified: "true" })),
      oidc(issuer),
    );
    expect(id?.account).toBe("u@leeguoo.com");
  });

});

describe("oidc end-to-end via SELF.fetch", () => {
  it("GET /api/config exposes the configured issuer + client_id", async () => {
    const res = await SELF.fetch("http://ap.test/api/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      oidc: { issuer: CONFIGURED_ISSUER, client_id: CLIENT_ID },
      auth: {
        providers: [
          {
            id: "lark-main",
            kind: "lark",
            label: "Sign in with Lark",
            client_id: "cli_test_lark",
            authorize_url: "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
            scope: "",
          },
        ],
      },
      cli_client_id: "agentparty-cli",
    });
  });

  it("accepts an OIDC human end-to-end: list, create channel, post message", async () => {
    mockJwks(CONFIGURED_ISSUER); // 首次验签拉一次 JWKS，其后命中缓存
    const jwt = await signJwt(claims(CONFIGURED_ISSUER, { name: "OIDCUser" }));
    const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };

    const list = await SELF.fetch("http://ap.test/api/channels", { headers: auth });
    expect(list.status).toBe(200);

    // /api/me 暴露登录身份：OIDC 人类 owner = email，name = sub
    const me = await SELF.fetch("http://ap.test/api/me", { headers: auth });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      name: "user-abc",
      email: "u@leeguoo.com",
      kind: "human",
      role: "human",
      owner: "u@leeguoo.com",
      channel_scope: null,
      lineage: null,
      handle: null,
      display_name: "OIDCUser",
      avatar_url: null,
      avatar_thumb: null,
      provider: null,
      tenant_key: null,
      // 会员骨架（#277）：新账号默认 free，无 member_since
      membership_tier: "free",
      member_since: null,
      // OIDC 人类：非 readonly 能发/建频道；有 account 能自助铸 agent；无 scope；spawn 只给 scoped parent agent
      caps: { send: true, create_channel: true, mint_agents: true, spawn_children: false, scoped_to: null },
    });
    const profileBeforeInvite = await env.DB.prepare("SELECT handle FROM account_profiles WHERE account = ?")
      .bind("u@leeguoo.com")
      .first<{ handle: string }>();
    expect(profileBeforeInvite).toBeNull();

    const cliAudJwt = await signJwt(
      claims(CONFIGURED_ISSUER, { aud: "agentparty-cli", sub: "cli-user", email: "cli@leeguoo.com" }),
    );
    const cliMe = await SELF.fetch("http://ap.test/api/me", { headers: { authorization: `Bearer ${cliAudJwt}` } });
    expect(cliMe.status).toBe(200);
    expect(await cliMe.json()).toMatchObject({
      name: "cli-user",
      email: "cli@leeguoo.com",
      role: "human",
      caps: { send: true, create_channel: true, mint_agents: true, spawn_children: false, scoped_to: null },
    });

    // DO 的 isTokenActive 认 oidc: 前哨（不走 D1 吊销扫描），OIDC 人类可建频道并发消息
    const slug = await createChannel(jwt);
    const post = await SELF.fetch(`http://ap.test/api/channels/${slug}/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "message", body: "hi from human", mentions: [], reply_to: null }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()) as { seq: number }).toMatchObject({ seq: 1 });
    const history = await SELF.fetch(`http://ap.test/api/channels/${slug}/messages`, { headers: auth });
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      messages: { sender: { owner?: string; handle?: string; display_name?: string } }[];
    };
    expect(historyBody.messages[0]?.sender).toMatchObject({
      owner: "u@leeguoo.com",
      display_name: "OIDCUser",
    });
    expect(historyBody.messages[0]?.sender.handle).toBeUndefined();

    // 真正兑换外部邀请时才创建资料，并保留邀请预设的唯一 handle 与 OIDC 展示名。
    const owner = await seedToken("human", uniq("invite-owner"), { owner: "invite-owner@example.com" });
    const inviteSlug = await createChannel(owner.token);
    const presetHandle = uniq("oidcguest").replaceAll("-", "");
    const inviteResponse = await api(`/api/channels/${inviteSlug}/external-invites`, owner.token, {
      method: "POST",
      body: JSON.stringify({ handle: presetHandle }),
    });
    expect(inviteResponse.status).toBe(201);
    const invite = (await inviteResponse.json()) as { code: string };
    const inviteJwt = await signJwt(
      claims(CONFIGURED_ISSUER, {
        sub: "invited-user",
        email: "invited@example.com",
        name: "Invited User",
      }),
    );
    const redeem = await SELF.fetch(`http://ap.test/api/instance/invites/${invite.code}/redeem`, {
      method: "POST",
      headers: { authorization: `Bearer ${inviteJwt}` },
    });
    expect(redeem.status).toBe(200);
    expect(await redeem.json()).toMatchObject({ channel_slug: inviteSlug, handle: presetHandle });
    expect(
      await env.DB.prepare(
        "SELECT handle, display_name, provider, provider_user_id FROM account_profiles WHERE account = ?",
      )
        .bind("invited@example.com")
        .first(),
    ).toMatchObject({
      handle: presetHandle,
      display_name: "Invited User",
      provider: "oidc",
      provider_user_id: "invited-user",
    });

    // 邀请预设的唯一 handle 可路由。
    const handleMention = await SELF.fetch(`http://ap.test/api/channels/${inviteSlug}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${inviteJwt}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "message", body: "handle works", mentions: [presetHandle], reply_to: null }),
    });
    expect(handleMention.status).toBe(200);

    // 无效邀请不能因为 token 带 name 就留下 account_profiles 副作用。
    const invalidJwt = await signJwt(
      claims(CONFIGURED_ISSUER, {
        sub: "invalid-invite-user",
        email: "invalid-invite@example.com",
        name: "Invalid Invite User",
      }),
    );
    const invalidRedeem = await SELF.fetch("http://ap.test/api/instance/invites/not-a-real-code/redeem", {
      method: "POST",
      headers: { authorization: `Bearer ${invalidJwt}` },
    });
    expect(invalidRedeem.status).toBe(404);
    expect(
      await env.DB.prepare("SELECT handle FROM account_profiles WHERE account = ?")
        .bind("invalid-invite@example.com")
        .first(),
    ).toBeNull();
  });

});
