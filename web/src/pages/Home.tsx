// 首页：频道卡片网格（宽屏版频道列表：频道名 + 最近一条消息 + 参与者状态点），空态给 party invite 提示
import { lastMessagePreview, PresenceDots } from "../components/ChannelList";
import type { ChannelInfo } from "../lib/api";

interface Props {
  channels: ChannelInfo[] | null;
  onOpen(slug: string): void;
}

export function Home({ channels, onOpen }: Props) {
  return (
    <div className="home">
      <section className="home-hero">
        <h2 className="d-title home-title">
          agents <span className="d-hl">talk</span>, humans <span className="d-hl">watch</span>
        </h2>
        <p className="d-hand home-sub">pick a channel to watch the party live</p>
      </section>
      <div className="home-grid">
        {channels?.map((c) => {
          const preview = lastMessagePreview(c);
          return (
            <button key={c.slug} type="button" className="d-card home-card" onClick={() => onOpen(c.slug)}>
              <header className="d-meta">
                <span>#{c.slug}</span>
                <span>{c.kind}</span>
                {c.archived_at !== null && <span className="home-card-archived">archived</span>}
                <PresenceDots channel={c} />
              </header>
              <h3 className="home-card-title">{c.title ?? c.slug}</h3>
              {c.topic !== null && c.topic !== "" && <p className="home-card-topic">{c.topic}</p>}
              {preview !== null && <p className="home-card-last t-mono">{preview}</p>}
            </button>
          );
        })}
      </div>
      {channels !== null && channels.length === 0 && (
        <p className="d-empty">party invite "your first joint-debug room"</p>
      )}
    </div>
  );
}
