// `party ack --drain`（#958）：一次把游标之后**全部** @ 我的消息读出来并推进游标。
//
// 存在的理由：codex Stop hook 每轮只推进一条最老的 @（逐条推进本身是对的——不漏消息），
// 积压 9 条时刚被 @ 的那条要等 8 个回合才浮出来，用户观感与「坏了」无法区分。注入提示里
// 现在会说出「第 1/9 条」并指向这条命令；这里就是那个口子：列出全部、正文照打、游标推到
// 最后一条——之后的 Stop 事件不会再逐条把它们翻出来。
//
// 信号源与 hook 同一个端点（`next-mention`）：服务端按 bearer 身份过滤，本地不需要再猜
// 「哪条是 @ 我的」。新服务端一次回整个列表；老服务端只回队首，就逐条问下去（有界）。
// 正文仍旧逐条走 /messages 拉——列表端点一个字的正文都不回，「频道是唯一数据源」不破。
import type { MsgFrame } from "@agentparty/shared";
import type { NextMention } from "./rest";

/** 一次最多列多少条。与服务端 NEXT_MENTION_SCAN_LIMIT 同阶；超过就分两次跑，提示里会说。 */
export const DRAIN_MENTIONS_CAP = 200;

export interface DrainMentionsSource {
  /** 「> since 的 @ 我的消息」——新服务端带全表，老服务端只带队首。 */
  nextMention: (since: number) => Promise<NextMention | null>;
}

export interface PendingMentionSeqs {
  /** 升序、去重、全部 > since。 */
  seqs: number[];
  /** 列表只是下限（服务端窗口打满 / 本地 cap 打满）。 */
  truncated: boolean;
}

/**
 * 收齐游标之后全部 @ 我的 seq。
 *
 * 新服务端：一次问询拿到整张表。老服务端（`seqs` 为 null）：以上一条为 since 逐条问下去，
 * 直到 null 或打到 cap。两条路径的结果形状一致，调用方不必知道服务端新旧。
 */
export async function collectPendingMentionSeqs(
  source: DrainMentionsSource,
  since: number,
  cap: number = DRAIN_MENTIONS_CAP,
): Promise<PendingMentionSeqs> {
  const first = await source.nextMention(since);
  if (first === null) return { seqs: [], truncated: false };
  if (first.seqs !== null) {
    const seqs = dedupeAscending(first.seqs.filter((seq) => seq > since));
    return seqs.length > cap
      ? { seqs: seqs.slice(0, cap), truncated: true }
      : { seqs, truncated: first.truncated };
  }
  const seqs: number[] = [first.seq];
  while (seqs.length < cap) {
    const last = seqs[seqs.length - 1]!;
    const next = await source.nextMention(last);
    // 服务端契约是「> since」；回了个不前进的 seq 就当到头，绝不死循环。
    if (next === null || next.seq <= last) return { seqs, truncated: false };
    seqs.push(next.seq);
  }
  // 打到 cap 还没见到 null：后面可能还有。
  return { seqs, truncated: (await source.nextMention(seqs[seqs.length - 1]!)) !== null };
}

function dedupeAscending(seqs: readonly number[]): number[] {
  const sorted = [...seqs].sort((a, b) => a - b);
  return sorted.filter((seq, index) => index === 0 || seq !== sorted[index - 1]);
}

/** 排空输出的头一行：几条、从哪个游标之后算起、列表是不是下限。 */
export function formatDrainHeader(channel: string, cursor: number, pending: PendingMentionSeqs): string {
  const count = `${pending.seqs.length}${pending.truncated ? "+" : ""}`;
  return `#${channel}: ${count} pending @ for you after seq=${cursor} (oldest first)`;
}

/** 单条正文拉不到（撤回/擦除/权限）时的占位行——序号照报，不许静默跳过。 */
export function formatDrainMissing(channel: string, seq: number): string {
  return `[seq ${seq}] body unavailable — read it with: party history ${channel} --seq ${seq}`;
}

/** 排空结束的总结行：列了几条、游标推到哪、还剩没剩。 */
export function formatDrainSummary(
  channel: string,
  pending: PendingMentionSeqs,
  cursor: number,
): string {
  const first = pending.seqs[0]!;
  const last = pending.seqs[pending.seqs.length - 1]!;
  const range = first === last ? `seq ${first}` : `seq ${first}…${last}`;
  const more = pending.truncated ? `; more may remain — run \`party ack --drain --channel ${channel}\` again` : "";
  return `drained #${channel}: listed ${pending.seqs.length} @ (${range}), cursor advanced to seq=${cursor}${more}`;
}

/** 按 seq 精确取一条：/messages 的 since 是「> since」，所以 since=seq-1、limit=1 再核对 seq。 */
export function pickMessage(frames: readonly MsgFrame[], seq: number): MsgFrame | null {
  return frames.find((frame) => frame.seq === seq) ?? null;
}
