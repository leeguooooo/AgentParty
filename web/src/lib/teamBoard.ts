import type {
  AgentActivity,
  ChannelRoleAssignment,
  ChannelSquad,
  CollaborationRole,
  HostBoard,
  PresenceEntry,
  PublicDirectedDelivery,
  Sender,
  TaskRecord,
} from "@agentparty/shared";
import { isOpaqueAccount } from "@agentparty/shared/identity";
import type { ChannelIdentity } from "./api";
import { buildPersonRows } from "./personRoster";
import { resolveTeamMemberView, type TeamMemberRole, type TeamMemberView } from "./teamMember";
import type { TeamSummary } from "./teams";

/**
 * 团队看板的统一模型（#1060 PR B）。
 *
 * 之前「谁负责什么、正在干什么」散在五个组件里各算一遍（角色卡 / 组织树 / 主持看板 / 血缘团队 / agent 泳道）。
 * 这里把 presence、频道角色、任务、定向投递、主持看板、spawn 血缘、squad 合成**一张成员卡一份事实**，
 * 组件只负责画。纯函数，无 React。
 */

/** 泳道：按「需要谁来处理」排序——受阻最前，离线最后。 */
export type TeamLane = "blocked" | "working" | "waiting" | "idle" | "offline";
export const TEAM_LANES: readonly TeamLane[] = ["blocked", "working", "waiting", "idle", "offline"];
const LANE_ORDER: Record<TeamLane, number> = { blocked: 0, working: 1, waiting: 2, idle: 3, offline: 4 };

export interface TeamCardDoing {
  /** 正在处理的任务 id（presence.current_task），没有则 null。 */
  taskId: number | null;
  taskTitle: string | null;
  taskStartedAt: number | null;
  heartbeatAt: number | null;
  /** hook 上报的活动（#602）。 */
  activity: AgentActivity | null;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
}

export interface TeamCardWork {
  inProgress: number;
  queued: number;
  review: number;
  blocked: number;
  /** 分到这个人头上、尚未收尾的任务（按状态优先级排好）。 */
  tasks: TaskRecord[];
  /** 还在跑的定向投递（queued/claimed/running/waiting_owner）。 */
  deliveries: PublicDirectedDelivery[];
}

export interface TeamCard {
  name: string;
  display: string;
  kind: Sender["kind"];
  /** 可读的归属人；不透明账号 id 一律 null。 */
  owner: string | null;
  account: string | null;
  handle: string | null;
  displayName: string | null;
  /** #1067：同一个人的其它会话（本卡是代表）。人按 handle/account 聚合，agent 恒为空。 */
  otherSessions: TeamCard[];
  /** 这个人名下有几个不同账号串（>1 说明登录路径岔开了）。 */
  accountCount: number;
  /** 给 personRoster 用的聚合字段（= presence 状态，离线为 "offline"）。 */
  state: string;
  avatarUrl: string | null;
  avatarThumb: string | null;
  lane: TeamLane;
  online: boolean;
  paused: boolean;
  busy: boolean;
  queueDepth: number;
  waitingOwnerCount: number;
  unhandledMentions: number;
  lastSeen: number | null;
  clientVersion: string | null;
  /** 角色三态：已确认 / 自报待确认 / 未分配。 */
  role: TeamMemberRole;
  reportsTo: string | null;
  /** 主持：来自 hostBoard（服务端口径），lease 表示主持权是否有效。 */
  host: { lease: "active" | "stale"; staleReason: string | null } | null;
  /** spawn 血缘：谁拉起了它（team_id 同组）。 */
  lineageParent: string | null;
  teamId: string | null;
  squads: string[];
  doing: TeamCardDoing;
  work: TeamCardWork;
  agentSession: PresenceEntry["agent_session"] | null;
  presence: PresenceEntry | null;
}

export interface TeamUnassignedRole {
  role: CollaborationRole;
  responsibility: string | null;
  reportsTo: string | null;
  /** 角色行原本指向的名字（可能已离开频道），用于「指派给…」的默认值。 */
  name: string;
}

