// 接入包（web AgentJoin / cli party invite）共用的生成规则。两条邀请路径发出的
// 命令必须逐字节同语义——规则只放这一份，别在 web/cli 各自复刻（#585）。

/**
 * MCP server 注册名：必须按 agent 唯一。同一目录跑多个 agent 时，固定叫 `party` 会让
 * 后注册的覆盖先注册的身份 env——重启会话后静默串号（比 CLI 忘带前缀更难察觉）。
 * agent 名本身是 NAME_RE 约束的 ASCII，但 `.` 在 Codex 的 TOML 键等处不安全，消毒成 `-`；
 * 消毒有损时（a.b 与 a-b 会同形）追加原名短哈希保持单射，
 * 别让「防覆盖」的规则自己引入新的覆盖面（#583 评审）。
 */
export function mcpServerName(agentName: string): string {
  const cleaned = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (cleaned === agentName) return `party-${agentName}`;
  let h = 5381;
  for (let i = 0; i < agentName.length; i += 1) h = (Math.imul(h, 33) ^ agentName.charCodeAt(i)) >>> 0;
  return `party-${cleaned}-${h.toString(36)}`;
}
