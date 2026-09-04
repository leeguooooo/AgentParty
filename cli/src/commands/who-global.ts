// `party who` 不带频道时的全局视图（#1074）。
//
// 此前 who/agents 都是频道内视图：要用它们，你得先知道该进哪个频道。于是「找人」的实际路径
// 变成了「开网页 → 看频道列表 → 进频道 → 看名单」。这里把「我已加入的所有频道」的 presence
// 聚合成一份「我能到达谁」，按人去重（同一个人在多个频道出现只占一行），每行给出可达性与
// 出现在哪些频道，供下一步 `party send --channel <其中之一> --mention <name>`。
//
// 没有新增服务端接口：只用现成的 listChannels + fetchPresence。
import type { PresenceEntry, SenderKind } from "@agentparty/shared";
import { autoWakeReachable } from "@agentparty/shared";
import { isOpaqueAccount } from "@agentparty/shared/identity";
import type { ChannelInfo } from "../rest";

/** 可达性档位，与频道内 who 同序：能立刻说上话的排前面。 */
export type GlobalReach = "online" | "wakeable" | "recent" | "offline";
const REACH_ORDER: Record<GlobalReach, number> = { online: 0, wakeable: 1, recent: 2, offline: 3 };

export interface GlobalWhoRow {
  /**
   * 可直接用于 `party send --mention <name>` 的地址。
   * 人类的会话名是 UUID / provider subject，**@ 不到**——只有全局昵称 handle 能被服务端解析成
   * 「被 @」，所以人类优先取 handle；没有 handle 时退回会话名并置 mentionable:false，
   * 让调用方知道这行不能直接 @（而不是让它发一条永远叫不醒人的消息）。
   */
  name: string;
  /** 缺省即可 @；false 表示这一行没有可 @ 的地址。 */
  mentionable?: false;
  kind: SenderKind;
  reach: GlobalReach;
  /** 可读的归属人；不透明账号串一律省略。 */
  owner?: string;
  /** 这个人出现在哪些频道（已按频道名排序），下一步 --channel 从这里挑。 */
  channels: string[];
  /** 同一个人被折叠掉的其它会话名（便于精确寻址时区分）。 */
  aka?: string[];
  last_seen?: number;
  /** 人为暂停接待：被 @ 也不会醒，必须显式标出，否则 online 会骗人。 */
  paused?: true;
}

export interface GlobalWhoInput {
  /** 每个频道一份 presence 快照；顺序不影响结果。 */
  channels: Array<{ slug: string; presence: PresenceEntry[] }>;
  /** 自己的名字，输出里排除（找人是找别人）。 */
  self?: string;
  now: number;
  /** 超过这个时长没露面就归为 offline，与频道内 who 的 recent 判据同源。 */
  staleMs?: number;
}

const DEFAULT_STALE_MS = 60_000;

function nonBlank(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v !== undefined && v !== "" ? v : undefined;
}

function readable(value: string | null | undefined): string | undefined {
  const v = nonBlank(value);
  return v !== undefined && !isOpaqueAccount(v) ? v : undefined;
}

/**
 * 单条 presence 的可达性。故意比频道内 who 粗一档：全局视图要回答的是「我现在能不能找到他」，
 * 不承担「为什么叫不醒」的诊断——那仍然是 `party who <channel>` 的职责。
 */
export function reachOf(entry: PresenceEntry, now: number, staleMs = DEFAULT_STALE_MS): GlobalReach {
  const age = now - (entry.last_seen ?? entry.ts ?? 0);
  // state 是自报的**工作**状态（working/waiting/blocked/done），不是连通性：一个 49 天前
  // 报过 working 的会话至今仍是 state=working。判「在线」必须同时看 live 或新鲜度，
  // 口径与频道内 who 的 tier 完全一致，否则全局视图会把一堆死会话标成在线。
  if (entry.state !== "offline" && (entry.live === true || age < staleMs)) return "online";
  // 可唤醒同样走权威判定（wake 声明 + 新鲜度 + residency），不只看 wake.kind 存在。
  if (autoWakeReachable(entry, now, staleMs)) return "wakeable";
  return age <= staleMs ? "recent" : "offline";
}

/**
 * 同一个人的聚合键。与 web 侧名单（#1067）同一套思路：人靠全局昵称跨会话对上，
 * 其次账号；agent 是独立个体，恒按名字各自成行——同一 owner 名下的两个 agent 不是同一个东西。
 */
export function personKeyOf(entry: PresenceEntry): string {
  if (entry.kind !== "human") return `agent:${entry.name}`;
  const handle = nonBlank(entry.handle);
  if (handle !== undefined) return `handle:${handle.toLowerCase()}`;
  // account 在服务端按原值精确比较，只差大小写是两个主体，不折叠大小写。
  const account = nonBlank(entry.account);
  return account !== undefined ? `account:${account}` : `human:${entry.name}`;
}

function displayOf(entry: PresenceEntry): string {
  // 人类的会话名常是 UUID / provider subject，直接展示没人认得；昵称与展示名优先。
  if (entry.kind === "human") {
    return nonBlank(entry.display_name) ?? nonBlank(entry.handle) ?? readable(entry.account) ?? entry.name;
  }
  return nonBlank(entry.handle) ?? entry.name;
}

