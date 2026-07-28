// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import type { OrgTreeNode } from "../lib/orgTree";
import { buildMemberDirectory } from "./OrgTreePreview";

function node(overrides: Partial<OrgTreeNode> & Pick<OrgTreeNode, "name" | "display">): OrgTreeNode {
  return {
    role: null,
    kind: "agent",
    accountLabel: null,
    source: "unassigned",
    reportsTo: null,
    reportsToExternal: false,
    isLead: false,
    depth: 0,
    skipLevel: false,
    children: [],
    ...overrides,
  };
}

describe("member directory", () => {
  test("deduplicates repeated human sessions and nests every agent under its account", () => {
    const account = "lark:on_owner";
    const groups = buildMemberDirectory({
      roots: [],
      unassigned: [
        node({ name: "human-session-a", display: "王路", kind: "human", accountLabel: account }),
        node({ name: "human-session-b", display: "王路", kind: "human", accountLabel: account }),
        node({ name: "lark-a1b2c3-demo", display: "lark-a1b2c3-demo", accountLabel: account }),
        node({ name: "reviewer", display: "代码审查", accountLabel: account }),
        node({ name: "orphan", display: "orphan", accountLabel: null }),
      ],
      memberCount: 5,
    });

    const owned = groups.find((group) => group.key === `account:${account}`);
    expect(owned?.people.map((person) => person.display)).toEqual(["王路"]);
    expect(owned?.agents.map((agent) => agent.name)).toEqual(["lark-a1b2c3-demo", "reviewer"]);
    expect(groups.find((group) => group.key === "unowned:orphan")?.agents).toHaveLength(1);
  });
});
