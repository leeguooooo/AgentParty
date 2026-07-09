// 左侧频道列表：频道名 + 最近一条消息 + 参与者状态点（spec §9 第 1 块）
import { useState } from "react";
import type { ChannelInfo } from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/Home"; // 复用 "已归档 (N)" key，两处折叠开关文案一致

interface Props {
  channels: ChannelInfo[] | null;
  active: string | null;
  error: string | null;
  onOpen(slug: string): void;
}

const MAX_DOTS = 4;

// 参与者状态点：每人一个蜡笔点，色 = presence 状态；没人报过 presence 给一颗灰点占位
export function PresenceDots({ channel }: { channel: ChannelInfo }) {
  const t = useT();
  const entries = channel.presence.slice(0, MAX_DOTS);
  return (
    <span className="chan-dots">
      {entries.length === 0 && <span className="d-dot d-dot--offline" title={t("Home.noParticipants")} />}
      {entries.map((p) => (
        <span key={p.name} className={`d-dot d-dot--${p.state}`} title={`${p.name} — ${p.state}`} />
      ))}
    </span>
  );
}

export function lastMessagePreview(c: ChannelInfo): string | null {
  if (c.last_message === null) return null;
  const body = c.last_message.body.replace(/\s+/g, " ").trim();
  return `${c.last_message.sender}: ${body === "" ? `[${c.last_message.kind}]` : body}`;
}

function ChannelPill({
  c,
  active,
  onOpen,
}: {
  c: ChannelInfo;
  active: string | null;
  onOpen(slug: string): void;
}) {
  const preview = lastMessagePreview(c);
  return (
    <button
      type="button"
      className={
        "d-pill chan-pill" +
        (c.slug === active ? " is-active" : "") +
        (c.archived_at !== null ? " chan-pill--archived" : "")
      }
      onClick={() => onOpen(c.slug)}
      title={c.topic ?? c.slug}
    >
      <span className="chan-head">
        <PresenceDots channel={c} />
        <span className="chan-name">{c.title ?? c.slug}</span>
        {c.visibility === "public" && <span className="d-hl public-badge">PUBLIC</span>}
        {c.mode === "party" && <span className="d-hl party-badge">PARTY</span>}
        {c.kind === "temp" && <span className="chan-tag t-mono">temp</span>}
        {c.archived_at !== null && <span className="chan-tag t-mono">archived</span>}
      </span>
      {preview !== null && <span className="chan-last t-mono">{preview}</span>}
    </button>
  );
}

export function ChannelList({ channels, active, error, onOpen }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const t = useT();
  // 默认只显示活跃频道；归档的（联调用完的 temp 等）折叠起来，避免刷屏
  const live = channels?.filter((c) => c.archived_at === null) ?? null;
  const archived = channels?.filter((c) => c.archived_at !== null) ?? [];
  return (
    <nav className="side" aria-label="channels">
      <p className="side-label t-mono">{t("Home.channelsLabel")}</p>
      {channels === null && error === null && <p className="side-note t-mono">{t("Home.loading")}</p>}
      {error !== null && <p className="side-note side-note--err t-mono">{error}</p>}
      {live?.map((c) => (
        <ChannelPill key={c.slug} c={c} active={active} onOpen={onOpen} />
      ))}
      {live !== null && live.length === 0 && archived.length === 0 && (
        <p className="side-note t-mono">$ party channel create</p>
      )}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            className="side-archived-toggle t-mono"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
          >
            {showArchived ? "▾" : "▸"} {t("Home.archivedToggle", { count: archived.length })}
          </button>
          {showArchived &&
            archived.map((c) => (
              <ChannelPill key={c.slug} c={c} active={active} onOpen={onOpen} />
            ))}
        </>
      )}
    </nav>
  );
}
