import type { PresenceEntry, Sender } from "@agentparty/shared";

/** 频道里「在线」的名字：已连接的参与者 ∪ presence 里 live 的条目。 */
export function teamMemberOnlineNames(presence: PresenceEntry[], participants: Sender[]): Set<string> {
  const onlineNames = new Set(participants.map((participant) => participant.name));
  for (const entry of presence) {
    if (entry.live === true) onlineNames.add(entry.name);
  }
  return onlineNames;
}
