import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { CollaborationRole } from "@agentparty/shared";
import { useT, type TFunc } from "../../i18n/useT";
import "../../i18n/strings/TeamBoard";
import { presenceStateLabel } from "../../lib/presenceLabels";
import { TEAM_LANES, type TeamBoardModel, type TeamCard, type TeamLane, type TeamUnassignedRole } from "../../lib/teamBoard";
import { TeamSquads, type TeamSquadDraft } from "./TeamSquads";

/** 与 Channel.tsx 的 RoleDraft 同形，避免组件依赖页面文件。 */
export interface TeamRoleDraft {
  role: CollaborationRole;
  responsibility: string;
  reportsTo?: string | null;
}

export interface TeamBoardProps {
  model: TeamBoardModel;
  now: number;
  canModerate: boolean;
  /** 正在保存的成员名（禁用该卡的表单）。 */
  roleSaving?: string | null;
  roleError?: string | null;
  onSaveRole?: (name: string, draft: TeamRoleDraft) => Promise<boolean>;
  onDeleteRole?: (name: string) => void;
  onOpenAgentDetail?: (name: string) => void;
  onOpenTask?: (id: number) => void;
  /** 离线 / 叫不醒的 agent 一键接回（复用名单弹窗的接回引导）。 */
  onReconnect?: (name: string) => void;
  /** #1060 PR C：把某个 agent 设为频道主持（走角色写路径）。 */
  onAssignHost?: (name: string) => Promise<boolean>;
  squadSaving?: string | null;
  squadError?: string | null;
  onCreateSquad?: (name: string, draft: TeamSquadDraft) => Promise<boolean>;
  onUpdateSquad?: (name: string, draft: TeamSquadDraft) => Promise<boolean>;
  onDeleteSquad?: (name: string) => Promise<boolean>;
}

const ROLE_OPTIONS: readonly CollaborationRole[] = ["host", "worker", "reviewer", "observer"];

