import { useEffect, useMemo, useState } from "react";
import type { HostBoard, RecommendedAction } from "@agentparty/shared";
import { useT } from "../i18n/useT";
import {
  resolveIdentityPresentation,
  type IdentityDisplayMap,
} from "../lib/identityDisplay";
import "../i18n/strings/Channel";

export interface HostCandidate {
  name: string;
  label: string;
  online: boolean;
}

export function buildHostCandidate(
  member: { name: string; display: string; account?: string | null },
  identities: IdentityDisplayMap,
  online: boolean,
): HostCandidate {
  const presentation = resolveIdentityPresentation(member.name, identities, {
    kind: "agent",
    owner: member.account ?? null,
    display: member.display,
  });
  const label = presentation.ownerLabel === null
    ? presentation.label
    : `${presentation.ownerLabel} · ${presentation.label}`;
  return { name: member.name, label, online };
}

const EMPTY_HOST_CANDIDATES: readonly HostCandidate[] = [];

function RecommendedActionCard({ action }: { action: RecommendedAction }) {
  const t = useT();
  return (
    <li className={`host-action host-action--${action.kind}`}>
      <div className="host-action-head">
        <span className="t-mono host-action-kind">{action.kind}</span>
        {action.target !== null && <span className="host-action-target">{action.target}</span>}
        {action.requires_human && <span className="t-mono host-action-human">{t("Channel.hostBoard.human")}</span>}
      </div>
      <p>{action.reason}</p>
      {action.command !== null && <code>{action.command}</code>}
    </li>
  );
}

export function HostBoardPanel({
  board,
  candidates = EMPTY_HOST_CANDIDATES,
  canAssignHost = false,
  assigningHost = false,
  assignError = null,
  onAssignHost,
}: {
  board: HostBoard;
  candidates?: readonly HostCandidate[];
  canAssignHost?: boolean;
  assigningHost?: boolean;
  assignError?: string | null;
  onAssignHost?: (name: string) => Promise<boolean>;
}) {
  const t = useT();
  const assignAction = board.recommended_actions.find((action) => action.kind === "assign-host") ?? null;
  const otherActions = board.recommended_actions.filter((action) => action.kind !== "assign-host");
  const sortedCandidates = useMemo(
    () => [...candidates].sort((left, right) => (
      Number(right.online) - Number(left.online) || left.label.localeCompare(right.label)
    )),
    [candidates],
  );
  const [selectedHost, setSelectedHost] = useState("");
  const [assignedHost, setAssignedHost] = useState<string | null>(null);

  useEffect(() => {
    if (sortedCandidates.some((candidate) => candidate.name === selectedHost)) return;
    setSelectedHost(sortedCandidates[0]?.name ?? "");
  }, [selectedHost, sortedCandidates]);

  useEffect(() => {
    if (assignAction === null) setAssignedHost(null);
  }, [assignAction]);

  if (board.hosts.length === 0 && board.recommended_actions.length === 0 && board.conflicts.length === 0) return null;

  const assignSelectedHost = async () => {
    if (
      selectedHost === ""
      || assigningHost
      || !canAssignHost
      || onAssignHost === undefined
    ) return;
    setAssignedHost(null);
    if (await onAssignHost(selectedHost)) setAssignedHost(selectedHost);
  };

  return (
    <section className="host-board-panel" aria-label={t("Channel.hostBoard.aria")}>
      <div className="host-board-head">
        <h2 className="host-board-title">{t("Channel.heading.hostBoard")}</h2>
        <span className="t-mono host-board-count">#{board.last_seq}</span>
      </div>

      {assignAction !== null && (
        <section className="host-assignment" aria-label={t("Channel.hostBoard.assignAria")}>
          <div className="host-assignment-copy">
            <h3>{t("Channel.hostBoard.assignTitle")}</h3>
            <p>{t("Channel.hostBoard.assignDescription")}</p>
          </div>
          {candidates.length === 0 ? (
            <p className="host-assignment-notice">{t("Channel.hostBoard.assignNoCandidates")}</p>
          ) : canAssignHost && onAssignHost !== undefined ? (
            <div className="host-assignment-controls">
              <label>
                <span>{t("Channel.hostBoard.assignLabel")}</span>
                <select
                  value={selectedHost}
                  disabled={assigningHost}
                  onChange={(event) => {
                    setAssignedHost(null);
                    setSelectedHost(event.currentTarget.value);
                  }}
                >
                  {sortedCandidates.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>
                      {candidate.label} · {t(candidate.online
                        ? "Channel.hostBoard.candidateOnline"
                        : "Channel.hostBoard.candidateOffline")}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="d-btn d-btn--primary"
                disabled={assigningHost || selectedHost === ""}
                onClick={assignSelectedHost}
              >
                {assigningHost
                  ? t("Channel.hostBoard.assigning")
                  : t("Channel.hostBoard.assignButton")}
              </button>
            </div>
          ) : (
            <p className="host-assignment-notice">{t("Channel.hostBoard.assignPermission")}</p>
          )}
          {assignError !== null && <p className="banner banner--red" role="alert">{assignError}</p>}
          {assignedHost !== null && assignError === null && (
            <p className="banner banner--green" role="status">
              {t("Channel.hostBoard.assignSuccess", { name: assignedHost })}
            </p>
          )}
          {assignAction.command !== null && (
            <details className="host-assignment-cli">
              <summary>{t("Channel.hostBoard.cliFallback")}</summary>
              <code>{assignAction.command}</code>
            </details>
          )}
        </section>
      )}

      {otherActions.length > 0 && (
        <ol className="host-action-list">
          {otherActions.map((action, index) => (
            <RecommendedActionCard
              key={`${action.kind}:${action.target ?? "channel"}:${index}`}
              action={action}
            />
          ))}
        </ol>
      )}
      {board.conflicts.length > 0 && (
        <ol className="host-conflict-list">
          {board.conflicts.map((conflict) => (
            <li key={conflict.scope} className="host-conflict">
              <span className="t-mono host-conflict-scope">{conflict.scope}</span>
              <span>{conflict.owners.join(t("Channel.hostBoard.conflictSeparator"))}</span>
            </li>
          ))}
        </ol>
      )}
      {board.hosts.length > 0 && (
        <div className="host-board-hosts">
          {board.hosts.map((host) => (
            <span
              key={host.name}
              className={`t-mono host-board-host host-board-host--${host.lease}`}
              title={[
                t("Channel.hostBoard.hostTitle", { state: host.state, residency: host.residency, wake: host.wake_kind }),
                host.stale_reason !== null ? t("Channel.hostBoard.reason", { reason: host.stale_reason }) : null,
              ].filter((part): part is string => part !== null).join("\n")}
            >
              {host.name} · {host.lease}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
