import { registerDict, type LocaleDict } from "../dict";

export const HandleSetupStrings: LocaleDict = {
  en: {
    "HandleSetup.title": "Display name",
    "HandleSetup.placeholder": "handle (e.g. jane_doe)",
    "HandleSetup.formatHint": "lowercase letters/digits/._-, starting with a letter or digit, 2–32 chars",
    "HandleSetup.save": "save",
    "HandleSetup.saving": "saving…",
    "HandleSetup.cancel": "cancel",
    "HandleSetup.errConflict": "That handle is already taken — try another",
    "HandleSetup.errValidation": "Invalid handle format",
    "HandleSetup.errForbidden": "Only human accounts can set a handle",
    "HandleSetup.errGeneric": "Couldn't save, try again shortly",
  },
  zh: {
    "HandleSetup.title": "显示名",
    "HandleSetup.placeholder": "显示名（如 jane_doe）",
    "HandleSetup.formatHint": "小写字母/数字/._-，字母或数字开头，2–32 位",
    "HandleSetup.save": "保存",
    "HandleSetup.saving": "保存中…",
    "HandleSetup.cancel": "取消",
    "HandleSetup.errConflict": "该显示名已被占用，换一个试试",
    "HandleSetup.errValidation": "显示名格式不合法",
    "HandleSetup.errForbidden": "只有人类账号能设置显示名",
    "HandleSetup.errGeneric": "保存失败，请稍后重试",
  },
};

registerDict(HandleSetupStrings);
