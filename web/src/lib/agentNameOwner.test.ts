// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { agentNameOwnerLabel } from "./agentNameOwner";

describe("agentNameOwnerLabel", () => {
  test("uses the readable handle instead of a Lark provider subject", () => {
    expect(
      agentNameOwnerLabel(
        {
          name: "lark-ad72b3f9749e-agentparty-codex1",
          handle: "leo",
          display_name: "leo",
          email: null,
        },
        "agentparty",
      ),
    ).toBe("leo");
  });

  test("falls back through display name, email local-part, name, then slug", () => {
    expect(agentNameOwnerLabel({ handle: null, display_name: "Leo Zhang", email: "mail@example.com", name: "legacy" }, "demo")).toBe("Leo Zhang");
    expect(agentNameOwnerLabel({ handle: null, display_name: null, email: "mail@example.com", name: "legacy" }, "demo")).toBe("mail");
    expect(agentNameOwnerLabel({ handle: null, display_name: null, email: null, name: "legacy" }, "demo")).toBe("legacy");
    expect(agentNameOwnerLabel({ handle: null, display_name: null, email: null, name: "lark-ad72b3f9749e" }, "demo")).toBe("demo");
    expect(agentNameOwnerLabel(null, "demo")).toBe("demo");
  });
});
