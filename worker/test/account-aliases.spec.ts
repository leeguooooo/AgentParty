// #1067 第三层：同一个人跨账号对齐。
// 2026-07-12（#358）之前 Lark 登录按邮箱构造 account（`lark-email:<邮箱>`），之后统一成 `lark:<provider_user_id>`；
// 跨过这条分界线的人会有两个账号，名单里显示成两个人。别名表把遗留账号指到规范账号，identities 读侧统一解析。
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { api, createChannel, postMessage, seedToken, uniq } from "./helpers";

async function link(alias: string, canonical: string) {
  await env.DB.prepare(
    `INSERT INTO account_aliases (alias_account, canonical_account, provider, linked_at)
     VALUES (?, ?, 'lark', ?)
     ON CONFLICT(alias_account) DO UPDATE SET canonical_account = excluded.canonical_account`,
  ).bind(alias, canonical, Date.now()).run();
}

async function identitiesOf(slug: string, token: string) {
  const res = await api(`/api/channels/${slug}/identities`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { identities: { name: string; account?: string }[] }).identities;
}

describe("account aliases (#1067)", () => {
  it("identities 把别名账号解析成规范账号——同一个人的两个会话报同一个 account", async () => {
    const canonical = `lark:on_${uniq("canon").replace(/-/g, "")}`;
    const legacy = `lark-email:${uniq("leo")}@example.com`;
    const humanName = crypto.randomUUID();
    const olderName = crypto.randomUUID();
    const owner = await seedToken("human", humanName, { owner: canonical });
    const slug = await createChannel(owner.token);
    const older = await seedToken("human", olderName, { owner: legacy });
    // 两个人都真的在频道里说过话，才会进入频道身份表
    expect((await postMessage(slug, owner.token, "hi from new session")).status).toBe(200);
    const add = await api(`/api/channels/${slug}/members/${encodeURIComponent(legacy)}`, owner.token, { method: "PUT" });
    expect(add.status).toBe(200);
    expect((await postMessage(slug, older.token, "hi from old session")).status).toBe(200);

    const before = await identitiesOf(slug, owner.token);
    expect(before.find((i) => i.name === olderName)?.account).toBe(legacy);
    expect(before.find((i) => i.name === humanName)?.account).toBe(canonical);

    await link(legacy, canonical);

    const after = await identitiesOf(slug, owner.token);
    expect(after.some((i) => i.account === legacy)).toBe(false);
    expect(after.find((i) => i.name === olderName)?.account).toBe(canonical);
    expect(after.find((i) => i.name === humanName)?.account).toBe(canonical);
  });

  it("没有别名时原样返回账号（别名表为空不改变既有行为）", async () => {
    const account = `lark:on_${uniq("plain").replace(/-/g, "")}`;
    const humanName = crypto.randomUUID();
    const owner = await seedToken("human", humanName, { owner: account });
    const slug = await createChannel(owner.token);
    expect((await postMessage(slug, owner.token, "hi")).status).toBe(200);
    expect((await identitiesOf(slug, owner.token)).find((i) => i.name === humanName)?.account).toBe(account);
  });
});
