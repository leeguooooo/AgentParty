// #125：rev_seq 必须来自单调计数器，绝不能从 MAX(rev_seq) 派生。
//
// 修剪按 seq 删行（DELETE FROM messages WHERE seq <= cutoff）。一条【旧】消息若被【近期】
// 编辑/撤回过，它的 seq 很小、rev_seq 却很大。删掉这一行，MAX(rev_seq) 就回退，
// 下一个修订复用一个已经广播过的号。
//
// 后果：离线客户端带着 since_rev = R 回来补拉，服务端按 rev_seq > since_rev 过滤，
// 新修订的号 <= R → 永久漏收。retract 的设计场景正是撤回误发的密钥——漏收就是撤不掉。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, postMessage, seedToken, uniq, WsClient } from "./helpers";

/** 直接读 DO 里的 messages 表，拿当前最大 rev_seq（模拟修复前 lastRevSeq 的做法）。 */
async function maxRevSeqInTable(slug: string): Promise<number> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  return runInDurableObject(stub, async (_i: ChannelDO, state) => {
    const row = state.storage.sql.exec("SELECT COALESCE(MAX(rev_seq), 0) AS m FROM messages").one();
    return Number(row.m);
  });
}

/** 精确模拟修剪：删掉持有最大 rev_seq 的那一行（它的 seq 很小，会先被修剪掉）。 */
async function deleteRowHoldingMaxRev(slug: string): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (_i: ChannelDO, state) => {
    state.storage.sql.exec(
      "DELETE FROM messages WHERE seq = (SELECT seq FROM messages WHERE rev_seq = (SELECT MAX(rev_seq) FROM messages))",
    );
  });
}

async function welcomeRevSeq(slug: string, token: string): Promise<number> {
  const ws = await WsClient.open(slug, token);
  const welcome = (await ws.nextOfType("welcome")) as { last_rev_seq?: number };
  ws.close();
  return welcome.last_rev_seq ?? 0;
}

describe("rev_seq monotonic counter (#125)", () => {
  it("never reuses a revision number after the row holding MAX(rev_seq) is pruned away", async () => {
    const author = await seedToken("human", uniq("a"));
    const slug = await createChannel(author.token);

    // 一条【旧】消息（低 seq），随后再发几条把它推成"旧"的
    const oldMsg = (await (await postMessage(slug, author.token, "old message")).json()) as { seq: number };
    for (let i = 0; i < 3; i++) expect((await postMessage(slug, author.token, `filler-${i}`)).status).toBe(200);

    // 近期编辑这条旧消息 → 它拿到当前最大的 rev_seq，但 seq 仍然最小
    const edited = await api(`/api/channels/${slug}/messages/${oldMsg.seq}/edit`, author.token, {
      method: "POST",
      body: JSON.stringify({ body: "edited late" }),
    });
    expect(edited.status).toBe(200);

    const revBefore = await maxRevSeqInTable(slug);
    expect(revBefore).toBeGreaterThan(0);
    // 离线客户端此刻记下的水位
    const clientSinceRev = await welcomeRevSeq(slug, author.token);
    expect(clientSinceRev).toBe(revBefore);

    // 修剪把这条低 seq 的行删掉 → 表里的 MAX(rev_seq) 回退
    await deleteRowHoldingMaxRev(slug);
    expect(await maxRevSeqInTable(slug)).toBeLessThan(revBefore);

    // 现在做一次新的修订（撤回另一条消息）
    const victim = (await (await postMessage(slug, author.token, "secret to retract")).json()) as { seq: number };
    const retracted = await api(`/api/channels/${slug}/messages/${victim.seq}/retract`, author.token, {
      method: "POST",
    });
    expect(retracted.status).toBe(200);

    // 关键断言：新修订号必须严格大于离线客户端记下的水位，否则它补拉时会被
    // rev_seq > since_rev 过滤掉——撤回永远送不到。
    const newRev = await maxRevSeqInTable(slug);
    expect(newRev).toBeGreaterThan(clientSinceRev);
  }, 30_000);

  it("welcome.last_rev_seq never goes backwards even after pruning", async () => {
    const author = await seedToken("human", uniq("a"));
    const slug = await createChannel(author.token);

    const m = (await (await postMessage(slug, author.token, "m")).json()) as { seq: number };
    expect((await api(`/api/channels/${slug}/messages/${m.seq}/edit`, author.token, {
      method: "POST",
      body: JSON.stringify({ body: "e1" }),
    })).status).toBe(200);

    const before = await welcomeRevSeq(slug, author.token);
    await deleteRowHoldingMaxRev(slug);
    const after = await welcomeRevSeq(slug, author.token);

    // 修复前：welcome 报的水位会随 MAX 一起回退，客户端据此重连就会漏拉
    expect(after).toBeGreaterThanOrEqual(before);
  }, 30_000);

  it("revision numbers stay strictly increasing across edit / retract", async () => {
    const author = await seedToken("human", uniq("a"));
    const slug = await createChannel(author.token);

    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const msg = (await (await postMessage(slug, author.token, `m${i}`)).json()) as { seq: number };
      await api(`/api/channels/${slug}/messages/${msg.seq}/edit`, author.token, {
        method: "POST",
        body: JSON.stringify({ body: `e${i}` }),
      });
      seen.push(await maxRevSeqInTable(slug));
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  }, 30_000);
});
