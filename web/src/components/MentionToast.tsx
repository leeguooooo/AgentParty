// 被@页内提示（Task R5-toast）：标签页聚焦时被@弹右上角 toast，可点跳转/手动关/6s 自动消失。
// 与浏览器系统通知（未聚焦时）互补；页内 toast 不需要通知授权。
import { useEffect } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Channel";

export interface MentionToastItem {
  seq: number;
  sender: string; // 已解析显示名（@handle 或 name）
  body: string;   // 已截断的正文预览
}

interface Props {
  items: MentionToastItem[];
  channel: string;
  onJump(seq: number): void;
  onDismiss(seq: number): void;
}

const AUTO_DISMISS_MS = 6000;

function ToastCard({
  item, channel, onJump, onDismiss,
}: { item: MentionToastItem; channel: string; onJump(seq: number): void; onDismiss(seq: number): void }) {
  const t = useT();
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.seq), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [item.seq, onDismiss]);
  return (
    <div
      className="mention-toast"
      role="button"
      tabIndex={0}
      onClick={() => onJump(item.seq)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onJump(item.seq); }
      }}
    >
      <div className="mention-toast-head">
        <span className="mention-toast-title">🔔 {t("Channel.toast.title", { sender: item.sender, channel })}</span>
        <button
          type="button"
          className="mention-toast-close"
          aria-label={t("Channel.toast.dismiss")}
          onClick={(e) => { e.stopPropagation(); onDismiss(item.seq); }}
        >×</button>
      </div>
      <div className="mention-toast-body">{item.body}</div>
    </div>
  );
}

export function MentionToast({ items, channel, onJump, onDismiss }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="mention-toasts" aria-live="polite">
      {items.map((it) => (
        <ToastCard key={it.seq} item={it} channel={channel} onJump={onJump} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
