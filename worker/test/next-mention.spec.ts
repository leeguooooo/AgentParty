// #903：`GET /api/channels/:slug/next-mention?since=N` —— 「> N 的消息里，第一条 @ 我的是第几条」。
//
// 存在的理由在 CLI 那侧：codex 的 Stop hook 只有 ~10s 预算，又没有 serve/watch 落下的本地欠账
// 可读（它存在的意义正是顶替那条通道）。所以它需要一次极便宜、只回指针的问询；正文仍旧走
// /messages，本端点一个字的正文都不回。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
// 源码文本（vite ?raw）：workers 运行时读不到宿主文件系统，源码守卫只能靠构建期把文本嵌进来。
import doSource from "../src/do.ts?raw";
import { api, createChannel, seedToken, uniq } from "./helpers";

/** 与 worker/src/do.ts 的 NEXT_MENTION_SCAN_LIMIT 对齐：一次问询最多核查多少条候选。 */
const NEXT_MENTION_SCAN_LIMIT = 200;

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

/** 索引里某条 seq 还剩几行——用来证明「编辑之后陈旧行真的没了」而不是靠端点行为间接推断。 */
function indexRowCount(stub: DurableObjectStub<ChannelDO>, seq: number): Promise<number> {
  return runInDurableObject(stub, (_instance: ChannelDO, state) =>
    [...state.storage.sql.exec("SELECT COUNT(*) AS n FROM message_mentions WHERE seq = ?", seq)][0]!.n as number,
  );
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
    // 规模只需大到「全扫实现必然读满整条频道」即可；CI 上每条消息都走真实 POST /messages，
    // 200 条要 40 秒以上并已实际超时过。12 vs 72 的对比同样能证伪「读行数随长度增长」。
    const short = await seedNoisyChannel(12);
    const long = await seedNoisyChannel(72);

    // 正控：消息真的存进去了、那些 @ 也真的查得到——否则「读行数小」可能只是因为频道是空的，
    // 被测的那道闸根本没被考到。
    expect(await nextMention(short.slug, short.noisy.token, 0)).toBe(1);
    expect(await nextMention(long.slug, long.noisy.token, 0)).toBe(1);
    const history = await api(`/api/channels/${long.slug}/messages?limit=1000`, long.human.token);
    expect(((await history.json()) as { messages: unknown[] }).messages.length).toBe(72);

    expect(await nextMention(short.slug, short.bystander.token, 0)).toBeNull();
    const shortRows = await rowsRead(short.slug);
    expect(await nextMention(long.slug, long.bystander.token, 0)).toBeNull();
    const longRows = await rowsRead(long.slug);

    // 频道长了 6 倍，读行数不许跟着长。全扫实现这里会是 12 vs 72。
    expect(longRows).toBeLessThanOrEqual(shortRows + 2);
    // 且绝对值必须是常数级，不是「涨得慢一点」。
    expect(longRows).toBeLessThanOrEqual(4);
  });

  it("命中时的读行数只跟命中位置有关，不跟 since 到命中点的距离有关", async () => {
    const { slug, human, noisy, bystander } = await seedNoisyChannel(72);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    await runInDurableObject(stub, (_instance: ChannelDO, state) => {
      state.storage.sql.exec("DELETE FROM rate");
    });
    // 在长频道最末尾补一条 @ bystander 的：命中点在 201，since=0 的距离是满的。
    const target = await send(slug, human.token, `@${bystander.name} 轮到你`, [bystander.name]);
    expect(target).toBe(73);

    expect(await nextMention(slug, bystander.token, 0)).toBe(target);
    // 索引直接定位到那一条；全扫实现要走完前面 72 行才够得到它。
    expect(await rowsRead(slug)).toBeLessThanOrEqual(4);
    // 同一频道里被 @ 了 72 次的那位，仍旧拿到最早的那条（LIMIT 语义没被换掉）。
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

  // 索引化把「查得到」从**全表扫描**换成**索引探针**，代价是：任何写 messages.mentions_json 的路径
  // 漏同步，那条 @ 就从此查不到——而改动前 LIKE 全扫是找得到的，也就是说漏一处即是**漏唤醒回归**。
  // do.ts 里有四处 `INSERT INTO messages`，靠人眼数是靠不住的（第一版就漏了三处，CodeRabbit 逮到）。
  // 这条守卫按源码钉死：每一处 INSERT 只要写 mentions_json，其后必须紧跟 indexMessageMentions。
  // 将来任何人新增第五处直写路径，这里会立刻红，而不是等某个 agent 神秘地叫不醒。
  it("所有直写 messages.mentions_json 的 INSERT 都同步了 @ 索引（源码守卫）", async () => {
    const source = doSource;
    const inserts = [...source.matchAll(/INSERT INTO messages \(/g)];
    // 数量本身也钉一下：新增写路径必须来这里过一遍，而不是悄悄多一处。
    expect(inserts.length).toBe(4);
    for (const insert of inserts) {
      const block = source.slice(insert.index!, insert.index! + 4000);
      if (!block.slice(0, 1200).includes("mentions_json")) continue;
      const statementEnd = block.indexOf("\n    );");
      const after = block.slice(statementEnd === -1 ? 0 : statementEnd, statementEnd === -1 ? 4000 : statementEnd + 600);
      expect(after).toContain("indexMessageMentions");
    }
  });

  // 上一条是源码守卫；这一条是行为守卫，走真实端点证明「审阅驳回 @ 原作者」这一类的 @ 查得到。
  // 挑驳回回复是因为它最要命：作者正等着被叫醒去改，查不到就等于驳回通知石沉大海。
  it("审阅驳回回复里的 @ 能被 next-mention 查到（非 handleSend 的写路径）", async () => {
    const acct = `${uniq("acct")}@leeguoo.com`;
    const owner = await seedToken("agent", uniq("owner"), { owner: acct });
    const slug = await createChannel(owner.token);
    const writer = await seedToken("agent", uniq("writer"), { owner: acct, channelScope: slug });
    const reviewer = await seedToken("agent", uniq("reviewer"), {
      owner: `${uniq("reviewer")}@example.com`,
      channelScope: slug,
    });
    const gate = await api(`/api/channels/${slug}/completion-gate`, owner.token, {
      method: "PUT",
      body: JSON.stringify({ gate: "reviewer", policy: "sender" }),
    });
    expect(gate.status).toBe(200);

    const kickoff = await send(slug, writer.token, "please do the work");
    const completion = await api(`/api/channels/${slug}/messages`, writer.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "message",
        body: "final synthesis",
        mentions: [],
        reply_to: kickoff,
        completion_artifact: {
          kind: "final_synthesis",
          kickoff_seq: kickoff,
          replies_count: 1,
          timeout: false,
          related_issues: [],
          related_prs: [],
        },
      }),
    });
    expect(completion.status).toBe(200);
    const completionSeq = ((await completion.json()) as { seq: number }).seq;
    // 驳回之前 writer 没有任何待处理的 @（它自己发的不算）——把闸前的状态先钉死，
    // 免得下面的「查得到」是别的东西凑出来的。
    expect(await nextMention(slug, writer.token, 0)).toBeNull();

    const rejected = await api(`/api/channels/${slug}/messages/${completionSeq}/review`, reviewer.token, {
      method: "POST",
      body: JSON.stringify({ action: "reject", reason: "missing test evidence" }),
    });
    expect(rejected.status).toBe(200);
    const replySeq = ((await rejected.json()) as { reply: { seq: number; mentions: string[] } }).reply;
    expect(replySeq.mentions).toEqual([writer.name]);

    // 这就是 codex Stop hook 会问的那一句：作者查得到「有人 @ 我了」。
    expect(await nextMention(slug, writer.token, 0)).toBe(replySeq.seq);
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

  // CodeRabbit on #932 推翻了本 PR 初版的安全论证：「索引是超集 + 回表核验 ⇒ 永不误报」只在**不设上限**
  // 时成立。候选是有上限的（NEXT_MENTION_SCAN_LIMIT），而编辑是唯一会**移除** @ 的常规路径；只追加不
  // 替换的话，被编辑掉的 @ 会在索引里留下陈旧行，攒够上限就能把排在它们后面的**真** @ 挤出候选窗口
  // ⇒ 漏唤醒。这是本 PR 会引入的回归，不是既有缺陷。修法是编辑路径先删后建。
  // 原来这条用真发 200 条 + 编辑 200 次来把候选窗口填满，CI 上要跑 107 秒（120s 预算）——
  // 必然 flake，而且它把两件独立的事捆在一起证。拆成下面两条：各自直接构造被证的那个状态，
  // 秒级完成，且比原来更强（危险状态是显式造出来的，不依赖「编辑真的留下了陈旧行」这个前提）。
  it("编辑移除 @ 之后，索引里不再留下该 seq 的陈旧行", async () => {
    const human = await seedToken("human");
    // 被 @ 的是人类：agent 的 @ 会落成 directed delivery，而已路由的目标**不允许**被编辑掉
    // （必须撤回/supersede）。所以能制造陈旧索引行的只有非路由 @，这里用人类目标来构造。
    const target = await seedToken("human");
    const slug = await createChannel(human.token);
    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));

    const seq = await send(slug, human.token, `@${target.name} 原文`, [target.name]);
    // 正控：编辑之前索引里确实有这一行——否则下面的「没有了」可能只是因为它从来就没进去过。
    expect(await indexRowCount(stub, seq)).toBe(1);

    const edit = await api(`/api/channels/${slug}/messages/${seq}/edit`, human.token, {
      method: "POST",
      body: JSON.stringify({ body: "改口，不 @ 了" }),
    });
    expect(edit.status).toBe(200);

    expect(await indexRowCount(stub, seq)).toBe(0);
    expect(await nextMention(slug, target.token, 0)).toBeNull();
  });

  // 这里曾经有一条「攒满候选窗口的陈旧行也挤不掉真 @」的用例，已删除，理由记下来免得有人再写一遍：
  //
  //   1. 想让陈旧行真的消耗 `LIMIT` 预算，它必须**指向仍然存在的消息**（否则 JOIN messages 就把它
  //      丢了，LIMIT 作用在 JOIN 之后，够不到的行不占名额）；也必须 `seq > since`。
  //   2. 于是唯一忠实的构造就是「发 N 条真消息再逐条编辑掉 @」——那正是原来那条跑 107 秒、
  //      CI 上必然 flake 的写法。
  //   3. 直接往 message_mentions 塞行（负 seq、或指向不存在的消息）**证明不了任何事**：那些行
  //      在 SQL 层就被过滤掉，用例恒绿，是典型的空转守卫。
  //
  // 而修复后的不变式本来就是「索引对每条消息精确」——陈旧行不再产生，上一条用例直接钉住了这一点。
  // 与其留一条证明不了危险的用例，不如把「危险为什么不再存在」写清楚。
});
