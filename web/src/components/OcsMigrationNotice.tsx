// Agent Party 关停公告（2026-10-31）：挂在 #root 最上方（main.tsx），所以登录门、邀请落地、频道页、
// 桌面版都能看到。引导迁移到 open-cross-session（ocs），并链到卸载指南。
//
// 关闭规则（owner 拍板）：本浏览器**第一次**看到时不给关——必须先被看见；之后再打开页面才出现
// 「知道了」按钮，点了按浏览器记住（localStorage），不再显示。存储不可用（隐私模式等）时一律当作
// 「第一次」——宁可多显示，不可静默吞掉公告。
import { useEffect, useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/OcsMigrationNotice";

export const OCS_REPO_URL = "https://github.com/leeguooooo/open-cross-session";
export const OCS_INSTALL_SH = "curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh";
export const OCS_INSTALL_PS1 = "irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex";

export const OCS_NOTICE_STORAGE_KEY = "ap:ocsMigrationNotice";

type NoticeState = "first" | "seen" | "dismissed";

function readState(): NoticeState {
  try {
    if (typeof localStorage === "undefined") return "first";
    const v = localStorage.getItem(OCS_NOTICE_STORAGE_KEY);
    return v === "seen" || v === "dismissed" ? v : "first";
  } catch {
    return "first";
  }
}

function writeState(state: Exclude<NoticeState, "first">): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(OCS_NOTICE_STORAGE_KEY, state);
  } catch {
    // 存不下就算了：本次挂载内 React state 仍生效。
  }
}

export function OcsMigrationNotice() {
  const t = useT();
  // 挂载时读一次；首次看到就在 effect 里落「seen」，本次挂载仍按「first」处理（不给关闭按钮）。
  // 写盘放 effect 而不是 useState 初始化函数：StrictMode 会把初始化函数跑两遍，第二遍会读到刚写的
  // 「seen」，首屏就冒出关闭按钮。
  const [state, setState] = useState<NoticeState>(readState);
  useEffect(() => {
    if (state === "first") writeState("seen");
  }, [state]);
  if (state === "dismissed") return null;

  return (
    <aside className="banner banner--yellow ocs-migration-notice" role="status" aria-live="polite" data-notice-state={state}>
      <div className="ocs-migration-notice-head">
        <strong className="ocs-migration-notice-title">⚠ {t("OcsMigrationNotice.title")}</strong>
        {state === "seen" && (
          <button
            type="button"
            className="d-btn ocs-migration-notice-dismiss"
            onClick={() => {
              writeState("dismissed");
              setState("dismissed");
            }}
          >
            {t("OcsMigrationNotice.dismiss")}
          </button>
        )}
      </div>
      <p className="ocs-migration-notice-lead">{t("OcsMigrationNotice.lead")}</p>
      <div className="ocs-migration-notice-install">
        <span>{t("OcsMigrationNotice.install")}</span>
        <code className="t-mono">{OCS_INSTALL_SH}</code>
        <span>{t("OcsMigrationNotice.installWindows")}</span>
        <code className="t-mono">{OCS_INSTALL_PS1}</code>
      </div>
      <div className="ocs-migration-notice-links">
        <a className="ocs-migration-notice-link" href={OCS_REPO_URL} target="_blank" rel="noopener noreferrer">
          {t("OcsMigrationNotice.repo")}
        </a>
        <a className="ocs-migration-notice-link" href={t("OcsMigrationNotice.uninstallUrl")} target="_blank" rel="noopener noreferrer">
          {t("OcsMigrationNotice.uninstall")}
        </a>
      </div>
    </aside>
  );
}
