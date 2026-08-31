// #1018：没被授权的会话照样能用 AgentParty。根因是两条叠加——插件全局启用，于是每个 Claude
// 会话都加载 `party mcp`；而 `~/.agentparty/config.json` 是**无差别兜底**，任何目录都能拿到它。
// 这里钉住的是：工具面只认「绑过」的身份来源，兜底那条一律拒，且拒绝要能照做。
import { describe, expect, test } from "bun:test";
import {
  MCP_OPT_IN_ENV,
  inspectMcpSessionBinding,
  mcpSessionBindingDenial,
} from "../src/mcp-session-binding";

describe("mcp session binding gate (#1018)", () => {
  test("全局兜底是唯一被拒的来源；绑过的三条路都放行", () => {
    const at = (kind: "explicit" | "workspace" | "global" | "none", env: NodeJS.ProcessEnv = {}) =>
      inspectMcpSessionBinding({ configSourceKind: kind, env });

    // AGENTPARTY_CONFIG 显式指定 / cwd breadcrumb（也报 explicit）
    expect(at("explicit")).toEqual({ bound: true, via: "explicit_config" });
    // party join / party init 写的该目录自己的 config
    expect(at("workspace")).toEqual({ bound: true, via: "workspace_config" });
    // 这一条就是「没授权却能用」的来源
    expect(at("global")).toEqual({ bound: false, reason: "global_fallback" });
  });

  test("显式指过 AGENTPARTY_HOME 不算兜底——那与 AGENTPARTY_CONFIG 同类，也是按进程树的选择", () => {
    expect(inspectMcpSessionBinding({ configSourceKind: "global", env: { AGENTPARTY_HOME: "/tmp/h" } }))
      .toEqual({ bound: true, via: "explicit_home" });
    // 空串不算「指过」，否则一个被清空的变量会静默放行。
    expect(inspectMcpSessionBinding({ configSourceKind: "global", env: { AGENTPARTY_HOME: "" } }).bound).toBe(false);
  });

  test("进程树 opt-in 压过来源判定——那是 owner 亲手起的会话", () => {
    expect(inspectMcpSessionBinding({ configSourceKind: "global", env: { [MCP_OPT_IN_ENV]: "1" } }))
      .toEqual({ bound: true, via: "opt_in_env" });
    // 只认 "1"：别的取值（含空串、"0"、"true"）不算授权，免得半配置状态被当成放行。
    for (const value of ["", "0", "true", "yes"]) {
      expect(inspectMcpSessionBinding({ configSourceKind: "global", env: { [MCP_OPT_IN_ENV]: value } }).bound)
        .toBe(false);
    }
  });

  test("env 不在这个进程树里就不生效（别的会话是另一棵树）", () => {
    // 判据只看传进来的 env 快照，不读 process.env——同机另一个会话的 env 根本不可见。
    expect(inspectMcpSessionBinding({ configSourceKind: "global", env: {} }).bound).toBe(false);
  });

  test("拒绝文案给出三条能照做的路，且不泄露那个身份是谁", () => {
    const denial = mcpSessionBindingDenial("/Users/leo/.agentparty/config.json");
    expect(denial).toContain("party claude <channel>");
    expect(denial).toContain("party join <invite>");
    expect(denial).toContain(MCP_OPT_IN_ENV);
    expect(denial).toContain("/Users/leo/.agentparty/config.json");
    // 会话没被授予那个身份，就不该从拒绝信息里得知它叫什么。
    expect(denial).not.toMatch(/logged in as|identity=/);
    expect(mcpSessionBindingDenial(null)).toContain("the global config");
  });
});
