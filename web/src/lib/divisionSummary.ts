import type { CollaborationRole, SenderKind } from "@agentparty/shared";

const ROLE_ORDER: readonly CollaborationRole[] = ["host", "worker", "reviewer", "observer"];

export interface DeclaredRoleIdentity {
  name: string;
  display: string;
  kind?: SenderKind;
  role: CollaborationRole;
}

export function declaredAgentRoles<T extends DeclaredRoleIdentity>(roles: readonly T[]): T[] {
  const knownAgents = roles.filter((role) => role.kind === "agent");
  if (knownAgents.length > 0) return knownAgents;
  return roles.filter((role) => role.kind !== "human");
}

export function formatAgentRoleSummary(roles: readonly DeclaredRoleIdentity[]): string {
  const byRole = new Map<CollaborationRole, string[]>();
  const seen = new Set<string>();
  for (const item of declaredAgentRoles(roles)) {
    const key = `${item.role}:${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const names = byRole.get(item.role) ?? [];
    names.push(item.display);
    byRole.set(item.role, names);
  }
  return ROLE_ORDER
    .flatMap((role) => {
      const names = byRole.get(role);
      return names === undefined || names.length === 0 ? [] : [`${role}=${names.join(", ")}`];
    })
    .join(" · ");
}