export interface TeamBoardCounts {
  blocked: number;
  working: number;
  waiting: number;
  idle: number;
  offline: number;
  people: number;
  agents: number;
  unassignedRoles: number;
  pendingClaims: number;
}

export interface TeamBoardModel {
  lanes: Array<{ lane: TeamLane; cards: TeamCard[] }>;
  cards: TeamCard[];
  unassignedRoles: TeamUnassignedRole[];
  counts: TeamBoardCounts;
  squads: ChannelSquad[];
}

export interface BuildTeamBoardInput {
  presence: PresenceEntry[];
  participants: Sender[];
  roles: ChannelRoleAssignment[];
  /** 频道身份表（/api 的 identities）：display / handle / kind / account。 */
  identities?: ChannelIdentity[];
  tasks?: TaskRecord[];
  deliveries?: PublicDirectedDelivery[];
  hostBoard?: HostBoard | null;
  teams?: TeamSummary[];
  squads?: ChannelSquad[];
  /** 只认这些名字为成员（频道成员表）；不传则 presence ∪ participants ∪ roles 全算。 */
  memberNames?: ReadonlySet<string>;
  now: number;
}

const ACTIVE_TASK_STATES: ReadonlySet<TaskRecord["state"]> = new Set(["in_progress", "assigned", "needs_review", "blocked"]);
const TASK_STATE_ORDER: Record<TaskRecord["state"], number> = {
  blocked: 0,
  in_progress: 1,
  needs_review: 2,
  assigned: 3,
  triage: 4,
  backlog: 5,
  done: 6,
};
const ACTIVE_DELIVERY_STATES: ReadonlySet<PublicDirectedDelivery["state"]> = new Set([
  "queued",
  "claimed",
  "running",
  "waiting_owner",
]);

function nonBlank(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value.trim() !== "" ? value : null;
}

function readable(value: string | null | undefined): string | null {
  const v = nonBlank(value);
  return v !== null && !isOpaqueAccount(v) ? v : null;
}

/** 泳道判定。顺序即优先级：受阻（含等 owner 拍板）> 处理中 > 等待 > 在线空闲 > 离线。 */
export function teamLaneOf(
  presence: PresenceEntry | null,
  deliveries: PublicDirectedDelivery[],
  tasks: TaskRecord[],
): TeamLane {
  if (presence === null || presence.state === "offline") return "offline";
  if (presence.state === "blocked" || deliveries.some((d) => d.state === "waiting_owner")) return "blocked";
  if (tasks.some((task) => task.state === "blocked")) return "blocked";
  if (
    presence.state === "working"
    || presence.busy === true
    || presence.current_task !== undefined
    || deliveries.some((d) => d.state === "queued" || d.state === "claimed" || d.state === "running")
    || tasks.some((task) => task.state === "in_progress")
  ) {
    return "working";
  }
  if (presence.state === "waiting" || tasks.some((task) => task.state === "needs_review" || task.state === "assigned")) {
    return "waiting";
  }
  return "idle";
}

function memberDisplay(view: TeamMemberView, presence: PresenceEntry | null, participant: Sender | null, identity: ChannelIdentity | undefined): string {
  return (
    nonBlank(presence?.display_name)
    ?? nonBlank(participant?.display_name)
    ?? nonBlank(presence?.handle)
    ?? nonBlank(participant?.handle)
    ?? nonBlank(identity?.handle)
    ?? view.display
  );
}

