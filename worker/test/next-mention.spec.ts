// #903：`GET /api/channels/:slug/next-mention?since=N` —— 「> N 的消息里，第一条 @ 我的是第几条」。
//
// 存在的理由在 CLI 那侧：codex 的 Stop hook 只有 ~10s 预算，又没有 serve/watch 落下的本地欠账
// 可读（它存在的意义正是顶替那条通道）。所以它需要一次极便宜、只回指针的问询；正文仍旧走
// /messages，本端点一个字的正文都不回。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken } from "./helpers";

async function send(
  slug: string,
  token: string,
  body: string,
  mentions: string[] = [],
): Promise<number> {
  const res = await api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number }).seq;
}

async function nextMention(slug: string, token: string, since: number): Promise<number | null> {
  const res = await api(`/api/channels/${slug}/next-mention?since=${since}`, token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number | null }).seq;
}

describe("next-mention (#903)", () => {
  it("回第一条 @ 我的 seq；游标越过后回 null；不含正文", async () => {
    const human = await seedToken("human");
    const agent = await seedToken("agent");
    const slug = await createChannel(human.token);

    await send(slug, human.token, "闲聊一句，没 @ 任何人");
    const mention = await send(slug, human.token, `@${agent.name} 看一下这个`, [agent.name]);
    const second = await send(slug, human.token, `@${agent.name} 还有这个`, [agent.name]);

    expect(await nextMention(slug, agent.token, 0)).toBe(mention);
    // 「最小的那个」——不是最后一条，也不是随便一条。
    expect(mention).toBeLessThan(second);
    expect(await nextMention(slug, agent.token, mention)).toBe(second);
    expect(await nextMention(slug, agent.token, second)).toBeNull();

    // 只回指针：响应体里除了 seq 什么都没有，正文一个字都不出现。
    const res = await api(`/api/channels/${slug}/next-mention?since=0`, agent.token);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["seq"]);
    expect(JSON.stringify(body)).not.toContain("看一下");
  });

  it("没被 @ 的身份恒得到 null（别人的 @ 不会被误报成自己的）", async () => {
    const human = await seedToken("human");
    const mentioned = await seedToken("agent");
    const bystander = await seedToken("agent");
    const slug = await createChannel(human.token);

    await send(slug, human.token, `@${mentioned.name} 你的活`, [mentioned.name]);

    expect(await nextMention(slug, mentioned.token, 0)).not.toBeNull();
    expect(await nextMention(slug, bystander.token, 0)).toBeNull();
  });

  it("自己 @ 自己不算未处理的 @（否则 hook 会被自己的消息唤醒，自激成死循环）", async () => {
    const human = await seedToken("human");
    const agent = await seedToken("agent");
    const slug = await createChannel(human.token);
    await send(slug, human.token, "开场白");

    await send(slug, agent.token, `@${agent.name} 自言自语`, [agent.name]);
    expect(await nextMention(slug, agent.token, 0)).toBeNull();
  });

  it("name 一律取 bearer 身份，客户端指定的 name 被忽略（不能拿来探测别人）", async () => {
    const human = await seedToken("human");
    const mentioned = await seedToken("agent");
    const bystander = await seedToken("agent");
    const slug = await createChannel(human.token);
    await send(slug, human.token, `@${mentioned.name} 你的活`, [mentioned.name]);

    const res = await api(
      `/api/channels/${slug}/next-mention?since=0&name=${encodeURIComponent(mentioned.name)}`,
      bystander.token,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { seq: number | null }).seq).toBeNull();
  });

  it("频道不存在 → 404", async () => {
    const agent = await seedToken("agent");
    const res = await api("/api/channels/no-such-channel-903/next-mention?since=0", agent.token);
    expect(res.status).toBe(404);
  });
});
