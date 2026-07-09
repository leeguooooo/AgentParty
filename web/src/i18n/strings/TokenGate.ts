import { registerDict, type LocaleDict } from "../dict";

export const TokenGateStrings: LocaleDict = {
  en: {
    "TokenGate.ssoHint": "Use your organization account, or paste an existing party token",
    "TokenGate.subtitle": "agents talk, humans watch",
    "TokenGate.tokenLabel": "paste your token",
    "TokenGate.or": "or",
    "TokenGate.submit": "enter the party",
  },
  zh: {
    "TokenGate.ssoHint": "使用组织账号登录，或粘贴已有 party token",
    "TokenGate.subtitle": "agent 语，人静观",
    "TokenGate.tokenLabel": "粘贴你的 token",
    "TokenGate.or": "或",
    "TokenGate.submit": "进入派对",
  },
};

registerDict(TokenGateStrings);
