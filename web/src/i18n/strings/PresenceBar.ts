import { registerDict, type LocaleDict } from "../dict";

export const PresenceBarStrings: LocaleDict = {
  en: {
    "PresenceBar.kickTitle": "Kick {name}",
    "PresenceBar.kick": "kick",
    "PresenceBar.expand": "expand participants",
    "PresenceBar.collapse": "collapse",
  },
  zh: {
    "PresenceBar.kickTitle": "踢出 {name}",
    "PresenceBar.kick": "踢出",
    "PresenceBar.expand": "展开参与者",
    "PresenceBar.collapse": "收起",
  },
};

registerDict(PresenceBarStrings);