export function buildTeamBoard(input: BuildTeamBoardInput): TeamBoardModel {
  const {
    presence,
    participants,
    roles,
    identities,
    tasks = [],
    deliveries = [],
    hostBoard = null,
    teams = [],
    squads = [],
    memberNames,
  } = input;
  const included = (name: string) => memberNames === undefined || memberNames.has(name);

  const presenceByName = new Map(presence.map((entry) => [entry.name, entry]));
  const participantByName = new Map(participants.map((p) => [p.name, p]));
  const roleByName = new Map(roles.map((role) => [role.name, role]));
  const hostByName = new Map((hostBoard?.hosts ?? []).map((host) => [host.name, host]));
  const identityByName = new Map((identities ?? []).map((identity) => [identity.name, identity]));

  const tasksByName = new Map<string, TaskRecord[]>();
  const tasksById = new Map<number, TaskRecord>();
  for (const task of tasks) {
    tasksById.set(task.id, task);
    const name = task.assignee?.name;
    if (!name || task.assignee?.kind === "squad" || !ACTIVE_TASK_STATES.has(task.state)) continue;
    const list = tasksByName.get(name) ?? [];
    list.push(task);
    tasksByName.set(name, list);
  }
  for (const list of tasksByName.values()) {
    list.sort((a, b) => TASK_STATE_ORDER[a.state] - TASK_STATE_ORDER[b.state] || b.updated_at - a.updated_at || a.id - b.id);
  }

  const deliveriesByName = new Map<string, PublicDirectedDelivery[]>();
  for (const delivery of deliveries) {
    if (!ACTIVE_DELIVERY_STATES.has(delivery.state)) continue;
    const list = deliveriesByName.get(delivery.target_name) ?? [];
    list.push(delivery);
    deliveriesByName.set(delivery.target_name, list);
  }
  for (const list of deliveriesByName.values()) {
    list.sort((a, b) => b.updated_at - a.updated_at || b.message_seq - a.message_seq || a.id.localeCompare(b.id));
  }

  const lineageByName = new Map<string, { parent: string | null; teamId: string }>();
  for (const team of teams) {
    for (const member of team.members) {
      lineageByName.set(member.name, { parent: member.parentAgent, teamId: team.teamId });
    }
  }
  const squadsByName = new Map<string, string[]>();
  for (const squad of squads) {
    for (const member of squad.members) {
      const list = squadsByName.get(member) ?? [];
      list.push(squad.name);
      squadsByName.set(member, list);
    }
    if (squad.leader) {
      const list = squadsByName.get(squad.leader) ?? [];
      if (!list.includes(squad.name)) list.push(squad.name);
      squadsByName.set(squad.leader, list);
    }
  }

  // 成员全集：presence ∪ participants ∪ 已分配角色（角色指向的人可能已离线甚至离开）。
  const names = new Set<string>();
  for (const entry of presence) if (included(entry.name)) names.add(entry.name);
  for (const participant of participants) if (included(participant.name)) names.add(participant.name);
  const connectedOrKnown = new Set(names);
  for (const role of roles) if (included(role.name) && connectedOrKnown.has(role.name)) names.add(role.name);

  const cards: TeamCard[] = [];
  for (const name of names) {
    const entry = presenceByName.get(name) ?? null;
    const participant = participantByName.get(name) ?? null;
    const identity = identityByName.get(name);
    const view = resolveTeamMemberView({
      name,
      assignment: roleByName.get(name) ?? null,
      identity: identity ? { display: identity.display, kind: identity.kind, account: identity.account } : null,
      presence: entry,
      participant,
    });
    const memberTasks = tasksByName.get(name) ?? [];
    const memberDeliveries = deliveriesByName.get(name) ?? [];
    const lane = teamLaneOf(entry, memberDeliveries, memberTasks);
    const host = hostByName.get(name);
    const lineage = lineageByName.get(name) ?? null;
    const currentTaskId = entry?.current_task ?? null;
    const currentTask = currentTaskId !== null ? tasksById.get(currentTaskId) ?? null : null;

    cards.push({
      name,
      display: memberDisplay(view, entry, participant, identity),
      kind: view.kind,
      owner: readable(view.owner),
      account: view.account,
      handle: nonBlank(entry?.handle) ?? nonBlank(participant?.handle) ?? nonBlank(identity?.handle),
      displayName: nonBlank(entry?.display_name) ?? nonBlank(participant?.display_name),
      otherSessions: [],
      accountCount: 1,
      state: lane === "offline" ? "offline" : (entry?.state ?? "online"),
      avatarUrl: entry?.avatar_url ?? null,
      avatarThumb: entry?.avatar_thumb ?? null,
      lane,
      online: view.runtime.online,
      paused: entry?.paused === true,
      busy: entry?.busy === true,
      queueDepth: entry?.queue_depth ?? 0,
      // 服务端 waiting_owner_count 只在 >0 时下发；本地定向投递里的 waiting_owner 同样算「等 owner」。
      waitingOwnerCount: Math.max(entry?.waiting_owner_count ?? 0, memberDeliveries.filter((d) => d.state === "waiting_owner").length),
      unhandledMentions: entry?.unhandled_mention_count ?? 0,
      lastSeen: entry?.last_seen ?? entry?.ts ?? null,
      clientVersion: entry?.client_version ?? null,
      role: view.role,
      reportsTo: view.role.reportsTo,
      host: host ? { lease: host.lease, staleReason: host.stale_reason } : null,
      lineageParent: lineage?.parent ?? view.runtime.lineageParent,
      teamId: lineage?.teamId ?? entry?.lineage?.team_id ?? participant?.lineage?.team_id ?? null,
      squads: squadsByName.get(name) ?? [],
      doing: {
        taskId: currentTaskId,
        taskTitle: currentTask?.title ?? null,
        taskStartedAt: entry?.task_started_at ?? null,
        heartbeatAt: entry?.heartbeat_at ?? null,
        activity: entry?.activity ?? null,
        repo: nonBlank(entry?.context?.repo),
        branch: nonBlank(entry?.context?.branch),
        worktree: nonBlank(entry?.context?.worktree_label),
      },
      work: {
        inProgress: memberTasks.filter((task) => task.state === "in_progress").length,
        queued: memberTasks.filter((task) => task.state === "assigned").length,
        review: memberTasks.filter((task) => task.state === "needs_review").length,
        blocked: memberTasks.filter((task) => task.state === "blocked").length,
        tasks: memberTasks,
        deliveries: memberDeliveries,
      },
      agentSession: entry?.agent_session ?? null,
      presence: entry,
    });
  }

  // #1067：人按 handle/account 折成一行（agent 各自成行）；被折起来的会话挂在代表卡的 otherSessions 上。
  const personRows = buildPersonRows<TeamCard>(cards, {
    rank: (card) => LANE_ORDER[card.lane] * 10 + (card.online ? 0 : 1),
  });
  const merged: TeamCard[] = personRows.map((row) => {
    const [primary, ...rest] = row.sessions;
    if (rest.length === 0 && row.accountCount <= 1) return primary!;
    return { ...primary!, display: row.display, owner: row.owner, otherSessions: rest, accountCount: row.accountCount };
  });
  cards.length = 0;
  cards.push(...merged);

  cards.sort((a, b) =>
    LANE_ORDER[a.lane] - LANE_ORDER[b.lane]
    // 同泳道：有主持权的靠前，然后 agent 先于人（人不需要被「盯」），最后按名字稳定。
    || Number(b.host?.lease === "active") - Number(a.host?.lease === "active")
    || Number(a.kind === "human") - Number(b.kind === "human")
    || (a.lane === "offline" ? (b.lastSeen ?? 0) - (a.lastSeen ?? 0) : 0)
    || a.display.localeCompare(b.display),
  );

  // 未认领角色：角色表里有、成员卡里没有（指向的人不在频道）。
  const cardNames = new Set(cards.map((card) => card.name));
  const unassignedRoles: TeamUnassignedRole[] = roles
    .filter((role) => !cardNames.has(role.name))
    .map((role) => ({
      role: role.role,
      responsibility: nonBlank(role.responsibility),
      reportsTo: nonBlank(role.reports_to),
      name: role.name,
    }));

  const lanes = TEAM_LANES.map((lane) => ({ lane, cards: cards.filter((card) => card.lane === lane) }));
  const counts: TeamBoardCounts = {
    blocked: lanes[0]!.cards.length,
    working: lanes[1]!.cards.length,
    waiting: lanes[2]!.cards.length,
    idle: lanes[3]!.cards.length,
    offline: lanes[4]!.cards.length,
    people: cards.filter((card) => card.kind === "human").length,
    agents: cards.filter((card) => card.kind !== "human").length,
    unassignedRoles: unassignedRoles.length,
    pendingClaims: cards.filter((card) => card.role.confirmation === "unconfirmed").length,
  };

  return { lanes, cards, unassignedRoles, counts, squads };
}
