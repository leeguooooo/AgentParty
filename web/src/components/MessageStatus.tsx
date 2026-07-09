// 统一消息状态条（Phase 3）：把 Phase 1 的 @ 唤醒回执 + Phase 2 的已读游标合成一条，点开像 Lark 的
// 已读弹层。两条泳道诚实分开：
//   · 已读/未读 = 逐帧流式在读的身份(人类 + serve/watch --follow 的 agent)，靠 read_cursor
//   · @ 提及送达 = 事件驱动 agent(webhook/watch --once)的唤醒回执——它们不逐条读频道，只被 @ 唤醒
// 不把事件驱动 agent 混进「已读」假装它逐条读了。
import { useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/WakeReceipt";
import type { ReadEntry } from "../lib/readList";
import { fmtTime } from "../lib/time";
import type { MentionReceipt, ReceiptState } from "../lib/wakeReceipt";

const RECEIPT_ICON: Record<ReceiptState, string> = {
  replied: "success",
  woke: "success",
  wake_failed: "failed",
  delivered: "success",
  pending_wake: "waiting",
  pending_reconnect: "waiting",
};

interface Props {
  receipts: MentionReceipt[];
  readers: ReadEntry[];
  unread: ReadEntry[];
  display: (name: string) => string;
}

function kindLabel(kind: "agent" | "human" | undefined): string {
  return kind === "human" ? "H" : "A";
}

export function MessageStatus({ receipts, readers, unread, display }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasRead = readers.length > 0 || unread.length > 0;
  if (!hasRead && receipts.length === 0) return null;

  const receiptText = (r: MentionReceipt): string => {
    const base = t(`WakeReceipt.state.${r.state}`, { detail: r.detail ?? "" });
    return r.state === "woke" && r.at !== null ? `${base} ${fmtTime(r.at)}` : base;
  };
  const receiptTitle = (r: MentionReceipt): string =>
    t(`WakeReceipt.title.${r.state}`, { name: display(r.name), detail: r.detail ?? "" });

  return (
    <div className="msg-status-bar">
      <div className="msg-status-line">
        {hasRead && (
          <button
            type="button"
            className={"msg-status-summary" + (open ? " is-open" : "")}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="msg-status-read">
              <span className="ap-sprite ap-sprite--success" aria-hidden="true" /> {t("WakeReceipt.read.read", { n: readers.length })}
            </span>
            {unread.length > 0 && (
              <span className="msg-status-unread"> · {t("WakeReceipt.read.unread", { n: unread.length })}</span>
            )}
            <span className="msg-status-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        )}
        {receipts.map((r) => (
          <span key={r.name} className={`msg-receipt msg-receipt--${r.state}`} title={receiptTitle(r)}>
            <span className={`msg-receipt-icon ap-sprite ap-sprite--${RECEIPT_ICON[r.state]}`} aria-hidden="true" />
            <span className="msg-receipt-name t-mono">@{display(r.name)}</span>
            <span className="msg-receipt-label">{receiptText(r)}</span>
          </span>
        ))}
      </div>
      {open && hasRead && (
        <div className="msg-status-pop" role="group">
          <section className="msg-status-group">
            <h4 className="msg-status-group-head">{t("WakeReceipt.read.readSection", { n: readers.length })}</h4>
            {readers.length === 0 ? (
              <p className="msg-status-empty">{t("WakeReceipt.read.none")}</p>
            ) : (
              <ul className="msg-status-names">
                {readers.map((e) => (
                  <li key={e.name} className="msg-status-name">
                    <span className={`msg-status-kind msg-status-kind--${e.kind ?? "agent"}`} aria-hidden="true">
                      {kindLabel(e.kind)}
                    </span>{" "}
                    <span className="t-mono">{display(e.name)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {unread.length > 0 && (
            <section className="msg-status-group">
              <h4 className="msg-status-group-head">{t("WakeReceipt.read.unreadSection", { n: unread.length })}</h4>
              <ul className="msg-status-names">
                {unread.map((e) => (
                  <li key={e.name} className="msg-status-name msg-status-name--unread">
                    <span className={`msg-status-kind msg-status-kind--${e.kind ?? "agent"}`} aria-hidden="true">
                      {kindLabel(e.kind)}
                    </span>{" "}
                    <span className="t-mono">{display(e.name)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {receipts.length > 0 && (
            <section className="msg-status-group">
              <h4 className="msg-status-group-head">{t("WakeReceipt.read.mentionSection")}</h4>
              <p className="msg-status-note">{t("WakeReceipt.read.agentNote")}</p>
              <ul className="msg-status-names">
                {receipts.map((r) => (
                  <li key={r.name} className={`msg-status-name msg-receipt--${r.state}`} title={receiptTitle(r)}>
                    <span className={`msg-receipt-icon ap-sprite ap-sprite--${RECEIPT_ICON[r.state]}`} aria-hidden="true" />{" "}
                    <span className="t-mono">@{display(r.name)}</span>
                    <span className="msg-status-name-state"> — {receiptText(r)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
