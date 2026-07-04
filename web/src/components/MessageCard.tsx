// 消息渲染：message → doodle 卡片外壳 + mono 元信息 + markdown 正文；
// status → 时间线分隔条（spec §9 第 2 块）。
import type { MsgFrame } from "@agentparty/shared";
import type { CSSProperties } from "react";
import { agentHue } from "../lib/agentColor";
import { fmtTime } from "../lib/time";
import { Markdown } from "./Markdown";

interface Props {
  msg: MsgFrame;
  self: string | null;
}

export function MessageCard({ msg, self }: Props) {
  // 每个 agent 一个确定性色相：CSS 用 --ah 套 hsl() 给头像点/名字/卡片左条上色
  const hueStyle = { "--ah": agentHue(msg.sender.name) } as CSSProperties;

  if (msg.kind === "status") {
    return (
      <div className="msg-status" data-state={msg.state ?? undefined} style={hueStyle}>
        <span>
          <span className="msg-sender">{msg.sender.name}</span> → {msg.state}
          {msg.note ? ` · ${msg.note}` : ""} · {fmtTime(msg.ts)}
        </span>
      </div>
    );
  }

  const mine = self !== null && msg.sender.name === self;
  return (
    <article className={"d-card msg-card" + (mine ? " msg-card--own" : "")} style={hueStyle}>
      <header className="d-meta msg-head">
        <span className="msg-avatar" aria-hidden="true" />
        <span className="msg-sender">{msg.sender.name}</span>
        {msg.sender.owner !== undefined &&
          msg.sender.owner !== "" &&
          msg.sender.owner !== msg.sender.name && (
            <span className="t-mono msg-owner" title={`owner: ${msg.sender.owner}`}>
              · {msg.sender.owner}
            </span>
          )}
        <span className={"msg-kind" + (msg.sender.kind === "human" ? " msg-kind--human" : "")}>
          {msg.sender.kind}
        </span>
        {msg.mentions.map((m) => (
          <span key={m} className="msg-mention">
            @{m}
          </span>
        ))}
        {msg.reply_to !== null && <span className="msg-reply">↩ #{msg.reply_to}</span>}
        <span className="msg-fill" />
        <span>#{msg.seq}</span>
        <time>{fmtTime(msg.ts)}</time>
      </header>
      <Markdown source={msg.body} />
    </article>
  );
}
