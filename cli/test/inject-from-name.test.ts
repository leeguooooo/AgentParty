import { describe, expect, test } from "bun:test";
import { friendlyAgentLabel, generatedAgentRole } from "@agentparty/shared/identity";
import { wrapCrossSessionMessage } from "../src/claude-inbox-inject";
import { injectFromName, senderInjectFromName } from "../src/serve-wake-proxy";
import type { CachedIdentity } from "../src/config";

function identity(overrides: Partial<CachedIdentity> = {}): CachedIdentity {
  return {
    name: "lark-ad72b3f97491-agentparty",
    email: null,
    kind: "agent",
    role: "agent",
    owner: null,
    channel_scope: "dev",
    verified_at: 0,
    ...overrides,
  };
}

describe("friendlyAgentLabel (shared, web 同源)", () => {
  test("prefers owner_display_name, then handle, then owner", () => {
    expect(friendlyAgentLabel({ name: "lark-ad72b3f97491-agentparty", owner_display_name: "leo" })).toBe(
      "leo · agentparty",
    );
    expect(friendlyAgentLabel({ name: "lark-ad72b3f97491-agentparty", owner_handle: "leo-h" })).toBe(
      "leo-h · agentparty",
    );
    expect(friendlyAgentLabel({ name: "lark-ad72b3f97491-agentparty", owner: "leo@example.com" })).toBe(
      "leo@example.com · agentparty",
    );
  });

  test("degrades to the bare role without a readable owner, and to the raw name without a role", () => {
    expect(friendlyAgentLabel({ name: "lark-ad72b3f97491-agentparty" })).toBe("agentparty");
    expect(friendlyAgentLabel({ name: "lark-ad72b3f97491-agentparty", owner: "oidc:abc" })).toBe("agentparty");
    expect(friendlyAgentLabel({ name: "plain-agent", owner_display_name: "leo" })).toBe("leo · plain-agent");
    expect(friendlyAgentLabel({ name: "plain-agent" })).toBe("plain-agent");
    // 非 lark 前缀但同样是生成名的形态也能提出角色。
    expect(generatedAgentRole("ad72b3f97491-agentparty")).toBe("agentparty");
  });
});

describe("injectFromName / senderInjectFromName", () => {
  test("keeps both the friendly label and the technical id", () => {
    expect(injectFromName("dev", identity({ owner_display_name: "leo" }))).toBe(
      "leo · agentparty (lark-ad72b3f97491-agentparty)",
    );
  });

  test("two identities differing only in the hash segment stay distinguishable", () => {
    const a = injectFromName("dev", identity({ owner_display_name: "leo" }));
    const b = injectFromName(
      "dev",
      identity({ name: "lark-ad72b3f9749e-agentparty", owner_display_name: "leo" }),
    );
    expect(a).not.toBe(b);
    expect(b).toContain("lark-ad72b3f9749e-agentparty");
  });

  test("falls back to the channel when no identity is cached", () => {
    expect(injectFromName("dev", null)).toBe("agentparty#dev");
    expect(senderInjectFromName(undefined, "dev")).toBe("agentparty#dev");
  });

  test("humans show their readable name; agents keep owner · role (id)", () => {
    expect(
      senderInjectFromName({ name: "leo", kind: "human", display_name: "郭立lee" }, "dev"),
    ).toBe("郭立lee (leo)");
    expect(
      senderInjectFromName(
        { name: "lark-ad72b3f97491-agentparty", kind: "agent", owner: "leo@example.com" },
        "dev",
      ),
    ).toBe("leo@example.com · agentparty (lark-ad72b3f97491-agentparty)");
  });

  test("sanitizes characters that would break the receiver's integrity self-check", () => {
    const name = senderInjectFromName({ name: 'we"ird<x>', kind: "agent" }, "dev");
    expect(name).not.toContain('"');
    expect(name).not.toContain("<");
  });

  test("the wrapped from-name survives an attribute round-trip", () => {
    const fromName = injectFromName("dev", identity({ owner_display_name: "leo" }));
    const wrapped = wrapCrossSessionMessage({ fromName, fromMode: "prompting", body: "hi" });
    const match = /^<cross-session-message((?:\s+[a-z-]+="[^"]*")*)>\n([\s\S]*)\n<\/cross-session-message>$/.exec(
      wrapped,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toContain(`from-name="${fromName}"`);
    expect(match![2]).toBe("hi");
  });
});
