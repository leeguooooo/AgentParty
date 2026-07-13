// #128：三张表（wake_delivery_ledger / message_audit / read_cursor）修复前从不修剪，DO 存储只增不减。
// 直接调 DO 内部修剪方法验证——不灌 10000 条消息（真实 cutoff = seq - RETAIN_N，要到 seq≈10100 才动手），
// 手法同 rev-seq-counter.spec.ts / alarm-schedule.spec.ts：runInDurableObject 直接建表数据、跑修剪、查表。
import { MAX_READ_CURSORS } from "@agentparty/shared";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChannelDO } from "../src/do";
import { api, createChannel, seedToken, uniq } from "./helpers";

// 私有方法在测试里直接调；DO 单线程，直接操作 storage.sql 与 rev-seq 测试同一路数。
// 独立接口（不与 ChannelDO 交叉），否则 private 成员会把交叉类型塌成 never。
interface PrunableDO {
  pruneReferencedTables(cutoff: number): void;
  pruneReadCursors(): void;
}

function stubFor(slug: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(slug));
}

async function withDO<T>(slug: string, fn: (i: PrunableDO, sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(stubFor(slug), async (instance: ChannelDO, state) =>
    fn(instance as unknown as PrunableDO, state.storage.sql),
  );
}

async function freshChannel(): Promise<string> {
  const author = await seedToken("human", uniq("a"));
  const slug = await createChannel(author.token);
  // onStart（建表）只在 DO 收到第一个请求时跑；createChannel 只写 D1 没碰 DO。
  // 戳一个路由到 DO 的只读端点触发建表，且不留下任何消息（否则会污染 seq）。
  const res = await api(`/api/channels/${slug}/read-cursors`, author.token);
  if (res.status !== 200) throw new Error(`DO init failed: ${res.status}`);
  return slug;
}

function insertMessage(sql: SqlStorage, seq: number): void {
  sql.exec(
    "INSERT OR REPLACE INTO messages (seq, sender_name, sender_kind, kind, body, mentions_json, ts) VALUES (?, 'a', 'human', 'message', 'b', '[]', ?)",
    seq,
    Date.now(),
  );
}

function insertLedger(sql: SqlStorage, mentionSeq: number): void {
  sql.exec(
    `INSERT INTO wake_delivery_ledger
       (mention_seq, target_name, webhook_name, adapter_kind, attempt, result, http_status, error, attempted_at)
     VALUES (?, 't', 'w', 'webhook', 1, 'ok', 200, NULL, ?)`,
    mentionSeq,
    Date.now(),
  );
}

function insertAudit(sql: SqlStorage, targetSeq: number): void {
  sql.exec(
    `INSERT INTO message_audit (target_seq, action, actor_name, actor_kind, old_body, new_body, created_at)
     VALUES (?, 'edit', 'a', 'human', 'old', 'new', ?)`,
    targetSeq,
    Date.now(),
  );
}

function seqsIn(sql: SqlStorage, table: string, col: string): number[] {
  return sql
    .exec(`SELECT ${col} AS s FROM ${table} ORDER BY ${col}`)
    .toArray()
    .map((r) => Number(r.s));
}

describe("DO storage pruning (#128)", () => {
  it("prunes ledger/audit rows orphaned by message pruning, spares survivors and in-window rows", async () => {
    const slug = await freshChannel();
    await withDO(slug, (_i, sql) => {
      // messages 表模拟消息修剪后的状态：seq 1,2 已被 message 修剪删掉；
      // seq 3 是 pending_review 幸存者（低 seq 仍在表里）；seq 5 在保留窗口内。
      insertMessage(sql, 3);
      insertMessage(sql, 4);
      insertMessage(sql, 5);
      for (const s of [1, 2, 3, 5]) {
        insertLedger(sql, s);
        insertAudit(sql, s);
      }
    });

    // cutoff = 4：seq 1,2 是孤儿（<=4 且消息已不在）→ 删；seq 3 消息仍在（幸存者）→ 留；seq 5 > 4（窗口内）→ 留。
    await withDO(slug, (i) => i.pruneReferencedTables(4));

    await withDO(slug, (_i, sql) => {
      expect(seqsIn(sql, "wake_delivery_ledger", "mention_seq")).toEqual([3, 5]);
      expect(seqsIn(sql, "message_audit", "target_seq")).toEqual([3, 5]);
    });
  });

  it("pruneReferencedTables no-ops when cutoff <= 0 (early channel life)", async () => {
    const slug = await freshChannel();
    await withDO(slug, (_i, sql) => {
      insertLedger(sql, 1);
      insertAudit(sql, 1);
    });
    await withDO(slug, (i) => i.pruneReferencedTables(0));
    await withDO(slug, (_i, sql) => {
      expect(seqsIn(sql, "wake_delivery_ledger", "mention_seq")).toEqual([1]);
      expect(seqsIn(sql, "message_audit", "target_seq")).toEqual([1]);
    });
  });

  it("caps read_cursor to MAX_READ_CURSORS, evicting the least-recently-updated", async () => {
    const slug = await freshChannel();
    const overflow = 5;
    await withDO(slug, (_i, sql) => {
      // 造 MAX+overflow 行，updated_at = i 让顺序确定：i 越小越旧
      for (let i = 0; i < MAX_READ_CURSORS + overflow; i++) {
        sql.exec(
          "INSERT INTO read_cursor (name, kind, last_seen_seq, updated_at) VALUES (?, 'agent', 1, ?)",
          `reader-${String(i).padStart(4, "0")}`,
          i,
        );
      }
    });

    await withDO(slug, (i) => i.pruneReadCursors());

    await withDO(slug, (_i, sql) => {
      const total = Number(sql.exec("SELECT COUNT(*) AS n FROM read_cursor").one().n);
      expect(total).toBe(MAX_READ_CURSORS);
      // 最旧的 overflow 行（updated_at 0..overflow-1）被淘汰
      const oldestKept = Number(sql.exec("SELECT MIN(updated_at) AS m FROM read_cursor").one().m);
      expect(oldestKept).toBe(overflow);
    });
  });

  it("pruneReadCursors no-ops below the cap", async () => {
    const slug = await freshChannel();
    await withDO(slug, (_i, sql) => {
      for (let i = 0; i < 10; i++) {
        sql.exec(
          "INSERT INTO read_cursor (name, kind, last_seen_seq, updated_at) VALUES (?, 'human', 1, ?)",
          `r-${i}`,
          i,
        );
      }
    });
    await withDO(slug, (i) => i.pruneReadCursors());
    await withDO(slug, (_i, sql) => {
      expect(Number(sql.exec("SELECT COUNT(*) AS n FROM read_cursor").one().n)).toBe(10);
    });
  });
});
