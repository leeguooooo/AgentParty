import { Fragment, useState } from "react";
import type { TeamSummary } from "../../lib/teams";
import { fmtTime } from "../../lib/time";
import { presenceStateLabel, residencyLabel } from "../../lib/presenceLabels";
import { useT } from "../../i18n/useT";
import "../../i18n/strings/Channel";

export function TeamPanel({ teams }: { teams: TeamSummary[] }) {
  const t = useT();
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  if (teams.length === 0) return null;

  return (
    <section className="team-panel" aria-label={t("Channel.team.aria")}>
      <div className="team-panel-head">
        <h2 className="team-title">{t("Channel.heading.teams")}</h2>
        <span className="t-mono team-count">{teams.length}</span>
      </div>
      <ol className="team-list">
        {teams.map((team) => {
          const front = team.frontAgent;
          const workerMembers = front === null ? team.members : team.members.filter((member) => member.name !== front.name);
          const meta = [
            t("Channel.team.meta.root", { name: team.rootAgent }),
            team.parentAgents.length === 1
              ? t("Channel.team.meta.parent", { name: team.parentAgents[0]! })
              : t("Channel.team.meta.parents", { count: team.parentAgents.length }),
            t("Channel.team.meta.depth", { depth: team.maxDepth }),
            team.expiresAt !== null ? t("Channel.team.meta.expires", { time: fmtTime(team.expiresAt) }) : null,
            team.lastSeen !== null ? t("Channel.team.meta.seen", { time: fmtTime(team.lastSeen) }) : null,
          ].filter((part): part is string => part !== null);
          return (
            <li key={team.key} className="team-item">
              <div className="team-item-head">
                <span className="team-name">{team.teamId}</span>
                <span
                  className={"t-mono team-front" + (front?.active ? " is-active" : "")}
                  title={front === null
                    ? t("Channel.team.front", { name: team.rootAgent })
                    : t("Channel.team.frontTitle", {
                        name: front.name,
                        state: presenceStateLabel(front.state, t),
                        residency: residencyLabel(front.residency, t),
                      })}
                >
                  <span className={`d-dot d-dot--${front?.active ? front.state : "offline"}`} />
                  {t("Channel.team.front", { name: front?.name ?? team.rootAgent })}
                </span>
                <span className="t-mono team-active">
                  {t("Channel.team.active", { active: team.activeCount, total: team.memberCount })}
                </span>
                <span className={`t-mono team-residency team-residency--${team.residency}`}>
                  {residencyLabel(team.residency, t)}
                </span>
              </div>
              <div className="t-mono team-meta">{meta.join(" · ")}</div>
              <div className="team-members">
                {workerMembers.length === 0 && <span className="t-mono team-member team-member--empty">{t("Channel.team.noWorkers")}</span>}
                {workerMembers.map((member) => {
                  const detail = [
                    t("Channel.team.memberTitle", {
                      name: member.name,
                      parent: member.parentAgent,
                      state: presenceStateLabel(member.state, t),
                      residency: residencyLabel(member.residency, t),
                    }),
                    member.expiresAt !== null ? t("Channel.team.meta.expires", { time: fmtTime(member.expiresAt) }) : null,
                    member.lastSeen !== null ? t("Channel.team.meta.seen", { time: fmtTime(member.lastSeen) }) : null,
                  ].filter((part): part is string => part !== null).join(" · ");
                  const expanded = expandedMember === member.name;
                  return (
                    <Fragment key={member.name}>
                      <button
                        type="button"
                        className={"t-mono team-member" + (member.active ? " is-active" : "")}
                        title={detail}
                        aria-expanded={expanded}
                        onClick={() => setExpandedMember((current) => current === member.name ? null : member.name)}
                      >
                        <span className={`d-dot d-dot--${member.active ? member.state : "offline"}`} />
                        <span>{member.name}</span>
                      </button>
                      {expanded && <span className="t-mono team-member-detail">{detail}</span>}
                    </Fragment>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
