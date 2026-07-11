import { registerDict, type LocaleDict } from "../dict";

// 功能级 tips 文案（#145）。和 #146 的首次总览引导不同：这些是挂在具体按钮/区域旁的一句话
// 提示，hover/focus 才显示，帮新用户看懂「这个东西是干嘛的」。选了 3 个最需要解释的点：
// @ 唤醒 agent、被 @ 通知铃铛、频道公开/私密。每条只讲一句；en/zh 双语，zh 不照抄 en。
export const TipsStrings: LocaleDict = {
  en: {
    "Tips.wake": "Type @name in the box to wake an agent into this channel.",
    "Tips.notify": "Get a browser ping when someone @mentions you here.",
    "Tips.visibility": "Public shows this channel to anyone; private stays invite-only.",
    "Tips.ariaHelp": "What's this?",
  },
  zh: {
    "Tips.wake": "在输入框敲 @名字，把 agent 唤进这个频道。",
    "Tips.notify": "有人在这里 @ 你时，浏览器弹条提醒你。",
    "Tips.visibility": "公开后谁都看得到这个频道；私密则只对受邀者可见。",
    "Tips.ariaHelp": "这是什么？",
  },
};

registerDict(TipsStrings);
