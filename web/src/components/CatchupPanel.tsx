import { useState } from "react";
import { useT } from "../i18n/useT";
import type { CatchupDigest, CatchupItem } from "../lib/digest";

export function CatchupPanel({
  digest,
  seenSeq,
  latestSeq,
  onCaughtUp,
  onJump,
}: {
  digest: CatchupDigest;
  seenSeq: number;
  latestSeq: number;
  onCaughtUp: () => void;
  onJump: (seq: number) => void | Promise<void>;
}) {
  const t = useT();
  const [showUpdates, setShowUpdates] = useState(digest.attentionCount === 0);
  const chips = [
    t("Channel.catchup.chip.new", { count: digest.messages }),
    digest.openMentions > 0 ? t("Channel.catchup.chip.mentions", { count: digest.openMentions }) : null,
    digest.respondedMentions > 0 ? t("Channel.catchup.chip.handled", { count: digest.respondedMentions }) : null,
    digest.blocked > 0 ? t("Channel.catchup.chip.blocked", { count: digest.blocked }) : null,
    digest.done > 0 ? t("Channel.catchup.chip.done", { count: digest.done }) : null,
    digest.releases > 0 ? t("Channel.catchup.chip.release", { count: digest.releases }) : null,
    digest.issues > 0 ? t("Channel.catchup.chip.issues", { count: digest.issues }) : null,
    digest.questions > 0 ? t("Channel.catchup.chip.question", { count: digest.questions }) : null,
    digest.replies > 0 ? t("Channel.catchup.chip.replies", { count: digest.replies }) : null,
  ].filter((chip): chip is string => chip !== null);
  const itemLabel = (item: CatchupItem) => t(`Channel.catchup.item.${item.kind}`);
  const group = (title: string, items: CatchupItem[], attention: boolean) => (
    items.length > 0 && (
      <section className={`catchup-group${attention ? " catchup-group--attention" : ""}`}>
        <h3 className="catchup-group-title">{title}</h3>
        <ol className="catchup-items">
          {items.map((item) => (
            <li key={item.seq}>
              <button
                type="button"
                className="catchup-item-button"
                onClick={() => void onJump(item.seq)}
                aria-label={t("Channel.catchup.jump", { seq: item.seq })}
              >
                <span className="t-mono catchup-item-meta">
                  #{item.seq} {itemLabel(item)}
                </span>
                <span>{item.text}</span>
              </button>
            </li>
          ))}
        </ol>
        {attention && digest.attentionCount > items.length && (
          <p className="catchup-overflow-note">
            {t("Channel.catchup.moreAttention", { count: digest.attentionCount - items.length })}
          </p>
        )}
      </section>
    )
  );

  return (
    <section className="catchup-panel" aria-label={t("Channel.catchup.aria")}>
      <div className="catchup-head">
        <div>
          <h2 className="catchup-title">{t("Channel.heading.catchup")}</h2>
          <p className="catchup-range t-mono">
            #{seenSeq + 1}..#{latestSeq}
          </p>
        </div>
        <button className="d-btn catchup-action" type="button" onClick={onCaughtUp}>
          <span>{t("Channel.catchup.markAllRead")}</span>
        </button>
      </div>

      <div className="catchup-priority-summary" aria-live="polite">
        <strong>
          {digest.attentionCount > 0
            ? t("Channel.catchup.summary.attention", { count: digest.attentionCount })
            : t("Channel.catchup.summary.clear")}
        </strong>
        <span>{t("Channel.catchup.summary.updates", { count: digest.updateCount })}</span>
      </div>

      <details className="catchup-stats">
        <summary>{t("Channel.catchup.stats")}</summary>
        <div className="catchup-chips t-mono">
          {chips.map((chip) => (
            <span key={chip} className="catchup-chip">
              {chip}
            </span>
          ))}
        </div>
      </details>

      {group(t("Channel.catchup.attention"), digest.attentionItems, true)}

      {digest.updateItems.length > 0 && (
        <div className="catchup-updates">
          <button
            type="button"
            className="catchup-updates-toggle"
            aria-expanded={showUpdates}
            onClick={() => setShowUpdates((current) => !current)}
          >
            {showUpdates
              ? t("Channel.catchup.hideUpdates")
              : t("Channel.catchup.showUpdates", { count: digest.updateItems.length })}
          </button>
          {showUpdates && group(t("Channel.catchup.updates"), digest.updateItems, false)}
        </div>
      )}
    </section>
  );
}
