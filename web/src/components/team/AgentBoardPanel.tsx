import type { MsgFrame, PresenceEntry, PublicDirectedDelivery, Sender, TaskRecord } from "@agentparty/shared";
import { fmtTime } from "../../lib/time";
import { useT } from "../../i18n/useT";
import "../../i18n/strings/Channel";
import "../../i18n/strings/WakeReceipt";
import "../../i18n/strings/AgentDetailModal";
import {
  ACTIVE_DELIVERY_STATES,
  AGENT_BOARD_MAX_WORK_ROWS,
  AGENT_STATUS_ORDER,
  agentBoardTaskAssignee,
  agentPresenceSummary,
  agentWorkSummaryFor,
  type AgentBoardStatus,
} from "./agentBoard";

export function AgentBoardPanel({
  presence,
  participants = [],
  tasks,
  deliveries = [],
  messages = [],
  onOpenAgentDetail,
  onOpenTask,
  onOpenMessage,
  memberNames,
}: {
  presence: PresenceEntry[];
  participants?: Sender[];
  tasks: TaskRecord[];
  deliveries?: PublicDirectedDelivery[];
  messages?: MsgFrame[];
  onOpenAgentDetail?: (name: string) => void;
  onOpenTask?: (id: number) => void;
  onOpenMessage?: (seq: number) => void | Promise<void>;
  /** Current channel roster; task/delivery/history cannot recreate a removed member. */
  memberNames?: ReadonlySet<string>;
}) {
  const t = useT();
  const messagesBySeq = new Map(messages.map((message) => [message.seq, message]));
  const activeDeliveriesByName = new Map<string, PublicDirectedDelivery[]>();
  for (const delivery of deliveries) {
    if (memberNames !== undefined && !memberNames.has(delivery.target_name)) continue;
    if (!ACTIVE_DELIVERY_STATES.has(delivery.state)) continue;
    const assigned = activeDeliveriesByName.get(delivery.target_name) ?? [];
    assigned.push(delivery);
    activeDeliveriesByName.set(delivery.target_name, assigned);
  }
  for (const assigned of activeDeliveriesByName.values()) {
    assigned.sort((a, b) => b.updated_at - a.updated_at || b.message_seq - a.message_seq || a.id.localeCompare(b.id));
  }
  const tasksByName = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const name = agentBoardTaskAssignee(task);
    if (name === null) continue;
    if (memberNames !== undefined && !memberNames.has(name)) continue;
    const assigned = tasksByName.get(name) ?? [];
    assigned.push(task);
    tasksByName.set(name, assigned);
  }
  const taskStateOrder: Partial<Record<TaskRecord["state"], number>> = {
    in_progress: 0,
    blocked: 1,
    needs_review: 2,
    assigned: 3,
  };
  for (const assigned of tasksByName.values()) {
    assigned.sort((a, b) =>
      (taskStateOrder[a.state] ?? 99) - (taskStateOrder[b.state] ?? 99)
      || b.priority - a.priority
      || b.updated_at - a.updated_at
      || a.id - b.id,
    );
  }
  const presenceByName = new Map(presence.map((p) => [p.name, p]));
  const presenceSummary = agentPresenceSummary(
    presence,
    participants,
    [...tasksByName.keys(), ...activeDeliveriesByName.keys()],
    memberNames,
  );
  const names = new Set(presenceSummary.agentNames);
  const statusOf = (name: string, p: PresenceEntry | undefined, activeDeliveries: PublicDirectedDelivery[]): AgentBoardStatus => {
    if (!presenceSummary.onlineNames.has(name)) return "offline";
    if (p?.state === "blocked" || activeDeliveries.some((delivery) => delivery.state === "waiting_owner")) return "blocked";
    if (
      p?.busy === true
      || p?.state === "working"
      || activeDeliveries.some((delivery) => delivery.state === "queued" || delivery.state === "claimed" || delivery.state === "running")
    ) return "busy";
    return "idle";
  };
  const rows = [...names]
    .map((name) => {
      const p = presenceByName.get(name);
      const assigned = tasksByName.get(name) ?? [];
      const activeDeliveries = activeDeliveriesByName.get(name) ?? [];
      const knownDeliverySeqs = new Set(activeDeliveries.map((delivery) => delivery.message_seq));
      const activeWork = activeDeliveries.map((delivery) => ({
        id: delivery.id,
        seq: delivery.message_seq,
        state: delivery.state,
        // 优先本地已加载正文（含实时编辑），窗口外的老消息退回 worker 投影时带的 preview。
        summary: agentWorkSummaryFor(messagesBySeq.get(delivery.message_seq), delivery.preview),
      }));
      if (typeof p?.current_task === "number" && !knownDeliverySeqs.has(p.current_task)) {
        activeWork.unshift({
          id: `presence-${name}-${p.current_task}`,
          seq: p.current_task,
          state: "running",
          summary: agentWorkSummaryFor(messagesBySeq.get(p.current_task)),
        });
      }
      // #187 第4项「排期」：surface presence 里的暂停/定时恢复（resume_at），看板本行直接可见。
      return {
        name,
        status: statusOf(name, p, activeDeliveries),
        online: presenceSummary.onlineNames.has(name),
        note: p?.note ?? null,
        paused: p?.paused === true,
        resumeAt: p?.resume_at ?? null,
        activeWork,
        tasks: assigned,
        inProgress: assigned.filter((task) => task.state === "in_progress").length,
        queued: assigned.filter((task) => task.state === "assigned").length,
        review: assigned.filter((task) => task.state === "needs_review").length,
        blocked: assigned.filter((task) => task.state === "blocked").length,
      };
    })
    .sort((a, b) =>
      AGENT_STATUS_ORDER[a.status] - AGENT_STATUS_ORDER[b.status]
      || (a.status === "offline" && b.status === "offline"
        ? Number(Boolean(b.note?.trim())) - Number(Boolean(a.note?.trim()))
        : 0)
      || b.inProgress - a.inProgress
      || a.name.localeCompare(b.name),
    );
  const laneStatuses: AgentBoardStatus[] = ["busy", "blocked", "idle", "offline"];
  const counts = Object.fromEntries(laneStatuses.map((status) => [status, rows.filter((row) => row.status === status).length])) as Record<AgentBoardStatus, number>;

  if (rows.length === 0) {
    return (
      <section className="agent-board-panel" aria-label={t("Channel.agentBoard.aria")}>
        <p className="agent-board-empty">{t("Channel.agents.empty")}</p>
      </section>
    );
  }
  return (
    <section className="agent-board-panel" aria-label={t("Channel.agentBoard.aria")}>
      <header className="agent-board-overview">
        <span className="t-mono agent-board-summary">
          {t("Channel.agentBoard.summary", {
            busy: String(counts.busy),
            blocked: String(counts.blocked),
            idle: String(counts.idle),
            offline: String(counts.offline),
          })}
        </span>
      </header>
      {laneStatuses.map((status) => {
        const laneRows = rows.filter((row) => row.status === status);
        const statusLabel = t(`Channel.agents.status.${status}`);
        const cards = (
          <div className="agent-board-lane-cards">
            {laneRows.length === 0 && <p className="agent-board-lane-empty">{statusLabel} · 0 — {t("Channel.tasks.columnEmpty")}</p>}
            {laneRows.map((row) => (
              <article key={row.name} className={`agent-board-row agent-board-row--${row.status}`} data-agent={row.name}>
                <div className="agent-board-row-head">
                  {onOpenAgentDetail !== undefined ? (
                    <button
                      type="button"
                      className="agent-board-name agent-board-name--button"
                      data-team-member={row.name}
                      onClick={() => onOpenAgentDetail(row.name)}
                    >
                      <span className={`agent-board-live-dot${row.online ? " is-online" : ""}`} aria-hidden="true" />
                      {row.name}
                    </button>
                  ) : (
                    <span className="agent-board-name">
                      <span className={`agent-board-live-dot${row.online ? " is-online" : ""}`} aria-hidden="true" />
                      {row.name}
                    </span>
                  )}
                  <span className={`t-mono agent-board-status agent-board-status--${row.status}`}>{statusLabel}</span>
                </div>
                {row.note !== null && row.note.trim() !== "" && <p className="agent-board-note">{row.note}</p>}
                {row.paused && (
                  <p className="t-mono agent-board-schedule">
                    {row.resumeAt !== null
                      ? t("Channel.agents.pausedUntil", { time: fmtTime(row.resumeAt) })
                      : t("Channel.agents.pausedManual")}
                  </p>
                )}
                <div className="agent-board-counts t-mono">
                  <span title={t("Channel.agents.count.inProgress")}>▶ {row.inProgress}</span>
                  <span title={t("Channel.agents.count.queued")}>⏳ {row.queued}</span>
                  <span title={t("Channel.agents.count.review")}>👁 {row.review}</span>
                  {row.blocked > 0 && <span className="agent-board-count-blocked" title={t("Channel.agents.count.blocked")}>⛔ {row.blocked}</span>}
                </div>
                {row.activeWork.length > 0 && (
                  <ol className="agent-board-task-list agent-board-work-list">
                    {row.activeWork.slice(0, AGENT_BOARD_MAX_WORK_ROWS).map((work) => (
                      <li key={work.id} className={`agent-board-task agent-board-work agent-board-work--${work.state}`}>
                        <span className="t-mono agent-board-task-id">#{work.seq}</span>
                        {onOpenMessage !== undefined ? (
                          <button
                            type="button"
                            className="agent-board-task-title agent-board-name--button"
                            title={work.summary || undefined}
                            aria-label={t("AgentDetailModal.openMessage", {
                              seq: String(work.seq),
                              summary: work.summary || t("Channel.agentBoard.workUnavailable"),
                            })}
                            onClick={() => { void onOpenMessage(work.seq); }}
                          >
                            {work.summary || t("Channel.agentBoard.workUnavailable")}
                          </button>
                        ) : (
                          <span className="agent-board-task-title" title={work.summary || undefined}>
                            {work.summary || t("Channel.agentBoard.workUnavailable")}
                          </span>
                        )}
                        <span className="t-mono agent-board-task-state">{t(`WakeReceipt.delivery.state.${work.state}`)}</span>
                      </li>
                    ))}
                    {row.activeWork.length > AGENT_BOARD_MAX_WORK_ROWS && (
                      <li className="agent-board-task agent-board-work agent-board-work-more t-mono">
                        {t("Channel.agentBoard.workMore", { count: String(row.activeWork.length - AGENT_BOARD_MAX_WORK_ROWS) })}
                      </li>
                    )}
                  </ol>
                )}
                {row.tasks.length > 0 && (
                  <ol className="agent-board-task-list">
                    {row.tasks.map((task) => (
                      <li key={task.id} className={`agent-board-task agent-board-task--${task.state}`}>
                        <span className="t-mono agent-board-task-id">#{task.id}</span>
                        {onOpenTask !== undefined ? (
                          <button
                            type="button"
                            className="agent-board-task-title agent-board-name--button"
                            title={task.title}
                            aria-label={t("AgentDetailModal.openTask", {
                              id: String(task.id),
                              title: task.title,
                            })}
                            onClick={() => onOpenTask(task.id)}
                          >
                            {task.title}
                          </button>
                        ) : (
                          <span className="agent-board-task-title" title={task.title}>{task.title}</span>
                        )}
                        <span className="t-mono agent-board-task-state">{t(`Channel.tasks.state.${task.state}`)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            ))}
          </div>
        );
        if (status === "offline") {
          const handoffCount = laneRows.filter((row) => row.note?.trim()).length;
          return (
            <details
              key={status}
              className="agent-board-lane agent-board-lane--offline"
              data-status={status}
            >
              <summary className="agent-board-lane-head">
                <h3 className="agent-board-lane-title agent-board-status--offline">{statusLabel}</h3>
                <span className="t-mono agent-board-lane-count">{laneRows.length}</span>
                {handoffCount > 0 && <span className="t-mono agent-board-handoff-count">{t("Channel.agentBoard.handoffs", { count: String(handoffCount) })}</span>}
              </summary>
              {cards}
            </details>
          );
        }
        return (
          <section
            key={status}
            className={`agent-board-lane agent-board-lane--${status}`}
            data-status={status}
            data-empty={laneRows.length === 0}
            aria-label={t("Channel.tasks.columnAria", { state: statusLabel })}
          >
            <header className="agent-board-lane-head">
              <h3 className={`agent-board-lane-title agent-board-status--${status}`}>{statusLabel}</h3>
              <span className="t-mono agent-board-lane-count">{laneRows.length}</span>
            </header>
            {cards}
          </section>
        );
      })}
    </section>
  );
}
