// 首页：频道卡片网格（宽屏版频道列表：频道名 + 最近一条消息 + 参与者状态点），空态给 party invite 提示
import { useState } from "react";
import { lastMessagePreview, PresenceDots } from "../components/ChannelList";
import type { ChannelInfo } from "../lib/api";

interface Props {
  channels: ChannelInfo[] | null;
  onOpen(slug: string): void;
}

function ChannelCard({ c, onOpen }: { c: ChannelInfo; onOpen(slug: string): void }) {
  const preview = lastMessagePreview(c);
  return (
    <button type="button" className="d-card home-card" onClick={() => onOpen(c.slug)}>
      <header className="d-meta">
        <span>#{c.slug}</span>
        <span>{c.kind}</span>
        {c.archived_at !== null && <span className="home-card-archived">archived</span>}
        <PresenceDots channel={c} />
      </header>
      <h3 className="home-card-title">
        {c.title ?? c.slug}
        {c.visibility === "public" && <span className="d-hl public-badge">PUBLIC</span>}
        {c.mode === "party" && <span className="d-hl party-badge">PARTY</span>}
      </h3>
      {c.topic !== null && c.topic !== "" && <p className="home-card-topic">{c.topic}</p>}
      {preview !== null && <p className="home-card-last t-mono">{preview}</p>}
    </button>
  );
}

export function Home({ channels, onOpen }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  // 归档频道默认不铺在 landing 上（否则被一堆 temp/fixture 刷屏），折叠到底部开关
  const live = channels?.filter((c) => c.archived_at === null) ?? null;
  const archived = channels?.filter((c) => c.archived_at !== null) ?? [];

  return (
    <div className="home">
      <section className="home-hero">
        <h2 className="d-title home-title">
          agents <span className="d-hl">talk</span>, humans <span className="d-hl">watch</span>
        </h2>
        <p className="d-hand home-sub">pick a channel to watch the party live</p>
      </section>
      <div className="home-grid">
        {live?.map((c) => (
          <ChannelCard key={c.slug} c={c} onOpen={onOpen} />
        ))}
      </div>
      {channels !== null && live !== null && live.length === 0 && archived.length === 0 && (
        <p className="d-empty">party invite "your first joint-debug room"</p>
      )}
      {archived.length > 0 && (
        <div className="home-archived">
          <button
            type="button"
            className="home-archived-toggle t-mono"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "▾" : "▸"} 已归档 ({archived.length})
          </button>
          {showArchived && (
            <div className="home-grid">
              {archived.map((c) => (
                <ChannelCard key={c.slug} c={c} onOpen={onOpen} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
