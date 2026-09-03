import type { MsgFrame, PresenceEntry, PublicDirectedDelivery, Sender, TaskRecord } from "@agentparty/shared";

// #187：agent 维度看板——每个 agent 在忙/空闲/阻塞/离线，手里在做/排队/待审/受阻多少任务。
// 纯只读聚合：合并 presence、task 台账与可靠投递状态；delivery/current_task 反指消息正文，直接说明在忙什么。
export type AgentBoardStatus = "busy" | "blocked" | "idle" | "offline";
export const AGENT_STATUS_ORDER: Record<AgentBoardStatus, number> = { busy: 0, blocked: 1, idle: 2, offline: 3 };
export const ACTIVE_DELIVERY_STATES = new Set<PublicDirectedDelivery["state"]>(["queued", "claimed", "running", "waiting_owner"]);
// 一个 agent 积压几十条排队投递时，卡片不能被撑成整屏——只展示最近几条，其余折叠成一行计数。
export const AGENT_BOARD_MAX_WORK_ROWS = 5;

export function activeDeliveryTargets(deliveries: PublicDirectedDelivery[]): string[] {
  return [...new Set(deliveries.filter((delivery) => ACTIVE_DELIVERY_STATES.has(delivery.state)).map((delivery) => delivery.target_name))];
}

function agentWorkSummary(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}…` : compact;
}

// 已撤回消息的本地行是 [retracted] 占位甚至历史残留，正文和 delivery.preview 都不可再展示。
export function agentWorkSummaryFor(message: MsgFrame | undefined, preview?: string | null): string {
  if (message?.retracted === true) return "";
  return agentWorkSummary(message?.body ?? "") || (preview ?? "");
}

export function agentPresenceSummary(
  presence: PresenceEntry[],
  participants: Sender[],
  taskAgentNames: Iterable<string> = [],
  memberNames?: ReadonlySet<string>,
) {
  const included = (name: string) => memberNames === undefined || memberNames.has(name);
  const participantKinds = new Map(participants.map((participant) => [participant.name, participant.kind]));
  const agentNames = new Set<string>();
  for (const entry of presence) {
    if (included(entry.name) && (participantKinds.get(entry.name) ?? entry.kind) !== "human") agentNames.add(entry.name);
  }
  for (const participant of participants) {
    if (!included(participant.name)) continue;
    if (participant.kind === "agent") agentNames.add(participant.name);
    else agentNames.delete(participant.name);
  }
  for (const name of taskAgentNames) {
    if (included(name)) agentNames.add(name);
  }

  // participants is the Durable Object's authoritative list of currently open
  // connections. A freshly connected agent does not necessarily have a
  // persisted presence row yet, so presence.live alone under-counts the board.
  const onlineNames = new Set(
    participants
      .filter((participant) => participant.kind === "agent" && included(participant.name))
      .map((participant) => participant.name),
  );
  for (const entry of presence) {
    if (
      included(entry.name)
      && entry.live === true
      && (participantKinds.get(entry.name) ?? entry.kind) !== "human"
    ) {
      onlineNames.add(entry.name);
    }
  }
  return { agentNames, onlineNames, online: onlineNames.size, offline: agentNames.size - onlineNames.size };
}

export function teamMemberOnlineNames(
  presence: PresenceEntry[],
  participants: Sender[],
): Set<string> {
  const onlineNames = new Set(participants.map((participant) => participant.name));
  for (const entry of presence) {
    if (entry.live === true) onlineNames.add(entry.name);
  }
  return onlineNames;
}

export function teamMemberPresenceSummary(
  memberNames: ReadonlySet<string>,
  onlineNames: ReadonlySet<string>,
): { online: number; offline: number } {
  let online = 0;
  for (const name of memberNames) {
    if (onlineNames.has(name)) online += 1;
  }
  return { online, offline: memberNames.size - online };
}

export function agentBoardTaskAssignee(task: TaskRecord): string | null {
  const name = task.assignee?.name;
  if (!name || task.assignee?.kind !== "agent") return null;
  return task.state === "in_progress" || task.state === "assigned" || task.state === "needs_review" || task.state === "blocked"
    ? name
    : null;
}
