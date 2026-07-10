import { registerDict, type LocaleDict } from "../dict";

export const DesktopPairingStrings: LocaleDict = {
  en: {
    "DesktopPairing.title": "Pair this desktop",
    "DesktopPairing.subtitle": "Approve this app from your signed-in browser.",
    "DesktopPairing.start": "Start pairing",
    "DesktopPairing.creating": "Creating a secure pairing",
    "DesktopPairing.codeLabel": "Your pairing code",
    "DesktopPairing.pending": "Waiting for approval in your browser",
    "DesktopPairing.slowDown": "The server asked us to slow down. Pairing is still active.",
    "DesktopPairing.cancel": "Cancel",
    "DesktopPairing.denied": "This pairing was rejected.",
    "DesktopPairing.expired": "This pairing code expired.",
    "DesktopPairing.cancelled": "Pairing cancelled on this device.",
    "DesktopPairing.error": "Pairing could not be completed.",
    "DesktopPairing.retry": "Try again",
    "DesktopPairing.browserFailed": "The approval page could not be opened in your system browser.",
  },
  zh: {
    "DesktopPairing.title": "配对这台桌面设备",
    "DesktopPairing.subtitle": "请在已登录的系统浏览器中批准此应用。",
    "DesktopPairing.start": "开始配对",
    "DesktopPairing.creating": "正在创建安全配对",
    "DesktopPairing.codeLabel": "你的配对短码",
    "DesktopPairing.pending": "正在等待浏览器批准",
    "DesktopPairing.slowDown": "服务器要求降低轮询速度，配对仍然有效。",
    "DesktopPairing.cancel": "取消",
    "DesktopPairing.denied": "此配对已被拒绝。",
    "DesktopPairing.expired": "此配对短码已过期。",
    "DesktopPairing.cancelled": "已在此设备取消配对。",
    "DesktopPairing.error": "无法完成配对。",
    "DesktopPairing.retry": "重试",
    "DesktopPairing.browserFailed": "无法在系统浏览器中打开批准页面。",
  },
};

registerDict(DesktopPairingStrings);
