// 账号维度自助铸 agent token（spec §5.3 / P3）：无需 ADMIN_SECRET，凭 human 账号会话即可铸。
// owner 恒 = 铸造者的 principal.account（不接受客户端传），role 固定 agent，channel_scope 可选。
// 铸造门的授权分支与身份来源无关（OIDC 人类 vs 带 owner 的 human ap_ token 走同一判定），
// OIDC 身份解析本身由 oidc.spec.ts 覆盖，这里用 human ap_ token 驱动账号会话。
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN_HEADERS, api, seedToken, uniq } from "./helpers";

// 用 ADMIN 铸一个带 owner 的 human token = 一个账号会话（account = owner）
async function humanSession(owner = "leo@leeguoo.com"): Promise<string> {
  const res = await SELF.fetch("http://ap.test/api/tokens", {
    method: "POST",
    headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ name: uniq("human"), role: "human", owner }),
  });
  if (res.status !== 201) throw new Error(`human session mint failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

function mintAgent(token: string | null, body: unknown): Promise<Response> {
  return SELF.fetch("http://ap.test/api/agents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/agents", () => {
  it("a human account session mints an agent with owner = the caller's account", async () => {
    const session = await humanSession("leo@leeguoo.com");
    const res = await mintAgent(session, { name: uniq("bot") });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; role: string; owner: string; channel_scope?: string };
    expect(body.token).toMatch(/^ap_[0-9a-f]{32}$/);
    expect(body.role).toBe("agent");
    // owner 来自铸造者账号，不是客户端传的
    expect(body.owner).toBe("leo@leeguoo.com");
    expect(body).not.toHaveProperty("channel_scope");
    // 铸出的 token 立即可用作 bearer
    expect((await api("/api/channels", body.token)).status).toBe(200);
  });

  it("ignores a client-supplied owner and always uses the caller's account", async () => {
    const session = await humanSession("real@leeguoo.com");
    const res = await mintAgent(session, { name: uniq("bot"), owner: "victim@evil.com" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { owner: string };
    expect(body.owner).toBe("real@leeguoo.com");
  });

  it("passes channel_scope through", async () => {
    const session = await humanSession();
    const scope = uniq("scoped");
    const res = await mintAgent(session, { name: uniq("bot"), channel_scope: scope });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel_scope: string; role: string };
    expect(body.channel_scope).toBe(scope);
    expect(body.role).toBe("agent");
  });

  it("scoped session can only mint tokens for its own channel (no scope escalation)", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const { token: scoped } = await seedToken("human", uniq("bcorp-h"), { owner: acct, channelScope: "collab" });
    // 无 scope 请求 → 强制继承调用者的 scope，铸不出无 scope（更宽）的 token
    const r1 = await mintAgent(scoped, { name: uniq("bot") });
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { channel_scope?: string }).channel_scope).toBe("collab");
    // 请求别的频道 scope → 403，不得放大到其它频道
    const r2 = await mintAgent(scoped, { name: uniq("bot"), channel_scope: "elsewhere" });
    expect(r2.status).toBe(403);
  });

  it("rejects an invalid channel_scope", async () => {
    const session = await humanSession();
    const res = await mintAgent(session, { name: uniq("bot"), channel_scope: "Not A Slug" });
    expect(res.status).toBe(400);
  });

  it("a readonly token cannot mint (403)", async () => {
    const { token } = await seedToken("readonly", uniq("ro"), { owner: "leo@leeguoo.com" });
    const res = await mintAgent(token, { name: uniq("bot") });
    expect(res.status).toBe(403);
  });

  it("an agent token cannot mint (403)", async () => {
    const { token } = await seedToken("agent", uniq("ag"), { owner: "leo@leeguoo.com" });
    const res = await mintAgent(token, { name: uniq("bot") });
    expect(res.status).toBe(403);
  });

  it("a legacy human token without an account cannot mint (403)", async () => {
    // legacy 存量 human token：owner=null → account undefined → 无从确定归属账号
    const { token } = await seedToken("human", uniq("legacy"));
    const res = await mintAgent(token, { name: uniq("bot") });
    expect(res.status).toBe(403);
  });

  it("an anonymous request is 401", async () => {
    const res = await mintAgent(null, { name: uniq("bot") });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid or reserved name", async () => {
    const session = await humanSession();
    expect((await mintAgent(session, { name: "bad name!" })).status).toBe(400);
    expect((await mintAgent(session, { name: "system" })).status).toBe(400);
  });

  it("409 on a duplicate active name", async () => {
    const session = await humanSession();
    const name = uniq("dup");
    expect((await mintAgent(session, { name })).status).toBe(201);
    expect((await mintAgent(session, { name })).status).toBe(409);
  });

  it("the minted agent shares the minter's account: it can read the minter's private channel", async () => {
    const session = await humanSession("owner@leeguoo.com");
    // 房主账号建私有频道
    const slug = uniq("priv");
    const created = await api("/api/channels", session, {
      method: "POST",
      body: JSON.stringify({ slug, kind: "standing", visibility: "private" }),
    });
    expect(created.status).toBe(201);
    // 同账号铸出的 agent
    const minted = await mintAgent(session, { name: uniq("bot") });
    const agentToken = ((await minted.json()) as { token: string }).token;
    // agent 与房主同账号 → 能进私有频道
    expect((await api(`/api/channels/${slug}/messages`, agentToken)).status).toBe(200);
    // 且该私有频道出现在 agent 的频道列表里
    const list = (await (await api("/api/channels", agentToken)).json()) as { channels: { slug: string }[] };
    expect(list.channels.some((ch) => ch.slug === slug)).toBe(true);
  });
});
