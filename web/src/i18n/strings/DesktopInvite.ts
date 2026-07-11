import { registerDict, type LocaleDict } from "../dict";

export const DesktopInviteStrings: LocaleDict = {
  en: {
    "DesktopInvite.button": "paste invite link",
    "DesktopInvite.hint": "Paste a web invite link to enter a channel — the same link works in the browser and here.",
    "DesktopInvite.placeholder": "https://…/join/… or https://…/c/…?t=…",
    "DesktopInvite.join": "join",
    "DesktopInvite.detect": "detect from clipboard",
    "DesktopInvite.detected.participate": "Invite link detected — click join to enter.",
    "DesktopInvite.detected.watch": "Watch link for #{slug} detected — click join to open read-only.",
    "DesktopInvite.detected.open": "Channel link for #{slug} detected — click join to open.",
    "DesktopInvite.error.empty": "Paste an invite link first.",
    "DesktopInvite.error.malformed": "That doesn't look like a link — copy the full invite URL.",
    "DesktopInvite.error.unsupported": "Unrecognized link — use a /join/… or /c/… invite link.",
    "DesktopInvite.error.wrongHost": "This invite is for {actual}, but you're connected to {expected}. Switch servers first.",
    "DesktopInvite.error.clipboard": "Couldn't read the clipboard — paste the link manually.",
  },
  zh: {
    "DesktopInvite.button": "粘贴邀请链接",
    "DesktopInvite.hint": "粘贴网页版的邀请链接进入频道——同一条链接在浏览器和这里都能用。",
    "DesktopInvite.placeholder": "https://…/join/… 或 https://…/c/…?t=…",
    "DesktopInvite.join": "加入",
    "DesktopInvite.detect": "从剪贴板检测",
    "DesktopInvite.detected.participate": "检测到邀请链接——点「加入」进入。",
    "DesktopInvite.detected.watch": "检测到 #{slug} 的观看链接——点「加入」以只读方式打开。",
    "DesktopInvite.detected.open": "检测到 #{slug} 的频道链接——点「加入」打开。",
    "DesktopInvite.error.empty": "先粘贴一条邀请链接。",
    "DesktopInvite.error.malformed": "这不像一条链接——请复制完整的邀请 URL。",
    "DesktopInvite.error.unsupported": "无法识别的链接——请使用 /join/… 或 /c/… 邀请链接。",
    "DesktopInvite.error.wrongHost": "这条邀请属于 {actual}，而你当前连接的是 {expected}。请先切换服务器。",
    "DesktopInvite.error.clipboard": "读取剪贴板失败——请手动粘贴链接。",
  },
};

registerDict(DesktopInviteStrings);
