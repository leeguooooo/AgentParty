// 被@浏览器通知的铃铛开关（Task C2）。opt-in 是全局设置（跨频道生效），落 localStorage；
// 真正的“要不要弹”判定在纯函数 shouldNotify（lib/notify.ts）里，本组件只管开关本身：
// 读/写 opt-in、申请浏览器通知权限、把结果上报给持有 optin state 的父组件（ChannelPage）。
import { useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Channel";

const OPTIN_KEY = "ap_notify_optin";

export function readNotifyOptin(): boolean {
  try {
    return localStorage.getItem(OPTIN_KEY) === "1";
  } catch {
    return false; // 私有模式等场景 localStorage 不可用时，默认关闭（不静默弹通知）
  }
}

function writeNotifyOptin(on: boolean) {
  try {
    localStorage.setItem(OPTIN_KEY, on ? "1" : "0");
  } catch {
    // 写入失败不阻断本次切换，只是刷新/换标签页后会回落到默认关闭
  }
}

interface Props {
  optin: boolean;
  onChange(next: boolean): void;
}

export function NotifyToggle({ optin, onChange }: Props) {
  const t = useT();
  const [hint, setHint] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && "Notification" in window;

  const toggle = () => {
    setHint(null);
    if (!supported) return;
    if (optin) {
      // 关闭不需要权限往返，立即生效
      writeNotifyOptin(false);
      onChange(false);
      return;
    }
    if (Notification.permission === "granted") {
      writeNotifyOptin(true);
      onChange(true);
      return;
    }
    void Notification.requestPermission().then((permission) => {
      if (permission === "granted") {
        writeNotifyOptin(true);
        onChange(true);
      } else {
        // denied / default 都保持关闭；denied 时浏览器不会再弹权限框，给一次内联提示说明原因
        writeNotifyOptin(false);
        onChange(false);
        setHint(t("Channel.notify.denied"));
      }
    });
  };

  return (
    <span className="notify-toggle">
      <button
        type="button"
        className={"d-btn notify-toggle-btn" + (optin ? " is-active" : "")}
        disabled={!supported}
        onClick={toggle}
        aria-pressed={optin}
        title={supported ? (optin ? t("Channel.notify.onTitle") : t("Channel.notify.offTitle")) : t("Channel.notify.unsupported")}
      >
        {optin ? "🔔" : "🔕"}
      </button>
      {!supported && <span className="notify-toggle-hint t-mono">{t("Channel.notify.unsupported")}</span>}
      {supported && hint !== null && <span className="notify-toggle-hint t-mono">{hint}</span>}
    </span>
  );
}
