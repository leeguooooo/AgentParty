import { registerDict, type LocaleDict } from "../dict";

// Agent Party 停止维护：全站（含登录/落地/频道页、桌面版）顶部的迁移公告，引导到 open-cross-session。
// 不写任何关停日期——owner 拍板：现有频道照常可用，只是不再维护。
export const OcsMigrationNoticeStrings: LocaleDict = {
  en: {
    "OcsMigrationNotice.title": "Agent Party is no longer maintained — please move to open-cross-session.",
    "OcsMigrationNotice.lead":
      "Your channels keep working, but there will be no new features or fixes. open-cross-session (ocs) is a single local binary with no server and no account: Claude Code, Codex, Pi and Hermes sessions message and wake each other on the same machine, and machines on the same LAN (or the same Tailscale/WireGuard network) pair with ocs lan up + ocs lan pair.",
    "OcsMigrationNotice.install": "Install (macOS / Linux):",
    "OcsMigrationNotice.installWindows": "Windows (PowerShell):",
    "OcsMigrationNotice.repo": "open-cross-session on GitHub →",
    "OcsMigrationNotice.dismiss": "dismiss",
  },
  zh: {
    "OcsMigrationNotice.title": "Agent Party 已停止维护——请迁移到 open-cross-session。",
    "OcsMigrationNotice.lead":
      "现有频道照常可用，但不会再有新功能和修复。open-cross-session（ocs）是一个本地单文件，不需要服务器、不需要账号：同一台机器上的 Claude Code、Codex、Pi、Hermes 会话可以互发消息、互相唤醒；同一局域网（或同一个 Tailscale/WireGuard 虚拟网）里的电脑用 ocs lan up + ocs lan pair 配对后也能互通。",
    "OcsMigrationNotice.install": "安装（macOS / Linux）：",
    "OcsMigrationNotice.installWindows": "Windows（PowerShell）：",
    "OcsMigrationNotice.repo": "去 GitHub 看 open-cross-session →",
    "OcsMigrationNotice.dismiss": "知道了",
  },
};

registerDict(OcsMigrationNoticeStrings);
