// #818：wake debt 按 delivery 逐条记，可现实里一条回复常常同时答掉对方连发的 2-3 条 @。
// 只有 count + oldest 时，「中间欠的是哪几条」无从得知——已经处理过的 @ 于是被一遍遍重放，
// 收到的人还得先花时间辨认「这是新消息还是重放」。缺口在查询侧（欠哪几条）和操作侧（一次清几条）。
import { describe, expect, it } from "vitest";
import { api, createChannel, seedToken, uniq } from "./helpers";

function send(slug: string, token: string, body: string, mentions: string[] = [], extra: Record<string, unknown> = {}) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "message", body, mentions, reply_to: null, ...extra }),
  });
}

// 让 bot 在频道里有 presence 行（未报到的身份不出现在 presence 快照里，也就无处挂债务）。
function checkIn(slug: string, token: string) {
  return api(`/api/channels/${slug}/messages`, token, {
    method: "POST",
    body: JSON.stringify({ kind: "status", state: "waiting", note: "standby", mentions: [] }),
  });
}

async function seqOf(res: Response): Promise<number> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { seq: number }).seq;
}

async function presenceOf(slug: string, token: string, name: string): Promise<Record<string, unknown>> {
  const res = await api(`/api/channels/${slug}/presence`, token);
  expect(res.status).toBe(200);
  const { presence } = (await res.json()) as { presence: Record<string, unknown>[] };
  const entry = presence.find((p) => p.name === name);
  expect(entry).toBeDefined();
  return entry!;
}

describe("#818 presence 报得出「当前欠哪几条 seq」", () => {
  it("pending_mention_seqs 列出全部未清的 @，不只是最老那条", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("debt-bot"));
    const slug = await createChannel(sender.token);
    await checkIn(slug, bot.token);

    const first = await seqOf(await send(slug, sender.token, `@${bot.name} 主线问题`, [bot.name]));
    const second = await seqOf(await send(slug, sender.token, `@${bot.name} 补充一句`, [bot.name]));
    const third = await seqOf(await send(slug, sender.token, `@${bot.name} 再补一句`, [bot.name]));

    const entry = await presenceOf(slug, sender.token, bot.name);
    expect(entry.unhandled_mention_count).toBe(3);
    expect(entry.oldest_unhandled_mention_seq).toBe(first);
    // 有了完整列表，agent 才能精确 ack；只给 count+oldest 时中间的 second 查不到。
    expect(entry.pending_mention_seqs).toEqual([first, second, third]);
  });

  it("没有欠账时不下发这个字段（不给调用方一个恒空数组去判空）", async () => {
    const sender = await seedToken("agent");
    const slug = await createChannel(sender.token);
    await checkIn(slug, sender.token);
    await send(slug, sender.token, "no mentions here");

    const entry = await presenceOf(slug, sender.token, sender.name);
    expect(entry.pending_mention_seqs).toBeUndefined();
  });
});

describe("#818 一条回复可以同时了结多条 @", () => {
  it("also_resolves 清掉 reply_to 之外的那几条，它们不再重放", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("multi-ack-bot"));
    const slug = await createChannel(sender.token);
    await checkIn(slug, bot.token);

    const main = await seqOf(await send(slug, sender.token, `@${bot.name} 主线`, [bot.name]));
    const extra = await seqOf(await send(slug, sender.token, `@${bot.name} 补充`, [bot.name]));
    const unrelated = await seqOf(await send(slug, sender.token, `@${bot.name} 另一件事`, [bot.name]));

    expect((await presenceOf(slug, sender.token, bot.name)).pending_mention_seqs).toEqual([main, extra, unrelated]);

    // 一条回复同时答掉 main 和 extra：reply_to 仍是 main（线程锚点），extra 走 also_resolves。
    expect(
      (await send(slug, bot.token, "一起回了", [], { reply_to: main, also_resolves: [extra] })).status,
    ).toBe(200);

    const after = await presenceOf(slug, sender.token, bot.name);
    // 没被提到的那条仍然欠着——also_resolves 只清列出来的，不是"清空所有债务"。
    expect(after.unhandled_mention_count).toBe(1);
    expect(after.pending_mention_seqs).toEqual([unrelated]);
  });

  it("without also_resolves the second @ stays owed — the behaviour this issue is about", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("single-ack-bot"));
    const slug = await createChannel(sender.token);
    await checkIn(slug, bot.token);

    const main = await seqOf(await send(slug, sender.token, `@${bot.name} 主线`, [bot.name]));
    const extra = await seqOf(await send(slug, sender.token, `@${bot.name} 补充`, [bot.name]));

    expect((await send(slug, bot.token, "只回了主线", [], { reply_to: main })).status).toBe(200);

    const after = await presenceOf(slug, sender.token, bot.name);
    expect(after.unhandled_mention_count).toBe(1);
    expect(after.pending_mention_seqs).toEqual([extra]);
  });

  it("和 reply_to 重复的 seq 不算额外一条，重复项去重", async () => {
    const sender = await seedToken("agent");
    const bot = await seedToken("agent", uniq("dedupe-bot"));
    const slug = await createChannel(sender.token);
    await checkIn(slug, bot.token);

    const main = await seqOf(await send(slug, sender.token, `@${bot.name} 主线`, [bot.name]));
    const extra = await seqOf(await send(slug, sender.token, `@${bot.name} 补充`, [bot.name]));

    expect(
      (await send(slug, bot.token, "回", [], { reply_to: main, also_resolves: [main, extra, extra] })).status,
    ).toBe(200);

    const after = await presenceOf(slug, sender.token, bot.name);
    expect(after.unhandled_mention_count ?? 0).toBe(0);
  });

  it("非法/超量 also_resolves 整条拒发，不静默忽略", async () => {
    const sender = await seedToken("agent");
    const slug = await createChannel(sender.token);

    expect((await send(slug, sender.token, "x", [], { also_resolves: [0] })).status).toBe(400);
    expect((await send(slug, sender.token, "x", [], { also_resolves: ["3"] })).status).toBe(400);
    expect((await send(slug, sender.token, "x", [], { also_resolves: 3 })).status).toBe(400);
    // 上限 20：别让一条消息把整个接待债务一次清空。
    expect(
      (await send(slug, sender.token, "x", [], { also_resolves: Array.from({ length: 21 }, (_, i) => i + 1) })).status,
    ).toBe(400);
  });
});
