// party mcp 的会话绑定闸（issue #1018）。
//
// 插件是全局启用的，于是**每一个** Claude 会话都会加载 `party mcp`。频道注入那层
// （claude-channel）早就有 opt-in 闸，工具面这层却没有——再叠上 `~/.agentparty/config.json`
// 这条无差别兜底，结果就是：从没接入过的会话照样能以某个 agent 的名义发言（owner 实测，
// 一个与项目无关的目录 `party whoami` 直接拿到活身份）。
//
// 这里掐掉的只有**兜底**那一条来源。判据是「这个身份是不是被绑到了这个会话／这个目录」：
//
//   explicit   AGENTPARTY_CONFIG 显式指定，或 cwd breadcrumb —— 绑过
//   workspace  该目录自己的 config（party join / party init 写的）—— 绑过
//   global     ~/.agentparty/config.json 兜底 —— **没绑过**，正是要挡的
//              （AGENTPARTY_HOME 被显式指过则不算兜底：那与 AGENTPARTY_CONFIG 同类，是按进程树的选择）
//   none       没有任何 config —— 沿用既有的 "no config" 文案，不归本闸管
//
// 另加一条进程树旁路：`party claude` / `party bridge` 起的会话带 AGENTPARTY_MCP_OPT_IN=1。
// env 只沿进程树继承，别的会话是另一棵进程树，天然拿不到——这就是「绑定 session」。
// 刻意**不复用** AGENTPARTY_CLAUDE_CHANNEL_OPT_IN：bridge 会故意删掉那个（避免同时激活
// marketplace 频道 MCP），拿它当工具面的判据会把 bridge 起的会话一起误伤。
//
// 手敲的 `party send` 等 CLI 命令不受影响：闸只在 MCP 这条自动加载的通道上。
import type { ConfigSourceKind } from "./config";

export const MCP_OPT_IN_ENV = "AGENTPARTY_MCP_OPT_IN";

export type McpSessionBinding =
  | { bound: true; via: "opt_in_env" | "explicit_home" | "explicit_config" | "workspace_config" }
  | { bound: false; reason: "global_fallback" };

/**
 * 判这个会话有没有被授予身份。`none` 不进这里——它由调用方沿用既有的 "no config" 文案，
 * 那是「压根没接入过」，不是「继承了别人的身份」。
 */
export function inspectMcpSessionBinding(input: {
  configSourceKind: ConfigSourceKind;
  env: NodeJS.ProcessEnv;
}): McpSessionBinding {
  if (input.env[MCP_OPT_IN_ENV] === "1") return { bound: true, via: "opt_in_env" };
  // AGENTPARTY_HOME 是把整个 home 指到别处——和 AGENTPARTY_CONFIG 同一类的、按进程树生效的
  // 显式选择（serve 的隔离 lane、测试夹具都靠它）。要挡的是**默认那份** ~/.agentparty/config.json
  // 白给每个会话，不是有人明确指了家目录还要拦。
  if ((input.env.AGENTPARTY_HOME ?? "") !== "") return { bound: true, via: "explicit_home" };
  switch (input.configSourceKind) {
    case "explicit":
      return { bound: true, via: "explicit_config" };
    case "workspace":
      return { bound: true, via: "workspace_config" };
    default:
      return { bound: false, reason: "global_fallback" };
  }
}

/**
 * 拒绝时给的话。三条放行路各给一条能照做的命令——**不**打印全局 config 里那个身份的名字：
 * 会话没被授予它，就不该从这里得知它存在。
 */
export function mcpSessionBindingDenial(configPath: string | null): string {
  const where = configPath === null ? "the global config" : `the global config (${configPath})`;
  return [
    `this Claude session was not granted an AgentParty identity: it would fall back to ${where},`,
    "which every session on this machine shares. Pick one:",
    "  party claude <channel>                       start a session bound to that channel",
    "  party join <invite>                          bind this directory's own identity",
    `  ${MCP_OPT_IN_ENV}=1                          deliberate one-off for this process tree`,
  ].join("\n");
}
