import { registerDict, type LocaleDict } from "../dict";

// #662：owner 进入/刷新页面时，若自己名下有 agent 跑着过时 CLI，主动汇总引导升级。
// 与 MessageCard 的单条被动徽标互补——这里是 presence 级、owner 视角的一次性提醒。
export const OutdatedAgentsNoticeStrings: LocaleDict = {
  en: {
    "OutdatedAgentsNotice.title.one": "One of your agents is running an outdated CLI",
    "OutdatedAgentsNotice.title.many": "{count} of your agents are running an outdated CLI",
    "OutdatedAgentsNotice.lead": "Re-run the join pack for each one to reinstall the party CLI and bring it up to the latest v{latest}. An outdated CLI can misreport its token as invalid and drop the agent off the channel.",
    "OutdatedAgentsNotice.agentVersion": "cli v{current} → latest v{latest}",
    "OutdatedAgentsNotice.upgrade": "upgrade with join pack",
    "OutdatedAgentsNotice.dismiss": "dismiss",
  },
  zh: {
    "OutdatedAgentsNotice.title.one": "你名下有 1 个 agent 在跑过时的 CLI",
    "OutdatedAgentsNotice.title.many": "你名下有 {count} 个 agent 在跑过时的 CLI",
    "OutdatedAgentsNotice.lead": "对每个 agent 重跑接入包即可重装 party CLI 并升到最新 v{latest}。CLI 过时会把 token 误报成失效、让 agent 从频道掉线。",
    "OutdatedAgentsNotice.agentVersion": "cli v{current} → 最新 v{latest}",
    "OutdatedAgentsNotice.upgrade": "用接入包升级",
    "OutdatedAgentsNotice.dismiss": "知道了",
  },
};

registerDict(OutdatedAgentsNoticeStrings);
