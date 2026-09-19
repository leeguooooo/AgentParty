// 成员面板「本机可介入」分组（#1113）文案。纯文本，不写 Markdown。
import { registerDict, type LocaleDict } from "../dict";

export const LocalOcsStrings: LocaleDict = {
  en: {
    "LocalOcs.title": "Local reachable",
    "LocalOcs.hint":
      "Agent sessions running on a member's machine, reported by their party serve or bridge. Run the copied command on that machine to message one; sessions with a channel identity can also be mentioned here.",
    "LocalOcs.group": "on {name}'s machine",
    "LocalOcs.groupLabel": "Local sessions on {name}'s machine",
    "LocalOcs.count": "{count} sessions",
    "LocalOcs.sameProject": "same project",
    "LocalOcs.self": "reporter",
    "LocalOcs.host.terminal": "terminal",
    "LocalOcs.host.desktop": "desktop app",
    "LocalOcs.host.process": "process",
    "LocalOcs.host.unknown": "host unknown",
    "LocalOcs.cwdHidden": "path visible only to the reporter and the channel owner",
    "LocalOcs.cwdUnknown": "path unknown",
    "LocalOcs.copy": "copy ocs dm",
    "LocalOcs.copied": "copied",
    "LocalOcs.copyFailed": "copy failed, select the command",
    "LocalOcs.copyTitle": "Copy this command, then run it on that machine: {cmd}",
    "LocalOcs.mention": "@{name}",
    "LocalOcs.mentionTitle": "Mention {name} in the message composer",
  },
  zh: {
    "LocalOcs.title": "本机可介入",
    "LocalOcs.hint":
      "成员机器上正在运行的 agent 会话，由对方的 party serve 或桥接上报。在那台机器上执行复制的命令即可给它发消息；已有频道身份的会话也可以直接在这里 @。",
    "LocalOcs.group": "{name} 的机器",
    "LocalOcs.groupLabel": "{name} 机器上的本机会话",
    "LocalOcs.count": "{count} 个会话",
    "LocalOcs.sameProject": "同项目",
    "LocalOcs.self": "上报者",
    "LocalOcs.host.terminal": "终端",
    "LocalOcs.host.desktop": "桌面应用",
    "LocalOcs.host.process": "进程",
    "LocalOcs.host.unknown": "宿主未知",
    "LocalOcs.cwdHidden": "路径仅上报者本人与频道 owner 可见",
    "LocalOcs.cwdUnknown": "路径未知",
    "LocalOcs.copy": "复制 ocs dm",
    "LocalOcs.copied": "已复制",
    "LocalOcs.copyFailed": "复制失败，请手动选中命令",
    "LocalOcs.copyTitle": "复制这条命令，到那台机器上执行：{cmd}",
    "LocalOcs.mention": "@{name}",
    "LocalOcs.mentionTitle": "在输入框里 @{name}",
  },
};

registerDict(LocalOcsStrings);
