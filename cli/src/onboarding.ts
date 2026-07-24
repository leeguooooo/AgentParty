import { channelDecisionSnapshotBodyLines, charterSnapshotBodyLines } from "@agentparty/shared/onboarding";
import type { ChannelCharter } from "./rest";

export function formatScopeGuardForOnboarding(slug: string): string[] {
  return [
    `# AgentParty onboarding scope: join the existing channel #${slug} using only the supplied party commands.`,
    "# Do not create or select another channel; do not use third-party or project-local channel workflows (for example, Trellis); do not delegate onboarding.",
  ];
}

export function formatCharterSnapshotForOnboarding(charter: ChannelCharter | null): string[] {
  const charterLines = charter?.charter
    ? [
        "# ----- BEGIN CHANNEL CHARTER -----",
        // 公告正文必须整体注释化：接入包约定「不带 # 的行是要执行的命令」，charter 由频道管理员
        // 可控——逐字插入等于让对方频道的管理员向接入方终端注入任意命令。空行补 "#" 防漏出裸行；
        // 正文先剥控制字节（ESC/CSI/CR 能视觉覆盖注释前缀），清洗逻辑在 shared 与 web 共用一份。
        ...charterSnapshotBodyLines(charter.charter).map((line) => (line === "" ? "#" : `# ${line}`)),
        "# ----- END CHANNEL CHARTER -----",
      ]
    : [];
  const decisionLines = channelDecisionSnapshotBodyLines(charter?.active_decisions ?? [])
    .map((line) => `# ${line}`);
  if (charterLines.length === 0 && decisionLines.length === 0) return [];
  return [
    "# 频道公告 / 用前必读（生成接入包时的快照；活文档用 party charter 看最新）",
    ...charterLines,
    ...(charterLines.length > 0 && decisionLines.length > 0 ? ["#"] : []),
    ...decisionLines,
    "",
  ];
}
