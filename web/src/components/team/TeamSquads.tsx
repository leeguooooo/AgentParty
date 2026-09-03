import { useState, type FormEvent } from "react";
import type { ChannelSquad } from "@agentparty/shared";
import { useT } from "../../i18n/useT";
import "../../i18n/strings/TeamBoard";
import type { TeamCard } from "../../lib/teamBoard";

/** 与 api.ts 的 SquadWriteBody 同形；组件不直接依赖 api。 */
export interface TeamSquadDraft {
  title?: string | null;
  members?: string[];
  leader?: string | null;
}

export interface TeamSquadsProps {
  squads: ChannelSquad[];
  members: TeamCard[];
  canModerate: boolean;
  saving?: string | null;
  error?: string | null;
  /** 当前按哪个 squad 筛选看板；null = 全部。 */
  filter: string | null;
  onFilter: (name: string | null) => void;
  onCreate?: (name: string, draft: TeamSquadDraft) => Promise<boolean>;
  onUpdate?: (name: string, draft: TeamSquadDraft) => Promise<boolean>;
  onDelete?: (name: string) => Promise<boolean>;
}

const SQUAD_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function MemberPicker({
  members,
  selected,
  onChange,
  disabled,
}: {
  members: TeamCard[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <div className="team-squad-picker" role="group" aria-label={t("TeamBoard.squad.members")}>
      {members.filter((m) => m.kind !== "human").map((m) => {
        const on = selected.includes(m.name);
        return (
          <label key={m.name} className={`team-squad-pick${on ? " is-on" : ""}`}>
            <input
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={() => onChange(on ? selected.filter((n) => n !== m.name) : [...selected, m.name])}
            />
            {m.display}
          </label>
        );
      })}
    </div>
  );
}

function SquadForm({
  initial,
  members,
  saving,
  error,
  onSubmit,
  onCancel,
  nameLocked,
}: {
  initial: { name: string; title: string; members: string[]; leader: string };
  members: TeamCard[];
  saving: boolean;
  error: string | null;
  onSubmit: (name: string, draft: TeamSquadDraft) => Promise<boolean>;
  onCancel: () => void;
  nameLocked: boolean;
}) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [title, setTitle] = useState(initial.title);
  const [picked, setPicked] = useState<string[]>(initial.members);
  const [leader, setLeader] = useState(initial.leader);
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim().replace(/^@/, "");
    if (!SQUAD_NAME_RE.test(trimmed)) { setLocalError(t("TeamBoard.squad.nameInvalid")); return; }
    if (picked.length === 0) { setLocalError(t("TeamBoard.squad.membersRequired")); return; }
    setLocalError(null);
    const ok = await onSubmit(trimmed, {
      title: title.trim() === "" ? null : title.trim(),
      members: picked,
      leader: leader === "" ? null : leader,
    });
    if (ok) onCancel();
  };
  const shown = localError ?? error;
  return (
    <form className="team-squad-form" onSubmit={submit} aria-label={nameLocked ? t("TeamBoard.squad.editTitle", { name: initial.name }) : t("TeamBoard.squad.create")}>
      <label>
        <span>{t("TeamBoard.squad.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={saving || nameLocked} placeholder="fe-team" maxLength={64} />
      </label>
      <label>
        <span>{t("TeamBoard.squad.title")}</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} placeholder={t("TeamBoard.squad.titlePlaceholder")} maxLength={80} />
      </label>
      <div className="team-squad-form-members">
        <span>{t("TeamBoard.squad.members")}</span>
        <MemberPicker members={members} selected={picked} onChange={setPicked} disabled={saving} />
      </div>
      <label>
        <span>{t("TeamBoard.squad.leader")}</span>
        <select value={leader} onChange={(e) => setLeader(e.target.value)} disabled={saving}>
          <option value="">{t("TeamBoard.squad.leaderNone")}</option>
          {members.filter((m) => picked.includes(m.name)).map((m) => (
            <option key={m.name} value={m.name}>{m.display}</option>
          ))}
        </select>
      </label>
      {shown !== null && <p className="team-card-edit-error" role="alert">{shown}</p>}
      <div className="team-card-edit-actions">
        <button type="submit" className="d-btn d-btn--primary" disabled={saving}>{t("TeamBoard.role.save")}</button>
        <button type="button" className="d-btn" disabled={saving} onClick={onCancel}>{t("TeamBoard.role.cancel")}</button>
      </div>
    </form>
  );
}

