import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  type DesktopAgentAdapter,
  type DesktopAgentConfig,
} from "../lib/desktopAgent";
import { aggregateLocalAgents, type LocalAgentRow } from "../lib/localAgents";
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
  ownerLabel: string | null;
  channel: string;
  level: LogLevel;
  message: string;
  timestamp: number | null;
  timestampLabel: string | null;
  sourceOrder: number;
  lineOrder: number;
}

function inferredLogLevel(line: string): LogLevel {
  if (/\b(error|failed?|fatal|panic|exception)\b|错误|失败|异常/i.test(line)) return "error";
  if (/\b(warn(?:ing)?|retry|reconnect)\b|警告|重试|重连/i.test(line)) {
    return "warn";
  }
  return "info";
}

const EXPLICIT_LEVEL = /^\s*\[(ERROR|ERR|FATAL|WARN|WARNING|INFO|DEBUG|TRACE)\]\s*/i;
const DUPLICATE_SOURCE = /^\s*\[[^\]\r\n]+?\s+#[^\]\r\n]+\]\s*/;
const ISO_TIMESTAMP = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))\b/;

function explicitLevel(value: string): LogLevel | null {
  const normalized = value.toUpperCase();
  if (normalized === "ERROR" || normalized === "ERR" || normalized === "FATAL") return "error";
  if (normalized === "WARN" || normalized === "WARNING") return "warn";
  return normalized === "INFO" || normalized === "DEBUG" || normalized === "TRACE" ? "info" : null;
}

export function formatLocalLogTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function parseLocalLogLine(line: string): {
  level: LogLevel;
  message: string;
  timestamp: number | null;
  timestampLabel: string | null;
} {
  let message = line.trim();
  const levelMatch = message.match(EXPLICIT_LEVEL);
  const declaredLevel = levelMatch === null ? null : explicitLevel(levelMatch[1]!);
  if (levelMatch !== null) message = message.slice(levelMatch[0].length);
  // 旧日志查看器已经把来源写进原始文本时，不要再显示第二遍。
  message = message.replace(DUPLICATE_SOURCE, "");

  const timestampMatch = message.match(ISO_TIMESTAMP);
  const timestamp = timestampMatch === null ? null : Date.parse(timestampMatch[1]!);
  const validTimestamp = timestamp !== null && Number.isFinite(timestamp) ? timestamp : null;
  if (timestampMatch !== null && validTimestamp !== null) {
    const index = timestampMatch.index ?? 0;
    message = `${message.slice(0, index)}${message.slice(index + timestampMatch[0].length)}`
      .replace(/:\s+:/, ":")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  return {
    level: declaredLevel ?? inferredLogLevel(message),
    message,
    timestamp: validTimestamp,
    timestampLabel: validTimestamp === null ? null : formatLocalLogTime(validTimestamp),
  };
}

function targetLabel(row: LocalAgentRow, t: TFunc): string {
  return row.name ?? t("ResidentDutyLogs.unknownAgent");
}

function targetSourceLabel(row: LocalAgentRow, t: TFunc): string {
  return [
    row.ownerLabel === null ? t("ResidentDutyLogs.ownerPending") : t("ResidentDutyLogs.owner", { owner: row.ownerLabel }),
    targetLabel(row, t),
    row.channel ? `#${row.channel}` : "",
  ].filter(Boolean).join(" · ");
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

  const readRow = useCallback(async (row: LocalAgentRow, sourceOrder: number): Promise<LogEntry[]> => {
    let text = "";
    if (row.kind === "duty") {
      text = await adapter.dutyLogRead(row.duty!.label);
    } else if (row.instanceId !== null && adapter.logsInstance !== undefined) {
      text = (await adapter.logsInstance(row.instanceId)).join("\n");
    } else if (adapter.logs !== undefined) {
      text = (await adapter.logs()).join("\n");
    }
    const name = targetLabel(row, t);
    return splitLines(text).map((line, index) => {
      const parsed = parseLocalLogLine(line);
      return {
        id: `${row.key}:${index}`,
        targetKey: row.key,
        agentName: name,
        ownerLabel: row.ownerLabel,
        channel: row.channel,
        level: parsed.level,
        message: parsed.message,
        timestamp: parsed.timestamp,
        timestampLabel: parsed.timestampLabel,
        sourceOrder,
        lineOrder: index,
      };
    });
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
      const results = await Promise.allSettled(chosen.map((row, index) => readRow(row, index)));
      if (!activeRef.current || request !== requestRef.current) return;
      const perSource = Math.max(1, Math.floor(1_500 / Math.max(1, chosen.length)));
      const nextEntries = results
        .flatMap((result) => result.status === "fulfilled" ? result.value.slice(-perSource) : [])
        .sort((left, right) => {
          // 最新在上：有时间的跨 Agent 合并为真实时间线；旧日志没有时间时，按来源和
          // 来源内倒序稳定展示，并明确标为「时间未知」，不伪造时间。
          if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
            return right.timestamp - left.timestamp;
          }
          if (left.timestamp !== null) return -1;
          if (right.timestamp !== null) return 1;
          if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
          return right.lineOrder - left.lineOrder;
        });
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
        `${entry.ownerLabel ?? ""} ${entry.agentName} ${entry.channel} ${entry.message}`.toLowerCase().includes(normalized)
      ));
  }, [entries, level, query]);

  const renderedLog = useMemo(
    () => visibleEntries.map((entry) =>
      `[${entry.timestampLabel ?? t("ResidentDutyLogs.unknownTime")}] ` +
      `[${entry.level.toUpperCase()}] ` +
      `[${entry.ownerLabel === null ? t("ResidentDutyLogs.ownerPending") : t("ResidentDutyLogs.owner", { owner: entry.ownerLabel })}` +
      ` · ${entry.agentName}${entry.channel ? ` · #${entry.channel}` : ""}] ${entry.message}`,
    ).join("\n"),
    [t, visibleEntries],
  );

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
                    {targetSourceLabel(row, t)}
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
            <pre className="t-mono resident-logs-pre" tabIndex={0}>{renderedLog}</pre>
          )}
        </>
      )}
    </section>
  );
}
