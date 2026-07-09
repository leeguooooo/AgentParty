import { registerDict, type LocaleDict } from "../dict";

export const HomeStrings: LocaleDict = {
  en: {
    "Home.archivedToggle": "Archived ({count})",
    "Home.channelsLabel": "# channels",
    "Home.noParticipants": "no participants yet",
    "Home.loading": "loading…",
  },
  zh: {
    "Home.archivedToggle": "已归档 ({count})",
    "Home.channelsLabel": "# 频道",
    "Home.noParticipants": "尚无参与者",
    "Home.loading": "加载中…",
  },
};

registerDict(HomeStrings);
