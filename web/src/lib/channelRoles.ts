// 频道分工的纯数据层：正式 channel_roles 草稿、presence 自报角色与「未分工」成员归桶。
// 从 pages/Channel.tsx 原样搬出（DivisionBoard 与 ChannelPage 两边共用，避免组件间循环 import）。
import type { CollaborationRole, PresenceEntry, Sender } from "@agentparty/shared";
import type { ChannelIdentity, ChannelRoleInfo } from "./api";
import type { TFunc } from "../i18n/useT";

export const COLLAB_ROLES: CollaborationRole[] = ["host", "worker", "reviewer", "observer"];

export interface RoleDraft {
  role: CollaborationRole;
  responsibility: string;
}

export function roleDraftFrom(role: ChannelRoleInfo): RoleDraft {
  return { role: role.role, responsibility: role.responsibility ?? "" };
}

function selfReportedRoles(
  assignedRoles: ChannelRoleInfo[],
  presence: Record<string, PresenceEntry>,
  identities: ChannelIdentity[],
): ChannelRoleInfo[] {
  const assigned = new Set(assignedRoles.map((role) => role.name));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const roles: ChannelRoleInfo[] = [];
  for (const [name, entry] of Object.entries(presence)) {
    if (assigned.has(name)) continue;
    if (entry.role_source !== "self") continue;
    if (entry.role === undefined || !COLLAB_ROLES.includes(entry.role)) continue;
    const identity = identityByName.get(name);
    const kind = entry.kind ?? identity?.kind;
    const account = entry.account ?? identity?.account;
    roles.push({
      name,
      role: entry.role,
      responsibility: entry.note && entry.note.trim() !== "" ? entry.note : null,
      assigned_by: name,
      assigned_at: entry.ts ?? entry.last_seen ?? 0,
      ...(kind === undefined ? {} : { kind }),
      ...(account === undefined ? {} : { account }),
      display: identity?.display ?? name,
    });
  }
  return roles;
}

interface UnassignedMember {
  name: string;
  display: string;
  accountLabel: string;
  owner: string | null;
  kind: Sender["kind"];
}

// issue #169：分工面板此前只收录「已分配角色」（roles）+「self-report 过角色」
// （presence role_source==="self"）的成员——已连接但从没声明过角色的 agent 会被
// 整条跳过，界面上直接消失（"频道四个 agent 分工面板只有两个"）。这里把他们也
// 收进名单，用「未分工」占位展示，而不是从 roster 里彻底丢失。
// 名单来源取 participants（当前连接）∪ presence（当前/最近连接过）∪ identities
// （channel 曾经见过的身份）的并集，与 Team 头部的权威 roster 口径一致；已在
// roles/selfRoles 里出现的名字（assigned 或 self）不重复收录。
function unassignedMembers(
  assignedRoles: ChannelRoleInfo[],
  selfRoles: ChannelRoleInfo[],
  presence: Record<string, PresenceEntry>,
  identities: ChannelIdentity[],
  participants: Sender[],
  t: TFunc,
): UnassignedMember[] {
  const known = new Set([...assignedRoles, ...selfRoles].map((role) => role.name));
  const identityByName = new Map(identities.map((identity) => [identity.name, identity]));
  const participantByName = new Map(participants.map((participant) => [participant.name, participant]));
  const names = new Set([
    ...Object.keys(presence),
    ...identities.map((identity) => identity.name),
    ...participants.map((participant) => participant.name),
  ]);
  const members: UnassignedMember[] = [];
  for (const name of names) {
    if (name === "system" || known.has(name)) continue;
    const entry = presence[name];
    const identity = identityByName.get(name);
    const participant = participantByName.get(name);
    // Preserve the existing presence → identity authority for current runtime
    // metadata. participants fills the fresh-connection gap but never lets a
    // connection snapshot overwrite an already known presence/identity row.
    const kind = entry?.kind ?? identity?.kind ?? participant?.kind ?? "agent";
    const account = entry?.account ?? identity?.account ?? participant?.owner;
    const participantDisplay = participant?.handle
      ?? (participant?.kind === "human" ? participant.display_name ?? participant.owner : undefined);
    const display = identity?.display ?? participantDisplay ?? name;
    const accountLabel = account && account !== ""
      ? account
      : kind === "human"
        ? display
        : t("Channel.roles.unowned");
    const owner = account && account !== display ? account : null;
    members.push({
      name,
      display,
      accountLabel,
      owner,
      kind,
    });
  }
  return members;
}

export function teamRoleBuckets(
  assignedRoles: ChannelRoleInfo[],
  presence: Record<string, PresenceEntry>,
  identities: ChannelIdentity[],
  participants: Sender[],
  t: TFunc,
): {
  selfReported: ChannelRoleInfo[];
  unassigned: UnassignedMember[];
} {
  const selfReported = selfReportedRoles(assignedRoles, presence, identities);
  return {
    selfReported,
    unassigned: unassignedMembers(assignedRoles, selfReported, presence, identities, participants, t),
  };
}
