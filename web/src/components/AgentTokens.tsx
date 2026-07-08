import { type CSSProperties, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AuthError,
  type ChannelAgentInfo,
  ForbiddenError,
  listChannelAgents,
  rotateChannelAgent,
} from "../lib/api";
import {
  buildMinimalAgentCommand,
  copyText,
  findSavedAgentToken,
  listSavedAgentTokens,
  saveAgentToken,
} from "../lib/agentTokenVault";
import { useT } from "../i18n/useT";
import "../i18n/strings/AgentTokens";

interface Props {
  slug: string;
  token: string;
  accountKey: string;
  inviterName: string;
  onAuthFailed(message: string): void;
}

type CopyTarget = `${string}:token` | `${string}:command`;

export function AgentTokens({ slug, token, accountKey, inviterName, onAuthFailed }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<ChannelAgentInfo[] | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const localOnly = useMemo(() => {
    const serverNames = new Set((agents ?? []).map((agent) => agent.name));
    return listSavedAgentTokens(accountKey, slug).filter((rec) => !serverNames.has(rec.name));
  }, [accountKey, agents, slug]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setAgents(await listChannelAgents(token, slug));
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errForbidden"));
      else setError(t("AgentTokens.errLoad"));
    }
  }, [onAuthFailed, slug, t, token]);

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && agents === null) void refresh();
  }, [agents, open, refresh]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePanelPosition = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const gap = 6;
      const margin = 12;
      const width = Math.min(620, window.innerWidth - margin * 2);
      const top = Math.min(anchor.bottom + gap, window.innerHeight - margin);
      const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
      const maxHeight = Math.max(220, window.innerHeight - top - margin);
      setPanelStyle({ left, top, width, maxHeight });
    };

    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open]);

  async function copy(name: string, kind: "token" | "command", text: string) {
    const ok = await copyText(text);
    if (!ok) {
      setError(t("AgentTokens.errCopy"));
      return;
    }
    const key = `${name}:${kind}` as CopyTarget;
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
  }

  async function rotate(name: string) {
    const ok = window.confirm(t("AgentTokens.rotateConfirm", { name }));
    if (!ok) return;
    setBusyName(name);
    setError(null);
    try {
      const next = await rotateChannelAgent(token, slug, name);
      const command = buildMinimalAgentCommand({
        server: location.origin,
        slug,
        name: next.name,
        token: next.token,
        inviterName,
        checkinMessage: t("AgentTokens.checkinMessage", { name: next.name }),
      });
      saveAgentToken({
        account: accountKey,
        slug,
        name: next.name,
        token: next.token,
        command,
        savedAt: Date.now(),
      });
      await refresh();
    } catch (err) {
      if (err instanceof AuthError) onAuthFailed(err.message);
      else if (err instanceof ForbiddenError) setError(t("AgentTokens.errRotateForbidden"));
      else setError(t("AgentTokens.errRotate"));
    } finally {
      setBusyName(null);
    }
  }

  return (
    <div className="agenttokens" ref={rootRef}>
      <button type="button" className="d-btn agenttokens-btn" onClick={toggle} aria-expanded={open}>
        {t("AgentTokens.open")}
      </button>
      {open && (
        <div className="agenttokens-panel" style={panelStyle}>
          <div className="agenttokens-head">
            <span className="agenttokens-title">{t("AgentTokens.title")}</span>
            <button type="button" className="d-btn agenttokens-refresh" onClick={refresh}>
              {t("AgentTokens.refresh")}
            </button>
          </div>
          <p className="agenttokens-hint">{t("AgentTokens.hint")}</p>
          {error !== null && <p className="agenttokens-error">{error}</p>}
          {agents === null && error === null && <p className="agenttokens-empty">{t("AgentTokens.loading")}</p>}
          {agents !== null && agents.length === 0 && localOnly.length === 0 && (
            <p className="agenttokens-empty">{t("AgentTokens.empty")}</p>
          )}
          {agents !== null && agents.length > 0 && (
            <ul className="agenttokens-list">
              {agents.map((agent) => {
                const saved = findSavedAgentToken(accountKey, slug, agent.name);
                return (
                  <li key={agent.name} className="agenttokens-item">
                    <div className="agenttokens-main">
                      <strong className="agenttokens-name">{agent.name}</strong>
                      <span className="agenttokens-meta">
                        {saved ? t("AgentTokens.hasPlaintext") : t("AgentTokens.noPlaintext")}
                      </span>
                    </div>
                    {saved ? <code className="agenttokens-token t-mono">{saved.token}</code> : null}
                    <div className="agenttokens-actions">
                      {saved ? (
                        <>
                          <button type="button" className="d-btn" onClick={() => copy(agent.name, "token", saved.token)}>
                            {copied === `${agent.name}:token` ? t("AgentTokens.copied") : t("AgentTokens.copyToken")}
                          </button>
                          <button type="button" className="d-btn" onClick={() => copy(agent.name, "command", saved.command)}>
                            {copied === `${agent.name}:command` ? t("AgentTokens.copied") : t("AgentTokens.copyPack")}
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="d-btn agenttokens-rotate"
                        disabled={busyName === agent.name}
                        onClick={() => rotate(agent.name)}
                      >
                        {busyName === agent.name ? t("AgentTokens.rotating") : t("AgentTokens.rotate")}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {localOnly.length > 0 && (
            <>
              <p className="agenttokens-subtitle">{t("AgentTokens.localOnlyTitle")}</p>
              <ul className="agenttokens-list">
                {localOnly.map((rec) => (
                  <li key={rec.name} className="agenttokens-item agenttokens-item--stale">
                    <div className="agenttokens-main">
                      <strong className="agenttokens-name">{rec.name}</strong>
                      <span className="agenttokens-meta">{t("AgentTokens.localOnlyMeta")}</span>
                    </div>
                    <code className="agenttokens-token t-mono">{rec.token}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
