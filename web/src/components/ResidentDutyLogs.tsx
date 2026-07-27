// #725：桌面端「常驻 agent 日志」——枚举本机 launchd 常驻实例，点开看它的 serve 日志尾部，
// 方便排查「设了常驻、@ 没反应」这类问题(日志里能看到 ▶ wake / serve: / runner 报错)。
import { useCallback, useEffect, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  type DesktopAgentAdapter,
  type DesktopAgentConfig,
  type DesktopDutyEntry,
} from "../lib/desktopAgent";
import { useAutoScrollToLatest } from "../lib/useAutoScrollToLatest";
import "../i18n/strings/ResidentDutyLogs";

type ResidentDutyAdapter = Pick<DesktopAgentAdapter, "dutyList" | "dutyLogRead"> &
  Partial<Pick<DesktopAgentAdapter, "listConfigs">>;

interface Props {
  t: TFunc;
  adapter?: ResidentDutyAdapter;
  active?: boolean;
}

// instanceId 形如 "<config_id>:<channel>"；频道名给人看，config 短哈希只作区分。
function channelOf(entry: DesktopDutyEntry): string {
  const idx = entry.instanceId.lastIndexOf(":");
  return idx >= 0 ? entry.instanceId.slice(idx + 1) : entry.instanceId;
}

function configIdOf(entry: DesktopDutyEntry): string {
  const idx = entry.instanceId.indexOf(":");
  return idx >= 0 ? entry.instanceId.slice(0, idx) : entry.instanceId;
}

function configNames(configs: readonly DesktopAgentConfig[]): Map<string, string> {
  return new Map(configs.map((config) => [config.configId, config.name]));
}

export function ResidentDutyLogs({ t, adapter = desktopAgentAdapter, active = true }: Props) {
  const [entries, setEntries] = useState<DesktopDutyEntry[] | null>(null);
  const [namesByConfigId, setNamesByConfigId] = useState<Map<string, string>>(() => new Map());
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // 选中的 label
  const [log, setLog] = useState<string>("");
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  // 请求排序保护:快速切换条目时,只让「最后一次点击」的结果落地,避免慢请求覆盖新选中的日志。
  const loadSeqRef = useRef(0);
  const listSeqRef = useRef(0);
  const listActiveRef = useRef(active);
  const logPreRef = useAutoScrollToLatest<HTMLPreElement>(log, !logBusy && logError === null);

  const refreshList = useCallback(async () => {
    const seq = ++listSeqRef.current;
    setListError(null);
    try {
      const configsRequest = adapter.listConfigs?.().catch(() => [] as DesktopAgentConfig[]) ??
        Promise.resolve([] as DesktopAgentConfig[]);
      const [list, configs] = await Promise.all([adapter.dutyList(), configsRequest]);
      if (!listActiveRef.current || seq !== listSeqRef.current) return;
      setEntries(list);
      setNamesByConfigId(configNames(configs));
      // 选中项若已消失，清掉日志。
      setSelected((current) => (current !== null && list.some((e) => e.label === current) ? current : null));
    } catch (err) {
      if (!listActiveRef.current || seq !== listSeqRef.current) return;
      setEntries([]);
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, [adapter]);

  const loadLog = useCallback(
    async (label: string) => {
      const seq = ++loadSeqRef.current;
      setSelected(label);
      setLog(""); // 先清掉旧日志,别让上一条实例的内容残留在新标题下(加载中会显示 loading)
      setLogBusy(true);
      setLogError(null);
      try {
        const text = await adapter.dutyLogRead(label);
        if (seq !== loadSeqRef.current) return; // 已被更晚的点击取代——丢弃这次结果
        setLog(text);
      } catch (err) {
        if (seq !== loadSeqRef.current) return;
        setLog("");
        setLogError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === loadSeqRef.current) setLogBusy(false);
      }
    },
    [adapter],
  );

  useEffect(() => {
    listActiveRef.current = active;
    if (!active) {
      listSeqRef.current += 1;
      return;
    }
    void refreshList();
    return () => {
      listActiveRef.current = false;
      listSeqRef.current += 1;
    };
  }, [active, refreshList]);

  const agentNameOf = (entry: DesktopDutyEntry): string => {
    const configId = configIdOf(entry);
    return namesByConfigId.get(configId) ?? configId;
  };

  const selectedEntry = entries?.find((entry) => entry.label === selected) ?? null;

  return (
    <div className="resident-logs">
      <div className="resident-logs-head">
        <h3 className="resident-logs-title">{t("ResidentDutyLogs.title")}</h3>
        <button type="button" className="d-btn resident-logs-refresh" onClick={() => void refreshList()}>
          {t("ResidentDutyLogs.refresh")}
        </button>
      </div>
      <p className="resident-logs-lead">{t("ResidentDutyLogs.lead")}</p>

      {listError !== null && <p className="banner banner--red" role="alert">{listError}</p>}

      {entries !== null && entries.length === 0 && listError === null ? (
        <p className="resident-logs-empty">{t("ResidentDutyLogs.empty")}</p>
      ) : (
        <ul className="resident-logs-list">
          {(entries ?? []).map((entry) => (
            <li key={entry.label}>
              <button
                type="button"
                className={`d-btn resident-logs-item${selected === entry.label ? " resident-logs-item--active" : ""}`}
                onClick={() => void loadLog(entry.label)}
              >
                <span className="resident-logs-chan">#{channelOf(entry)}</span>
                <span className="resident-logs-agent">{agentNameOf(entry)}</span>
                <span className={`resident-logs-dot${entry.loaded ? " resident-logs-dot--on" : ""}`} aria-hidden="true">
                  ●
                </span>
                <span className="resident-logs-state">
                  {entry.loaded ? t("ResidentDutyLogs.loaded") : t("ResidentDutyLogs.stopped")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected !== null && (
        <div className="resident-logs-view">
          <div className="resident-logs-view-head">
            <span className="resident-logs-selection">
              {selectedEntry !== null && <strong>{agentNameOf(selectedEntry)}</strong>}
              <span className="t-mono resident-logs-label">{selected}</span>
            </span>
            <button type="button" className="d-btn resident-logs-reload" disabled={logBusy} onClick={() => void loadLog(selected)}>
              {logBusy ? t("ResidentDutyLogs.loading") : t("ResidentDutyLogs.reload")}
            </button>
          </div>
          {logError !== null && <p className="banner banner--red" role="alert">{logError}</p>}
          {logError === null &&
            (log.trim() === "" ? (
              <p className="resident-logs-empty">{t("ResidentDutyLogs.noLog")}</p>
            ) : (
              <pre ref={logPreRef} className="t-mono resident-logs-pre">{log}</pre>
            ))}
        </div>
      )}
    </div>
  );
}
