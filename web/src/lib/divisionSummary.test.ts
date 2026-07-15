// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { declaredAgentRoles, formatAgentRoleSummary, type DeclaredRoleIdentity } from "./divisionSummary";

const screenshotRoles: DeclaredRoleIdentity[] = [
  { name: "lark:on_owner", display: "lark:on_owner", role: "host" },
  { name: "ai-girl", display: "ai-girl", kind: "agent", role: "worker" },
  { name: "ai-girl-zim", display: "ai-girl-zim", kind: "agent", role: "worker" },
  { name: "ai-girl-host-codex", display: "ai-girl-host-codex", kind: "agent", role: "host" },
  { name: "qa", display: "QA", kind: "agent", role: "worker" },
];

describe("division agent summary", () => {
  test("lists assigned and self-reported agent names instead of an unresolved owner account and counts", () => {
    expect(formatAgentRoleSummary(screenshotRoles)).toBe(
      "host=ai-girl-host-codex · worker=ai-girl, ai-girl-zim, QA",
    );
  });

  test("uses explicit agent identities when stale unknown or human role rows coexist", () => {
    const roles = declaredAgentRoles([
      ...screenshotRoles,
      { name: "human", display: "Leo", kind: "human", role: "host" },
    ]);
    expect(roles.map((role) => role.name)).not.toContain("lark:on_owner");
    expect(roles.map((role) => role.name)).not.toContain("human");
  });

  test("keeps legacy unknown agent rows when no typed agent identity is available", () => {
    expect(formatAgentRoleSummary([
      { name: "legacy-agent", display: "legacy-agent", role: "reviewer" },
    ])).toBe("reviewer=legacy-agent");
  });
});
