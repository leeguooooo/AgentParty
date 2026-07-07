import type { ChannelCharter } from "./rest";

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
