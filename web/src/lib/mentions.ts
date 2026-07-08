// @ 提及候选（issue #39）：把 participants（WS 连着）∪ presence（含 wake 信息）合成一个
// 分档的候选列表，供 Composer 的 @ 补全下拉用。"可 @" ≠ "在线连接"——本产品最特别的一档是
// 「可唤醒」：人不在但 @ 了会被 serve/watch/webhook 拉起来。
import type { PresenceEntry, Sender, WakeKind } from "@agentparty/shared";

export type MentionTier = "online" | "wakeable" | "recent";

export interface MentionIdentity {
  name: string;
  display: string;
  kind?: "agent" | "human";
  account?: string;
}

export interface MentionCandidate {
  name: string; // @ 目标（token 名；人类网页会话是 UUID）
  display: string; // 可读名：人类优先显示账号 email，否则 name
  kind: "agent" | "human";
  tier: MentionTier;
  group: string; // UI 分组：账号 / 未归属
  account?: string; // 会话背后的账号（人类 = email）
  role?: string; // 协作角色/职责（host/worker/reviewer/observer），hover 显示
  note?: string; // 当前 status note，临时承载职责说明；长期应由结构化 channel role 提供
}

const WAKEABLE: readonly WakeKind[] = ["serve", "watch", "webhook"];
const STALE_MS = 60_000; // 与 PRESENCE_TIMEOUT_MS 一致：超过即算 recent 而非在线/可唤醒
// 幽灵清理：只为防止频道长期累积几个月前的一次性 agent。设得宽松——几天前聊过的 agent
// 仍是合理的 @/唤醒目标，不该被剔。真正的噪声（围观的人类会话）已由 kind/UUID 规则处理。
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 14 天没露面才视为幽灵
// 系统生成的人类会话名，永远不是有意义的 @ 目标：网页登录 token 默认名 = 纯 UUID；
// OIDC 设备验证流 = login-verify-*。过渡期旧 presence 行没回填 kind 时靠名字把它们判为 human。
const SYSTEM_HUMAN_SESSION_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|login-verify-.+)$/i;

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
// 只把「有意义的 @ 目标」纳入：agent 各档都留；human 只在当前在线时才留（围观的人、尤其是
// 只有 UUID 名的登录会话，不该冒进候选）；超过 1 天没露面的幽灵 presence 一律剔除。
export function mentionCandidates(
  participants: Sender[],
  presence: Record<string, PresenceEntry>,
  self: string | null,
  now: number,
  identities: MentionIdentity[] = [],
): MentionCandidate[] {
  const online = new Set(participants.map((p) => p.name));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const kindOf = new Map<string, "agent" | "human">();
  for (const p of participants) kindOf.set(p.name, p.kind);
  for (const identity of identities) {
    if (identity.kind === "agent" || identity.kind === "human") kindOf.set(identity.name, identity.kind);
  }
  for (const [name, p] of Object.entries(presence)) {
    if (!kindOf.has(name) && (p.kind === "agent" || p.kind === "human")) kindOf.set(name, p.kind);
  }
  // kind 已知取 kind；未知（旧 presence 行没回填）时：UUID 名当 human，其余当 agent。
  const kindFor = (name: string): "agent" | "human" =>
    kindOf.get(name) ?? (SYSTEM_HUMAN_SESSION_RE.test(name) ? "human" : "agent");

  const names = new Set<string>([...online, ...Object.keys(presence)]);
  const rank: Record<MentionTier, number> = { online: 0, wakeable: 1, recent: 2 };
  return [...names]
    .filter((name) => name !== self && name !== "system")
    .map((name) => {
      const kind = kindFor(name);
      const p = presence[name];
      const identity = identityByName.get(name);
      const account = identity?.account ?? p?.account;
      // 人类网页会话名是 UUID，显示账号 email 才认得出「是谁」；agent 名本身可读，用 name。
      const display = identity?.display && identity.display !== "" ? identity.display : (kind === "human" && account ? account : name);
      const group = account ?? (kind === "human" ? "human sessions" : "unowned agents");
      return { name, display, kind, tier: tierFor(name, online, presence, now), group, account, role: p?.role, note: p?.note ?? undefined };
    })
    .filter((c) => {
      if (c.tier === "online") return true; // 当前连着的都留（含在线的人类）
      if (c.kind === "human") return false; // 不在线的人类围观者不作候选
      const p = presence[c.name];
      const seen = p?.last_seen ?? p?.ts ?? 0;
      return now - seen <= DEAD_MS; // 幽灵清理：太久没露面的 agent 也剔除
    })
    .filter((c) => {
      // 可读身份缺失的人类 UUID 不进补全菜单；否则用户只会看到一串无法识别的 session id。
      if (c.kind !== "human") return true;
      if (!SYSTEM_HUMAN_SESSION_RE.test(c.name)) return true;
      return c.account !== undefined && c.display !== c.name;
    })
    .sort((a, b) => a.group.localeCompare(b.group) || rank[a.tier] - rank[b.tier] || a.display.localeCompare(b.display));
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
    // 名字与可读显示名（人类的 email）都参与匹配——这样能直接搜 @thejacks 找到 UUID 会话
    const n = c.name.toLowerCase();
    const d = c.display.toLowerCase();
    if (n.startsWith(q) || d.startsWith(q)) pref.push(c);
    else if (n.includes(q) || d.includes(q)) sub.push(c);
  }
  return [...pref, ...sub].slice(0, limit);
}
