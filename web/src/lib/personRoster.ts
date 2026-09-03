import { isOpaqueAccount } from "@agentparty/shared/identity";

/**
 * 名单按「人」聚合（#1067）。
 *
 * 名单行原本 = 一个技术 name（一个会话）。同一个自然人会因为
 * ①同一账号开了多个会话 ②同一个人有多个账号串（`lark-email:<邮箱>` 登录 vs `lark:<open_id>` 目录入册/桌面端）
 * 而占据多行，且历史遗留的会话行连 account 都没有，只能原样显示 `lark:on_…`。
 *
 * 这里只做显示层聚合：把属于同一个人的会话折成一行，展开才看得到各会话。纯函数，不依赖 React。
 */

/** 聚合只需要 Item 的这几个字段；用结构类型避免 lib 依赖组件。 */
export interface PersonLike {
  name: string;
  kind: "human" | "agent";
  account: string | null;
  handle: string | null;
  displayName: string | null;
  owner: string | null;
  display: string;
  state: string;
}

export type PersonAnchor = "handle" | "account" | "name";

export interface PersonRow<T extends PersonLike> {
  key: string;
  /** 靠什么把这些会话认成同一个人：handle 最强（可跨账号），account 次之，name 表示无法归并。 */
  anchor: PersonAnchor;
  kind: "human" | "agent";
  display: string;
  /** 人类的归属邮箱/账号；不可读的账号串一律 null。 */
  owner: string | null;
  /** 代表这一行的会话（在线优先）。 */
  primary: T;
  sessions: T[];
  /** 这个人名下同时有几个账号串（>1 说明账号维度也岔开了，值得提示）。 */
  accountCount: number;
  /** 无账号、无 handle、名字本身就是不透明 id 且早已离线——历史遗留，默认折叠。 */
  stale: boolean;
}

function norm(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v !== undefined && v !== "" ? v : null;
}

function readable(value: string | null | undefined): string | null {
  const v = norm(value);
  return v !== null && !isOpaqueAccount(v) ? v : null;
}

/**
 * 同一个人的锚点。handle 是全局唯一昵称，能跨账号把同一个人对上；
 * account 只能合并「同一账号的多个会话」；都没有就退回 name（各自成行）。
 */
export function personAnchor(item: PersonLike): { key: string; anchor: PersonAnchor } {
  // agent 是独立个体，不是某个人的会话：同一 owner 名下的多个 agent 必须各自成行。
  if (item.kind !== "human") return { key: `name:agent:${item.name}`, anchor: "name" };
  const handle = norm(item.handle);
  if (handle !== null) return { key: `handle:${handle.toLowerCase()}`, anchor: "handle" };
  const account = norm(item.account) ?? norm(item.owner);
  // account 在服务端按原值精确比较，只差大小写的两个账号是两个主体——不能折叠大小写。
  if (account !== null) return { key: `account:${account}`, anchor: "account" };
  return { key: `name:human:${item.name}`, anchor: "name" };
}

/** 一个会话行是否属于「历史遗留」：没有任何身份信息，名字本身是不透明 id，且不在线。 */
export function isStaleSession(item: PersonLike): boolean {
  return (
    item.kind === "human"
    && norm(item.account) === null
    && norm(item.owner) === null
    && norm(item.handle) === null
    && norm(item.displayName) === null
    && item.state === "offline"
    && (isOpaqueAccount(item.name) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(item.name))
  );
}

function personDisplay<T extends PersonLike>(sessions: T[]): string {
  // 人类：SSO 展示名 > handle > 可读的归属账号 > 现有 display；不可读的账号串永远不当名字。
  for (const pick of [
    (s: T) => (s.kind === "human" ? norm(s.displayName) : null),
    (s: T) => norm(s.handle),
    (s: T) => readable(s.owner) ?? readable(s.account),
    (s: T) => readable(s.display),
  ]) {
    for (const session of sessions) {
      const value = pick(session);
      if (value !== null) return value;
    }
  }
  return sessions[0]!.display;
}

export interface BuildPersonRowsOptions<T extends PersonLike> {
  /** 会话排序：越靠前越适合当代表（一般传「在线优先」的既有排序函数）。 */
  rank?: (item: T) => number;
}

export function buildPersonRows<T extends PersonLike>(items: T[], options: BuildPersonRowsOptions<T> = {}): PersonRow<T>[] {
  const rank = options.rank ?? (() => 0);
  const groups = new Map<string, { anchor: PersonAnchor; sessions: T[] }>();
  for (const item of items) {
    const { key, anchor } = personAnchor(item);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { anchor, sessions: [item] });
    else existing.sessions.push(item);
  }

  // 同一个人可能一半会话有 handle、另一半只有 account（离线行拿不到 handle）：
  // 先把 handle 组占用的账号登记下来，再把只有 account 的组并进去，否则同一个人还是两行。
  const keyByAccount = new Map<string, string>();
  for (const [key, group] of groups) {
    if (group.anchor !== "handle") continue;
    for (const session of group.sessions) {
      const account = norm(session.account) ?? norm(session.owner);
      if (account !== null && !keyByAccount.has(account)) keyByAccount.set(account, key);
    }
  }
  for (const [key, group] of [...groups]) {
    if (group.anchor !== "account") continue;
    const account = key.slice("account:".length);
    const target = keyByAccount.get(account);
    if (target === undefined || target === key) continue;
    groups.get(target)!.sessions.push(...group.sessions);
    groups.delete(key);
  }

  const rows: PersonRow<T>[] = [];
  for (const [key, { anchor, sessions }] of groups) {
    const ordered = [...sessions].sort((a, b) => rank(a) - rank(b));
    const accounts = new Set(ordered.map((s) => norm(s.account) ?? norm(s.owner)).filter((a): a is string => a !== null));
    rows.push({
      key,
      anchor,
      kind: ordered.some((s) => s.kind === "human") ? "human" : "agent",
      display: personDisplay(ordered),
      owner: ordered.map((s) => readable(s.owner) ?? readable(s.account)).find((o) => o !== null) ?? null,
      primary: ordered[0]!,
      sessions: ordered,
      accountCount: accounts.size,
      stale: ordered.every((s) => isStaleSession(s)),
    });
  }
  return rows;
}
