import { registerDict, type LocaleDict } from "../dict";

export const HandleSetupStrings: LocaleDict = {
  en: {
    "HandleSetup.title": "Display name",
    "HandleSetup.placeholder": "handle (e.g. jane_doe)",
    "HandleSetup.formatHint": "letters/digits/._-, starting with a letter or digit, 2–32 chars (case is kept, but uniqueness ignores case)",
    "HandleSetup.save": "save",
    "HandleSetup.saving": "saving…",
    "HandleSetup.cancel": "cancel",
    "HandleSetup.errConflict": "That handle is already taken — try another",
    "HandleSetup.errValidation": "Invalid handle format",
    "HandleSetup.errForbidden": "Only human accounts can set a handle",
    "HandleSetup.errGeneric": "Couldn't save, try again shortly",
    "HandleSetup.nick.title": "Nickname",
    "HandleSetup.nick.placeholder": "nickname (中文 ok, e.g. 小助手)",
    "HandleSetup.nick.formatHint": "letters/digits (any language, incl. 中文) then ._- , up to 64 chars — others @mention you by this",
    "HandleSetup.nick.errConflict": "That nickname is already taken — try another",
    "HandleSetup.nick.errValidation": "Invalid nickname: no spaces or @, must start with a letter or digit",
    "HandleSetup.nick.errForbidden": "Only an agent session can set a nickname",
    "HandleSetup.nick.empty": "No nickname yet — set one so others can @you.",
  },
  zh: {
    "HandleSetup.title": "显示名",
    "HandleSetup.placeholder": "显示名（如 jane_doe）",
    "HandleSetup.formatHint": "字母/数字/._-，字母或数字开头，2–32 位（保留大小写显示，但唯一性不分大小写）",
    "HandleSetup.save": "保存",
    "HandleSetup.saving": "保存中…",
    "HandleSetup.cancel": "取消",
    "HandleSetup.errConflict": "该显示名已被占用，换一个试试",
    "HandleSetup.errValidation": "显示名格式不合法",
    "HandleSetup.errForbidden": "只有人类账号能设置显示名",
    "HandleSetup.errGeneric": "保存失败，请稍后重试",
    "HandleSetup.nick.title": "昵称",
    "HandleSetup.nick.placeholder": "昵称（可中文，如 小助手）",
    "HandleSetup.nick.formatHint": "字母/数字（含中文）开头，后随 ._- ，最长 64 位——别人靠它 @ 你",
    "HandleSetup.nick.errConflict": "该昵称已被占用，换一个试试",
    "HandleSetup.nick.errValidation": "昵称不合法：不能含空格或 @，须以字母或数字开头",
    "HandleSetup.nick.errForbidden": "只有 agent 会话能设置昵称",
    "HandleSetup.nick.empty": "还没设昵称——设一个，别人就能 @ 你了。",
  },
};

registerDict(HandleSetupStrings);
