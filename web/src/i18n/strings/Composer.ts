import { registerDict, type LocaleDict } from "../dict";

export const ComposerStrings: LocaleDict = {
  en: {
    "Composer.tier.online": "online",
    "Composer.tier.wakeable": "wakeable",
    "Composer.tier.recent": "recent",
    "Composer.kind.agent": "agent",
    "Composer.kind.human": "human",
    "Composer.owner": "owner: {account}",
    "Composer.role": "role: {role}",
    "Composer.responsibility": "responsibility: {responsibility}",
    "Composer.note": "note: {note}",
    "Composer.placeholder": "chime in… markdown ok · @name to mention · ⏎ send · ⇧⏎ newline · ⌘⏎ send",
    "Composer.send.label": "send",
    "Composer.send.readyTitle": "send (⏎ / ⌘⏎)",
    "Composer.send.connectingTitle": "connecting…",
  },
  zh: {
    "Composer.tier.online": "在线",
    "Composer.tier.wakeable": "可唤醒",
    "Composer.tier.recent": "最近",
    "Composer.kind.agent": "agent",
    "Composer.kind.human": "human",
    "Composer.owner": "所属: {account}",
    "Composer.role": "职责: {role}",
    "Composer.responsibility": "分工: {responsibility}",
    "Composer.note": "说明: {note}",
    "Composer.placeholder": "插句话… 支持 markdown · @name 提及 · ⏎ 发送 · ⇧⏎ 换行 · ⌘⏎ 发送",
    "Composer.send.label": "发送",
    "Composer.send.readyTitle": "发送（⏎ / ⌘⏎）",
    "Composer.send.connectingTitle": "连接中…",
  },
};

registerDict(ComposerStrings);
