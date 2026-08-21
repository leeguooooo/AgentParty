// 同频道多身份的判重（#907）。
//
// #898 的幂等检查只问「这个**注册名**是不是已经存在」——换个身份名必然放行，于是同一个
// (server, channel, owner) 下可以静默攒出十几个身份，每个身份＝一个常驻 MCP 进程
// （owner 实测本机 127 个 party 进程 / 1.7GB）。本模块提供真正该问的那个问题：
//
//   「同一台 server、同一个频道、同一个 owner 下，我是不是已经有身份了？」
//
// 硬约束：
//  1. **server 必须参与比较**。本机两台生产实例都有同名频道 `#agentparty`（#865 跨实例误投），
//     只按频道名判重会把两台机器的身份混成一组。
//  2. 本模块只读、只判定、只返回结论，**绝不删除任何东西**。身份文件是凭据载体，删错＝
//     owner 只能重铸 token。副作用留在命令层，且默认 dry-run。
//  3. 同频道多身份**不是缺陷**（不同角色 / 不同 harness 确实需要）。这里输出的是「已存在」
//     这个事实，供人做显式选择，而不是一个自动执行的裁决。
import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** 一份本地身份配置的判重视图。永远不含 token。 */
export interface IdentityRecord {
  path: string;
  server: string;
  name: string;
  owner: string | null;
  channelScope: string;
}

/** 判重三元组。owner 为 null 表示配置里没记 owner（老配置），单独成组，不与有 owner 的混判。 */
export interface IdentityScope {
  server: string;
  channel: string;
  owner: string | null;
}

/** server 末尾斜杠不参与比较：`https://x/` 与 `https://x` 是同一台。 */
export function normalizeServerKey(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

/** 分组键。三段都参与——尤其 server（#865：两台实例都有 `#agentparty`）。 */
export function identityScopeKey(scope: IdentityScope): string {
  return JSON.stringify([normalizeServerKey(scope.server), scope.channel, scope.owner ?? ""]);
}

export function sameIdentityScope(a: IdentityScope, b: IdentityScope): boolean {
  return identityScopeKey(a) === identityScopeKey(b);
}

/** 从一份已解析的 JSON 里抽出判重视图；形状不对一律返回 null（宁可少认）。 */
export function identityRecordFromConfigJson(path: string, parsed: unknown): IdentityRecord | null {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const j = parsed as Record<string, unknown>;
  if (typeof j.server !== "string" || j.server === "") return null;
  const identity = j.identity !== null && typeof j.identity === "object" && !Array.isArray(j.identity)
    ? (j.identity as Record<string, unknown>)
    : null;
  if (identity === null) return null;
  const channelScope = typeof identity.channel_scope === "string" ? identity.channel_scope : "";
  const name = typeof identity.name === "string" ? identity.name : "";
  if (channelScope === "" || name === "") return null;
  return {
    path,
    server: normalizeServerKey(j.server),
    name,
    owner: typeof identity.owner === "string" && identity.owner !== "" ? identity.owner : null,
    channelScope,
  };
}

/**
 * 扫一个 agents 目录，读出全部可判重的身份配置。
 * 读不动 / 解析不了 / 形状不对的文件一律跳过——判重失败最多是少提示一句，
 * 而因为一个坏文件抛异常会让整条接入流程挂掉。
 */
export function readIdentityRecords(directory: string): IdentityRecord[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: IdentityRecord[] = [];
  for (const entry of entries.slice(0, 500)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      if (statSync(path).size > 1_000_000) continue;
      const rec = identityRecordFromConfigJson(path, JSON.parse(readFileSync(path, "utf8")) as unknown);
      if (rec !== null) out.push(rec);
    } catch {
      // 一份坏配置不能遮住其余可判重的身份。
    }
  }
  return sortRecords(out);
}

function sortRecords(records: IdentityRecord[]): IdentityRecord[] {
  return [...records].sort(
    (l, r) =>
      l.server.localeCompare(r.server)
      || l.channelScope.localeCompare(r.channelScope)
      || l.name.localeCompare(r.name)
      || l.path.localeCompare(r.path),
  );
}

