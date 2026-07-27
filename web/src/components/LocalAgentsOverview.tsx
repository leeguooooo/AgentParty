// #700：本机 agent 概览——独立弹窗、全局按频道视角、可检索。
// 与 DesktopAgentPanel（设置里的「启动器」，管单次起停 + 转常驻）互补：这里是「监控/管理」面
// ——把 app 内实例（statusAll）与 launchd 常驻（dutyList）归一、按频道分组、支持检索，并就地停止/卸载。
// 可从频道页工具条唤起（scopeChannel 预过滤到当前频道），也可全局打开。
import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  dutyDependencyErrorRunner,
  dutyRepairInput,
  type DesktopAgentAdapter,
  type DesktopAgentConfig,
  type DesktopAgentStatus,
  type DesktopDutyEntry,
} from "../lib/desktopAgent";
import {
  aggregateLocalAgents,
  filterLocalAgents,
  groupLocalAgentsByChannel,
  type LocalAgentRow,
} from "../lib/localAgents";
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
  active?: boolean;
  // 从频道页唤起时预过滤到该频道（点 ①「频道里能管理」）；全局打开则不传，看全部。
  scopeChannel?: string | null;
}

function isActive(state: string): boolean {
  return state === "starting" || state === "running" || state === "stopping";
}

function shortConfigId(configId: string): string {
  return configId.length <= 12 ? configId : `${configId.slice(0, 8)}…${configId.slice(-4)}`;
}

