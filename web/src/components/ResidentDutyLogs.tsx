import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  type DesktopAgentAdapter,
  type DesktopAgentConfig,
} from "../lib/desktopAgent";
import { aggregateLocalAgents, type LocalAgentRow } from "../lib/localAgents";
import { useAutoScrollToLatest } from "../lib/useAutoScrollToLatest";
import "../i18n/strings/ResidentDutyLogs";

type LocalLogsAdapter = Pick<DesktopAgentAdapter, "dutyList" | "dutyLogRead"> &
  Partial<Pick<DesktopAgentAdapter, "listConfigs" | "statusAll" | "status" | "logs" | "logsInstance">>;

interface Props {
  t: TFunc;
  adapter?: LocalLogsAdapter;
  active?: boolean;
  initialTargetKey?: string | null;
}

type LogLevel = "error" | "warn" | "info";
type LevelFilter = "all" | LogLevel;

interface LogEntry {
  id: string;
  targetKey: string;
  agentName: string;
  channel: string;
  level: LogLevel;
  text: string;
}

function classifyLogLevel(line: string): LogLevel {
  if (/\b(error|failed?|fatal|panic|exception)\b|错误|失败|异常/i.test(line)) return "error";
  if (/\b(warn(?:ing)?|retry|reconnect|restart|stale|standby|skip(?:ping|ped)?)\b|警告|重试|重连|跳过|待命/i.test(line)) {
    return "warn";
  }
  return "info";
}

function targetLabel(row: LocalAgentRow, t: TFunc): string {
  return row.name ?? t("ResidentDutyLogs.unknownAgent");
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(-500);
}

