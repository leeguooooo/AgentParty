// 身份区分码（#858）：同一个 owner 下同角色后缀的 agent（如 lark-ad72b3f97491-agentparty 与
// lark-ad72b3f9749e-agentparty）渲染出的友好名完全一样，界面上分不出谁是谁。
// 这里统一给「撞名组」里的每个技术 name 算一段最短且组内唯一的区分码，
// web（消息头 / presence / 引用预览）与 cli 的 cross-session fromName 注入（#857）共用同一实现，防止规则漂移。

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