export function LocalAgentsOverview({
  t,
  adapter = desktopAgentAdapter,
  scheduler = defaultScheduler,
  active = true,
  scopeChannel = null,
}: Props) {
  // available=null 未探测；false=不可用（非 macOS/旧壳，statusAll 与 dutyList 都失败）。
  const [available, setAvailable] = useState<boolean | null>(null);
  const [instances, setInstances] = useState<DesktopAgentStatus[]>([]);
  const [duties, setDuties] = useState<DesktopDutyEntry[]>([]);
  const [configs, setConfigs] = useState<DesktopAgentConfig[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [logView, setLogView] = useState<{
    key: string;
    text: string | null;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const aliveRef = useRef(true);
  const mountedRef = useRef(true);
  const opRef = useRef(false);
  const detailKeyRef = useRef<string | null>(null);
  // #707 评审：挂载刷新 / 轮询 / 操作后刷新可并发，早发的请求后到会把新快照覆盖成旧的。
  // 单调序号——只让「最新一次 refresh」的结果落地，乱序完成的旧结果丢弃。
  const refreshSeqRef = useRef(0);
  const logSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      logSeqRef.current += 1;
    };
  }, []);

  const refresh = async (): Promise<void> => {
    const seq = ++refreshSeqRef.current;
    const configsRequest = adapter.listConfigs().catch(() => null);
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
    const nextConfigs = await configsRequest;
    if (!aliveRef.current || seq !== refreshSeqRef.current) return;
    // 只列活跃/存在的实例：stopped 且无 instanceId 的空位不进概览（与启动器的完整实例表不同）。
    setInstances(nextInstances.filter((item) => item.state !== "stopped" || item.instanceId !== null));
    setDuties(nextDuties);
    if (nextConfigs !== null) setConfigs(nextConfigs);
    setAvailable(anyOk);
  };

  useEffect(() => {
    if (!active) {
      aliveRef.current = false;
      logSeqRef.current += 1;
      detailKeyRef.current = null;
      setDetailKey(null);
      setLogView(null);
      return () => {
        aliveRef.current = false;
        refreshSeqRef.current += 1;
        logSeqRef.current += 1;
      };
    }
    aliveRef.current = true;
    void refresh();
    const cancel = scheduler.every(() => void refresh(), 3_000);
    return () => {
      aliveRef.current = false;
      refreshSeqRef.current += 1;
      logSeqRef.current += 1;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapter, scheduler]);

  const rows = useMemo(
    () => aggregateLocalAgents(instances, duties, configs),
    [configs, duties, instances],
  );

  const groups = useMemo(() => {
    const scoped = scopeChannel === null || scopeChannel === "" ? rows : rows.filter((row) => row.channel === scopeChannel);
    return groupLocalAgentsByChannel(filterLocalAgents(scoped, query));
  }, [query, rows, scopeChannel]);

  useEffect(() => {
    if (detailKey === null || rows.some((row) => row.key === detailKey)) return;
    logSeqRef.current += 1;
    detailKeyRef.current = null;
    setDetailKey(null);
    setLogView(null);
  }, [detailKey, rows]);

  const runAction = async (action: () => Promise<unknown>): Promise<void> => {
    if (opRef.current) return;
    opRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      if (aliveRef.current) await refresh();
    } catch (cause) {
      if (aliveRef.current) {
        const runner = dutyDependencyErrorRunner(cause);
        setActionError(
          runner === null
            ? t("LocalAgents.actionFailed")
            : t("DesktopSettings.agent.dutyDependencyMissing", { runner }),
        );
      }
    } finally {
      opRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const loadRowLogs = async (row: LocalAgentRow): Promise<void> => {
    const seq = ++logSeqRef.current;
    setLogView({ key: row.key, text: null, busy: true, error: null });
    try {
      const text = row.kind === "duty"
        ? await adapter.dutyLogRead(row.duty!.label)
        : (row.instanceId === null
          ? await adapter.logs()
          : await adapter.logsInstance(row.instanceId)).join("\n");
      if (!mountedRef.current || seq !== logSeqRef.current || detailKeyRef.current !== row.key) return;
      setLogView({ key: row.key, text, busy: false, error: null });
    } catch {
      if (!mountedRef.current || seq !== logSeqRef.current || detailKeyRef.current !== row.key) return;
      setLogView({
        key: row.key,
        text: null,
        busy: false,
        error: t("LocalAgents.logsLoadFailed"),
      });
    }
  };

  const toggleRowDetails = (row: LocalAgentRow): void => {
    if (detailKey === row.key) {
      logSeqRef.current += 1;
      detailKeyRef.current = null;
      setDetailKey(null);
      setLogView(null);
      return;
    }
    detailKeyRef.current = row.key;
    setDetailKey(row.key);
    setLogView(null);
    void loadRowLogs(row);
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
          {actionError !== null && (
            <p className="desktop-agent-error" role="alert">{actionError}</p>
          )}

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
                    {group.rows.map((row) => {
                      const displayName = row.name ?? t("LocalAgents.unknownIdentity");
                      const detailId = `local-agent-detail-${row.key}`;
                      const detailOpen = detailKey === row.key;
                      const rowLog = logView?.key === row.key ? logView : null;
                      return (
                        <li key={row.key} className={`local-agents-row local-agents-row--${row.kind}`}>
                          <div className="local-agents-summary">
                            <span className={`local-agents-badge local-agents-badge--${row.kind}`}>
                              {t(row.kind === "duty" ? "LocalAgents.kind.duty" : "LocalAgents.kind.instance")}
                            </span>
                            <span className="local-agents-identity">
                              <strong className="t-mono local-agents-name">{displayName}</strong>
                              {row.configId !== null && (
                                <span className="t-mono local-agents-config-id" title={row.configId}>
                                  {t("LocalAgents.configIdShort", { id: shortConfigId(row.configId) })}
                                </span>
                              )}
                            </span>
                            {row.runner !== null && <span className="local-agents-runner">{row.runner}</span>}
                            <span
                              className={`desktop-agent-state desktop-agent-state--${row.state}`}
                              title={row.kind === "duty" ? row.duty!.terminalReason ?? undefined : undefined}
                            >
                              {row.kind === "duty"
                                ? t(row.duty!.terminalReason === "legacy-duty-needs-repair"
                                  ? "DesktopSettings.agent.dutyLegacyRepair"
                                  : row.duty!.terminalReason === "terminal-stop-quarantined"
                                    ? "DesktopSettings.agent.dutyQuarantined"
                                    : row.duty!.terminalBlocked === true
                                      ? "DesktopSettings.agent.dutyTerminalBlocked"
                                      : row.duty!.loaded
                                        ? "DesktopSettings.agent.dutyLoaded"
                                        : "DesktopSettings.agent.dutyNotLoaded")
                                : t(`DesktopSettings.agent.state.${row.state}`)}
                            </span>
                            <span className="local-agents-actions">
                              <button
                                type="button"
                                className="d-btn local-agents-details"
                                aria-expanded={detailOpen}
                                aria-controls={detailId}
                                onClick={() => toggleRowDetails(row)}
                              >
                                {t(detailOpen ? "LocalAgents.detailsClose" : "LocalAgents.detailsOpen")}
                              </button>
                              {row.kind === "instance" && row.instanceId !== null && isActive(row.state) && (
                                <button
                                  type="button"
                                  className="d-btn local-agents-stop"
                                  disabled={busy}
                                  aria-label={`${t("DesktopSettings.agent.instanceStop")} ${displayName}`}
                                  onClick={() => void runAction(() => adapter.stopInstance(row.instanceId!))}
                                >
                                  {t("DesktopSettings.agent.instanceStop")}
                                </button>
                              )}
                              {row.kind === "duty" && (
                                <>
                                  {(
                                    row.duty!.dependencyState === "missing" ||
                                    row.duty!.dependencyState === "repair-required"
                                  ) && dutyRepairInput(row.duty!) !== null && (
                                    <button
                                      type="button"
                                      className="d-btn local-agents-repair"
                                      disabled={busy}
                                      aria-label={`${t("DesktopSettings.agent.dutyRepair")} ${displayName}`}
                                      onClick={() => {
                                        const input = dutyRepairInput(row.duty!);
                                        if (input !== null) void runAction(() => adapter.dutyPersist(input));
                                      }}
                                    >
                                      {t("DesktopSettings.agent.dutyRepair")}
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="d-btn local-agents-unload"
                                    disabled={busy}
                                    aria-label={`${t("DesktopSettings.agent.dutyUnload")} ${displayName}`}
                                    onClick={() => void runAction(() => adapter.dutyUnpersist(row.instanceId!))}
                                  >
                                    {t("DesktopSettings.agent.dutyUnload")}
                                  </button>
                                </>
                              )}
                            </span>
                          </div>

                          {row.kind === "duty" && (
                            row.duty!.dependencyState === "missing" ||
                            row.duty!.dependencyState === "repair-required"
                          ) && (
                            <p className="desktop-agent-error local-agents-diagnostic" role="alert">
                              {t(
                                row.duty!.dependencyState === "missing"
                                  ? "DesktopSettings.agent.dutyDependencyMissing"
                                  : "DesktopSettings.agent.dutyDependencyRepair",
                                { runner: row.duty!.runner ?? "runner" },
                              )}
                            </p>
                          )}

                          {detailOpen && (
                            <section
                              id={detailId}
                              className="local-agents-detail"
                              aria-label={t("LocalAgents.detailsLabel", { name: displayName })}
                            >
                              <dl className="local-agents-meta">
                                <div>
                                  <dt>{t("LocalAgents.field.name")}</dt>
                                  <dd className="t-mono">{displayName}</dd>
                                </div>
                                <div>
                                  <dt>{t("LocalAgents.field.channel")}</dt>
                                  <dd className="t-mono">{row.channel === "" ? t("LocalAgents.unassigned") : `#${row.channel}`}</dd>
                                </div>
                                <div>
                                  <dt>{t("LocalAgents.field.mode")}</dt>
                                  <dd>{t(row.kind === "duty" ? "LocalAgents.kind.duty" : "LocalAgents.kind.instance")}</dd>
                                </div>
                                <div>
                                  <dt>{t("LocalAgents.field.runner")}</dt>
                                  <dd className="t-mono">{row.runner ?? t("LocalAgents.unknownValue")}</dd>
                                </div>
                                {row.config?.role && (
                                  <div>
                                    <dt>{t("LocalAgents.field.role")}</dt>
                                    <dd>{row.config.role}</dd>
                                  </div>
                                )}
                                {row.configId !== null && (
                                  <div>
                                    <dt>{t("LocalAgents.field.configId")}</dt>
                                    <dd className="t-mono">{row.configId}</dd>
                                  </div>
                                )}
                                {(row.instance?.workdir ?? row.duty?.workdir) && (
                                  <div>
                                    <dt>{t("LocalAgents.field.workdir")}</dt>
                                    <dd className="t-mono">{row.instance?.workdir ?? row.duty?.workdir}</dd>
                                  </div>
                                )}
                                {(row.instance?.repo ?? row.duty?.repo) && (
                                  <div>
                                    <dt>{t("LocalAgents.field.repo")}</dt>
                                    <dd className="t-mono">{row.instance?.repo ?? row.duty?.repo}</dd>
                                  </div>
                                )}
                                {row.duty !== undefined && (
                                  <div>
                                    <dt>{t("LocalAgents.field.logPath")}</dt>
                                    <dd className="t-mono">{row.duty.logPath}</dd>
                                  </div>
                                )}
                              </dl>
                              {row.instance?.lastError && (
                                <p className="desktop-agent-error local-agents-last-error" role="alert">
                                  <strong>{t("LocalAgents.field.lastError")}</strong> {row.instance.lastError}
                                </p>
                              )}
                              <div className="local-agents-log-head">
                                <strong>{t("LocalAgents.logsTitle")}</strong>
                                <button
                                  type="button"
                                  className="d-btn local-agents-log-reload"
                                  disabled={rowLog?.busy === true}
                                  onClick={() => void loadRowLogs(row)}
                                >
                                  {rowLog?.busy === true ? t("LocalAgents.logsLoading") : t("LocalAgents.logsReload")}
                                </button>
                              </div>
                              {rowLog?.busy === true && (
                                <p className="local-agents-log-state" role="status" aria-live="polite">
                                  {t("LocalAgents.logsLoading")}
                                </p>
                              )}
                              {rowLog?.error !== null && rowLog?.error !== undefined && (
                                <p className="desktop-agent-error" role="alert">{rowLog.error}</p>
                              )}
                              {rowLog?.busy !== true && rowLog?.error == null && (
                                rowLog?.text?.trim() ? (
                                  <pre className="t-mono local-agents-log" tabIndex={0}>{rowLog.text}</pre>
                                ) : (
                                  <p className="local-agents-log-state">{t("LocalAgents.logsEmpty")}</p>
                                )
                              )}
                            </section>
                          )}
                        </li>
                      );
                    })}
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
