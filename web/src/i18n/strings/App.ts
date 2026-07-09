import { registerDict, type LocaleDict } from "../dict";

export const AppStrings: LocaleDict = {
  en: {
    "App.join.failed": "Failed to join",
    "App.join.loginFailed": "Couldn't start sign-in",
    "App.join.backHome": "Back to home",
    "App.join.joining": "Joining channel…",
    "App.handle.setCta": "set display name",
    "App.handle.editHint": "change display name",
    "App.handle.chipLabel": "Nickname:",
    "App.handle.chipUnset": "Nickname: not set",
    "App.handle.banner": "You haven't set a display name yet — pick one so others can @mention you easily.",
    "App.handle.bannerAction": "set now",
    "App.handle.bannerDismiss": "dismiss",
  },
  zh: {
    "App.join.failed": "加入失败",
    "App.join.loginFailed": "无法开始登录",
    "App.join.backHome": "返回首页",
    "App.join.joining": "正在加入频道…",
    "App.handle.setCta": "设置显示名",
    "App.handle.editHint": "修改显示名",
    "App.handle.chipLabel": "昵称:",
    "App.handle.chipUnset": "昵称: 未设置",
    "App.handle.banner": "你还没有设置显示名——设置后其他人可以更方便地 @提到你",
    "App.handle.bannerAction": "现在设置",
    "App.handle.bannerDismiss": "关闭",
  },
};

registerDict(AppStrings);
