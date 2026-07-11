import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { WsClient, createChannel, seedToken } from "./helpers";

// #129: hello 首连补拉曾用单条无 LIMIT 查询把最多 1 万行一次性 toArray 序列化。
// 正确修法是分块（每页有界）而非砍 LIMIT——砍 LIMIT 会静默丢尾、破坏「首连即完整」契约。
// 这些用例把「> 一页」的频道喂给 since=0 的全新客户端，验证：
//   (1) 完整性：所有消息都补拉到，不在一页处被截断；
//   (2) 有界性：任何单条补拉查询返回的行数都 <= 一页，不再单次序列化上万行。

// 直接往 DO 的内建 SQLite 批量塞消息，绕开逐条 send 的往返（造 > 1000 行才够快）。
async function seedMessages(slug: string, count: number): Promise<void> {
  const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
  await runInDurableObject(stub, async (instance: ChannelDO) => {
    const sql = (instance as unknown as { ctx: { storage: { sql: SqlLike } } }).ctx.storage.sql;
    const now = Date.now();
    for (let seq = 1; seq <= count; seq++) {
      sql.exec(
        `INSERT INTO messages (seq, sender_name, sender_kind, kind, body, mentions_json, reply_to, ts)
         VALUES (?, ?, ?, 'message', ?, '[]', NULL, ?)`,
        seq,
        "seeder",
        "agent",
        `m${seq}`,
        now + seq,
      );
    }
  });
}

interface SqlLike {
  exec(query: string, ...args: unknown[]): { toArray(): Record<string, unknown>[] };
}

// 收集 since=0 补拉到的所有 msg 的 seq（收满 expected 条即停）。
async function collectBackfillSeqs(ws: WsClient, expected: number): Promise<number[]> {
  const seqs: number[] = [];
  while (seqs.length < expected) {
    const msg = await ws.nextOfType("msg", 8000);
    seqs.push(msg.seq);
  }
  return seqs;
}

describe("hello backfill chunking (#129)", () => {
  it("delivers ALL messages to a fresh since=0 client when the channel exceeds one page", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const total = 1500; // > 1000 一页，迫使至少两页续拉

    const reader = await WsClient.open(slug, token); // 先连一次让 onStart 建表
    await reader.nextOfType("welcome");
    await seedMessages(slug, total);
    reader.send({ type: "hello", since: 0 });

    const seqs = await collectBackfillSeqs(reader, total);
    reader.close();

    // 全量、无缺口、无重复：首连即完整
    expect(seqs.length).toBe(total);
    expect(new Set(seqs).size).toBe(total);
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(total);
  });

  it("bounds each backfill query to at most one page (no single 10k-row serialization)", async () => {
    const { token } = await seedToken("agent");
    const slug = await createChannel(token);
    const total = 1500;

    const reader = await WsClient.open(slug, token); // 先连一次让 onStart 建表
    await reader.nextOfType("welcome");
    await seedMessages(slug, total);

    const stub = env.CHANNELS.get(env.CHANNELS.idFromName(slug));
    // 给 DO 实例的 sql.exec 挂一个探针，记录任一「补拉查询」单次返回的最大行数。
    // 探针在同一 isolate 内持久存活，随后 WS hello 触发的查询都会经过它。
    await runInDurableObject(stub, async (instance: ChannelDO) => {
      const holder = instance as unknown as {
        ctx: { storage: { sql: SqlLike } };
        __maxBackfillBatch: number;
      };
      holder.__maxBackfillBatch = 0;
      const sql = holder.ctx.storage.sql;
      const realExec = sql.exec.bind(sql);
      sql.exec = ((query: string, ...args: unknown[]) => {
        if (/SELECT \* FROM messages/i.test(query) && /ORDER BY seq/i.test(query)) {
          const rows = realExec(query, ...args).toArray();
          if (rows.length > holder.__maxBackfillBatch) holder.__maxBackfillBatch = rows.length;
          return { toArray: () => rows };
        }
        return realExec(query, ...args);
      }) as SqlLike["exec"];
    });

    reader.send({ type: "hello", since: 0 });
    await collectBackfillSeqs(reader, total);
    reader.close();

    const maxBatch = await runInDurableObject(stub, async (instance: ChannelDO) => {
      return (instance as unknown as { __maxBackfillBatch: number }).__maxBackfillBatch;
    });
    // 每页有界：单次查询绝不返回超过一页（1000）行。
    expect(maxBatch).toBeGreaterThan(0);
    expect(maxBatch).toBeLessThanOrEqual(1000);
  });
});
