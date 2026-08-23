// 人类拍板 → 决策账本（#929）。
//
// 背景：`party decision ask → owner 点「批准」→ 写入 active_decisions` 这条链一直是断的。
// owner 在 UI 上点完批准，产物只是一条消息；下游 worker 想核验「这件事到底批没批」，除了读历史
// + 相信别人的转述之外别无选择——而这正是 #834 第 1 项那次事故的根源。
//
// 这里补上缺的那一段：人类把一条 decision_request 拍成 resolved 时，**额外**往
// channel_decisions 落一行，让「owner 拍过板的事」成为可查询字段。
//
// ⚠️ 安全不变量：批准一条 decision_request **绝不能**变成一张授权凭据。
// 否则任何 agent 都能构造一条 topic 长得像 `authz:*` 的请求，owner 随手一点就签发了总授权——
// 那是把 #834 第 1 项的口子换个地方重开，比现状更糟。
//
// 隔离手段是**结构性**的而不是检查性的：本文件产出的 topic 一律以 DECISION_ASK_TOPIC_PREFIX
// (`ask:`) 开头，prompt 原文整段作为后缀。因此 topic 永远不可能落在 `authz:` 命名空间里，
// 哪怕请求方把 prompt 写成 `AUTHZ: spend diamonds`（大小写 / 前后空白各种变体同理）。
//
// 这里**刻意只有这一道闸**：没有额外的「检测到 authz 前缀就拒绝」分支。两道互相兜底的闸会让
// 变异测试假阴性——去掉其中一道，反向用例照样绿（#884）。前缀拼接是唯一决定结果的那一步，
// 去掉它，reverse 用例必须立刻转红。
//
// 授权凭据只能由 owner/host 显式跑 `party authz grant` 产生——那是一次留痕的主动动作，
// 不是在别人写好的提示上点一下「批准」。
import {
  CHANNEL_DECISION_SUMMARY_LIMIT,
  CHANNEL_DECISION_TOPIC_LIMIT,
  DECISION_ASK_TOPIC_PREFIX,
} from "@agentparty/shared";

// 自动落账的 topic 命名空间（字面量在 shared，与 AUTHZ_TOPIC_PREFIX 并排）。`ask:` 既标明出处
// （这条结论来自一次被批准的 decision_request，而不是 owner 主动记的权威结论），又把它挡在
// AUTHZ_TOPIC_PREFIX 之外。
export { DECISION_ASK_TOPIC_PREFIX };

const textEncoder = new TextEncoder();

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** 按字节上限截断，且不切断 UTF-8 码点（topic/summary 都是字节计长的单行字段）。 */
function truncateToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  let out = "";
  let used = 0;
  for (const ch of value) {
    const size = byteLength(ch);
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/**
 * prompt 是自由文本（服务端只校验长度），账本 topic 是单行且禁控制字符的字段。
 * 控制字符一律折成空格，连续空白折成一个空格。
 */
function flattenPrompt(prompt: string): string {
  return prompt
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/**
 * decision_request 的 prompt → 账本 topic。
 *
 * 返回值恒以 DECISION_ASK_TOPIC_PREFIX 开头，这是本切片唯一的命名空间隔离手段（见文件头）。
 */
export function decisionAskLedgerTopic(prompt: string): string {
  const room = CHANNEL_DECISION_TOPIC_LIMIT - byteLength(DECISION_ASK_TOPIC_PREFIX);
  return `${DECISION_ASK_TOPIC_PREFIX}${truncateToBytes(flattenPrompt(prompt), room)}`;
}

export interface DecisionLedgerSummaryInput {
  kind: "approval" | "choice";
  chosenIndex: number;
  chosenOption: string;
  responder: string;
  seq: number;
  reason?: string;
}

/** 账本 summary：谁、在第几条上、拍成了什么。措辞对 approval 明确写 approved/rejected。 */
export function decisionAskLedgerSummary(input: DecisionLedgerSummaryInput): string {
  const verb =
    input.kind === "approval"
      ? input.chosenIndex === 0
        ? "approved"
        : "rejected"
      : `chose "${input.chosenOption}"`;
  const reason = input.reason === undefined || input.reason.trim() === "" ? "" : `: ${input.reason.trim()}`;
  const text = `${verb} by ${input.responder} on decision request #${input.seq}${reason}`;
  return truncateToBytes(flattenPrompt(text), CHANNEL_DECISION_SUMMARY_LIMIT);
}

export type DecisionLedgerSkipReason =
  | "already_recorded"
  | "ledger_full"
  | "conflict"
  | "archived"
  | "write_failed";

export interface DecisionLedgerWriteResult {
  recorded: boolean;
  id: string | null;
  topic: string;
  reason?: DecisionLedgerSkipReason;
}

export interface DecisionLedgerWriteInput {
  slug: string;
  seq: number;
  topic: string;
  summary: string;
  createdBy: string;
  createdByKind: "agent" | "human";
  createdAt: number;
}

/**
 * 往 channel_decisions 落一行「owner 拍过板」的记录。
 *
 * 与 `POST /api/channels/:slug/decisions` 共用同一张表、同一套 head 语义（DB 触发器兜底）：
 * - 同 topic 已有 active head → 显式 supersede，账本只增不改，不会因重复 prompt 卡 409；
 * - 同一条 source_seq 已落过账 → 幂等跳过（DO 对同一 responder 的重试会重放 200）。
 *
 * 决策消息本身此刻已经在 DO 里提交完毕，账本写失败**不能**反转那个成功结果——所以这里
 * 一律返回结构化结果而不是抛错。
 */
export async function writeDecisionLedgerEntry(
  db: D1Database,
  input: DecisionLedgerWriteInput,
): Promise<DecisionLedgerWriteResult> {
  const { slug, seq, topic, summary } = input;
  const existing = await db
    .prepare("SELECT id FROM channel_decisions WHERE channel_slug = ? AND source_seq = ? LIMIT 1")
    .bind(slug, seq)
    .first<{ id: string }>();
  if (existing !== null) {
    return { recorded: false, id: existing.id, topic, reason: "already_recorded" };
  }

  const head = await db
    .prepare("SELECT decision_id FROM channel_decision_heads WHERE channel_slug = ? AND topic = ? COLLATE NOCASE")
    .bind(slug, topic)
    .first<{ decision_id: string }>();
  const supersedesId = head === null ? null : head.decision_id;

  const id = `decision_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO channel_decisions (
             id, channel_slug, topic, summary, source_seq, supersedes_id,
             created_by, created_by_kind, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, slug, topic, summary, seq, supersedesId, input.createdBy, input.createdByKind, input.createdAt),
      supersedesId === null
        ? db
            .prepare("INSERT INTO channel_decision_heads (channel_slug, topic, decision_id) VALUES (?, ?, ?)")
            .bind(slug, topic, id)
        : db
            .prepare(
              `UPDATE channel_decision_heads
                  SET topic = ?, decision_id = ?
                WHERE channel_slug = ? AND topic = ? COLLATE NOCASE AND decision_id = ?`,
            )
            .bind(topic, id, slug, topic, supersedesId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/channel is archived/i.test(message)) return { recorded: false, id: null, topic, reason: "archived" };
    if (/active decision limit reached/i.test(message)) {
      return { recorded: false, id: null, topic, reason: "ledger_full" };
    }
    if (/active decision already exists|supersedes_id must reference|UNIQUE constraint/i.test(message)) {
      return { recorded: false, id: null, topic, reason: "conflict" };
    }
    return { recorded: false, id: null, topic, reason: "write_failed" };
  }
  return { recorded: true, id, topic };
}
