import type { MeInfo } from "./api";

type AgentNameOwner = Pick<MeInfo, "handle" | "display_name" | "email" | "name">;

// Lark/Feishu 的 provider subject 是身份键，不是给人看的名字。
// 当旧账号只把 subject 放在 me.name 时，宁可回退到频道名，也不把它塞进 agent 前缀。
const OPAQUE_PROVIDER_ID_RE = /^(?:lark-[a-f0-9]{10,}(?:-|$)|ou_[a-z0-9]{10,}$)/i;

function readable(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  return candidate && !OPAQUE_PROVIDER_ID_RE.test(candidate) ? candidate : null;
}

export function agentNameOwnerLabel(me: AgentNameOwner | null | undefined, slug: string): string {
  const emailLocalPart = me?.email?.split("@")[0] ?? null;
  return (
    readable(me?.handle) ??
    readable(me?.display_name) ??
    readable(emailLocalPart) ??
    readable(me?.name) ??
    slug
  );
}
