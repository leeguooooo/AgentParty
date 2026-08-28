// #958：`party ack --drain` 的纯计算部分——收齐游标之后全部 @ 我的 seq，新老服务端两条路径同形。
import { describe, expect, test } from "bun:test";
import {
  collectPendingMentionSeqs,
  formatDrainHeader,
  formatDrainMissing,
  formatDrainSummary,
  pickMessage,
} from "../src/mention-drain";
import type { NextMention } from "../src/rest";

// 事故现场的队列：游标 1910，1923…1935 共 9 条。
const MENTIONS = [1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930, 1935];

/** 新服务端：一次回整张表。 */
function modern(since: number): NextMention | null {
  const seqs = MENTIONS.filter((seq) => seq > since);
  return seqs.length === 0 ? null : { seq: seqs[0]!, seqs, truncated: false };
}

/** 老服务端（#958 之前）：只回队首。 */
function legacy(since: number): NextMention | null {
  const seq = MENTIONS.find((value) => value > since);
  return seq === undefined ? null : { seq, seqs: null, truncated: false };
}

describe("collectPendingMentionSeqs（#958）", () => {
  test("新服务端：一次问询拿到全部 9 条，一条不漏、升序、不含游标之前的", async () => {
    const asked: number[] = [];
    const result = await collectPendingMentionSeqs({
      nextMention: async (since) => {
        asked.push(since);
        return modern(since);
      },
    }, 1910);
    expect(result).toEqual({ seqs: MENTIONS, truncated: false });
    expect(asked).toEqual([1910]);
  });

  test("老服务端只回队首：以上一条为 since 逐条问下去，结果与新服务端逐字相同", async () => {
    const asked: number[] = [];
    const result = await collectPendingMentionSeqs({
      nextMention: async (since) => {
        asked.push(since);
        return legacy(since);
      },
    }, 1910);
    expect(result).toEqual({ seqs: MENTIONS, truncated: false });
    // 9 条 + 最后一次问到 null 收尾。
    expect(asked).toEqual([1910, ...MENTIONS]);
  });

  test("游标已在最新：空列表，不多问", async () => {
    expect(await collectPendingMentionSeqs({ nextMention: async (since) => modern(since) }, 1935)).toEqual({
      seqs: [],
      truncated: false,
    });
  });

  test("服务端回的列表若混进 ≤ since 或重复的 seq，本地过滤掉（游标之前的绝不重放）", async () => {
    const result = await collectPendingMentionSeqs({
      nextMention: async () => ({ seq: 1905, seqs: [1905, 1923, 1923, 1935, 1924], truncated: false }),
    }, 1910);
    expect(result.seqs).toEqual([1923, 1924, 1935]);
  });

  test("cap：新服务端超过 cap 截断并标 truncated；老服务端打到 cap 时再探一次确认还有没有", async () => {
    const modernResult = await collectPendingMentionSeqs({ nextMention: async (since) => modern(since) }, 1910, 4);
    expect(modernResult).toEqual({ seqs: [1923, 1924, 1925, 1926], truncated: true });

    const legacyResult = await collectPendingMentionSeqs({ nextMention: async (since) => legacy(since) }, 1910, 4);
    expect(legacyResult).toEqual({ seqs: [1923, 1924, 1925, 1926], truncated: true });
    // 恰好 cap 条：探针回 null ⇒ 不算截断。
    const exact = await collectPendingMentionSeqs({ nextMention: async (since) => legacy(since) }, 1910, 9);
    expect(exact).toEqual({ seqs: MENTIONS, truncated: false });
  });

  test("老服务端回了个不前进的 seq → 立即收手，绝不死循环", async () => {
    let calls = 0;
    const result = await collectPendingMentionSeqs({
      nextMention: async () => {
        calls += 1;
        return { seq: 1923, seqs: null, truncated: false };
      },
    }, 1910);
    expect(result).toEqual({ seqs: [1923], truncated: false });
    expect(calls).toBe(2);
  });

  test("服务端说 truncated 就原样传出去（列表只是下限）", async () => {
    const result = await collectPendingMentionSeqs({
      nextMention: async () => ({ seq: 1923, seqs: MENTIONS, truncated: true }),
    }, 1910);
    expect(result.truncated).toBe(true);
  });
});

describe("drain 文案", () => {
  test("头行说几条、从哪个游标之后；下限用 N+", () => {
    expect(formatDrainHeader("pwtk", 1910, { seqs: MENTIONS, truncated: false })).toBe(
      "#pwtk: 9 pending @ for you after seq=1910 (oldest first)",
    );
    expect(formatDrainHeader("pwtk", 1910, { seqs: MENTIONS, truncated: true })).toContain("9+ pending @");
  });

  test("总结行给出范围、游标去向；截断时提示再跑一次", () => {
    const line = formatDrainSummary("pwtk", { seqs: MENTIONS, truncated: false }, 1935);
    expect(line).toBe("drained #pwtk: listed 9 @ (seq 1923…1935), cursor advanced to seq=1935");
    expect(formatDrainSummary("pwtk", { seqs: [1923], truncated: false }, 1923)).toContain("(seq 1923)");
    expect(formatDrainSummary("pwtk", { seqs: MENTIONS, truncated: true }, 1935)).toContain(
      "party ack --drain --channel pwtk",
    );
  });

  test("拉不到正文的 seq 有占位行，序号照报", () => {
    expect(formatDrainMissing("pwtk", 1927)).toContain("seq 1927");
    expect(formatDrainMissing("pwtk", 1927)).toContain("party history pwtk --seq 1927");
  });

  test("pickMessage 只认 seq 精确相等", () => {
    const frame = { seq: 1923 } as unknown as Parameters<typeof pickMessage>[0][number];
    expect(pickMessage([frame], 1923)).toBe(frame);
    expect(pickMessage([frame], 1924)).toBeNull();
  });
});
