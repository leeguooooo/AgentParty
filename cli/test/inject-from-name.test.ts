import { describe, expect, test } from "bun:test";
import { friendlyAgentLabel, generatedAgentRole } from "@agentparty/shared/identity";
import { wrapCrossSessionMessage } from "../src/claude-inbox-inject";
import {
  injectFromName,
  senderFriendlyName,
  senderInjectFromName,
  wakeProxyNote,
  wakeProxyNoteFromId,
} from "../src/serve-wake-proxy";
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

describe("injectFromName / senderInjectFromName（#986：主名只放友好名）", () => {
  test("serve 路径：from-name 只放本机 identity 的友好名，不再拼技术 ID", () => {
    expect(injectFromName("dev", identity({ owner_display_name: "leo" }))).toBe("leo · agentparty");
    expect(injectFromName("dev", identity({ owner_display_name: "leo" }))).not.toContain("lark-ad72b3f97491");
  });

  test("技术 ID 走正文 from-id 元信息行，仍可逐字读回（防冒充字段不丢）", () => {
    const note = wakeProxyNote({ channel: "dev", server: "https://a.example.com", seq: 7, fromId: "lark-ad72b3f9749e" });
    expect(wakeProxyNoteFromId(note)).toBe("lark-ad72b3f9749e");
    // 没给 ⇒ 不写、读回 null；空白/空串同样当没有。
    expect(wakeProxyNoteFromId(wakeProxyNote({ channel: "dev", server: "x", seq: 7 }))).toBeNull();
    expect(wakeProxyNoteFromId(wakeProxyNote({ channel: "dev", server: "x", seq: 7, fromId: "  " }))).toBeNull();
    // 指针正文本身不变：仍是 channel+seq。
    expect(note).toContain("#dev");
    expect(note).toContain("seq=7");
  });

  test("单发信人 ⇒ from-name 恰为 `leo`（owner 真机形态：人类账号技术 ID + display_name）", () => {
    const leo = { name: "lark-ad72b3f9749e", kind: "human", display_name: "leo", owner: "leo@example.com" };
    expect(senderInjectFromName(leo, "dev")).toBe("leo");
    // 名册里只有自己 / 只有不同名的人 ⇒ 同样不加后缀。
    expect(senderInjectFromName(leo, "dev", [leo])).toBe("leo");
    expect(senderInjectFromName(leo, "dev", [leo, { name: "lark-0000aaaa1111", kind: "human", display_name: "bob" }]))
      .toBe("leo");
  });

  test("两个友好名相同、技术 ID 不同的发信人 ⇒ 各带短消歧后缀且互不相同", () => {
    const a = { name: "lark-ad72b3f97491", kind: "human", display_name: "leo" };
    const b = { name: "lark-ad72b3f9749e", kind: "human", display_name: "leo" };
    const peers = [a, b];
    const fromA = senderInjectFromName(a, "dev", peers);
    const fromB = senderInjectFromName(b, "dev", peers);
    expect(fromA).not.toBe(fromB);
    expect(fromA).toBe("leo·97491");
    expect(fromB).toBe("leo·9749e");
    // 短码，不是整段 hash：主名里绝不再出现完整技术 ID。
    expect(fromA).not.toContain("lark-ad72b3f97491");
    expect(fromB).not.toContain("lark-ad72b3f9749e");
  });

  test("agent 发信人同理：友好名 `owner · role`，只在撞名时带后缀", () => {
    const a = { name: "lark-ad72b3f97491-agentparty", kind: "agent", owner: "leo@example.com" };
    const b = { name: "lark-ad72b3f9749e-agentparty", kind: "agent", owner: "leo@example.com" };
    expect(senderInjectFromName(a, "dev")).toBe("leo@example.com · agentparty");
    expect(senderInjectFromName(a, "dev", [a, b])).toBe("leo@example.com · agentparty·97491");
    expect(senderInjectFromName(b, "dev", [a, b])).toBe("leo@example.com · agentparty·9749e");
    // 同 owner 不同角色 ⇒ 友好名本就不同，不算撞名。
    const c = { name: "lark-ad72b3f9749e-codex", kind: "agent", owner: "leo@example.com" };
    expect(senderInjectFromName(a, "dev", [a, c])).toBe("leo@example.com · agentparty");
  });

  test("非哈希前缀的 name 提不出角色 ⇒ 友好名就是整个 name，不重复", () => {
    expect(injectFromName("dev", identity({ name: "leeguooooo-codex2-agentparty", owner: "leo@example.com" })))
      .toBe("leo@example.com · leeguooooo-codex2-agentparty");
    expect(senderInjectFromName({ name: "plain-agent", kind: "agent" }, "dev")).toBe("plain-agent");
  });

  test("falls back to the channel when no identity is cached", () => {
    expect(injectFromName("dev", null)).toBe("agentparty#dev");
    expect(senderInjectFromName(undefined, "dev")).toBe("agentparty#dev");
    expect(senderFriendlyName(undefined)).toBeNull();
  });

  test("humans show their readable name (display_name > handle > owner > name)", () => {
    expect(senderInjectFromName({ name: "leo", kind: "human", display_name: "郭立lee" }, "dev")).toBe("郭立lee");
    expect(senderInjectFromName({ name: "lark-1", kind: "human", handle: "leo-h", owner: "leo@example.com" }, "dev"))
      .toBe("leo-h");
    expect(senderInjectFromName({ name: "lark-1", kind: "human", owner: "leo@example.com" }, "dev"))
      .toBe("leo@example.com");
  });

  test("sanitizes characters that would break the receiver's integrity self-check", () => {
    const name = senderInjectFromName({ name: 'we"ird<x>', kind: "agent" }, "dev");
    expect(name).not.toContain('"');
    expect(name).not.toContain("<");
    const human = senderInjectFromName({ name: "lark-1", kind: "human", display_name: 'a"b<c>\nd' }, "dev");
    expect(human).toMatch(/^[^"<>\r\n]+$/);
  });

  test("the wrapped from-name survives an attribute round-trip（含空格/中文/消歧点）", () => {
    for (const fromName of [
      injectFromName("dev", identity({ owner_display_name: "leo" })),
      senderInjectFromName({ name: "leo", kind: "human", display_name: "郭立 lee" }, "dev"),
      senderInjectFromName(
        { name: "lark-ad72b3f9749e", kind: "human", display_name: "leo" },
        "dev",
        [{ name: "lark-ad72b3f97491", kind: "human", display_name: "leo" }],
      ),
    ]) {
      const wrapped = wrapCrossSessionMessage({ fromName, fromMode: "prompting", body: "hi" });
      const match = /^<cross-session-message((?:\s+[a-z-]+="[^"]*")*)>\n([\s\S]*)\n<\/cross-session-message>$/.exec(
        wrapped,
      );
      expect(match).not.toBeNull();
      expect(match![1]).toContain(`from-name="${fromName}"`);
      // 原生接收侧 from-name 字符集 `[^"<>\n\r]+`（#953 守卫同款）。
      expect(fromName).toMatch(/^[^"<>\n\r]+$/);
      expect(match![2]).toBe("hi");
    }
  });
});