export function ResidentDutyLogs({
  t,
  adapter = desktopAgentAdapter,
  active = true,
  initialTargetKey = null,
}: Props) {
  const [targets, setTargets] = useState<LocalAgentRow[] | null>(null);
  const [selected, setSelected] = useState("all");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const activeRef = useRef(active);
  const selectedRef = useRef(selected);
  const routedTargetPropRef = useRef(initialTargetKey);
  const pendingRoutedTargetRef = useRef<string | null>(initialTargetKey);
  selectedRef.current = selected;
  if (routedTargetPropRef.current !== initialTargetKey) {
    routedTargetPropRef.current = initialTargetKey;
    pendingRoutedTargetRef.current = initialTargetKey;
  } else if (!active) {
    // Re-entering Logs from Overview should honor the routed target again, even
    // when the same row is opened twice. Once active, refreshes keep the user's
    // current filter instead of snapping back to this route hint.
    pendingRoutedTargetRef.current = initialTargetKey;
  }

  const readRow = useCallback(async (row: LocalAgentRow): Promise<LogEntry[]> => {
    let text = "";
    if (row.kind === "duty") {
      text = await adapter.dutyLogRead(row.duty!.label);
    } else if (row.instanceId !== null && adapter.logsInstance !== undefined) {
      text = (await adapter.logsInstance(row.instanceId)).join("\n");
    } else if (adapter.logs !== undefined) {
      text = (await adapter.logs()).join("\n");
    }
    const name = targetLabel(row, t);
    return splitLines(text).map((line, index) => ({
      id: `${row.key}:${index}`,
      targetKey: row.key,
      agentName: name,
      channel: row.channel,
      level: classifyLogLevel(line),
      text: line,
    }));
  }, [adapter, t]);

  const loadLogs = useCallback(async (nextTargets: LocalAgentRow[], nextSelected: string) => {
    const request = ++requestRef.current;
    const chosen = nextSelected === "all"
      ? nextTargets
      : nextTargets.filter((target) => target.key === nextSelected);
    setBusy(true);
    setLogError(null);
    setEntries([]);
    try {
      const results = await Promise.allSettled(chosen.map(readRow));
      if (!activeRef.current || request !== requestRef.current) return;
      const nextEntries = results
        .flatMap((result) => result.status === "fulfilled" ? result.value : [])
        .slice(-1_500);
      setEntries(nextEntries);
      if (results.some((result) => result.status === "rejected")) {
        setLogError(t("ResidentDutyLogs.partialError"));
      }
    } finally {
      if (activeRef.current && request === requestRef.current) setBusy(false);
    }
  }, [readRow, t]);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setListError(null);
    setLogError(null);
    setBusy(true);
    const configsRequest = adapter.listConfigs?.().catch(() => [] as DesktopAgentConfig[]) ??
      Promise.resolve([] as DesktopAgentConfig[]);
    const dutiesRequest = adapter.dutyList();
    const instancesRequest = adapter.statusAll?.().catch(async () => {
      const status = await adapter.status?.();
      return status === undefined || (status.state === "stopped" && status.instanceId === null) ? [] : [status];
    }) ?? Promise.resolve([]);

    const [dutiesResult, instancesResult, configs] = await Promise.all([
      dutiesRequest.then((value) => ({ ok: true as const, value })).catch((error: unknown) => ({ ok: false as const, error })),
      instancesRequest.then((value) => ({ ok: true as const, value })).catch((error: unknown) => ({ ok: false as const, error })),
      configsRequest,
    ]);
    if (!activeRef.current || request !== requestRef.current) return;
    if (!dutiesResult.ok && !instancesResult.ok) {
      const cause = dutiesResult.error;
      setTargets([]);
      setEntries([]);
      setListError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      return;
    }
    const rows = aggregateLocalAgents(
      instancesResult.ok ? instancesResult.value : [],
      dutiesResult.ok ? dutiesResult.value : [],
      configs,
    );
    if (!dutiesResult.ok || !instancesResult.ok) {
      const cause = !dutiesResult.ok ? dutiesResult.error : instancesResult.ok ? null : instancesResult.error;
      if (cause !== null) setListError(cause instanceof Error ? cause.message : String(cause));
    }
    const preferred = pendingRoutedTargetRef.current ?? selectedRef.current;
    pendingRoutedTargetRef.current = null;
    const nextSelected = preferred === "all" || rows.some((row) => row.key === preferred) ? preferred : "all";
    setTargets(rows);
    setSelected(nextSelected);
    await loadLogs(rows, nextSelected);
  }, [adapter, loadLogs]);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      requestRef.current += 1;
      return;
    }
    void refresh();
    return () => {
      activeRef.current = false;
      requestRef.current += 1;
    };
  }, [active, refresh]);

  const selectTarget = (key: string) => {
    selectedRef.current = key;
    setSelected(key);
    if (targets !== null) void loadLogs(targets, key);
  };

  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return entries.filter((entry) =>
      (level === "all" || entry.level === level) &&
      (
        normalized === "" ||
        `${entry.agentName} ${entry.channel} ${entry.text}`.toLowerCase().includes(normalized)
      ));
  }, [entries, level, query]);

  const renderedLog = useMemo(
    () => visibleEntries.map((entry) =>
      `[${entry.level.toUpperCase()}] [${entry.agentName}${entry.channel ? ` #${entry.channel}` : ""}] ${entry.text}`,
    ).join("\n"),
    [visibleEntries],
  );
  const logPreRef = useAutoScrollToLatest<HTMLPreElement>(renderedLog, !busy);

  const counts = useMemo(() => ({
    all: entries.length,
    error: entries.filter((entry) => entry.level === "error").length,
    warn: entries.filter((entry) => entry.level === "warn").length,
    info: entries.filter((entry) => entry.level === "info").length,
  }), [entries]);

  return (
    <section className="resident-logs" aria-labelledby="local-agent-logs-title">
      <div className="resident-logs-head">
        <div>
          <h3 className="resident-logs-title" id="local-agent-logs-title">{t("ResidentDutyLogs.title")}</h3>
          <p className="resident-logs-lead">{t("ResidentDutyLogs.lead")}</p>
        </div>
        <button type="button" className="d-btn resident-logs-refresh" disabled={busy} onClick={() => void refresh()}>
          {busy ? t("ResidentDutyLogs.loading") : t("ResidentDutyLogs.refresh")}
        </button>
      </div>

      {listError !== null && <p className="banner banner--red" role="alert">{listError}</p>}
      {targets !== null && targets.length === 0 && listError === null ? (
        <p className="resident-logs-empty">{t("ResidentDutyLogs.empty")}</p>
      ) : (
        <>
          <div className="resident-logs-toolbar">
            <label>
              <span>{t("ResidentDutyLogs.agentFilter")}</span>
              <select value={selected} onChange={(event) => selectTarget(event.currentTarget.value)}>
                <option value="all">{t("ResidentDutyLogs.allAgents")}</option>
                {(targets ?? []).map((row) => (
                  <option key={row.key} value={row.key}>
                    {targetLabel(row, t)}{row.channel ? ` · #${row.channel}` : ""}
                    {row.kind === "duty" ? ` · ${t("ResidentDutyLogs.resident")}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="resident-logs-search-label">
              <span>{t("ResidentDutyLogs.searchLabel")}</span>
              <input
                type="search"
                value={query}
                placeholder={t("ResidentDutyLogs.searchPlaceholder")}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="resident-logs-levels" aria-label={t("ResidentDutyLogs.levelFilter")}>
            {(["all", "error", "warn", "info"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`d-btn resident-logs-level resident-logs-level--${value}${level === value ? " is-active" : ""}`}
                aria-pressed={level === value}
                onClick={() => setLevel(value)}
              >
                {t(`ResidentDutyLogs.level.${value}`)} <span>{counts[value]}</span>
              </button>
            ))}
          </div>
          {logError !== null && <p className="banner banner--yellow" role="status">{logError}</p>}
          {busy ? (
            <p className="resident-logs-empty" role="status">{t("ResidentDutyLogs.loading")}</p>
          ) : renderedLog === "" ? (
            <p className="resident-logs-empty">{t(entries.length === 0 ? "ResidentDutyLogs.noLog" : "ResidentDutyLogs.noMatch")}</p>
          ) : (
            <pre ref={logPreRef} className="t-mono resident-logs-pre" tabIndex={0}>{renderedLog}</pre>
          )}
        </>
      )}
    </section>
  );
}
