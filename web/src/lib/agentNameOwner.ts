import { isOpaqueAccount } from "@agentparty/shared/identity";
import type { MeInfo } from "./api";

type AgentNameOwner = Pick<MeInfo, "handle" | "display_name" | "email" | "name">;

// Lark/Feishu 的 provider subject（lark-<hex>… / ou_…）是身份键，不是给人看的名字（#1043）。
// 旧账号只把 subject 放在 me.name 时，宁可退回频道名，也不把它塞进 agent 默认名前缀。
// 连频道 slug 都是不透明 id 时的中性兜底（CodeRabbit #1059）。
const NEUTRAL_PREFIX = "agent";

const OPAQUE_PROVIDER_ID_RE = /^(?:lark-[a-f0-9]{10,}(?:-|$)|ou_[a-z0-9]{10,}$)/i;

function readable(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  return OPAQUE_PROVIDER_ID_RE.test(candidate) || isOpaqueAccount(candidate) ? null : candidate;
}

/** agent 默认名的前缀：handle → display_name → 邮箱本地部分 → name → 频道 slug → "agent"，每级过可读性守卫。 */
export function agentNameOwnerLabel(me: AgentNameOwner | null | undefined, slug: string): string {
  const emailLocalPart = me?.email?.split("@")[0] ?? null;
  return (
    readable(me?.handle) ??
    readable(me?.display_name) ??
    readable(emailLocalPart) ??
    readable(me?.name) ??
    readable(slug) ??
    NEUTRAL_PREFIX
  );
}
