// #607：mention 决议走全实例 handle 面（account_profiles 不分频道），@ 一个从未连过本频道、
// 也没订阅任何通知渠道的人类会正常落库，然后无声无息。修复后：消息落库后异步核对可达面
// （presence 非 offline / 本频道同名 webhook），全都没有 → 频道内落一条 system status 警示，
// 并按 target 30 分钟去重。agent 目标不警示（离线 agent 有 directed delivery 持久重放）。
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fetchMock } from "./fetch-mock";
import { api, createChannel, seedToken, uniq } from "./helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

async function seedProfile(handle: string): Promise<string> {
  const account = `lark:${uniq("acct")}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO account_profiles (account, handle, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(account, handle, handle, now, now).run();
  return account;
}

function send(slug: string, token: string, body: string, mentions: string[]): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
}

async function frames(slug: string, token: string): Promise<Array<{ sender: { name: string }; kind: string; note?: string | null }>> {
  const res = await api(`/api/channels/${slug}/messages?limit=100`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Array<{ sender: { name: string }; kind: string; note?: string | null }> }).messages;
}

function warnings(msgs: Array<{ sender: { name: string }; kind: string; note?: string | null }>): string[] {
  return msgs
    .filter((m) => m.sender.name === "system" && (m.note ?? "").includes("won't see this mention"))
    .map((m) => m.note ?? "");
}

describe("#607 unreachable human mention warning", () => {
  it("mentioning a global handle that never joined the channel produces a system warning", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "warn-sender@leeguoo.com" });
    const handle = uniq("karl");
    await seedProfile(handle);
    const slug = await createChannel(sender.token);

    expect((await send(slug, sender.token, `@${handle} 在么`, [handle])).status).toBe(200);
    // waitUntil 副作用在响应后落库；vitest pool workers 会排空 waitUntil，但再读一次以防竞态。
    const found = warnings(await frames(slug, sender.token));
    expect(found.length).toBe(1);
    expect(found[0]).toContain(`@${handle}`);
  });

  it("dedupes repeat warnings for the same target within the window", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "warn-dedupe@leeguoo.com" });
    const handle = uniq("karl");
    await seedProfile(handle);
    const slug = await createChannel(sender.token);

    expect((await send(slug, sender.token, `@${handle} ping`, [handle])).status).toBe(200);
    expect((await send(slug, sender.token, `@${handle} ping again`, [handle])).status).toBe(200);
    expect(warnings(await frames(slug, sender.token)).length).toBe(1);
  });

  it("does not warn for offline agents (directed delivery replays those)", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "warn-agent@leeguoo.com" });
    const slug = await createChannel(sender.token);
    const agent = await seedToken("agent", uniq("bot"), { channelScope: slug });

    expect((await send(slug, sender.token, `@${agent.name} do it`, [agent.name])).status).toBe(200);
    expect(warnings(await frames(slug, sender.token)).length).toBe(0);
  });

  it("does not warn when the mentioned human has a notify webhook in this channel", async () => {
    const owner = await seedToken("human", uniq("sender"), { owner: "warn-hook@leeguoo.com" });
    const handle = uniq("subscribed");
    await seedProfile(handle);
    const slug = await createChannel(owner.token);
    fetchMock.get("https://relay.test").intercept({ path: "/notify", method: "POST" }).reply(202, "accepted");
    const hook = await api(`/api/channels/${slug}/webhooks`, owner.token, {
      method: "POST",
      body: JSON.stringify({ name: handle, url: "https://relay.test/notify", secret: "s3cret" }),
    });
    expect(hook.status).toBe(201);

    expect((await send(slug, owner.token, `@${handle} check`, [handle])).status).toBe(200);
    expect(warnings(await frames(slug, owner.token)).length).toBe(0);
  });
});
