// 被@页内提示（Task R5-toast）：标签页聚焦时被@弹右上角 toast，可点跳转/手动关/6s 自动消失。
// 与浏览器系统通知（未聚焦时）互补；页内 toast 不需要通知授权。
import { useEffect } from "react";
import type { Sender } from "@agentparty/shared";
import { resolveSenderLabel, type IdentityDisplayMap } from "../lib/identityDisplay";
import { useT } from "../i18n/useT";
import "../i18n/strings/Channel";

export interface MentionToastItem {
  seq: number;
  sender: Sender; // 原始发送者，渲染时经 resolveSenderLabel 解析显示名，保证与消息卡一致
  body: string;   // 已截断的正文预览
  fullBody?: string; // #280：完整正文，挂到 title 上供悬停看全文（缺省回退到 body）
}

interface Props {
  items: MentionToastItem[];
  channel: string;
  identityDisplay: IdentityDisplayMap;
  onJump(seq: number): void;
  onDismiss(seq: number): void;
}

const AUTO_DISMISS_MS = 6000;

function ToastCard({
  item, channel, identityDisplay, onJump, onDismiss,
}: {
  item: MentionToastItem;
  channel: string;
  identityDisplay: IdentityDisplayMap;
  onJump(seq: number): void;
  onDismiss(seq: number): void;
}) {
  const t = useT();
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(item.seq), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [item.seq, onDismiss]);
  const senderLabel = resolveSenderLabel(item.sender, identityDisplay);
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
        <span className="mention-toast-title">
          <span className="ap-sprite ap-sprite--bell-on" aria-hidden="true" />
          <span>{t("Channel.toast.title", { sender: senderLabel, channel })}</span>
        </span>
        <button
          type="button"
          className="mention-toast-close"
          aria-label={t("Channel.toast.dismiss")}
          onClick={(e) => { e.stopPropagation(); onDismiss(item.seq); }}
          onKeyDown={(e) => e.stopPropagation()}
        >×</button>
      </div>
      <div className="mention-toast-body" title={(item.fullBody ?? item.body) || undefined}>{item.body}</div>
    </div>
  );
}

export function MentionToast({ items, channel, identityDisplay, onJump, onDismiss }: Props) {
  // 容器常驻（即使空）：aria-live 区域必须先在 DOM 里，随首条 toast 一起插入的内容屏读器不会播报。
  // 空时无子元素、pointer-events:none，无视觉/交互影响。
  return (
    <div className="mention-toasts" aria-live="polite">
      {items.map((it) => (
        <ToastCard
          key={it.seq}
          item={it}
          channel={channel}
          identityDisplay={identityDisplay}
          onJump={onJump}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
