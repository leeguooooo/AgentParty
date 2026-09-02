import { registerDict, type LocaleDict } from "../dict";

// 模块⑧：presence 的原始枚举（state / residency / lease）给用户看时的人话。
// 只在渲染处过一遍；数据层与 CSS class 仍用原值。
export const PresenceLabelsStrings: LocaleDict = {
  en: {
    "PresenceLabel.state.working": "working",
    "PresenceLabel.state.waiting": "waiting",
    "PresenceLabel.state.blocked": "blocked",
    "PresenceLabel.state.done": "done",
    "PresenceLabel.state.offline": "offline",
    "PresenceLabel.residency.supervised": "always-on (supervised)",
    "PresenceLabel.residency.daemon": "background daemon",
    "PresenceLabel.residency.webhook": "woken by webhook",
    "PresenceLabel.residency.episodic": "started on demand",
    "PresenceLabel.residency.bare": "bare session (no wake channel)",
    "PresenceLabel.residency.human_driven": "manual",
    "PresenceLabel.residency.mixed": "mixed",
    "PresenceLabel.residency.unknown": "unknown",
    "PresenceLabel.lease.active": "holding the lease",
    "PresenceLabel.lease.stale": "lease lapsed",
  },
  zh: {
    "PresenceLabel.state.working": "处理中",
    "PresenceLabel.state.waiting": "等待中",
    "PresenceLabel.state.blocked": "受阻",
    "PresenceLabel.state.done": "已完成",
    "PresenceLabel.state.offline": "离线",
    "PresenceLabel.residency.supervised": "常驻托管",
    "PresenceLabel.residency.daemon": "后台守护",
    "PresenceLabel.residency.webhook": "回调唤醒",
    "PresenceLabel.residency.episodic": "按需拉起",
    "PresenceLabel.residency.bare": "裸会话（没有唤醒通道）",
    "PresenceLabel.residency.human_driven": "手动",
    "PresenceLabel.residency.mixed": "混合",
    "PresenceLabel.residency.unknown": "未知",
    "PresenceLabel.lease.active": "持有主持权",
    "PresenceLabel.lease.stale": "主持权已失效",
  },
};

registerDict(PresenceLabelsStrings);
