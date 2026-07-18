// #626：seq 必须来自单调计数器，绝不能从 MAX(seq) 派生（与 #125 的 rev_seq 同源问题）。
//
// 保留期修剪按 ts 删行（DELETE FROM messages WHERE ts <= cutoff），没有「保留最后 N 条」下限。
// 一个配了 message_retention_ms 的频道久静默后会把整张表清空；此时 MAX(seq) 塌回 0，下条消息
// 从 seq=1 重启、复用已被在线端消费过的号。recordSeen 因老 read_cursor 已 >= 复用 seq 而不推进，
// 流式消费端（serve/watch/web）按 seq > cursor 过滤 → 新 @ 帧被当积压丢掉，永久漏收唤醒。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

/** 精确模拟保留期把整张表清空（久静默频道会被 pruneRetainedContent 清到空）。 */
async function drainMessages(slug: string): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_i: ChannelDO, state) => {
    state.storage.sql.exec("DELETE FROM messages");
  });
}

async function tableMaxSeq(slug: string): Promise<number> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_i: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM messages").one();
    return Number(row.m);
  });
}

async function welcomeLastSeq(slug: string, token: string): Promise<number> {
  const ws = await WsClient.open(slug, token);
  const welcome = (await ws.nextOfType("welcome")) as { last_seq?: number };
  ws.close();
  return welcome.last_seq ?? 0;
}

describe("seq monotonic counter (#626)", () => {
  it("never reuses a seq after retention drains the whole messages table", async () => {
    const author = await seedToken("human", uniq("a"));
    const slug = await createChannel(author.token);

    let lastSeq = 0;
    for (let i = 0; i < 4; i++) {
      const m = (await (await postMessage(slug, author.token, `m${i}`)).json()) as { seq: number };
      lastSeq = m.seq;
    }
    expect(lastSeq).toBeGreaterThanOrEqual(4);

    await drainMessages(slug);
    expect(await tableMaxSeq(slug)).toBe(0); // 表已空——修复前 MAX(seq) 会塌回 0

    // 清空后再发一条：修复前复用 seq=1，修复后必须严格大于已消费过的 lastSeq。
    const next = (await (await postMessage(slug, author.token, "after drain")).json()) as { seq: number };
    expect(next.seq).toBeGreaterThan(lastSeq);
  }, 30_000);

  it("welcome.last_seq never goes backwards even after the table is drained", async () => {
    const author = await seedToken("human", uniq("a"));
    const slug = await createChannel(author.token);
    for (let i = 0; i < 3; i++) expect((await postMessage(slug, author.token, `m${i}`)).status).toBe(200);

    const before = await welcomeLastSeq(slug, author.token);
    expect(before).toBeGreaterThanOrEqual(3);

    await drainMessages(slug);
    const after = await welcomeLastSeq(slug, author.token);
    expect(after).toBeGreaterThanOrEqual(before); // 修复前会随 MAX 回退到 0
  }, 30_000);
});
