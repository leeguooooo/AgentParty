// 顶部 presence 条：每参与者一个手绘胶囊（名字 + 蜡笔状态点 + note + 相对时间），
// 右端挂连接状态。"对方卡在哪"一眼可见（spec §9 第 3 块）。
import type { PresenceEntry, Sender } from "@agentparty/shared";
import { useEffect, useState } from "react";
import { fmtRel } from "../lib/time";
import type { SocketStatus } from "../lib/ws";

interface Props {
  presence: Record<string, PresenceEntry>;
  participants: Sender[];
  status: SocketStatus;
  party?: boolean; // mode=party 的频道在最左挂蜡笔黄 PARTY 徽章
}

interface Item {
  name: string;
  state: string; // PresenceState | "online"（已连接但还没报过 status）
  note: string | null;
  ts: number | null;
  owner: string | null; // 所属人：agent 的操作者 / 人类的 email，仅连接中的参与者可知
}

export function PresenceBar({ presence, participants, status, party = false }: Props) {
  // 相对时间 30s 刷一次
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // 所属人只有连接中的参与者带（presence 快照不含 owner），按 name 建索引
  const byName = new Map(participants.map((p) => [p.name, p]));
  const names = [...new Set([...participants.map((p) => p.name), ...Object.keys(presence)])].sort();
  const items: Item[] = names.map((name) => {
    const entry = presence[name];
    const owner = byName.get(name)?.owner ?? null;
    const connected = byName.has(name);
    if (!connected) {
      return { name, state: "offline", note: null, ts: entry?.ts ?? null, owner: null };
    }
    if (entry && entry.state !== "offline") {
      return { name, state: entry.state, note: entry.note, ts: entry.ts, owner };
    }
    return { name, state: "online", note: null, ts: entry?.ts ?? null, owner };
  });

  return (
    <div className="presence-bar">
      {party && <span className="d-hl party-badge">PARTY</span>}
      {items.map((it) => (
        <span
          key={it.name}
          className={`d-pill presence-pill${it.state === "blocked" ? " presence-pill--blocked" : ""}`}
          title={it.owner !== null && it.owner !== it.name ? `${it.name} · ${it.owner}` : it.name}
        >
          <span className={`d-dot d-dot--${it.state}`} />
          <span className="presence-name">{it.name}</span>
          {it.owner !== null && it.owner !== "" && it.owner !== it.name && (
            <span className="t-mono presence-owner">· {it.owner}</span>
          )}
          {it.note !== null && it.note !== "" && <span className="t-mono presence-note">{it.note}</span>}
          {it.ts !== null && <span className="t-mono presence-ts">{fmtRel(it.ts)}</span>}
        </span>
      ))}
      {items.length === 0 && (
        <span className="t-mono presence-empty" role="status" aria-live="polite">
          nobody here yet
        </span>
      )}
      <span className="t-mono presence-count" title="connected participants">
        {participants.length} in
      </span>
      <span className="conn t-mono" data-s={status} role="status" aria-live="polite">
        {status === "open" ? "● live" : `◌ ${status}…`}
      </span>
    </div>
  );
}
