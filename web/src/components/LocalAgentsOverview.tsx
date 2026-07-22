// #700：本机 agent 概览——独立弹窗、全局按频道视角、可检索。
// 与 DesktopAgentPanel（设置里的「启动器」，管单次起停 + 转常驻）互补：这里是「监控/管理」面
// ——把 app 内实例（statusAll）与 launchd 常驻（dutyList）归一、按频道分组、支持检索，并就地停止/卸载。
// 可从频道页工具条唤起（scopeChannel 预过滤到当前频道），也可全局打开。
import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  type DesktopAgentAdapter,
  type DesktopAgentStatus,
  type DesktopDutyEntry,
} from "../lib/desktopAgent";
import { aggregateLocalAgents, filterLocalAgents, groupLocalAgentsByChannel } from "../lib/localAgents";
import type { DesktopAgentScheduler } from "./DesktopAgentPanel";
import "../i18n/strings/LocalAgentsOverview";

const defaultScheduler: DesktopAgentScheduler = {
  every(callback, intervalMs) {
    const timer = globalThis.setInterval(callback, intervalMs);
    return () => globalThis.clearInterval(timer);
  },
};

interface Props {
  t: TFunc;
  adapter?: DesktopAgentAdapter;
  scheduler?: DesktopAgentScheduler;
  // 从频道页唤起时预过滤到该频道（点 ①「频道里能管理」）；全局打开则不传，看全部。
  scopeChannel?: string | null;
}

function isActive(state: string): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

export function LocalAgentsOverview({ t, adapter = desktopAgentAdapter, scheduler = defaultScheduler, scopeChannel = null }: Props) {
  // available=null 未探测；false=不可用（非 macOS/旧壳，statusAll 与 dutyList 都失败）。
  const [available, setAvailable] = useState<boolean | null>(null);
  const [instances, setInstances] = useState<DesktopAgentStatus[]>([]);
  const [duties, setDuties] = useState<DesktopDutyEntry[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const opRef = useRef(false);

  const refresh = async (): Promise<void> => {
    let anyOk = false;
    let nextInstances: DesktopAgentStatus[] = [];
    try {
      nextInstances = await adapter.statusAll();
      anyOk = true;
    } catch {
      try {
        const single = await adapter.status();
        nextInstances = single.instanceId !== null || single.state !== "stopped" ? [single] : [];
        anyOk = true;
      } catch {
        // statusAll 与 status 都失败：本机 agent 不可用
      }
    }
    let nextDuties: DesktopDutyEntry[] = [];
    try {
      nextDuties = await adapter.dutyList();
      anyOk = true;
    } catch {
      // 非 macOS / 旧壳：无常驻，忽略
    }
    if (!aliveRef.current) return;
    // 只列活跃/存在的实例：stopped 且无 instanceId 的空位不进概览（与启动器的完整实例表不同）。
    setInstances(nextInstances.filter((item) => item.state !== "stopped" || item.instanceId !== null));
    setDuties(nextDuties);
    setAvailable(anyOk);
  };

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const cancel = scheduler.every(() => void refresh(), 3_000);
    return () => {
      aliveRef.current = false;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, scheduler]);

  const groups = useMemo(() => {
    const rows = aggregateLocalAgents(instances, duties);
    const scoped = scopeChannel === null || scopeChannel === "" ? rows : rows.filter((row) => row.channel === scopeChannel);
    return groupLocalAgentsByChannel(filterLocalAgents(scoped, query));
  }, [instances, duties, query, scopeChannel]);

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    if (opRef.current) return;
    opRef.current = true;
    setBusy(true);
    try {
      await action();
      await refresh();
    } catch {
      // 就地动作失败：下一轮轮询会纠正显示，不弹错打断概览。
    } finally {
      opRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const totalRows = groups.reduce((sum, g) => sum + g.rows.length, 0);

  return (
    <section className="local-agents" aria-labelledby="local-agents-title">
      <header className="local-agents-head">
        <strong id="local-agents-title">{t("LocalAgents.title")}</strong>
        <p className="local-agents-subtitle">{t("LocalAgents.subtitle")}</p>
      </header>

      {available === false ? (
        <p className="local-agents-empty" role="status">{t("LocalAgents.unavailable")}</p>
      ) : (
        <>
          <input
            type="search"
            className="local-agents-search t-mono"
            name="local-agents-search"
            value={query}
            placeholder={t("LocalAgents.search")}
            aria-label={t("LocalAgents.searchLabel")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />

          {totalRows === 0 ? (
            <p className="local-agents-empty" role="status">
              {query.trim() !== "" ? t("LocalAgents.emptyFiltered") : t("LocalAgents.empty")}
            </p>
          ) : (
            <div className="local-agents-groups">
              {groups.map((group) => (
                <section key={group.channel || "unassigned"} className="local-agents-group" aria-label={group.channel || t("LocalAgents.unassigned")}>
                  <h4 className="local-agents-group-title">
                    <span className="t-mono">{group.channel || t("LocalAgents.unassigned")}</span>
                    <span className="local-agents-group-count">{t("LocalAgents.count", { count: group.rows.length })}</span>
                  </h4>
                  <ul className="local-agents-list">
                    {group.rows.map((row) => (
                      <li key={row.key} className={`local-agents-row local-agents-row--${row.kind}`}>
                        <span className={`local-agents-badge local-agents-badge--${row.kind}`}>
                          {t(row.kind === "duty" ? "LocalAgents.kind.duty" : "LocalAgents.kind.instance")}
                        </span>
                        <span className="t-mono local-agents-name">{row.name}</span>
                        {row.runner !== null && <span className="local-agents-runner">{row.runner}</span>}
                        <span className={`desktop-agent-state desktop-agent-state--${row.state}`}>
                          {row.kind === "duty"
                            ? t(row.duty!.loaded ? "DesktopSettings.agent.dutyLoaded" : "DesktopSettings.agent.dutyNotLoaded")
                            : t(`DesktopSettings.agent.state.${row.state}`)}
                        </span>
                        {row.kind === "instance" && row.instanceId !== null && isActive(row.state) && (
                          <button
                            type="button"
                            className="d-btn local-agents-stop"
                            disabled={busy}
                            aria-label={`${t("DesktopSettings.agent.instanceStop")} ${row.instanceId}`}
                            onClick={() => void runAction(() => adapter.stopInstance(row.instanceId!))}
                          >
                            {t("DesktopSettings.agent.instanceStop")}
                          </button>
                        )}
                        {row.kind === "duty" && (
                          <button
                            type="button"
                            className="d-btn local-agents-unload"
                            disabled={busy}
                            aria-label={`${t("DesktopSettings.agent.dutyUnload")} ${row.instanceId}`}
                            onClick={() => void runAction(() => adapter.dutyUnpersist(row.instanceId!))}
                          >
                            {t("DesktopSettings.agent.dutyUnload")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
