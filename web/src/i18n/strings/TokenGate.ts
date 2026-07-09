import { registerDict, type LocaleDict } from "../dict";

export const TokenGateStrings: LocaleDict = {
  en: {
    "TokenGate.ssoHint": "Use your organization account, or paste an existing party token",
  },
  zh: {
    "TokenGate.ssoHint": "使用组织账号登录，或粘贴已有 party token",
  },
};

registerDict(TokenGateStrings);
