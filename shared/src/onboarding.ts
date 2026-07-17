// 接入包（web AgentJoin / cli party invite）共用的生成规则。两条邀请路径发出的
// 命令必须逐字节同语义——规则只放这一份，别在 web/cli 各自复刻（#585）。

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

/** agent/成员名的合法形状（与 cli/src/validation.ts 的 NAME_RE 同一约束）。 */
export const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function mcpServerName(agentName: string): string {
  const cleaned = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (cleaned === agentName) return `party-${agentName}`;
  let h = 5381;
  for (let i = 0; i < agentName.length; i += 1) h = (Math.imul(h, 33) ^ agentName.charCodeAt(i)) >>> 0;
  return `party-${cleaned}-${h.toString(36)}`;
}
