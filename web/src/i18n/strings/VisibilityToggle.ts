import { registerDict, type LocaleDict } from "../dict";

export const VisibilityToggleStrings: LocaleDict = {
  en: {
    "Visibility.groupLabel": "channel access",
    "Visibility.opt.private": "private",
    "Visibility.opt.public_watch": "public watch",
    "Visibility.opt.public": "public",
    "Visibility.opt.private.help": "Members only — only identities under your account (or invited) can read or send.",
    "Visibility.opt.public_watch.help": "Anyone can read (watch); sending needs membership or an invite.",
    "Visibility.opt.public.help": "Anyone signed in can read and send.",
    "Visibility.confirmDialogLabel": "confirm exposing history",
    "Visibility.confirmText.public": "Going public exposes {count} messages of history to anyone. Confirm?",
    "Visibility.confirmText.public_watch": "Public watch exposes {count} messages of history to any watcher. Confirm?",
    "Visibility.confirmButton": "confirm",
    "Visibility.cancel": "cancel",
  },
  zh: {
    "Visibility.groupLabel": "频道访问",
    "Visibility.opt.private": "私有",
    "Visibility.opt.public_watch": "观看公开",
    "Visibility.opt.public": "公开",
    "Visibility.opt.private.help": "仅成员——只有你账号下的身份（或被邀请者）能看和发。",
    "Visibility.opt.public_watch.help": "任何人可看（观看），参与发言需成员或被邀请。",
    "Visibility.opt.public.help": "任何登录的人都能看和发。",
    "Visibility.confirmDialogLabel": "确认暴露历史",
    "Visibility.confirmText.public": "转公开后，历史 {count} 条消息将对任何人可见。确认？",
    "Visibility.confirmText.public_watch": "转观看公开后，历史 {count} 条消息将对任何观看者可见。确认？",
    "Visibility.confirmButton": "确认",
    "Visibility.cancel": "取消",
  },
};

registerDict(VisibilityToggleStrings);
