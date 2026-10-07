import { registerDict, type LocaleDict } from "../dict";

// Agent Party 关停公告：全站（含登录/落地/频道页、桌面版）顶部，引导迁移到 open-cross-session、给出卸载指南。
// 关停日期（owner 拍板）：2026-10-31，届时 agentparty.leeguoo.com 托管服务停止；此前频道照常可用。
export const OcsMigrationNoticeStrings: LocaleDict = {
  en: {
    "OcsMigrationNotice.title": "Agent Party will shut down on 2026-10-31 — please move to open-cross-session.",
    "OcsMigrationNotice.lead":
      "The hosted service at agentparty.leeguoo.com stops on 2026-10-31; your channels keep working until that date. open-cross-session (ocs) is a single local binary with no server and no account: Claude Code, Codex, Pi and Hermes sessions message and wake each other on the same machine, and machines on the same LAN (or the same Tailscale/WireGuard network) pair with ocs lan up + ocs lan pair.",
    "OcsMigrationNotice.install": "Install (macOS / Linux):",
    "OcsMigrationNotice.installWindows": "Windows (PowerShell):",
    "OcsMigrationNotice.repo": "open-cross-session on GitHub →",
    "OcsMigrationNotice.uninstall": "Remove the local Agent Party install →",
    "OcsMigrationNotice.uninstallUrl": "https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md",
    "OcsMigrationNotice.dismiss": "dismiss",
  },
  zh: {
    "OcsMigrationNotice.title": "Agent Party 将于 2026-10-31 关停——请迁移到 open-cross-session。",
    "OcsMigrationNotice.lead":
      "agentparty.leeguoo.com 托管服务将在 2026-10-31 停止；在此之前频道照常可用。open-cross-session（ocs）是一个本地单文件，不需要服务器、不需要账号：同一台机器上的 Claude Code、Codex、Pi、Hermes 会话可以互发消息、互相唤醒；同一局域网（或同一个 Tailscale/WireGuard 虚拟网）里的电脑用 ocs lan up + ocs lan pair 配对后也能互通。",
    "OcsMigrationNotice.install": "安装（macOS / Linux）：",
    "OcsMigrationNotice.installWindows": "Windows（PowerShell）：",
    "OcsMigrationNotice.repo": "去 GitHub 看 open-cross-session →",
    "OcsMigrationNotice.uninstall": "卸载本机的 Agent Party →",
    "OcsMigrationNotice.uninstallUrl": "https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.zh.md",
    "OcsMigrationNotice.dismiss": "知道了",
  },
};

registerDict(OcsMigrationNoticeStrings);
