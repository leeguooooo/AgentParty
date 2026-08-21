import { describe, expect, test } from "bun:test";
import { mcpServerName, MIN_CLI } from "./agentTokenVault";
import * as vault from "./agentTokenVault";

// #902：vault 曾自带一份手写接入包 builder（buildMinimalAgentCommand），与 joinPack 双轨
// 并行且永远落后（缺 harness 分档、缺 `party hook install --codex`）。它已被删除，接入包的
// 唯一 builder 是 joinPack；这里钉住「vault 不再导出任何 builder」，防它被重新长回来。
describe("agentTokenVault", () => {
  test("不再导出平行的接入包 builder——接入包只有 joinPack 一份", () => {
    expect("buildMinimalAgentCommand" in vault).toBe(false);
    expect(Object.keys(vault).filter((key) => key.startsWith("build"))).toEqual([]);
  });

  test("MIN_CLI / VERSION_GE_SNIPPET 仍从 joinPack 透传，桌面消费者不受影响", () => {
    expect(typeof MIN_CLI).toBe("string");
    expect(vault.VERSION_GE_SNIPPET).toContain("version_ge(){ awk");
  });

  test("mcpServerName：`.` 消毒成 `-`，且消毒必须单射——a.b 与 a-b 不得同名（否则同目录注册互相覆盖=串号）", () => {
    expect(mcpServerName("desktop-worker")).toBe("party-desktop-worker");
    // 有损清洗追加原名短哈希；无损名字保持干净、稳定。
    expect(mcpServerName("leo.g_2")).toMatch(/^party-leo-g_2-[0-9a-z]+$/);
    expect(mcpServerName("a.b")).not.toBe(mcpServerName("a-b"));
    expect(mcpServerName("a-b")).toBe("party-a-b");
    expect(mcpServerName("a.b")).toBe(mcpServerName("a.b"));
  });
});
