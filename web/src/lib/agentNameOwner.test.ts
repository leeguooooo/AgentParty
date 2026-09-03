import { describe, expect, test } from "bun:test";
import { agentNameOwnerLabel } from "./agentNameOwner";

const me = (o: Partial<{ handle: string | null; display_name: string | null; email: string | null; name: string }>) =>
  ({ handle: null, display_name: null, email: null, name: "", ...o }) as never;

describe("agent 默认名前缀（#1043）", () => {
  test("有邮箱账号：行为与之前一致，取邮箱本地部分", () => {
    expect(agentNameOwnerLabel(me({ email: "leo@example.com", name: "lark-3f9a8b7c6d5e" }), "ludo")).toBe("leo");
  });
  test("阶梯：handle 优先于 display_name，display_name 优先于邮箱", () => {
    expect(agentNameOwnerLabel(me({ handle: "leo", display_name: "Leo Guo", email: "x@y.z" }), "ludo")).toBe("leo");
    expect(agentNameOwnerLabel(me({ display_name: "Leo Guo", email: "x@y.z" }), "ludo")).toBe("Leo Guo");
  });
  test("Lark 无邮箱账号：name 是 provider subject 时退回 slug，不产出 lark-/ou_ 前缀", () => {
    expect(agentNameOwnerLabel(me({ name: "lark-3f9a8b7c6d5e-ludo" }), "ludo")).toBe("ludo");
    expect(agentNameOwnerLabel(me({ name: "ou_9f8e7d6c5b4a3210" }), "ludo")).toBe("ludo");
    expect(agentNameOwnerLabel(me({ name: "lark:on_abcdef" }), "ludo")).toBe("ludo");
  });
  test("不透明 id 出现在更高一级时跳到下一级，而不是整体放弃", () => {
    expect(agentNameOwnerLabel(me({ handle: "ou_9f8e7d6c5b4a3210", display_name: "Leo" }), "ludo")).toBe("Leo");
    expect(agentNameOwnerLabel(me({ display_name: "   ", email: "  ", name: "leo" }), "ludo")).toBe("leo");
  });
  test("me 为空时退回 slug", () => {
    expect(agentNameOwnerLabel(null, "ludo")).toBe("ludo");
  });
});
