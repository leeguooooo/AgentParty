// #663：区分「显式 mention」与「正文附带 @」。
// - 显式 mentions[]（--mention / MCP mentions[]）是权威来源：未命中/歧义/保留字仍硬拒（回归守卫）。
// - body_mentions[]（正文便利提取）：命中即照常路由/唤醒；未命中/歧义/保留字降级为普通文本、不阻断整条发送，
//   原始 token 汇总进 REST 回执 unresolved_mentions（WS 回执同字段）。
// 反转 #552 的过度修复：自然语言「@我」不该把一条正常消息整条打回。
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WsClient, api, createChannel, seedToken, uniq } from "./helpers";

async function seedProfile(handle: string): Promise<string> {
  const account = `lark:${uniq("acct")}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO account_profiles (account, handle, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(account, handle, handle, now, now).run();
  return account;
}

interface SendBody {
  kind: "message";
  body: string;
  mentions: string[];
  body_mentions?: string[];
  reply_to: number | null;
}

function send(slug: string, token: string, payload: Omit<SendBody, "kind" | "reply_to"> & { reply_to?: number | null }): Promise<Response> {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", reply_to: null, ...payload }),
  });
}

async function storedBody(slug: string, token: string, seq: number): Promise<string> {
  const res = await api(`/api/channels/${slug}/messages?limit=200`, token);
  expect(res.status).toBe(200);
  const { messages } = (await res.json()) as { messages: Array<{ seq: number; body: string }> };
  const row = messages.find((m) => m.seq === seq);
  expect(row).toBeDefined();
  return row!.body;
}

describe("#663 explicit vs body mentions", () => {
  it("natural-language @我 in body_mentions sends successfully, stored verbatim, reported unresolved (not an error)", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "s663-a@leeguoo.com" });
    const slug = await createChannel(sender.token);
    const body = "有补充或纠正的 @我。";

    const res = await send(slug, sender.token, { body, mentions: [], body_mentions: ["我"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { seq: number; unresolved_mentions?: string[] };
    expect(json.unresolved_mentions).toEqual(["我"]);
    // 正文原样保留，绝不被裁剪。
    expect(await storedBody(slug, sender.token, json.seq)).toBe(body);
  });

  it("explicit --mention typo still hard-errors even when a body @ coexists", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "s663-b@leeguoo.com" });
    const slug = await createChannel(sender.token);

    const res = await send(slug, sender.token, {
      body: "@nosuchhandle 见正文 @我",
      mentions: ["nosuchhandle"],
      body_mentions: ["我"],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "mention_not_found" } });
  });

  it("explicit mention is authoritative and routes; body @我 rides along as unresolved text", async () => {
    const acct = "s663-c@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const slug = await createChannel(sender.token);
    const handle = uniq("realhandle");
    await seedProfile(handle);

    const res = await send(slug, sender.token, {
      body: `@${handle} 有补充 @我`,
      mentions: [handle],
      body_mentions: ["我"],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { seq: number; unresolved_mentions?: string[] };
    expect(json.unresolved_mentions).toEqual(["我"]);
    // 权威 mention 落库为路由目标。
    const listed = await api(`/api/channels/${slug}/messages?limit=200`, sender.token);
    const { messages } = (await listed.json()) as { messages: Array<{ seq: number; mentions: string[] }> };
    const row = messages.find((m) => m.seq === json.seq);
    expect(row?.mentions).toContain(handle);
  });

  it("a resolvable body @handle still routes/wakes with no regression (no unresolved)", async () => {
    const acct = "s663-d@leeguoo.com";
    const sender = await seedToken("human", uniq("sender"), { owner: acct });
    const agent = await seedToken("agent", uniq("worker663"), { owner: acct });
    const slug = await createChannel(sender.token);

    // 一个真实存在的 agent handle 出现在正文里 → 命中即照常路由（进 mentions[]），这正是 wake 的机制来源。
    const res = await send(slug, sender.token, {
      body: `请 @${agent.name} 看一下`,
      mentions: [],
      body_mentions: [agent.name],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { seq: number; unresolved_mentions?: string[] };
    // 命中的 body @ 不进 unresolved。
    expect(json.unresolved_mentions).toBeUndefined();
    const listed = await api(`/api/channels/${slug}/messages?limit=200`, sender.token);
    const { messages } = (await listed.json()) as { messages: Array<{ seq: number; mentions: string[] }> };
    const row = messages.find((m) => m.seq === json.seq);
    // 落库 mentions[] 含该 agent，即命中的 body @ 已进入路由/唤醒路径（wake 的机制来源）。
    expect(row?.mentions).toContain(agent.name);
  });

  it("reserved-word body @全体/@all downgrade to text (unresolved), never hard-fail", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "s663-e@leeguoo.com" });
    const slug = await createChannel(sender.token);
    const body = "@all 请注意 @everyone";

    const res = await send(slug, sender.token, { body, mentions: [], body_mentions: ["all", "everyone"] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { seq: number; unresolved_mentions?: string[] };
    expect(json.unresolved_mentions).toEqual(["all", "everyone"]);
    expect(await storedBody(slug, sender.token, json.seq)).toBe(body);
  });

  it("no body_mentions field (legacy client) preserves today's behavior exactly", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "s663-f@leeguoo.com" });
    const slug = await createChannel(sender.token);

    // 旧客户端把正文 @ 并进 mentions[] → 仍走硬拒，这是可接受的向后兼容。
    const res = await send(slug, sender.token, { body: "结尾 @我", mentions: ["我"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "mention_not_found" } });

    // 完全不带任何 @ 的消息照常发。
    const clean = await send(slug, sender.token, { body: "a@example.com 是邮箱", mentions: [] });
    expect(clean.status).toBe(200);
  });

  it("WS send surfaces unresolved_mentions on the sent ack", async () => {
    const sender = await seedToken("human", uniq("sender"), { owner: "s663-g@leeguoo.com" });
    const slug = await createChannel(sender.token);

    const ws = await WsClient.open(slug, sender.token);
    await ws.nextOfType("welcome");
    ws.send({ type: "hello", since: 0 });
    ws.send({
      type: "send",
      kind: "message",
      body: "有补充或纠正的 @我。",
      mentions: [],
      body_mentions: ["我"],
      reply_to: null,
    });
    const ack = await ws.nextOfType("sent");
    expect((ack as { unresolved_mentions?: string[] }).unresolved_mentions).toEqual(["我"]);
    ws.close();
  });
});
