// @ 提及候选（issue #39）：把 participants（WS 连着）∪ presence（含 wake 信息）合成一个
// 分档的候选列表，供 Composer 的 @ 补全下拉用。"可 @" ≠ "在线连接"——本产品最特别的一档是
// 「可唤醒」：人不在但 @ 了会被 serve/watch/webhook 拉起来。
import type { PresenceEntry, Sender, WakeKind } from "@agentparty/shared";

export type MentionTier = "online" | "wakeable" | "recent";

export interface MentionCandidate {
  name: string;
  kind: "agent" | "human";
  tier: MentionTier;
}

const WAKEABLE: readonly WakeKind[] = ["serve", "watch", "webhook"];
const STALE_MS = 60_000; // 与 PRESENCE_TIMEOUT_MS 一致：超过即算 recent 而非在线/可唤醒

// 档位：① 在线（当前有 WS 连接） ② 可唤醒（presence 声明了 serve/watch/webhook 且不 stale）
// ③ 最近活跃（其余 presence）。同名取更高档。
function tierFor(
  name: string,
  online: Set<string>,
  presence: Record<string, PresenceEntry>,
  now: number,
): MentionTier {
  if (online.has(name)) return "online";
  const p = presence[name];
  if (p) {
    const seen = p.last_seen ?? p.ts ?? 0;
    const fresh = now - seen < STALE_MS;
    const kind = p.wake?.kind;
    if (fresh && kind !== undefined && WAKEABLE.includes(kind)) return "wakeable";
  }
  return "recent";
}

// self 从候选里剔掉（@ 自己没意义）。档内按名字排序，档间 online > wakeable > recent。
export function mentionCandidates(
  participants: Sender[],
  presence: Record<string, PresenceEntry>,
  self: string | null,
  now: number,
): MentionCandidate[] {
  const online = new Set(participants.map((p) => p.name));
  const kindOf = new Map<string, "agent" | "human">();
  for (const p of participants) kindOf.set(p.name, p.kind);
  for (const [name, p] of Object.entries(presence)) {
    if (!kindOf.has(name)) kindOf.set(name, p.status?.owner ? "agent" : "agent");
  }

  const names = new Set<string>([...online, ...Object.keys(presence)]);
  const rank: Record<MentionTier, number> = { online: 0, wakeable: 1, recent: 2 };
  return [...names]
    .filter((name) => name !== self && name !== "system")
    .map((name) => ({ name, kind: kindOf.get(name) ?? "agent", tier: tierFor(name, online, presence, now) }))
    .sort((a, b) => rank[a.tier] - rank[b.tier] || a.name.localeCompare(b.name));
}

// Composer 用：光标前若正在打 @<prefix>，返回 { start, query }；否则 null。
// prefix 允许 [a-zA-Z0-9._-]（与 name 字符集一致），@ 前须是行首或空白（不匹配 email 里的 @）。
export function activeMentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && /[a-zA-Z0-9._-]/.test(text[i]!)) i--;
  if (i < 0 || text[i] !== "@") return null;
  if (i > 0 && !/\s/.test(text[i - 1]!)) return null; // @ 前不是空白/行首 → 是 email 之类，不触发
  return { start: i, query: text.slice(i + 1, caret) };
}

export function filterCandidates(cands: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const q = query.toLowerCase();
  if (q === "") return cands.slice(0, limit);
  // 前缀命中优先，其次子串命中
  const pref: MentionCandidate[] = [];
  const sub: MentionCandidate[] = [];
  for (const c of cands) {
    const n = c.name.toLowerCase();
    if (n.startsWith(q)) pref.push(c);
    else if (n.includes(q)) sub.push(c);
  }
  return [...pref, ...sub].slice(0, limit);
}