export function buildGlobalWho(input: GlobalWhoInput): GlobalWhoRow[] {
  const { channels, self, now, staleMs = DEFAULT_STALE_MS } = input;
  const groups = new Map<string, {
    best: PresenceEntry;
    bestReach: GlobalReach;
    names: Set<string>;
    entries: PresenceEntry[];
    channels: Set<string>;
    lastSeen: number;
    paused: boolean;
  }>();

  for (const { slug, presence } of channels) {
    for (const entry of presence) {
      if (entry.name === "system" || (self !== undefined && entry.name === self)) continue;
      const key = personKeyOf(entry);
      const reach = reachOf(entry, now, staleMs);
      const seen = entry.last_seen ?? entry.ts ?? 0;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          best: entry,
          bestReach: reach,
          names: new Set([entry.name]),
          entries: [entry],
          channels: new Set([slug]),
          lastSeen: seen,
          paused: entry.paused === true,
        });
        continue;
      }
      existing.names.add(entry.name);
      existing.entries.push(entry);
      existing.channels.add(slug);
      existing.lastSeen = Math.max(existing.lastSeen, seen);
      // 代表条目取可达性最好的那条；同档时取更近的一次露面。
      if (
        REACH_ORDER[reach] < REACH_ORDER[existing.bestReach] ||
        (REACH_ORDER[reach] === REACH_ORDER[existing.bestReach] && seen > (existing.best.last_seen ?? existing.best.ts ?? 0))
      ) {
        existing.best = entry;
        existing.bestReach = reach;
      }
      // 只要有一条会话是被暂停的就标出来：暂停是人主动按下的，@ 不会醒，宁可多提醒。
      if (entry.paused === true) existing.paused = true;
    }
  }

  // 同一个人可能一半会话带 handle、一半只有 account（离线行常拿不到 handle）：
  // 先记下 handle 组占用了哪些账号，再把纯 account 组并进去，否则同一个人会裂成两行。
  // 与 web 名单（#1067）同一趟二次合并。
  const keyByAccount = new Map<string, string>();
  for (const [key, group] of groups) {
    if (!key.startsWith("handle:")) continue;
    for (const entry of group.entries) {
      const account = nonBlank(entry.account);
      if (account !== undefined && !keyByAccount.has(account)) keyByAccount.set(account, key);
    }
  }
  for (const [key, group] of [...groups]) {
    if (!key.startsWith("account:")) continue;
    const target = keyByAccount.get(key.slice("account:".length));
    if (target === undefined || target === key) continue;
    const into = groups.get(target)!;
    for (const entry of group.entries) into.entries.push(entry);
    for (const name of group.names) into.names.add(name);
    for (const slug of group.channels) into.channels.add(slug);
    into.lastSeen = Math.max(into.lastSeen, group.lastSeen);
    into.paused = into.paused || group.paused;
    if (REACH_ORDER[group.bestReach] < REACH_ORDER[into.bestReach]) {
      into.best = group.best;
      into.bestReach = group.bestReach;
    }
    groups.delete(key);
  }

  const rows: GlobalWhoRow[] = [];
  for (const group of groups.values()) {
    // 人类：任一会话上的 handle 都是同一个全局昵称，取到即用；agent 的 name 本身就是地址。
    const handle = group.best.kind === "human"
      ? [...group.entries].map((entry) => nonBlank(entry.handle)).find((value) => value !== undefined)
      : undefined;
    const name = handle ?? group.best.name;
    const mentionable = group.best.kind !== "human" || handle !== undefined;
    const aka = [...group.names].filter((other) => other !== name).sort();
    const owner = readable(group.best.account);
    rows.push({
      name,
      ...(mentionable ? {} : { mentionable: false as const }),
      kind: group.best.kind ?? "agent",
      reach: group.bestReach,
      ...(owner === undefined ? {} : { owner }),
      channels: [...group.channels].sort(),
      ...(aka.length === 0 ? {} : { aka }),
      ...(group.lastSeen > 0 ? { last_seen: group.lastSeen } : {}),
      ...(group.paused ? { paused: true as const } : {}),
    });
  }

  return rows.sort((a, b) =>
    REACH_ORDER[a.reach] - REACH_ORDER[b.reach]
    // 同档内 agent 在前：找人办事时，能直接派活的排前面更顺手。
    || Number(a.kind === "human") - Number(b.kind === "human")
    || (b.last_seen ?? 0) - (a.last_seen ?? 0)
    || a.name.localeCompare(b.name),
  );
}

const REACH_MARK: Record<GlobalReach, string> = {
  online: "●",
  wakeable: "◐",
  recent: "○",
  offline: "·",
};

export function renderGlobalRow(row: GlobalWhoRow, display: string, now: number): string {
  const age = row.last_seen === undefined ? "" : ` ${fmtAge(now - row.last_seen)}`;
  const owner = row.owner === undefined ? "" : ` · ${row.owner}`;
  const paused = row.paused === true ? " ⏸ paused" : "";
  const noMention = row.mentionable === false ? "  ⚠ no @ handle" : "";
  const where = row.channels.length === 1 ? `#${row.channels[0]}` : `#${row.channels[0]} +${row.channels.length - 1}`;
  return `${REACH_MARK[row.reach]} ${display}${owner}  ${row.kind}${paused}  ${where}${age}${noMention}`;
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** 供命令层复用：只取未归档频道，避免把死频道的历史成员算进「我能到达谁」。 */
export function activeChannelSlugs(channels: ChannelInfo[]): string[] {
  return channels
    .filter((channel) => channel.archived_at === null || channel.archived_at === undefined)
    .map((channel) => channel.slug)
    .sort();
}

export { displayOf as globalWhoDisplay };