/**
 * 「这个 (server, channel, owner) 下我已经有哪些身份？」——本 issue 的核心问题。
 *
 * owner 传 null＝不按 owner 收窄（接入包在 `party init` 之前跑，那时还没验过身份、拿不到
 * owner）。这时宁可**多报**：同 server 同频道下的其它身份也列出来，让人自己看是不是自己的。
 * excludeName / excludePath 用来把「我自己这一份」排除掉，否则 init 重跑会自己报自己。
 */
export interface FindOptions {
  server: string;
  channel: string;
  owner?: string | null;
  excludeName?: string | null;
  excludePath?: string | null;
}

export function findExistingIdentities(records: IdentityRecord[], opts: FindOptions): IdentityRecord[] {
  const server = normalizeServerKey(opts.server);
  const owner = opts.owner ?? null;
  const excludePath = opts.excludePath ?? null;
  const excludeName = opts.excludeName ?? null;
  return sortRecords(
    records.filter((r) => {
      // 两侧都归一：readIdentityRecords 读进来时已归一，但调用方也可能直接构造记录。
      if (normalizeServerKey(r.server) !== server) return false;
      if (r.channelScope !== opts.channel) return false;
      // owner 已知时才按 owner 收窄；未知时不收窄（宁可多报）。
      if (owner !== null && r.owner !== null && r.owner !== owner) return false;
      if (excludePath !== null && r.path === excludePath) return false;
      if (excludeName !== null && r.name === excludeName) return false;
      return true;
    }),
  );
}

/**
 * `party init --channel C` 绑定频道前的提示文案（#907 建议 1）。
 *
 * 命中就返回一段要打给用户看的行；没命中返回空数组。**只提示，不阻断也不删除**——
 * init 常被脚本调用，阻断会把接入流程整个打断；而「同频道多身份」本身是合法的，
 * 需要的是让选择变显式，不是替用户做决定。
 */
export function sameChannelIdentityWarningLines(
  records: IdentityRecord[],
  opts: { server: string; channel: string; selfPath?: string | null; owner?: string | null },
): string[] {
  const existing = findExistingIdentities(records, {
    server: opts.server,
    channel: opts.channel,
    owner: opts.owner ?? null,
    excludePath: opts.selfPath ?? null,
  });
  if (existing.length === 0) return [];
  const server = normalizeServerKey(opts.server);
  return [
    `warning: this machine already has ${String(existing.length)} identity(ies) bound to ` +
      `${opts.channel} @ ${server}:`,
    ...existing.map((r) => `  ${r.name}  (owner=${r.owner ?? "-"}, config: ${r.path})`),
    "Every one of them becomes a resident MCP process in every session.",
    "If you meant to REPLACE one of them, retire it first (dry run, nothing is deleted without --yes):",
    `  party mcp identities --keep <this-identity> --channel ${opts.channel} --server ${server}`,
    "If you meant them to COEXIST (different roles / harnesses), nothing to do — this is just a heads-up.",
  ];
}

/** 一组同 (server, channel, owner) 的身份。 */
export interface IdentityGroup {
  scope: IdentityScope;
  records: IdentityRecord[];
}

/** 按三元组分组；`minSize` 默认 2＝只返回真正的重复组。 */
export function groupIdentities(records: IdentityRecord[], minSize = 2): IdentityGroup[] {
  const byKey = new Map<string, IdentityGroup>();
  for (const r of records) {
    const scope: IdentityScope = { server: r.server, channel: r.channelScope, owner: r.owner };
    const key = identityScopeKey(scope);
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { scope, records: [r] });
    else existing.records.push(r);
  }
  return [...byKey.values()]
    .filter((g) => g.records.length >= minSize)
    .map((g) => ({ scope: g.scope, records: sortRecords(g.records) }))
    .sort(
      (l, r) =>
        r.records.length - l.records.length
        || l.scope.channel.localeCompare(r.scope.channel)
        || l.scope.server.localeCompare(r.scope.server),
    );
}
