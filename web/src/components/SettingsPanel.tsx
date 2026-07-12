// #273 全局设置：把散落的跨频道偏好收进一个面板——语言、主题、被@通知、账号（身份 + @别名编辑 + 退出）。
// 纯前端；通知偏好读写 localStorage 的 ap_notify_optin（与 NotifyToggle 同键），语言走 LanguageSwitcher，
// 主题走 lib/theme（doodle↔midnight，写 <html data-theme> + localStorage）。账号 @handle/昵称编辑复用
// HandleSetup——顶栏不再单独挂浮层入口，编辑归位到这里。不动顶栏原有的桌面专属控件。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useT } from "../i18n/useT";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { HandleSetup } from "./HandleSetup";
import { applyTheme, readStoredTheme, SUPPORTED_THEMES, type Theme } from "../lib/theme";
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
  email?: string | null;
  provider?: string | null;
}

export function SettingsPanel({
  me,
  canSetHandle = false,
  onClose,
  onLogout,
  onHandleSaved,
  onShowOnboarding,
  desktopSettings = null,
}: {
  me: SettingsMe | null;
  canSetHandle?: boolean;
  onClose: () => void;
  onLogout: (() => void) | null;
  onHandleSaved?: (value: string) => void;
  onShowOnboarding?: () => void;
  desktopSettings?: ReactNode;
}) {
  const t = useT();
  const [notifyOptin, setNotifyOptin] = useState<boolean>(readNotifyOptin);
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  // Esc 关闭；打开时锁焦点在面板（简版：Esc + 点遮罩关）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setTheme(next);
  }, []);

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
          <div className="settings-label">{t("App.settings.theme")}</div>
          <div className="settings-theme" role="group" aria-label={t("App.settings.theme")}>
            {SUPPORTED_THEMES.map((option) => (
              <button
                key={option.code}
                type="button"
                data-theme-code={option.code}
                className={"settings-theme-btn" + (option.code === theme ? " is-active" : "")}
                aria-pressed={option.code === theme}
                onClick={() => pickTheme(option.code)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
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

        {onShowOnboarding && (
          <section className="settings-section">
            <div className="settings-label">{t("App.settings.help")}</div>
            <button type="button" className="d-btn settings-onboarding" onClick={onShowOnboarding}>
              {t("App.settings.onboarding")}
            </button>
          </section>
        )}

        {desktopSettings}

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
            {(me.email != null || me.provider != null) && (
              <dl className="settings-facts">
                {me.email != null && (
                  <div><dt>{t("App.settings.email")}</dt><dd>{me.email}</dd></div>
                )}
                {me.provider != null && (
                  <div><dt>{t("App.settings.provider")}</dt><dd>{me.provider}</dd></div>
                )}
              </dl>
            )}
            {canSetHandle && (
              <div className="settings-handle">
                <HandleSetup
                  current={me.handle}
                  mode={me.kind === "agent" ? "nickname" : "handle"}
                  onSaved={(value) => onHandleSaved?.(value)}
                />
              </div>
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
