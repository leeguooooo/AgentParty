import type { ChannelCharter } from "./rest";

export function formatScopeGuardForOnboarding(slug: string): string[] {
  return [
    `# AgentParty onboarding scope: join the existing channel #${slug} using only the supplied party commands.`,
    "# Do not create or select another channel; do not use third-party or project-local channel workflows (for example, Trellis); do not delegate onboarding.",
  ];
}

export function formatCharterSnapshotForOnboarding(charter: ChannelCharter | null): string[] {
  if (!charter?.charter) return [];
  return [
    "# 频道公告 / 用前必读（生成接入包时的快照；活文档用 party charter 看最新）",
    "# ----- BEGIN CHANNEL CHARTER -----",
    charter.charter,
    "# ----- END CHANNEL CHARTER -----",
    "",
  ];
}
