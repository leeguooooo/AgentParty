// Claude 收件箱回执（#1130）的展示口径。纯函数，供 MessageStatus 渲染与单测。
//
// 回执挂在**发信人自己的那条 @ 消息**上：目标的 Claude 会话把唤醒扣在待审队列里（held）、批准后进了
// 对话（delivered）、或根本没送达（expired / refused / dropped / denied）。它只解释「为什么还没动静」，
// 从不代表对方读了或回了——所以这里没有任何一个状态会被渲染成「已送达 / 已读」的绿色终态，
// `accepted`（没有回执）更是根本进不来（normalizeInboxReceipts 丢弃未知状态）。
import {
  inboxReceiptFor,
  inboxReceiptNotDelivered,
  normalizeInboxReceipts,
  type InboxReceiptState,
} from "@agentparty/shared";

export type InboxReceiptTone = "held" | "not_delivered" | "delivered" | "unknown";

export interface InboxReceiptRow {
  target: string;
  state: InboxReceiptState;
  tone: InboxReceiptTone;
  /** 接收端给的原因（对方可控文本，已压成一行、限长）；没有为 null。 */
  reason: string | null;
  /** 上报者不是目标自己时给出（serve 代投的那条腿）；否则 null。 */
  reportedBy: string | null;
  at: number;
  /** 目标已经回复了这条 @：回执只剩历史意义，不再计入「需处理」。 */
  settled: boolean;
}

export function inboxReceiptTone(state: InboxReceiptState): InboxReceiptTone {
  if (state === "held") return "held";
  if (state === "delivered") return "delivered";
  if (inboxReceiptNotDelivered(state)) return "not_delivered";
  return "unknown";
}

/** 每个目标一行（目标自己报的优先）；顺序跟随首次出现。input 是帧上的原始字段，宽容解析。 */
export function inboxReceiptRows(input: unknown, repliedTargets: ReadonlySet<string> = new Set()): InboxReceiptRow[] {
  const receipts = normalizeInboxReceipts(input);
  const rows: InboxReceiptRow[] = [];
  for (const target of new Set(receipts.map((receipt) => receipt.target))) {
    const receipt = inboxReceiptFor(receipts, target);
    if (receipt === null) continue;
    rows.push({
      target,
      state: receipt.state,
      tone: inboxReceiptTone(receipt.state),
      reason: receipt.reason ?? null,
      reportedBy: receipt.reported_by.name === target ? null : receipt.reported_by.name,
      at: receipt.ts,
      settled: repliedTargets.has(target),
    });
  }
  return rows;
}

/** 摘要行用的计数：只数目标还没回复的。 */
export function inboxReceiptCounts(rows: readonly InboxReceiptRow[]): { held: number; notDelivered: number } {
  let held = 0;
  let notDelivered = 0;
  for (const row of rows) {
    if (row.settled) continue;
    if (row.tone === "held") held += 1;
    else if (row.tone === "not_delivered") notDelivered += 1;
  }
  return { held, notDelivered };
}