export function TeamSquads({
  squads,
  members,
  canModerate,
  saving = null,
  error = null,
  filter,
  onFilter,
  onCreate,
  onUpdate,
  onDelete,
}: TeamSquadsProps) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const displayOf = (name: string) => members.find((m) => m.name === name)?.display ?? name;
  const canWrite = canModerate && onCreate !== undefined && onUpdate !== undefined;
  if (squads.length === 0 && !canWrite) return null;

  return (
    <section className="team-squads" aria-label={t("TeamBoard.squad.section")}>
      <h3 className="team-lane-head">
        {t("TeamBoard.squad.section")}
        <span className="team-lane-count">{squads.length}</span>
        <span className="team-lane-hint">{t("TeamBoard.squad.hint")}</span>
        {canWrite && !creating && (
          <button type="button" className="d-btn team-squad-create" disabled={saving !== null} onClick={() => setCreating(true)}>
            + {t("TeamBoard.squad.create")}
          </button>
        )}
      </h3>
      {creating && onCreate !== undefined && (
        <SquadForm
          initial={{ name: "", title: "", members: [], leader: "" }}
          members={members}
          saving={saving === "__new__"}
          error={saving === null ? error : null}
          onSubmit={onCreate}
          onCancel={() => setCreating(false)}
          nameLocked={false}
        />
      )}
      {squads.length > 0 && (
        <ul className="team-squad-list">
          {squads.map((squad) => {
            const active = filter === squad.name;
            const isEditing = editing === squad.name;
            return (
              <li key={squad.name} className={`team-squad${active ? " is-active" : ""}`} data-squad={squad.name}>
                <div className="team-squad-head">
                  <button
                    type="button"
                    className="team-squad-name"
                    aria-pressed={active}
                    onClick={() => onFilter(active ? null : squad.name)}
                    title={t(active ? "TeamBoard.squad.filterOff" : "TeamBoard.squad.filterOn", { name: squad.name })}
                  >
                    @{squad.name}
                    {squad.title !== null && squad.title !== "" && <span className="team-card-muted"> · {squad.title}</span>}
                  </button>
                  <span className="team-card-muted">
                    {t("TeamBoard.squad.memberCount", { count: squad.members.length })}
                    {squad.leader !== null && ` · ${t("TeamBoard.squad.leadBy", { name: displayOf(squad.leader) })}`}
                  </span>
                  {canWrite && !isEditing && (
                    <span className="team-card-actions">
                      <button type="button" className="team-card-linkbtn" disabled={saving !== null} onClick={() => setEditing(squad.name)}>
                        {t("TeamBoard.squad.edit")}
                      </button>
                      {onDelete !== undefined && (
                        <button
                          type="button"
                          className="team-card-linkbtn team-squad-delete"
                          disabled={saving !== null}
                          onClick={() => { void onDelete(squad.name); }}
                        >
                          {t("TeamBoard.squad.delete")}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {!isEditing && (
                  <div className="team-squad-members">
                    {squad.members.map((name) => (
                      <span key={name} className={`team-card-chip${squad.leader === name ? " team-card-chip--lead" : ""}`}>{displayOf(name)}</span>
                    ))}
                  </div>
                )}
                {isEditing && onUpdate !== undefined && (
                  <SquadForm
                    initial={{ name: squad.name, title: squad.title ?? "", members: squad.members, leader: squad.leader ?? "" }}
                    members={members}
                    saving={saving === squad.name}
                    error={saving === null ? error : null}
                    onSubmit={onUpdate}
                    onCancel={() => setEditing(null)}
                    nameLocked
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
