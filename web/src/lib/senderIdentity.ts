import type { Sender } from "@agentparty/shared";

export interface SenderIdentitySnapshot {
  ts: number;
  sender: Sender;
}

export const MENTION_SENDER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** 合并新旧协议混杂的 sender 快照：新身份字段优先，缺失/空串时保留旧值。 */
export function mergeSenderIdentity(previous: Sender | undefined, next: Sender): Sender {
  return {
    ...next,
    owner: next.owner || previous?.owner,
    lineage: next.lineage ?? previous?.lineage,
    handle: next.handle || previous?.handle,
    display_name: next.display_name || previous?.display_name,
    avatar_url: next.avatar_url || previous?.avatar_url,
    avatar_thumb: next.avatar_thumb || previous?.avatar_thumb,
    client_version: next.client_version || previous?.client_version,
    connection_count: next.connection_count ?? previous?.connection_count,
  };
}
