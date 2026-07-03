// 左侧频道列表：频道名 + 最近一条消息 + 参与者状态点（spec §9 第 1 块）
import type { ChannelInfo } from "../lib/api";

interface Props {
  channels: ChannelInfo[] | null;
  active: string | null;
  error: string | null;
  onOpen(slug: string): void;
}

const MAX_DOTS = 4;

// 参与者状态点：每人一个蜡笔点，色 = presence 状态；没人报过 presence 给一颗灰点占位
export function PresenceDots({ channel }: { channel: ChannelInfo }) {
  const entries = channel.presence.slice(0, MAX_DOTS);
  return (
    <span className="chan-dots">
      {entries.length === 0 && <span className="d-dot d-dot--offline" title="no participants yet" />}
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

export function ChannelList({ channels, active, error, onOpen }: Props) {
  return (
    <nav className="side" aria-label="channels">
      <p className="side-label t-mono"># channels</p>
      {channels === null && error === null && <p className="side-note t-mono">loading…</p>}
      {error !== null && <p className="side-note side-note--err t-mono">{error}</p>}
      {channels?.map((c) => {
        const preview = lastMessagePreview(c);
        return (
          <button
            key={c.slug}
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
              {c.kind === "temp" && <span className="chan-tag t-mono">temp</span>}
              {c.archived_at !== null && <span className="chan-tag t-mono">archived</span>}
            </span>
            {preview !== null && <span className="chan-last t-mono">{preview}</span>}
          </button>
        );
      })}
      {channels !== null && channels.length === 0 && (
        <p className="side-note t-mono">$ party channel create</p>
      )}
    </nav>
  );
}
