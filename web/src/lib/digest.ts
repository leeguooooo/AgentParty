import type { MsgFrame } from "@agentparty/shared";

const ISSUE_RE = /(^|[\s(])#[1-9]\d*\b/;
const RELEASE_RE = /\bv\d+\.\d+\.\d+\b|\b(release|released|deploy|deployed|shipped|landed)\b/i;
const QUESTION_RE = /[?？]|\b(blocked|unknown|unclear|open question)\b/i;

export interface CatchupItem {
  seq: number;
  kind: "mention" | "handled" | "blocked" | "done" | "release" | "issue" | "question" | "reply";
  attention: boolean;
  text: string;
}

export interface CatchupDigest {
  messages: number;
  mentions: number;
  openMentions: number;
  respondedMentions: number;
  statuses: number;
  blocked: number;
  done: number;
  replies: number;
  releases: number;
  issues: number;
  questions: number;
  items: CatchupItem[];
  attentionItems: CatchupItem[];
  updateItems: CatchupItem[];
  attentionCount: number;
  updateCount: number;
}

export function catchupKey(slug: string, self: string): string {
  return `ap_seen:v1:${slug}:${self}`;
}

export function compactDigestText(msg: MsgFrame): string {
  const raw = msg.kind === "status" ? (msg.note ?? msg.body) : msg.body;
  const normalized = raw.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? normalized.slice(0, 117) + "..." : normalized;
}

function hasResponse(messages: MsgFrame[], mention: MsgFrame, viewer: string): boolean {
  return messages.some(
    (candidate) =>
      candidate.seq > mention.seq &&
      candidate.sender.name === viewer &&
      (candidate.reply_to === mention.seq || candidate.status?.summary_seq === mention.seq),
  );
}

export function summarizeCatchup(messages: MsgFrame[], self: string, seenSeq: number): CatchupDigest {
  const fresh = messages.filter((m) => m.seq > seenSeq);
  const items: CatchupItem[] = [];
  let mentions = 0;
  let respondedMentions = 0;
  let statuses = 0;
  let blocked = 0;
  let done = 0;
  let replies = 0;
  let releases = 0;
  let issues = 0;
  let questions = 0;

  for (const msg of fresh) {
    const text = compactDigestText(msg);
    const mentioned = msg.mentions.includes(self);
    const responded = mentioned && hasResponse(messages, msg, self);
    const release = RELEASE_RE.test(text);
    // A shipped release that references its PR is one update, not both a release and an open issue.
    const issue = !release && ISSUE_RE.test(text);
    // Only another participant's ordinary message can create an open-question action.
    // Self-authored notes and blocked statuses already have their own, less ambiguous categories.
    const question = msg.sender.name !== self && msg.kind === "message" && QUESTION_RE.test(text);
    if (mentioned) mentions++;
    if (responded) respondedMentions++;
    if (msg.kind === "status") statuses++;
    if (msg.state === "blocked") blocked++;
    if (msg.state === "done") done++;
    if (msg.reply_to !== null) replies++;
    if (release) releases++;
    if (issue) issues++;
    if (question) questions++;

    let kind: CatchupItem["kind"] | null = null;
    if (mentioned) kind = responded ? "handled" : "mention";
    else if (msg.state === "blocked") kind = "blocked";
    else if (question) kind = "question";
    else if (release) kind = "release";
    else if (issue) kind = "issue";
    else if (msg.state === "done") kind = "done";
    else if (msg.reply_to !== null) kind = "reply";
    if (kind !== null && text !== "") {
      items.push({
        seq: msg.seq,
        kind,
        attention: kind === "mention" || kind === "blocked" || kind === "question",
        text,
      });
    }
  }

  const allAttentionItems = items.filter((item) => item.attention);
  const allUpdateItems = items.filter((item) => !item.attention);
  const attentionItems = allAttentionItems.slice(-4).reverse();
  const updateItems = allUpdateItems.slice(-4).reverse();
  return {
    messages: fresh.length,
    mentions,
    openMentions: Math.max(0, mentions - respondedMentions),
    respondedMentions,
    statuses,
    blocked,
    done,
    replies,
    releases,
    issues,
    questions,
    items: [...attentionItems, ...updateItems].slice(0, 6),
    attentionItems,
    updateItems,
    attentionCount: allAttentionItems.length,
    updateCount: allUpdateItems.length,
  };
}
