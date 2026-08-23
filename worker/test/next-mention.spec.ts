// #903：`GET /api/channels/:slug/next-mention?since=N` —— 「> N 的消息里，第一条 @ 我的是第几条」。
//
// 存在的理由在 CLI 那侧：codex 的 Stop hook 只有 ~10s 预算，又没有 serve/watch 落下的本地欠账
// 可读（它存在的意义正是顶替那条通道）。所以它需要一次极便宜、只回指针的问询；正文仍旧走
// /messages，本端点一个字的正文都不回。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
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

// #913：这个端点的存在前提是「便宜到 codex Stop hook 每轮结束都能问一次」。原实现用
// `seq > since AND (mentions_json LIKE ? OR delivery_targets_json LIKE ?)` 扫 messages——LIMIT 封的是
// 命中行数不是扫描行数，**零命中时必须扫完 since 之后每一行**才能确定「没有」。游标新鲜时窗口只有
// 几条，游标陈旧时（新身份 cursor=0，正是 #870 的形态）代价与频道长度同阶。
//
// 响应体里看不出扫了 1900 行还是 0 行，所以这里断言的是 DO 记下的真实读行数：同一场景把频道拉长
// 一个数量级，读行数不许跟着涨。退回 LIKE 全扫实现，长频道那次会读满整段，本用例立刻红。
describe("next-mention 扫描代价 (#913)", () => {
  // 造「长频道 + 零命中」：频道里全是 @ 别人的消息（索引非空、LIKE 也有得扫），
  // 问的人自己一次都没被 @ 过，since=0 —— 陈旧游标的极端形态。
  async function seedNoisyChannel(length: number) {
    const human = await seedToken("human");
    const noisy = await seedToken("agent");
    const bystander = await seedToken("agent");
    const slug = await createChannel(human.token);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    for (let i = 0; i < length; i += 1) {
      // 造长频道要绕开每分钟 30 条的发送限速——清的是限速账本，消息本身仍旧走真实的
      // POST /messages → storeMessage 路径（索引也就必须是那条路径自己维护出来的）。
      if (i > 0 && i % 20 === 0) {
        await runInDurableObject(stub, (_instance: ChannelDO, state) => {
          state.storage.sql.exec("DELETE FROM rate");
        });
      }
      await send(slug, human.token, `@${noisy.name} 第 ${i} 条`, [noisy.name]);
    }
    return { slug, human, noisy, bystander };
  }

  function rowsRead(slug: string): Promise<number> {
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    return runInDurableObject(stub, (instance: ChannelDO) => instance.nextMentionRowsRead);
  }

  it("零命中 + since=0：读行数不随频道长度增长", async () => {
    const short = await seedNoisyChannel(20);
    const long = await seedNoisyChannel(200);

    // 正控：消息真的存进去了、那些 @ 也真的查得到——否则「读行数小」可能只是因为频道是空的，
    // 被测的那道闸根本没被考到。
    expect(await nextMention(short.slug, short.noisy.token, 0)).toBe(1);
    expect(await nextMention(long.slug, long.noisy.token, 0)).toBe(1);
    const history = await api(`/api/channels/${long.slug}/messages?limit=1000`, long.human.token);
    expect(((await history.json()) as { messages: unknown[] }).messages.length).toBe(200);

    expect(await nextMention(short.slug, short.bystander.token, 0)).toBeNull();
    const shortRows = await rowsRead(short.slug);
    expect(await nextMention(long.slug, long.bystander.token, 0)).toBeNull();
    const longRows = await rowsRead(long.slug);

    // 频道长了 10 倍，读行数不许跟着长。全扫实现这里会是 20 vs 200。
    expect(longRows).toBeLessThanOrEqual(shortRows + 2);
    // 且绝对值必须是常数级，不是「涨得慢一点」。
    expect(longRows).toBeLessThanOrEqual(4);
  });

  it("命中时的读行数只跟命中位置有关，不跟 since 到命中点的距离有关", async () => {
    const { slug, human, noisy, bystander } = await seedNoisyChannel(200);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, (_instance: ChannelDO, state) => {
      state.storage.sql.exec("DELETE FROM rate");
    });
    // 在长频道最末尾补一条 @ bystander 的：命中点在 201，since=0 的距离是满的。
    const target = await send(slug, human.token, `@${bystander.name} 轮到你`, [bystander.name]);
    expect(target).toBe(201);

    expect(await nextMention(slug, bystander.token, 0)).toBe(target);
    // 索引直接定位到那一条；全扫实现要走完前面 200 行才够得到它。
    expect(await rowsRead(slug)).toBeLessThanOrEqual(4);
    // 同一频道里被 @ 了 200 次的那位，仍旧拿到最早的那条（LIMIT 语义没被换掉）。
    expect(await nextMention(slug, noisy.token, 0)).toBe(1);
  });

  // 索引是查询的唯一预筛，所以**存量频道**必须被回填——线上那些早于本次发布的消息一条都不能查不到。
  // 这里把索引连同回填标记一起抹掉（模拟「升级前就存在的频道」），再重跑 onStart。
  it("存量消息由 onStart 回填进索引，升级前发的 @ 一样查得到", async () => {
    const human = await seedToken("human");
    const agent = await seedToken("agent");
    const slug = await createChannel(human.token);
    await send(slug, human.token, "开场白");
    const mention = await send(slug, human.token, `@${agent.name} 老消息里的 @`, [agent.name]);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, (_instance: ChannelDO, state) => {
      state.storage.sql.exec("DELETE FROM message_mentions");
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'mention_index_v1'");
    });
    // 没有索引就查不到——这正是回填要补的洞，先把洞晾出来，免得后面的绿是白来的。
    expect(await nextMention(slug, agent.token, 0)).toBeNull();

    await runInDurableObject(stub, (instance: ChannelDO) => instance.onStart());
    expect(await nextMention(slug, agent.token, 0)).toBe(mention);
    // 回填是一次性的：标记落了，重复 hydrate 不再扫全表，也不会把索引扫坏。
    await runInDurableObject(stub, (instance: ChannelDO) => instance.onStart());
    expect(await nextMention(slug, agent.token, 0)).toBe(mention);
  });

  // 编辑是除 INSERT 之外唯一能**新增** @ 的路径。漏同步它 = 被新 @ 到的人这次唤醒直接查不到。
  it("编辑新增的 @ 立刻可查", async () => {
    const human = await seedToken("human");
    const agent = await seedToken("agent");
    const slug = await createChannel(human.token);
    const seq = await send(slug, human.token, "先不 @ 任何人");
    expect(await nextMention(slug, agent.token, 0)).toBeNull();

    const res = await api(`/api/channels/${slug}/messages/${seq}/edit`, human.token, {
      method: "POST",
      body: JSON.stringify({ body: `@${agent.name} 补 @ 你一下` }),
    });
    expect(res.status).toBe(200);

    expect(await nextMention(slug, agent.token, 0)).toBe(seq);
  });
});
