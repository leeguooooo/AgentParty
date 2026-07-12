// #277 会员真门槛：isMember 此前有骨架无调用点。这里验证两处真实生效的 gate——
//   1) POST /api/channels 的 owned 频道配额：free 低配额，member 解锁到平台原高上限。
//   2) POST /api/channels/:slug/attachments 的体积上限：free 低配额，member 解锁到原 25 MiB。
// 拒绝响应必须带会员提示（why + how to unlock），不是裸配额数字。
import { FREE_ATTACHMENT_SIZE_LIMIT, FREE_CHANNEL_CAP } from "@agentparty/shared";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { activateMembership, api, createChannel, seedToken, uniq } from "./helpers";
import { hostedMembershipGating } from "../src/index";

describe("member gating deployment policy (#277)", () => {
  it("is opt-in so self-hosted deployments keep the original full limits", () => {
    expect(hostedMembershipGating({})).toBe(false);
    expect(hostedMembershipGating({ HOSTED_MEMBERSHIP_GATING: "false" })).toBe(false);
    expect(hostedMembershipGating({ HOSTED_MEMBERSHIP_GATING: "true" })).toBe(true);
  });
});

async function seedChannels(ownerAccount: string, count: number, createdAt: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await env.DB.prepare(
      "INSERT INTO channels (slug, kind, created_by, owner_account, created_at) VALUES (?, 'standing', ?, ?, ?)",
    )
      .bind(uniq("seed"), "seed-creator", ownerAccount, createdAt)
      .run();
  }
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

describe("member gating — channel quota (#277)", () => {
  it("rejects a free account past the free-tier channel cap, with a membership hint", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    const old = Date.now() - 2 * 60 * 60 * 1000; // window 外，不撞创建限速
    await seedChannels(account, FREE_CHANNEL_CAP - 1, old);

    // 第 N 个（刚好到 free 配额）仍放行
    expect((await createChannelReq(token)).status).toBe(201);

    // 第 N+1 个：超 free 配额，403 quota_exceeded + 会员提示
    const over = await createChannelReq(token);
    expect(over.status).toBe(403);
    const body = (await over.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.message.toLowerCase()).toContain("member");
  });

  it("lets an activated member create channels past the free-tier cap", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    await activateMembership(account);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    // 播种超过 free 配额，member 应该不受影响
    await seedChannels(account, FREE_CHANNEL_CAP + 2, old);

    expect((await createChannelReq(token)).status).toBe(201);
  });
});

describe("member gating — attachment size (#277)", () => {
  it("rejects an oversize upload from a free account, with a membership hint", async () => {
    const { token } = await seedToken("agent", uniq("tok"), { owner: uniq("acct") });
    const slug = await createChannel(token);
    const big = new Uint8Array(FREE_ATTACHMENT_SIZE_LIMIT + 1024);
    const res = await upload(slug, token, "big.bin", big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("too_large");
    expect(body.error.message.toLowerCase()).toContain("member");
  });

  it("lets an activated member upload above the free-tier size but within the member cap", async () => {
    const account = uniq("acct");
    const { token } = await seedToken("agent", uniq("tok"), { owner: account });
    await activateMembership(account);
    const slug = await createChannel(token);
    // 大于 free 上限，但仍在 member 的 25 MiB 上限内
    const mid = new Uint8Array(FREE_ATTACHMENT_SIZE_LIMIT + 1024);
    const res = await upload(slug, token, "mid.bin", mid);
    expect(res.status).toBe(201);
  });
});