export function teamAge(ts: number | null, now: number, t: TFunc): string {
  if (ts === null) return "";
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return t("TeamBoard.age.now");
  if (diff < 3_600_000) return t("TeamBoard.age.m", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("TeamBoard.age.h", { n: Math.floor(diff / 3_600_000) });
  return t("TeamBoard.age.d", { n: Math.floor(diff / 86_400_000) });
}

function initials(display: string): string {
  const s = display.trim();
  if (s === "") return "?";
  // 中文/日文名取首字；ASCII 取首字母（最多两段）。
  if (/^[　-鿿]/.test(s)) return s.slice(0, 1);
  const parts = s.split(/[\s._-]+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

function roleLabel(role: CollaborationRole | null, t: TFunc): string {
  return role === null ? t("TeamBoard.role.none") : t(`TeamBoard.role.${role}`);
}

function Avatar({ card }: { card: TeamCard }) {
  const src = card.avatarThumb ?? card.avatarUrl;
  return (
    <span className={`team-card-ava team-card-ava--${card.kind === "human" ? "human" : "agent"}`} aria-hidden="true">
      {src ? <img src={src} alt="" /> : <span>{initials(card.display)}</span>}
    </span>
  );
}

function RoleEditor({
  card,
  members,
  saving,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  card: TeamCard;
  members: TeamCard[];
  saving: boolean;
  error: string | null;
  onSave: (draft: TeamRoleDraft) => Promise<boolean>;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [role, setRole] = useState<CollaborationRole>(card.role.role ?? "worker");
  const [responsibility, setResponsibility] = useState(card.role.responsibility ?? "");
  const [reportsTo, setReportsTo] = useState<string>(card.reportsTo ?? "");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await onSave({ role, responsibility: responsibility.trim(), reportsTo: reportsTo === "" ? null : reportsTo });
    if (ok) onClose();
  };
  return (
    <form className="team-card-edit" onSubmit={submit} aria-label={t("TeamBoard.role.editTitle", { name: card.display })}>
      <label>
        <span>{t("TeamBoard.role.edit")}</span>
        <select value={role} onChange={(e) => setRole(e.target.value as CollaborationRole)} disabled={saving}>
          {ROLE_OPTIONS.map((option) => (
            <option key={option} value={option}>{t(`TeamBoard.role.${option}`)}</option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("TeamBoard.role.responsibility")}</span>
        <input
          value={responsibility}
          onChange={(e) => setResponsibility(e.target.value)}
          placeholder={t("TeamBoard.role.responsibilityPlaceholder")}
          disabled={saving}
          maxLength={200}
        />
      </label>
      <label>
        <span>{t("TeamBoard.role.reportsTo")}</span>
        <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} disabled={saving}>
          <option value="">{t("TeamBoard.role.reportsToNone")}</option>
          {members.filter((m) => m.name !== card.name && m.kind !== "human").map((m) => (
            <option key={m.name} value={m.name}>{m.display}</option>
          ))}
        </select>
      </label>
      {error !== null && <p className="team-card-edit-error" role="alert">{error}</p>}
      <div className="team-card-edit-actions">
        <button type="submit" className="d-btn d-btn--primary" disabled={saving}>{t("TeamBoard.role.save")}</button>
        {onDelete !== undefined && card.role.confirmation === "confirmed" && (
          <button type="button" className="d-btn d-btn--danger" disabled={saving} onClick={onDelete}>{t("TeamBoard.role.clear")}</button>
        )}
        <button type="button" className="d-btn" disabled={saving} onClick={onClose}>{t("TeamBoard.role.cancel")}</button>
      </div>
    </form>
  );
}

function Card({
  card,
  members,
  now,
  canModerate,
  editing,
  saving,
  error,
  onEdit,
  onCloseEdit,
  onSaveRole,
  onDeleteRole,
  onOpenAgentDetail,
  onOpenTask,
  onReconnect,
  onAssignHost,
}: {
  card: TeamCard;
  members: TeamCard[];
  now: number;
  canModerate: boolean;
  editing: boolean;
  saving: boolean;
  error: string | null;
  onEdit: () => void;
  onCloseEdit: () => void;
  onSaveRole?: (name: string, draft: TeamRoleDraft) => Promise<boolean>;
  onDeleteRole?: (name: string) => void;
  onOpenAgentDetail?: (name: string) => void;
  onOpenTask?: (id: number) => void;
  onReconnect?: (name: string) => void;
  onAssignHost?: (name: string) => Promise<boolean>;
}) {
  const t = useT();
  const isAgent = card.kind !== "human";
  const canAssignHost = canModerate && onAssignHost !== undefined && isAgent && card.role.role !== "host" && card.lane !== "offline";
  const stateText = card.presence === null || card.presence.state === ("online" as never)
    ? (card.online ? t("TeamBoard.status.online") : presenceStateLabel("offline", t))
    : presenceStateLabel(card.presence.state, t);
  const lastSeen = card.lane === "offline" && card.lastSeen !== null ? teamAge(card.lastSeen, now, t) : null;
  const canReconnect = onReconnect !== undefined && isAgent && !card.paused && (card.lane === "offline" || card.presence?.wake_block !== undefined);
  const showEdit = canModerate && onSaveRole !== undefined && isAgent;
  const relations = [
    card.reportsTo !== null ? t("TeamBoard.doing.reportsTo", { name: card.reportsTo }) : null,
    card.reportsTo === null && card.lineageParent !== null ? t("TeamBoard.doing.spawnedBy", { name: card.lineageParent }) : null,
  ].filter((x): x is string => x !== null);

  return (
    <li className={`team-card team-card--${card.lane}`} data-name={card.name} data-lane={card.lane}>
      <div className="team-card-head">
        <Avatar card={card} />
        <div className="team-card-id">
          <div className="team-card-line">
            {onOpenAgentDetail ? (
              <button type="button" className="team-card-name" onClick={() => onOpenAgentDetail(card.name)} title={t("TeamBoard.action.detail", { name: card.display })}>
                {card.display}
              </button>
            ) : (
              <span className="team-card-name">{card.display}</span>
            )}
            <span className={`presence-kind presence-kind--${card.kind}`}>{t(`TeamBoard.kind.${card.kind === "human" ? "human" : "agent"}`)}</span>
            {card.owner !== null && <span className="team-card-owner">· {card.owner}</span>}
            {card.host !== null && (
              <span
                className={`team-card-host team-card-host--${card.host.lease}`}
                title={card.host.lease === "stale" ? t("TeamBoard.host.staleTitle", { reason: card.host.staleReason ?? "" }) : undefined}
              >
                ★ {t(card.host.lease === "active" ? "TeamBoard.host.active" : "TeamBoard.host.stale")}
              </span>
            )}
          </div>
          <div className="team-card-line team-card-roleline">
            <span className={`team-card-role team-card-role--${card.role.role ?? "none"}`}>{roleLabel(card.role.role, t)}</span>
            {card.role.responsibility !== null && <span className="team-card-resp">{card.role.responsibility}</span>}
            {card.role.confirmation === "unconfirmed" && (
              <span className="team-card-unconfirmed">
                {t("TeamBoard.role.unconfirmed")}
                {showEdit && (
                  <button
                    type="button"
                    className="team-card-linkbtn"
                    disabled={saving}
                    onClick={() => void onSaveRole!(card.name, { role: card.role.role!, responsibility: card.role.responsibility ?? "" })}
                  >
                    {t("TeamBoard.role.confirm")}
                  </button>
                )}
              </span>
            )}
            {relations.map((text) => <span key={text} className="team-card-rel">{text}</span>)}
            {card.squads.map((squad) => <span key={squad} className="team-card-squad">{t("TeamBoard.doing.squad", { name: squad })}</span>)}
          </div>
        </div>
        <div className="team-card-actions">
          {canReconnect && (
            <button type="button" className="d-btn d-btn--primary team-card-reconnect" onClick={() => onReconnect!(card.name)} title={t("TeamBoard.action.reconnectTitle")}>
              {t("TeamBoard.action.reconnect")}
            </button>
          )}
          {canAssignHost && !editing && (
            <button type="button" className="d-btn team-card-hostbtn" disabled={saving} onClick={() => { void onAssignHost!(card.name); }} title={t("TeamBoard.action.assignHostTitle", { name: card.display })}>
              ★ {t("TeamBoard.action.assignHost")}
            </button>
          )}
          {showEdit && !editing && (
            <button type="button" className="d-btn team-card-editbtn" onClick={onEdit} title={t("TeamBoard.role.editTitle", { name: card.display })}>
              {t("TeamBoard.role.edit")}
            </button>
          )}
        </div>
      </div>

      <div className="team-card-status">
        <i className={`d-dot d-dot--${card.lane === "offline" ? "offline" : (card.presence?.state ?? "online")}${card.paused ? " d-dot--paused" : ""}`} aria-hidden="true" />
        <span>{stateText}</span>
        {card.paused && <span className="team-card-chip team-card-chip--paused">⏸ {t("TeamBoard.status.paused")}</span>}
        {card.busy && (
          <span className="team-card-chip team-card-chip--busy">
            {card.queueDepth > 0 ? t("TeamBoard.status.busyQueue", { count: card.queueDepth }) : t("TeamBoard.status.busy")}
          </span>
        )}
        {card.waitingOwnerCount > 0 && <span className="team-card-chip team-card-chip--blocked">{t("TeamBoard.status.waitingOwner", { count: card.waitingOwnerCount })}</span>}
        {card.unhandledMentions > 0 && <span className="team-card-chip team-card-chip--warn">{t("TeamBoard.status.unhandled", { count: card.unhandledMentions })}</span>}
        {lastSeen !== null && <span className="team-card-muted">{t("TeamBoard.status.lastSeen", { time: lastSeen })}</span>}
      </div>

      {(card.doing.taskId !== null || card.doing.activity !== null || card.doing.repo !== null) && (
        <div className="team-card-doing">
          {card.doing.taskId !== null && (
            onOpenTask ? (
              <button type="button" className="team-card-task" onClick={() => onOpenTask(card.doing.taskId!)} title={t("TeamBoard.work.openTask", { id: card.doing.taskId })}>
                ▶ {card.doing.taskTitle !== null ? t("TeamBoard.doing.task", { id: card.doing.taskId, title: card.doing.taskTitle }) : t("TeamBoard.doing.taskNoTitle", { id: card.doing.taskId })}
              </button>
            ) : (
              <span className="team-card-task">▶ {card.doing.taskTitle !== null ? t("TeamBoard.doing.task", { id: card.doing.taskId, title: card.doing.taskTitle }) : t("TeamBoard.doing.taskNoTitle", { id: card.doing.taskId })}</span>
            )
          )}
          {card.doing.heartbeatAt !== null && card.lane === "working" && (
            <span className="team-card-muted">♥ {t("TeamBoard.doing.heartbeat", { age: teamAge(card.doing.heartbeatAt, now, t) })}</span>
          )}
          {card.doing.activity !== null && (
            <span className="team-card-activity">{card.doing.activity.phase}{card.doing.activity.tool ? ` · ${card.doing.activity.tool}` : ""}</span>
          )}
          {card.doing.repo !== null && (
            <span className="presence-git-context">{card.doing.repo}{card.doing.branch !== null ? `@${card.doing.branch}` : ""}</span>
          )}
        </div>
      )}

      {(card.work.inProgress + card.work.queued + card.work.review + card.work.blocked) > 0 && (
        <div className="team-card-work">
          {card.work.blocked > 0 && <span className="team-card-chip team-card-chip--blocked">{t("TeamBoard.work.blocked", { count: card.work.blocked })}</span>}
          {card.work.inProgress > 0 && <span className="team-card-chip">{t("TeamBoard.work.inProgress", { count: card.work.inProgress })}</span>}
          {card.work.review > 0 && <span className="team-card-chip">{t("TeamBoard.work.review", { count: card.work.review })}</span>}
          {card.work.queued > 0 && <span className="team-card-chip">{t("TeamBoard.work.queued", { count: card.work.queued })}</span>}
          {onOpenTask && card.work.tasks.slice(0, 3).map((task) => (
            <button key={task.id} type="button" className="team-card-linkbtn" onClick={() => onOpenTask(task.id)} title={t("TeamBoard.work.openTask", { id: task.id })}>
              #{task.id}
            </button>
          ))}
        </div>
      )}

      {editing && onSaveRole !== undefined && (
        <RoleEditor
          card={card}
          members={members}
          saving={saving}
          error={error}
          onSave={(draft) => onSaveRole(card.name, draft)}
          onDelete={onDeleteRole !== undefined ? () => { onDeleteRole(card.name); onCloseEdit(); } : undefined}
          onClose={onCloseEdit}
        />
      )}
    </li>
  );
}

function UnassignedRoles({
  roles,
  members,
  canModerate,
  saving,
  onSaveRole,
  onDeleteRole,
}: {
  roles: TeamUnassignedRole[];
  members: TeamCard[];
  canModerate: boolean;
  saving: string | null;
  onSaveRole?: (name: string, draft: TeamRoleDraft) => Promise<boolean>;
  onDeleteRole?: (name: string) => void;
}) {
  const t = useT();
  if (roles.length === 0) return null;
  const agents = members.filter((m) => m.kind !== "human");
  return (
    <section className="team-unassigned" aria-label={t("TeamBoard.unassigned.title")}>
      <h3>{t("TeamBoard.unassigned.title")} <span className="team-lane-count">{roles.length}</span></h3>
      <p className="team-card-muted">{t("TeamBoard.unassigned.hint")}</p>
      <ul>
        {roles.map((role) => (
          <li key={`${role.role}:${role.name}`} className="team-unassigned-row" data-role={role.role} data-name={role.name}>
            <span className={`team-card-role team-card-role--${role.role}`}>{roleLabel(role.role, t)}</span>
            {role.responsibility !== null && <span className="team-card-resp">{role.responsibility}</span>}
            <span className="team-card-muted">{t("TeamBoard.unassigned.was", { name: role.name })}</span>
            {canModerate && onSaveRole !== undefined && agents.length > 0 && (
              <select
                className="team-unassigned-assign"
                aria-label={t("TeamBoard.unassigned.assignTitle")}
                value=""
                disabled={saving !== null}
                onChange={(e) => {
                  const target = e.target.value;
                  if (target === "") return;
                  void onSaveRole(target, { role: role.role, responsibility: role.responsibility ?? "", reportsTo: role.reportsTo }).then((ok) => {
                    if (ok && onDeleteRole !== undefined) onDeleteRole(role.name);
                  });
                }}
              >
                <option value="">{t("TeamBoard.unassigned.assign")}</option>
                {agents.map((m) => <option key={m.name} value={m.name}>{m.display}</option>)}
              </select>
            )}
            {canModerate && onDeleteRole !== undefined && (
              <button type="button" className="team-card-linkbtn" disabled={saving !== null} onClick={() => onDeleteRole(role.name)}>
                {t("TeamBoard.unassigned.remove")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TeamBoard({
  model,
  now,
  canModerate,
  roleSaving = null,
  roleError = null,
  onSaveRole,
  onDeleteRole,
  onOpenAgentDetail,
  onOpenTask,
  onReconnect,
  onAssignHost,
  squadSaving = null,
  squadError = null,
  onCreateSquad,
  onUpdateSquad,
  onDeleteSquad,
}: TeamBoardProps) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  // squad 筛选：只看某个小队的成员；小队被删掉时自动回到全部。
  const [squadFilter, setSquadFilter] = useState<string | null>(null);
  useEffect(() => {
    if (squadFilter !== null && !model.squads.some((squad) => squad.name === squadFilter)) setSquadFilter(null);
  }, [squadFilter, model.squads]);
  const laneCards = useMemo(() => {
    if (squadFilter === null) return model.lanes;
    const squad = model.squads.find((s) => s.name === squadFilter);
    const allowed = new Set([...(squad?.members ?? []), ...(squad?.leader ? [squad.leader] : [])]);
    return model.lanes.map(({ lane, cards }) => ({ lane, cards: cards.filter((card) => allowed.has(card.name)) }));
  }, [model.lanes, model.squads, squadFilter]);
  // 正在编辑的成员离开了看板 → 关掉表单，别留一个指向空成员的编辑态。
  useEffect(() => {
    if (editing !== null && !model.cards.some((card) => card.name === editing)) setEditing(null);
  }, [editing, model.cards]);
  const laneLabel = useMemo(() => Object.fromEntries(TEAM_LANES.map((lane) => [lane, t(`TeamBoard.lane.${lane}`)])) as Record<TeamLane, string>, [t]);
  const { counts } = model;

  return (
    <section className="team-board" aria-label={t("TeamBoard.aria")}>
      <header className="team-board-head">
        <h2 className="team-board-title">{t("TeamBoard.title")}</h2>
        <div className="team-board-counts" role="list">
          {TEAM_LANES.map((lane) => counts[lane] > 0 && (
            <span key={lane} className={`team-board-count team-board-count--${lane}`} role="listitem">
              <i className="team-lane-dot" aria-hidden="true" /> {counts[lane]} {laneLabel[lane]}
            </span>
          ))}
          <span className="team-board-count team-card-muted" role="listitem">
            {t("TeamBoard.counts.people", { count: counts.people })} · {t("TeamBoard.counts.agents", { count: counts.agents })}
          </span>
          {counts.pendingClaims > 0 && <span className="team-board-count team-card-chip team-card-chip--warn" role="listitem">{t("TeamBoard.counts.pendingClaims", { count: counts.pendingClaims })}</span>}
          {counts.unassignedRoles > 0 && <span className="team-board-count team-card-chip team-card-chip--warn" role="listitem">{t("TeamBoard.counts.unassigned", { count: counts.unassignedRoles })}</span>}
        </div>
      </header>

      <UnassignedRoles
        roles={model.unassignedRoles}
        members={model.cards}
        canModerate={canModerate}
        saving={roleSaving}
        onSaveRole={onSaveRole}
        onDeleteRole={onDeleteRole}
      />

      <TeamSquads
        squads={model.squads}
        members={model.cards}
        canModerate={canModerate}
        saving={squadSaving}
        error={squadError}
        filter={squadFilter}
        onFilter={setSquadFilter}
        onCreate={onCreateSquad}
        onUpdate={onUpdateSquad}
        onDelete={onDeleteSquad}
      />

      {model.cards.length === 0 && <p className="team-board-empty">{t("TeamBoard.empty")}</p>}
      {squadFilter !== null && (
        <p className="team-board-filter">
          {t("TeamBoard.squad.filtering", { name: squadFilter })}
          <button type="button" className="team-card-linkbtn" onClick={() => setSquadFilter(null)}>{t("TeamBoard.squad.filterClear")}</button>
        </p>
      )}

      {laneCards.map(({ lane, cards }) => cards.length > 0 && (
        <section key={lane} className={`team-lane team-lane--${lane}`} aria-label={laneLabel[lane]} data-lane={lane}>
          <h3 className="team-lane-head">
            <i className="team-lane-dot" aria-hidden="true" />
            {laneLabel[lane]}
            <span className="team-lane-count">{cards.length}</span>
            {(lane === "blocked" || lane === "waiting") && <span className="team-lane-hint">{t(`TeamBoard.laneHint.${lane}`)}</span>}
          </h3>
          <ul className="team-lane-cards">
            {cards.map((card) => (
              <Card
                key={card.name}
                card={card}
                members={model.cards}
                now={now}
                canModerate={canModerate}
                editing={editing === card.name}
                saving={roleSaving === card.name}
                error={editing === card.name ? roleError : null}
                onEdit={() => setEditing(card.name)}
                onCloseEdit={() => setEditing(null)}
                onSaveRole={onSaveRole}
                onDeleteRole={onDeleteRole}
                onOpenAgentDetail={onOpenAgentDetail}
                onOpenTask={onOpenTask}
                onReconnect={onReconnect}
                onAssignHost={onAssignHost}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
