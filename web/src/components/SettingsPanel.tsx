// #273 全局设置：把散落的跨频道偏好收进一个面板——语言、被@通知、账号（身份 + 退出）。
// 纯前端；通知偏好读写 localStorage 的 ap_notify_optin（与 NotifyToggle 同键），语言走 LanguageSwitcher。
// 不动顶栏原有的桌面专属控件，只新增一个入口 + 面板。
import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n/useT";
import { LanguageSwitcher } from "./LanguageSwitcher";
import "../i18n/strings/App";

const NOTIFY_OPTIN_KEY = "ap_notify_optin";

function readNotifyOptin(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(NOTIFY_OPTIN_KEY) === "1";
  } catch {
    return false;
  }
}

export interface SettingsMe {
  name: string;
  kind: string;
  role: string;
  handle: string | null;
  display_name: string | null;
  owner: string | null;
}

export function SettingsPanel({
  me,
  onClose,
  onLogout,
}: {
  me: SettingsMe | null;
  onClose: () => void;
  onLogout: (() => void) | null;
}) {
  const t = useT();
  const [notifyOptin, setNotifyOptin] = useState<boolean>(readNotifyOptin);

  // Esc 关闭；打开时锁焦点在面板（简版：Esc + 点遮罩关）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggleNotify = useCallback(() => {
    setNotifyOptin((prev) => {
      const next = !prev;
      try {
        if (next) {
          localStorage.setItem(NOTIFY_OPTIN_KEY, "1");
          // best-effort 申请浏览器通知权限；拒绝/不支持不回滚，页内 toast 仍可用。
          if (typeof Notification !== "undefined" && Notification.requestPermission) {
            void Notification.requestPermission();
          }
        } else {
          localStorage.removeItem(NOTIFY_OPTIN_KEY);
        }
      } catch {
        /* localStorage 不可用时仅内存态，忽略 */
      }
      return next;
    });
  }, []);

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={t("App.settings.title")} onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2 className="settings-title">{t("App.settings.title")}</h2>
          <button type="button" className="settings-close" aria-label={t("App.settings.close")} onClick={onClose}>
            ×
          </button>
        </header>

        <section className="settings-section">
          <div className="settings-label">{t("App.settings.language")}</div>
          <LanguageSwitcher />
        </section>

        <section className="settings-section">
          <div className="settings-label">{t("App.settings.notifications")}</div>
          <button
            type="button"
            className={"settings-toggle" + (notifyOptin ? " is-on" : "")}
            aria-pressed={notifyOptin}
            onClick={toggleNotify}
          >
            <span className="settings-toggle-dot" aria-hidden="true" />
            {notifyOptin ? t("App.settings.notify.on") : t("App.settings.notify.off")}
          </button>
          <p className="settings-hint">{t("App.settings.notify.hint")}</p>
        </section>

        {me !== null && (
          <section className="settings-section">
            <div className="settings-label">{t("App.settings.account")}</div>
            <div className="settings-account">
              <span className="settings-account-name">{me.display_name ?? me.handle ?? me.name}</span>
              <span className={`settings-account-chip settings-account-chip--${me.kind}`}>{me.kind}</span>
              {me.role !== me.kind && <span className="settings-account-chip">{me.role}</span>}
            </div>
            {me.owner !== null && me.owner !== me.name && (
              <p className="settings-hint">owner: {me.owner}</p>
            )}
            {onLogout !== null && (
              <button type="button" className="settings-logout" onClick={onLogout}>
                {t("App.settings.logout")}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
