// Live session 只读终端视图（#1103）。所有入口（成员条 / AgentDetail 主行动 / 时间线 working 卡片）
// 打开的都是同一份 state.liveSessions[name]——同一 session id、同一条流，而不是再翻一遍频道历史。
// 只读：没有输入框；发话仍走频道 Composer。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LiveSession } from "../state";
import { useT } from "../i18n/useT";
import { useModalFocusTrap } from "./useModalFocusTrap";
import "../i18n/strings/LiveSession";

/** 距底部多少像素以内算「贴底」（贴底才自动 follow）。 */
export const FOLLOW_THRESHOLD_PX = 24;

/** 用户是否停在底部附近；只有贴底时新行才会把视图拽到底。 */
export function isPinnedToBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

/** 入口是否可用：有 live session 条目才亮；否则禁用并说明原因。 */
export function hasLiveSession(sessions: Record<string, LiveSession>, name: string): boolean {
  return Object.hasOwn(sessions, name);
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export interface LiveSessionViewProps {
  name: string;
  display: string;
  session: LiveSession | null;
  /** 嵌入模式（AgentDetail 里）用更矮的视口。 */
  compact?: boolean;
}

export function LiveSessionView({ name, display, session, compact = false }: LiveSessionViewProps) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const lineCount = session?.lines.length ?? 0;
  const sessionId = session?.session_id ?? null;

  // 换 session 时回到 follow。
  useEffect(() => {
    setFollowing(true);
  }, [sessionId]);

  // 新行到达：只有 follow 状态才滚到底；用户上翻后不拽回去。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || !following) return;
    el.scrollTop = el.scrollHeight;
  }, [lineCount, following, sessionId]);

  if (session === null) {
    return (
      <div className={`live-session live-session--empty${compact ? " live-session--compact" : ""}`} data-live-session={name}>
        <p className="t-mono live-session-empty">{t("LiveSession.empty")}</p>
      </div>
    );
  }

  const stateKey = `LiveSession.state.${session.state}`;
  return (
    <div
      className={`live-session live-session--${session.state}${compact ? " live-session--compact" : ""}`}
      data-live-session={name}
      data-session-id={session.session_id}
      data-state={session.state}
    >
      <div className="live-session-head t-mono">
        <span className={`live-session-dot live-session-dot--${session.state}`} aria-hidden="true" />
        <span className="live-session-who">{display}</span>
        {session.task_seq !== null && (
          <span className="live-session-task">{t("LiveSession.task", { seq: String(session.task_seq) })}</span>
        )}
        <span className="live-session-id" title={session.session_id}>
          {t("LiveSession.session", { id: session.session_id.slice(-8) })}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="live-session-screen t-mono"
        role="log"
        aria-live={session.state === "running" && following ? "polite" : "off"}
        aria-label={t("LiveSession.title", { name: display })}
        tabIndex={0}
        onScroll={(event) => {
          const pinned = isPinnedToBottom(event.currentTarget);
          if (pinned !== following) setFollowing(pinned);
        }}
      >
        {session.lines.length === 0 ? (
          <div className="live-session-line live-session-line--system">{t("LiveSession.noLines")}</div>
        ) : (
          session.lines.map((line, index) => (
            <div key={index} className={`live-session-line live-session-line--${line.kind}`} data-kind={line.kind}>
              <span className="live-session-ts" aria-hidden="true">{fmtClock(line.ts)}</span>
              <span className="live-session-kind">{t(`LiveSession.kind.${line.kind}`)}</span>
              <span className="live-session-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="live-session-foot t-mono">
        <span className={`live-session-status live-session-status--${session.state}`} data-live-state={session.state}>
          {t(stateKey)}
        </span>
        {!following && (
          <button
            type="button"
            className="d-btn live-session-jump"
            onClick={() => {
              setFollowing(true);
              const el = scrollRef.current;
              if (el !== null) el.scrollTop = el.scrollHeight;
            }}
          >
            {t("LiveSession.jumpLatest")}
          </button>
        )}
        <span className="live-session-readonly">{t("LiveSession.readonly")}</span>
      </div>
    </div>
  );
}

export interface LiveSessionModalProps {
  name: string;
  display: string;
  session: LiveSession | null;
  onClose: () => void;
}

export function LiveSessionModal({ name, display, session, onClose }: LiveSessionModalProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap({ active: true, containerRef: dialogRef, onEscape: onClose });
  return (
    <div
      ref={dialogRef}
      className="channel-panel-overlay live-session-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("LiveSession.title", { name: display })}
      tabIndex={-1}
    >
      <button className="channel-panel-scrim" type="button" aria-label={t("Channel.tools.close")} onClick={onClose} />
      <section className="channel-panel-card live-session-card">
        <header className="channel-panel-head">
          <div className="channel-panel-titlebox">
            <h2>{t("LiveSession.title", { name: display })}</h2>
          </div>
          <button className="d-btn channel-panel-close" type="button" onClick={onClose}>
            {t("Channel.tools.close")}
          </button>
        </header>
        <div className="channel-panel-body">
          <LiveSessionView name={name} display={display} session={session} />
        </div>
      </section>
    </div>
  );
}

export interface LiveSessionEntryButtonProps {
  name: string;
  display: string;
  available: boolean;
  onOpen: (name: string) => void;
  className?: string;
}

/** 通用入口按钮：有流就亮，没流禁用并在文案里说明（不跳到频道历史冒充终端）。 */
export function LiveSessionEntryButton({ name, display, available, onOpen, className }: LiveSessionEntryButtonProps) {
  const t = useT();
  return (
    <button
      type="button"
      className={`t-mono live-session-entry${available ? "" : " live-session-entry--off"}${className ? ` ${className}` : ""}`}
      data-live-entry={name}
      disabled={!available}
      title={available ? t("LiveSession.openTitle", { name: display }) : t("LiveSession.unavailableTitle", { name: display })}
      aria-label={available ? t("LiveSession.openTitle", { name: display }) : t("LiveSession.unavailableTitle", { name: display })}
      onClick={(event) => {
        event.stopPropagation();
        if (available) onOpen(name);
      }}
    >
      {available ? `▶ ${t("LiveSession.open")}` : t("LiveSession.unavailable")}
    </button>
  );
}
