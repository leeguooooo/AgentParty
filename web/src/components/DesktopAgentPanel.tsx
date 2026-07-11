import { useEffect, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  type DesktopAgentAdapter,
  type DesktopAgentConfig,
  type DesktopAgentRunner,
  type DesktopAgentStatus,
} from "../lib/desktopAgent";

const RUNNERS: readonly DesktopAgentRunner[] = ["codex", "claude", "codex-sdk"];

export interface DesktopAgentScheduler {
  every(callback: () => void, intervalMs: number): () => void;
}

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
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/\b(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\b(token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token redacted]")
    .replace(/(?:\/[\w.@~-]+)+\/config(?:\.json)?\b/gi, "[config path redacted]");
}

function isActive(status: DesktopAgentStatus | null): boolean {
  return status?.state === "starting" || status?.state === "running" || status?.state === "stopping";
}

function canRequestStop(status: DesktopAgentStatus | null): boolean {
  return status?.state === "starting" || status?.state === "running";
}

export function DesktopAgentPanel({ t, adapter = desktopAgentAdapter, scheduler = defaultScheduler }: Props) {
  const [configs, setConfigs] = useState<DesktopAgentConfig[] | null>(null);
  const [status, setStatus] = useState<DesktopAgentStatus | null>(null);
  const [configId, setConfigId] = useState("");
  const [channel, setChannel] = useState("");
  const [runner, setRunner] = useState<DesktopAgentRunner>("codex");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const aliveRef = useRef(true);
  const operationRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    let active = true;
    void Promise.all([adapter.listConfigs(), adapter.status()]).then(([nextConfigs, nextStatus]) => {
      if (!active) return;
      setConfigs(nextConfigs);
      setStatus(nextStatus);
      const selected = nextConfigs.find((item) => item.configId === nextStatus.configId) ?? nextConfigs[0];
      setConfigId(selected?.configId ?? "");
      setChannel(nextStatus.channel ?? selected?.channel ?? "");
      if (RUNNERS.includes(nextStatus.runner as DesktopAgentRunner)) {
        setRunner(nextStatus.runner as DesktopAgentRunner);
      }
    }).catch((cause) => {
      if (!active) return;
      setError(safeError(cause));
    });
    return () => {
      active = false;
      aliveRef.current = false;
    };
  }, [adapter, loadAttempt]);

  useEffect(() => {
    if (!isActive(status)) return;
    let active = true;
    const cancel = scheduler.every(() => {
      if (!active) return;
      void adapter.status().then((next) => {
        if (active) setStatus(next);
      }).catch((cause) => {
        if (active) setError(safeError(cause));
      });
      if (logsOpen) {
        void adapter.logs().then((next) => {
          if (active) setLogs(next.map(safeError));
        }).catch((cause) => {
          if (active) setError(safeError(cause));
        });
      }
    }, 2_000);
    return () => {
      active = false;
      cancel();
    };
  }, [adapter, logsOpen, scheduler, status?.state]);

  const runOperation = async (operation: () => Promise<DesktopAgentStatus>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError(null);
    setLogs(null);
    try {
      const next = await operation();
      if (aliveRef.current) {
        setStatus(next);
        if (logsOpen) {
          try {
            const nextLogs = (await adapter.logs()).map(safeError);
            if (aliveRef.current) setLogs(nextLogs);
          } catch (cause) {
            if (aliveRef.current) setError(safeError(cause));
          }
        }
      }
    } catch (cause) {
      if (aliveRef.current) setError(safeError(cause));
    } finally {
      operationRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const changeConfig = (nextId: string) => {
    setConfigId(nextId);
    const next = configs?.find((item) => item.configId === nextId);
    if (next?.channel) setChannel(next.channel);
  };

  const toggleLogs = async () => {
    const nextOpen = !logsOpen;
    setLogsOpen(nextOpen);
    if (!nextOpen || logs !== null) return;
    try {
      const nextLogs = (await adapter.logs()).map(safeError);
      if (aliveRef.current) setLogs(nextLogs);
    } catch (cause) {
      if (aliveRef.current) setError(safeError(cause));
    }
  };

  const stateLabel = status === null
    ? t("DesktopSettings.agent.state.loading")
    : t(`DesktopSettings.agent.state.${status.state}`);
  const noConfig = configs !== null && configs.length === 0;
  const canStart = !busy && !noConfig && configId !== "" && channel.trim() !== "" && !isActive(status);
  const canStop = !busy && canRequestStop(status);
  const channels = [...new Set((configs ?? []).map((item) => item.channel).filter((value): value is string => Boolean(value)))];

  return (
    <section className="desktop-agent" aria-labelledby="desktop-agent-title">
      <div className="desktop-agent-head">
        <strong id="desktop-agent-title">{t("DesktopSettings.agent.title")}</strong>
        <span className={`desktop-agent-state desktop-agent-state--${status?.state ?? "loading"}`} role="status" aria-live="polite">
          {stateLabel}
        </span>
      </div>

      {noConfig ? (
        <p className="desktop-agent-empty">{t("DesktopSettings.agent.empty")}</p>
      ) : (
        <div className="desktop-agent-fields">
          <label>
            <span>{t("DesktopSettings.agent.identity")}</span>
            <select
              value={configId}
              disabled={busy || configs === null || isActive(status)}
              onChange={(event) => changeConfig(event.target.value)}
            >
              {(configs ?? []).map((item) => (
                <option key={item.configId} value={item.configId}>{item.name} · {item.role}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("DesktopSettings.agent.channel")}</span>
            <input
              className="t-mono"
              name="desktop-agent-channel"
              value={channel}
              list="desktop-agent-channels"
              disabled={busy || configs === null || isActive(status)}
              onChange={(event) => setChannel(event.target.value)}
              autoComplete="off"
            />
            <datalist id="desktop-agent-channels">
              {channels.map((value) => <option key={value} value={value} />)}
            </datalist>
          </label>
          <label>
            <span>{t("DesktopSettings.agent.runner")}</span>
            <select
              value={runner}
              disabled={busy || configs === null || isActive(status)}
              onChange={(event) => setRunner(event.target.value as DesktopAgentRunner)}
            >
              {RUNNERS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
      )}

      {status !== null && status.state !== "stopped" && (
        <p className="desktop-agent-detail">
          {[status.name, status.channel ? `#${status.channel}` : null, status.runner].filter(Boolean).join(" · ")}
        </p>
      )}
      {status?.lastError && <p className="desktop-agent-error" role="alert">{safeError(status.lastError)}</p>}
      {error && <p className="desktop-agent-error" role="alert">{error}</p>}
      {error && (configs === null || status === null) && (
        <button
          type="button"
          className="d-btn desktop-agent-retry"
          aria-label={t("DesktopSettings.agent.retry")}
          onClick={() => {
            setError(null);
            setLoadAttempt((current) => current + 1);
          }}
        >
          {t("DesktopSettings.agent.retry")}
        </button>
      )}

      <div className="desktop-agent-actions">
        <button
          type="button"
          className="d-btn"
          aria-label={t("DesktopSettings.agent.start")}
          disabled={!canStart}
          onClick={() => runOperation(() => adapter.start({ configId, channel: channel.trim(), runner }))}
        >
          {t("DesktopSettings.agent.start")}
        </button>
        <button
          type="button"
          className="d-btn"
          aria-label={t("DesktopSettings.agent.stop")}
          disabled={!canStop}
          onClick={() => runOperation(() => adapter.stop())}
        >
          {t("DesktopSettings.agent.stop")}
        </button>
        <button
          type="button"
          className="desktop-agent-logs-toggle"
          aria-label={t(logsOpen ? "DesktopSettings.agent.logs.hide" : "DesktopSettings.agent.logs.show")}
          aria-expanded={logsOpen}
          aria-controls="desktop-agent-logs"
          onClick={() => void toggleLogs()}
        >
          {t(logsOpen ? "DesktopSettings.agent.logs.hide" : "DesktopSettings.agent.logs.show")}
        </button>
      </div>

      {logsOpen && (
        <pre id="desktop-agent-logs" className="desktop-agent-logs" aria-label={t("DesktopSettings.agent.logs.label")}>
          {logs === null
            ? t("DesktopSettings.agent.logs.loading")
            : logs.length === 0 ? t("DesktopSettings.agent.logs.empty") : logs.join("\n")}
        </pre>
      )}
    </section>
  );
}
