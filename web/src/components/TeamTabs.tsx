import { type ReactNode, useState } from "react";
import { useT } from "../i18n/useT";

// #504 团队面板「博客风」外壳：把原来一整页长滚动的三段（分工 / Agent 看板 / 协调）
// 收进三个页签，结构一目了然。页签带角标（分工=未认领数、协调=@数）。内部各段的数据
// 逻辑不动——本组件只负责终端/博客风的头部 + 页签导航 + 页签切换。

export type TeamTab = "division" | "board" | "coordination";

export interface TeamTabsStats {
  roles: number;
  online: number;
  offline: number;
  unclaimed: number;
}

export interface TeamTabsProps {
  stats: TeamTabsStats;
  mentionCount: number;
  division: ReactNode;
  board: ReactNode;
  coordination: ReactNode;
  initialTab?: TeamTab;
}

export function TeamTabs({ stats, mentionCount, division, board, coordination, initialTab = "division" }: TeamTabsProps) {
  const t = useT();
  const [tab, setTab] = useState<TeamTab>(initialTab);

  const tabs: Array<{ id: TeamTab; no: string; label: string; badge: number | null; badgeHot: boolean }> = [
    { id: "division", no: "01", label: t("Channel.team.tab.division"), badge: stats.unclaimed > 0 ? stats.unclaimed : null, badgeHot: true },
    { id: "board", no: "02", label: t("Channel.team.tab.board"), badge: null, badgeHot: false },
    { id: "coordination", no: "03", label: t("Channel.team.tab.coordination"), badge: mentionCount > 0 ? mentionCount : null, badgeHot: true },
  ];

  return (
    <section className="team-blog" aria-label={t("Channel.tools.team")}>
      <header className="team-blog-head">
        <div className="team-blog-title">
          <h2 className="team-blog-name">{t("Channel.team.overview.title")}</h2>
          <span className="t-mono team-blog-prompt">{t("Channel.team.overview.prompt")}</span>
        </div>
        <div className="team-blog-stats" role="list">
          <span className="t-mono team-blog-stat" role="listitem">{t("Channel.team.badge.roles", { count: String(stats.roles) })}</span>
          <span className="t-mono team-blog-stat" role="listitem">{t("Channel.team.badge.online", { count: String(stats.online) })}</span>
          <span className="t-mono team-blog-stat" role="listitem">{t("Channel.team.badge.offline", { count: String(stats.offline) })}</span>
          <span
            className={`t-mono team-blog-stat${stats.unclaimed > 0 ? " team-blog-stat--hot" : ""}`}
            role="listitem"
          >
            {t("Channel.team.badge.unclaimed", { count: String(stats.unclaimed) })}
          </span>
        </div>
      </header>

      <nav className="team-blog-tabs" role="tablist" aria-label={t("Channel.tools.team")}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={"team-blog-tab" + (tab === entry.id ? " team-blog-tab--active" : "")}
            onClick={() => setTab(entry.id)}
          >
            <span className="t-mono team-blog-tab-no">{entry.no}</span>
            <span className="team-blog-tab-label">{entry.label}</span>
            {entry.badge !== null && (
              <span className={"t-mono team-blog-tab-badge" + (entry.badgeHot ? " team-blog-tab-badge--hot" : "")}>
                {entry.id === "coordination" ? `@${entry.badge}` : entry.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="team-blog-panel" role="tabpanel">
        {tab === "division" && division}
        {tab === "board" && board}
        {tab === "coordination" && coordination}
      </div>
    </section>
  );
}
