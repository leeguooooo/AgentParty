import { registerDict, type LocaleDict } from "../dict";

export const LocalAgentCenterStrings: LocaleDict = {
  en: {
    "LocalAgentCenter.title": "Local agent center",
    "LocalAgentCenter.close": "Close local agent center",
    "LocalAgentCenter.navigation": "Local agent center sections",
    "LocalAgentCenter.section.overview": "Overview",
    "LocalAgentCenter.section.launcher": "Start agent",
    "LocalAgentCenter.section.logs": "Resident logs",
  },
  zh: {
    "LocalAgentCenter.title": "本机 Agent 控制中心",
    "LocalAgentCenter.close": "关闭本机 Agent 控制中心",
    "LocalAgentCenter.navigation": "本机 Agent 控制中心分区",
    "LocalAgentCenter.section.overview": "运行概览",
    "LocalAgentCenter.section.launcher": "启动 Agent",
    "LocalAgentCenter.section.logs": "常驻日志",
  },
};

registerDict(LocalAgentCenterStrings);
