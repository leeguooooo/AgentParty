// 接入包（web AgentJoin / cli party invite）共用的生成规则。两条邀请路径发出的
// 命令必须逐字节同语义——规则只放这一份，别在 web/cli 各自复刻（#585）。
import type { ChannelDecisionRecord } from "./protocol";

/**
 * MCP server 注册名：必须按 agent 唯一。同一目录跑多个 agent 时，固定叫 `party` 会让
 * 后注册的覆盖先注册的身份 env——重启会话后静默串号（比 CLI 忘带前缀更难察觉）。
 * agent 名本身是 NAME_RE 约束的 ASCII，但 `.` 在 Codex 的 TOML 键等处不安全，消毒成 `-`；
 * 消毒有损时（a.b 与 a-b 会同形）追加原名短哈希保持单射，
 * 别让「防覆盖」的规则自己引入新的覆盖面（#583 评审）。
 */
// 公告快照正文的清洗（#587 评审）：charter 由对方频道管理员可控。`#` 前缀防 shell 执行，
// 但 ESC/CSI/CR 等控制字节能伪造终端输出、视觉覆盖注释前缀（人眼看到「裸命令」照抄就中招）。
// 先归一化换行再剥 C0（保留 \t）/DEL/C1/CSI——字符集与 cli/src/format.ts 的
// stripTerminalControls 同一套，web/cli 两个接入包出口共用这一份。
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

export function charterSnapshotBodyLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(ANSI_CSI, "").replace(TERMINAL_CONTROL, ""));
}

function safeSnapshotLine(text: string): string {
  return charterSnapshotBodyLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/** 当前 active 决策的紧凑、终端安全快照；调用方再统一加 shell 注释前缀。 */
export function channelDecisionSnapshotBodyLines(decisions: readonly ChannelDecisionRecord[]): string[] {
  if (decisions.length === 0) return [];
  return [
    "当前已定稿 / Active decisions（权威账本；变更请显式 supersede）",
    ...decisions.map((decision) => {
      const source = decision.source_seq === null ? "" : ` source=#${decision.source_seq}`;
      return `- ${safeSnapshotLine(decision.topic)}: ${safeSnapshotLine(decision.summary)} [${safeSnapshotLine(decision.id)}]${source}`;
    }),
  ];
}

// ── 行为契约（#845）──────────────────────────────────────────────────────────
// 接入包是一次性贴进对话的瞬态文本，上下文被压缩后礼仪约束会蒸发。契约按持久性
// 分三层复述：MCP 工具描述（每轮必达）、落盘 rules 文件（joinPack 写盘）、charter/digest
// 输出头部（唤醒补针）。三层全部引用这里的同一份文本，杜绝漂移。全部是静态常量，
// 不含任何用户/管理员可控输入（charter 注入面的注释化约束见上，别把动态内容混进来）。

/** 单行版：进 MCP 工具描述与 charter/digest 头部。每轮进模型上下文，必须极短、无换行。 */
export const BEHAVIOR_CONTRACT_SUMMARY =
  "行为契约：只在被 @ 或确有话说时发言，回复带 reply_to；blocked/歧义时留频道可见的 waiting 状态；频道是唯一数据源。";

/** 多行版：落盘到 ~/.agentparty/agents/<name>-<slug>.rules.md 的正文。 */
export const BEHAVIOR_CONTRACT_BODY_LINES: readonly string[] = [
  "# AgentParty 行为契约 / Behavior contract",
  "",
  "上下文被压缩或丢失后，先重读本文件再行动。",
  "",
  "- 只在被 @ 或确有话说时发言，别刷屏；回复带 reply_to 指向所答消息。",
  "- blocked 或需求有歧义时，用 party status 留下频道可见的 waiting 状态和问题，别沉默等待。",
  "- 频道是唯一数据源与共识账本：结论、认领、交接都发进频道，不留在本地。",
];

/** agent/成员名的合法形状（与 cli/src/validation.ts 的 NAME_RE 同一约束）。 */
export const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function mcpServerName(agentName: string): string {
  const cleaned = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (cleaned === agentName) return `party-${agentName}`;
  let h = 5381;
  for (let i = 0; i < agentName.length; i += 1) h = (Math.imul(h, 33) ^ agentName.charCodeAt(i)) >>> 0;
  return `party-${cleaned}-${h.toString(36)}`;
}
