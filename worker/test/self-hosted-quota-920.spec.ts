// #920 自部署不该继承 SaaS 免费层限制。
// 取证：HOSTED_MEMBERSHIP_GATING 曾硬写在提交进仓库的 wrangler 配置里，于是任何照本仓自部署的
// 实例都走 FREE_CHANNEL_CAP=20 而不是 MAX_CHANNELS_PER_ACCOUNT=100，撞上限时还被劝去升级
// 一个跟本实例无关的会员。这里钉住 gating 关闭时的两件事：
//   1) 账号频道上限是 MAX_CHANNELS_PER_ACCOUNT，不是 free 层配额；
//   2) 撞到硬上限时的文案不含任何升级引导，只指向本实例运营方。
// 测试环境全局把 gating 设成 "true"（见 vitest.config.ts），所以这里显式改成 "false" 模拟
// 自部署默认形态，跑完还原，避免污染同一 workerd 里的其它 spec。
import { FREE_ATTACHMENT_SIZE_LIMIT, FREE_CHANNEL_CAP, MAX_CHANNELS_PER_ACCOUNT } from "@agentparty/shared";
import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

async function seedChannels(ownerAccount: string, count: number, createdAt: number): Promise<void> {
  const stmt = env.DB.prepare(
    "INSERT INTO channels (slug, kind, created_by, owner_account, created_at) VALUES (?, 'standing', ?, ?, ?)",
  );
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(stmt.bind(uniq("seed"), "seed-creator", ownerAccount, createdAt));
  await env.DB.batch(rows);
}

function createChannelReq(token: string) {
  return api("/api/channels", token, {
    method: "POST",
    body: JSON.stringify({ slug: uniq("ch"), kind: "standing" }),
  });
}

function upload(slug: string, token: string, filename: string, bytes: Uint8Array): Promise<Response> {
  return SELF.fetch(`http://ap.test/api/channels/${slug}/attachments?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: bytes,
  });
}

describe("self-hosted deployment keeps full limits (#920)", () => {
  beforeAll(() => {
    (env as unknown as Record<string, unknown>).HOSTED_MEMBERSHIP_GATING = "false";
  });
  afterAll(() => {
    (env as unknown as Record<string, unknown>).HOSTED_MEMBERSHIP_GATING = "true";
  });

  it("uses MAX_CHANNELS_PER_ACCOUNT (not the free cap) for a non-member account", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    const old = Date.now() - 2 * 60 * 60 * 1000; // 窗口外，不撞创建限速

    // 先播到刚好超过 free 配额：gating 开时这里就会被拒，gating 关时必须照常放行。
    await seedChannels(account, FREE_CHANNEL_CAP, old);
    expect((await createChannelReq(token)).status).toBe(201);

    // 再补到硬上限 - 1，最后一个仍放行，第 MAX+1 个才该被拒。
    await seedChannels(account, MAX_CHANNELS_PER_ACCOUNT - FREE_CHANNEL_CAP - 2, old);
    expect((await createChannelReq(token)).status).toBe(201);

    const over = await createChannelReq(token);
    expect(over.status).toBe(403);
    const body = (await over.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("quota_exceeded");
    // 报的是硬上限数字，不是 free 层数字
    expect(body.error.message).toContain(String(MAX_CHANNELS_PER_ACCOUNT));
    expect(body.error.message).not.toContain(`max ${FREE_CHANNEL_CAP} channels`);
  });

  it("never offers a membership upgrade when the instance runs no membership gating", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    await seedChannels(account, MAX_CHANNELS_PER_ACCOUNT, Date.now() - 2 * 60 * 60 * 1000);

    const over = await createChannelReq(token);
    expect(over.status).toBe(403);
    const message = ((await over.json()) as { error: { message: string } }).error.message.toLowerCase();
    // 升级引导在自部署实例上无对象可升，必须消失……
    expect(message).not.toContain("upgrade");
    expect(message).not.toContain("member");
    expect(message).not.toContain("free tier");
    // ……并被换成一个真的能执行的下一步
    expect(message).toContain("contact the operator of this instance");
  });

  it("does not apply the free attachment size limit", async () => {
    // 非会员账号（无 account_membership 行），gating 关 ⇒ 应享有 member 档的 25 MiB 上限
    const { token } = await seedToken("agent", uniq("tok"), { owner: uniq("acct") });
    const slug = await createChannel(token);
    const overFree = new Uint8Array(FREE_ATTACHMENT_SIZE_LIMIT + 1024);
    expect((await upload(slug, token, "over-free.bin", overFree)).status).toBe(201);
  });
});
