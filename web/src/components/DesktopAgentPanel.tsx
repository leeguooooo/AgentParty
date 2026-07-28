import { useEffect, useRef, useState } from "react";
import type { TFunc } from "../i18n/useT";
import {
  desktopAgentAdapter,
  dutyDependencyErrorRunner,
  type DesktopAgentAdapter,
  type DesktopAgentConfig,
  type DesktopAgentRunner,
  type DesktopAgentStartInput,
  type DesktopAgentStatus,
  type DesktopDutyEntry,
} from "../lib/desktopAgent";
import { pickDirectory as pickDirectoryDefault } from "../lib/desktopRuntime";

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
  active?: boolean;
  // 原生目录选择器（测试可注入）；默认走 tauri dialog。返回 null=非桌面/取消。
  pickDirectory?: (title?: string) => Promise<string | null>;
}

function safeError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/\b(bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\b(token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[token redacted]")
    .replace(/(?:\/[\w.@~-]+)+\/config(?:\.json)?\b/gi, "[config path redacted]");
}

function dutyOperationError(value: unknown, t: TFunc): string {
  const runner = dutyDependencyErrorRunner(value);
  return runner === null
    ? safeError(value)
    : t("DesktopSettings.agent.dutyDependencyMissing", { runner });
}

function isActive(status: DesktopAgentStatus | null): boolean {
  return status?.state === "starting" || status?.state === "running" || status?.state === "stopping";
}

function canRequestStop(status: DesktopAgentStatus | null): boolean {
  return status?.state === "starting" || status?.state === "running";
}

// #616 多实例：statusAll 可用（新 shell）时用实例列表；旧 shell 抛错则回退单实例视图。
function derivePrimary(instances: DesktopAgentStatus[]): DesktopAgentStatus | null {
  return (
    instances.find((item) => isActive(item)) ??
    instances.find((item) => item.state === "failed") ??
    instances[0] ??
    null
  );
}

export function DesktopAgentPanel({
  t,
  adapter = desktopAgentAdapter,
  scheduler = defaultScheduler,
  active = true,
  pickDirectory = pickDirectoryDefault,
}: Props) {
  const [configs, setConfigs] = useState<DesktopAgentConfig[] | null>(null);
  const [status, setStatus] = useState<DesktopAgentStatus | null>(null);
  const [instances, setInstances] = useState<DesktopAgentStatus[] | null>(null);
  const [configId, setConfigId] = useState("");
  const [channel, setChannel] = useState("");
  const [runner, setRunner] = useState<DesktopAgentRunner>("codex");
  const [workdir, setWorkdir] = useState("");
  const [repo, setRepo] = useState("");
  // #616 phase 3：launchd 常驻。duties=null 表示不可用（非 macOS / 旧 shell），整个区块隐藏。
  const [persistMode, setPersistMode] = useState(false);
  const [duties, setDuties] = useState<DesktopDutyEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const aliveRef = useRef(true);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);
  const initializedRef = useRef(false);
  const statusRequestSeqRef = useRef(0);
  const dutyRequestSeqRef = useRef(0);
  // null=未探测，true/false=statusAll 是否可用（探测一次，之后不再打旧 shell 的未知命令）。
  const multiRef = useRef<boolean | null>(null);

  const fetchStatus = async (): Promise<{
    requestSeq: number;
    status: DesktopAgentStatus | null;
  }> => {
    const requestSeq = ++statusRequestSeqRef.current;
    if (multiRef.current !== false) {
      try {
        const all = await adapter.statusAll();
        multiRef.current = true;
        if (aliveRef.current && requestSeq === statusRequestSeqRef.current) setInstances(all);
        return { requestSeq, status: derivePrimary(all) };
      } catch {
        if (multiRef.current === true) throw new Error("desktop agent status is unavailable");
        multiRef.current = false;
      }
    }
    return { requestSeq, status: await adapter.status() };
  };

  const fetchDuties = async (): Promise<{
    requestSeq: number;
    entries: DesktopDutyEntry[];
  }> => {
    const requestSeq = ++dutyRequestSeqRef.current;
    return { requestSeq, entries: await adapter.dutyList() };
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let requestActive = true;
    if (!active) {
      aliveRef.current = false;
      statusRequestSeqRef.current += 1;
      dutyRequestSeqRef.current += 1;
      return () => {
        requestActive = false;
        aliveRef.current = false;
        statusRequestSeqRef.current += 1;
        dutyRequestSeqRef.current += 1;
      };
    }
    aliveRef.current = true;
    void fetchDuties().then((snapshot) => {
      if (requestActive && snapshot.requestSeq === dutyRequestSeqRef.current) {
        setDuties(snapshot.entries);
      }
    }).catch(() => {
      // 非 macOS / 旧 shell：常驻不可用，静默隐藏
    });
    void Promise.all([adapter.listConfigs(), fetchStatus()]).then(([nextConfigs, snapshot]) => {
      if (!requestActive || snapshot.requestSeq !== statusRequestSeqRef.current) return;
      setConfigs(nextConfigs);
      setStatus(snapshot.status);
      if (!initializedRef.current) {
        const selected = nextConfigs.find((item) => item.configId === snapshot.status?.configId) ?? nextConfigs[0];
        setConfigId(selected?.configId ?? "");
        setChannel(snapshot.status?.channel ?? selected?.channel ?? "");
        if (RUNNERS.includes(snapshot.status?.runner as DesktopAgentRunner)) {
          setRunner(snapshot.status?.runner as DesktopAgentRunner);
        }
        initializedRef.current = true;
      }
    }).catch((cause) => {
      if (!requestActive) return;
      setError(safeError(cause));
    });
    return () => {
      requestActive = false;
      aliveRef.current = false;
      statusRequestSeqRef.current += 1;
      dutyRequestSeqRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapter, loadAttempt]);

  useEffect(() => {
    if (!active) return;
    let polling = true;
    const cancel = scheduler.every(() => {
      if (!polling) return;
      void fetchDuties().then((snapshot) => {
        if (
          polling &&
          aliveRef.current &&
          snapshot.requestSeq === dutyRequestSeqRef.current
        ) {
          setDuties(snapshot.entries);
        }
      }).catch(() => {
        // 非 macOS / 旧 shell：与首次探测一致，静默保持常驻区块不可用。
      });
    }, 2_000);
    return () => {
      polling = false;
      dutyRequestSeqRef.current += 1;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapter, scheduler]);

  const anyActive = isActive(status) || (instances ?? []).some((item) => isActive(item));

  useEffect(() => {
    if (!active || busy || !anyActive) return;
    let polling = true;
    const cancel = scheduler.every(() => {
      if (!polling) return;
      void fetchStatus().then((snapshot) => {
        if (polling && snapshot.requestSeq === statusRequestSeqRef.current) {
          setStatus(snapshot.status);
        }
      }).catch((cause) => {
        if (polling) setError(safeError(cause));
      });
    }, 2_000);
    return () => {
      polling = false;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapter, anyActive, busy, scheduler, status?.state]);

  const runOperation = async (operation: () => Promise<DesktopAgentStatus>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    statusRequestSeqRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const next = await operation();
      if (aliveRef.current) {
        setStatus(next);
        // 多实例：任何操作后刷新整表，别让列表与单实例回执漂移。
        if (multiRef.current === true) {
          try {
            const snapshot = await fetchStatus();
            if (aliveRef.current && snapshot.requestSeq === statusRequestSeqRef.current) {
              setStatus(snapshot.status);
            }
          } catch {
            // 刷新失败不吞操作结果；下一轮轮询会补上。
          }
        }
      }
    } catch (cause) {
      if (aliveRef.current) setError(safeError(cause));
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const changeConfig = (nextId: string) => {
    setConfigId(nextId);
    const next = configs?.find((item) => item.configId === nextId);
    if (next?.channel) setChannel(next.channel);
  };

  const persistDuty = async (input?: DesktopAgentStartInput) => {
    if (operationRef.current) return;
    operationRef.current = true;
    statusRequestSeqRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      await adapter.dutyPersist(input ?? {
          configId,
          channel: channel.trim(),
          runner,
          workdir: workdir.trim() === "" ? undefined : workdir.trim(),
          repo: repo.trim() === "" ? undefined : repo.trim(),
        });
      if (!aliveRef.current) return;
      const snapshot = await fetchDuties();
      if (aliveRef.current && snapshot.requestSeq === dutyRequestSeqRef.current) {
        setDuties(snapshot.entries);
      }
      // 转常驻会顺带停掉 app 内同键实例——刷新实例表别让两处状态漂移
      if (multiRef.current === true) {
        try {
          const snapshot = await fetchStatus();
          if (aliveRef.current && snapshot.requestSeq === statusRequestSeqRef.current) {
            setStatus(snapshot.status);
          }
        } catch {
          // 下一轮轮询补上
        }
      }
    } catch (cause) {
      if (aliveRef.current) setError(dutyOperationError(cause, t));
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const stateLabel = status === null
    ? t("DesktopSettings.agent.state.loading")
    : t(`DesktopSettings.agent.state.${status.state}`);
  const noConfig = configs !== null && configs.length === 0;
  const targetKey = `${configId}:${channel.trim()}`;
  const targetActive = instances === null
    ? isActive(status)
    : instances.some((item) => item.instanceId === targetKey && isActive(item));
  const activeCount = (instances ?? []).filter((item) => isActive(item)).length;
  const canStart =
    !busy && !noConfig && configId !== "" && channel.trim() !== "" && !targetActive &&
    (instances === null || activeCount < 8);
  const canStop = !busy && (instances === null ? canRequestStop(status) : activeCount > 0);
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
              disabled={busy || configs === null || (instances === null && isActive(status))}
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
              disabled={busy || configs === null || (instances === null && isActive(status))}
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
              disabled={busy || configs === null || (instances === null && isActive(status))}
              onChange={(event) => setRunner(event.target.value as DesktopAgentRunner)}
            >
              {RUNNERS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <div className="desktop-agent-workdir-field">
            <label htmlFor="desktop-agent-workdir">{t("DesktopSettings.agent.workdir")}</label>
            <span className="desktop-agent-workdir-row">
              <input
                id="desktop-agent-workdir"
                className="t-mono desktop-agent-workdir-input"
                name="desktop-agent-workdir"
                value={workdir}
                placeholder="/absolute/path"
                disabled={busy || configs === null}
                onChange={(event) => setWorkdir(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="d-btn desktop-agent-workdir-pick"
                disabled={busy || configs === null}
                aria-label={t("DesktopSettings.agent.workdirPick")}
                onClick={() => {
                  void pickDirectory(t("DesktopSettings.agent.workdirPick")).then((dir) => {
                    if (dir !== null && mountedRef.current) setWorkdir(dir);
                  });
                }}
              >
                {t("DesktopSettings.agent.workdirPick")}
              </button>
            </span>
          </div>
          <label className="desktop-agent-persist">
            <input
              type="checkbox"
              name="desktop-agent-persist"
              checked={persistMode}
              disabled={busy || duties === null}
              onChange={(event) => setPersistMode(event.target.checked)}
            />
            <span>{t("DesktopSettings.agent.persistMode")}</span>
          </label>
          <label>
            <span>{t("DesktopSettings.agent.repo")}</span>
            <input
              className="t-mono"
              name="desktop-agent-repo"
              value={repo}
              placeholder="https://github.com/org/repo.git"
              disabled={busy || configs === null}
              onChange={(event) => setRepo(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
      )}

      {(anyActive || (duties?.length ?? 0) > 0) && (
        <p className="desktop-agent-manage-hint">
          {t("DesktopSettings.agent.manageHint", {
            running: String(instances === null ? (isActive(status) ? 1 : 0) : activeCount),
            resident: String(duties?.length ?? 0),
          })}
        </p>
      )}

      {instances === null && status !== null && status.state !== "stopped" && (
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
          onClick={() => {
            if (persistMode && duties !== null) {
              void persistDuty();
              return;
            }
            void runOperation(() =>
              adapter.start({
                configId,
                channel: channel.trim(),
                runner,
                workdir: workdir.trim() === "" ? undefined : workdir.trim(),
                repo: repo.trim() === "" ? undefined : repo.trim(),
              }),
            );
          }}
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
      </div>
    </section>
  );
}
