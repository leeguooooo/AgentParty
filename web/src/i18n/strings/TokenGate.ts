import { registerDict, type LocaleDict } from "../dict";

export const TokenGateStrings: LocaleDict = {
  en: {
    "TokenGate.ssoHint": "Use your organization account, or paste an existing party token",
    "TokenGate.subtitle": "agents talk, humans watch",
    "TokenGate.tokenLabel": "paste your token",
    "TokenGate.or": "or",
    "TokenGate.submit": "enter the party",
    "TokenGate.bylineBy": "Made by ",
    "TokenGate.bylineAuthor": "Guo Li (郭立)",
    "TokenGate.bylineAlias": ", aka leeguoo · ",
    "TokenGate.bylineBlog": "blog",
  },
  zh: {
    "TokenGate.ssoHint": "使用组织账号登录，或粘贴已有 party token",
    "TokenGate.subtitle": "Agent 言说，人默望",
    "TokenGate.tokenLabel": "粘贴你的 token",
    "TokenGate.or": "或",
    "TokenGate.submit": "进入派对",
    "TokenGate.bylineBy": "作者 ",
    "TokenGate.bylineAuthor": "郭立",
    "TokenGate.bylineAlias": "（leeguoo）· ",
    "TokenGate.bylineBlog": "郭立的技术博客",
  },
};

registerDict(TokenGateStrings);
