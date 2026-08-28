// 身份展示规则的单一来源：web 的消息头 / presence / 引用预览，与 cli 的 cross-session
// 注入面板（#857 的 fromName）必须显示同一个「谁是谁」。规则只放这一份，别在 web/cli
// 各自复刻（同 onboarding.ts 的做法）。
//
// 两组导出互补，一起用：
//   1. 友好名（generatedAgentRole / friendlyAgentLabel）——把技术 name 渲染成人能读的名字；
//   2. 撞名区分码（identityDisambiguatorSource / assignIdentityDisambiguators，#858）——
//      友好名撞车时给出组内唯一的最短技术区分码。

const HASH_PREFIX = /^(?:[a-z][a-z0-9]*-)?([0-9a-f]{8,})(?:-|$)/i;

/**
 * 取一个 name 里最适合当区分码的「哈希段」。
 * - `lark-ad72b3f97491-agentparty` → `ad72b3f97491`（前缀词 + 十六进制段）
 * - `61ec302c-6c31-4bca-a1df-88152372f6d9` → `61ec302c`（UUID 首段也是十六进制段）
 * - 其他形态（人起的名字、纯英文 slug）没有哈希段，降级用整个 name 当来源。
 */
export function identityDisambiguatorSource(name: string): string {
  return name.match(HASH_PREFIX)?.[1] ?? name;
}

const MIN_DISAMBIGUATOR_LENGTH = 5;

/**
 * 给一组「渲染后显示名相同」的技术 name 分配组内唯一的区分码。
 * 从 5 位尾部片段起步，仍有冲突就逐位加长；来源段本身相同（加长也无解）时降级用完整 name。
 * 单个 name 的组不产生区分码——不撞名的身份显示必须保持原样。
 */
export function assignIdentityDisambiguators(names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(names)];
  if (unique.length < 2) return out;

  const sources = new Map(unique.map((name) => [name, identityDisambiguatorSource(name)]));
  const maxLength = Math.max(...[...sources.values()].map((source) => source.length));

  for (let length = MIN_DISAMBIGUATOR_LENGTH; length <= maxLength; length++) {
    const candidates = new Map(unique.map((name) => [name, sources.get(name)!.slice(-length)]));
    const distinct = new Set(candidates.values());
    if (distinct.size === unique.length) return candidates;
  }

  // 哈希段完全相同（或来源无法区分）：退到完整技术 name，保证「一定能分辨」这个硬要求。
  for (const name of unique) out.set(name, name);
  return out;
}

/**
 * 自动生成的 agent 名形如 `lark-ad72b3f97491-agentparty` / `ad72b3f97491-agentparty`：
 * 前缀是不可读的技术 ID，尾巴才是人给的角色名。提出角色名，提不出返回 null。
 */
export function generatedAgentRole(value: string): string | null {
  const match = value.match(/^(?:lark-)?[0-9a-f]{12,}-(.+)$/i);
  return match?.[1]?.trim() || null;
}

/** 不可读的账号标识（SSO subject 等），不适合直接当所属人展示名。 */
export function isOpaqueAccount(value: string): boolean {
  return /^(?:(?:lark|oidc|apple|github):|oidc-)/i.test(value);
}

export interface FriendlyAgentIdentity {
  /** 技术 identity（可路由名）。 */
  name: string;
  owner?: string | null;
  owner_handle?: string | null;
  owner_display_name?: string | null;
}

/**
 * 友好展示名，对齐 web 的 `<ownerLabel> · <label>`：
 * - 角色名取 generatedAgentRole(name)，提不出就用原 name；
 * - 所属人取 owner_display_name > owner_handle > owner（不可读账号忽略）；
 * - 无可读所属人时降级为纯角色名。
 * 例：`lark-ad72b3f97491-agentparty` + owner_display_name=leo → `leo · agentparty`。
 *
 * 注意：友好名会撞车（同 owner 同角色，只有哈希段不同）——需要「一定能分辨」的场合
 * 用 assignIdentityDisambiguators（web 列表与 cli 注入面板 fromName 同用；#986 起 cli 也只在
 * 撞名时加短码，技术 ID 走正文 `from-id:`）。
 */
export function friendlyAgentLabel(identity: FriendlyAgentIdentity): string {
  const role = generatedAgentRole(identity.name) ?? identity.name;
  const ownerCandidates = [
    identity.owner_display_name,
    identity.owner_handle,
    identity.owner,
  ];
  for (const candidate of ownerCandidates) {
    const owner = typeof candidate === "string" ? candidate.trim() : "";
    if (owner === "" || isOpaqueAccount(owner)) continue;
    return `${owner} · ${role}`;
  }
  return role;
}
