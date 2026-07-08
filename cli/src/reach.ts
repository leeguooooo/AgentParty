// party send 后即时反馈：一个 @ 目标现在能不能收到。是网页发送前状态条的终端版——不用开网页，
// 发完就知道会不会白发。与 who 的 classify 不同：这里对「找不到/离线/幽灵」一律回 offline（要提醒
// 「重连前收不到」），不返回 null；档位判定与网页 mentions.ts 保持一致（online / wakeable / offline）。
import type { PresenceEntry, WakeKind } from "@agentparty/shared";

const WAKEABLE: readonly WakeKind[] = ["serve", "watch", "webhook"];
// 档位窗口与 `party who` 的 classify 保持一致，避免 who 说「可唤醒」而 send --reach 说「离线」自相矛盾：
// online 需当前连着且新鲜(<STALE_MS)；wakeable 只要声明了 serve/watch/webhook 且 14 天内露过面。
const STALE_MS = 60_000; // 与 DO presence 扫描一致
const DEAD_MS = 14 * 24 * 60 * 60 * 1000; // 超过即视为幽灵，不再算可唤醒

export type Reach = "online" | "wakeable" | "offline";

export interface Reachability {
  name: string;
  reach: Reach;
  wake?: WakeKind;
}

export function reachOf(name: string, presence: PresenceEntry[], now: number): Reachability {
  const e = presence.find((p) => p.name === name);
  if (e === undefined) return { name, reach: "offline" };
  const seen = e.last_seen ?? e.ts ?? 0;
  const age = now - seen;
  const wake = e.wake?.kind;
  if (e.state !== "offline" && age < STALE_MS) return { name, reach: "online", ...(wake ? { wake } : {}) };
  if (wake !== undefined && WAKEABLE.includes(wake) && age <= DEAD_MS) return { name, reach: "wakeable", wake };
  return { name, reach: "offline", ...(wake ? { wake } : {}) };
}

const DOT: Record<Reach, string> = { online: "●", wakeable: "◐", offline: "○" };

export function formatReach(r: Reachability): string {
  if (r.reach === "online") return `@${r.name} ${DOT.online} online`;
  if (r.reach === "wakeable") return `@${r.name} ${DOT.wakeable} wakeable${r.wake ? `(${r.wake})` : ""}`;
  return `@${r.name} ${DOT.offline} offline — reconnect to reach`;
}

// 发送后打印的一行：→ @a ● online  ·  @b ◐ wakeable(serve)  ·  @c ○ offline — reconnect to reach
export function formatReachLine(rs: Reachability[]): string {
  return "→ " + rs.map(formatReach).join("  ·  ");
}
