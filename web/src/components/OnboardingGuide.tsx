// 首次进入的 1-2-3-4 引导浮层（#146）。只在浏览器第一次进来时出现，关掉后落一个
// localStorage 标记（复用 ap_locale 那套持久化模式，不造新机制），之后不再打扰。
// 范围克制：一张可关闭的四步卡片，讲清「加入频道 → @唤醒 → 认领任务 → 提交」主线。
import { useState } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Onboarding";

const STORAGE_KEY = "ap_onboarded";

function alreadyOnboarded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage 不可用（隐私模式等）→ 当作没引导过：本次会话显示一次，只是刷新不记
    return false;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // 静默：写不进就本次会话内关掉，不炸 UI
  }
}

const STEP_KEYS = ["step1", "step2", "step3", "step4"] as const;

export function OnboardingGuide({
  forceOpen = false,
  onClose,
}: {
  forceOpen?: boolean;
  onClose?: () => void;
}) {
  const t = useT();
  // 「是否首次进入」判定：读 localStorage 标记。改这里（比如恒为 false）会让首次显示的测试红。
  const [open, setOpen] = useState(() => !alreadyOnboarded());

  const dismiss = () => {
    markOnboarded();
    setOpen(false);
    onClose?.();
  };

  if (!forceOpen && !open) return null;

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-backdrop" onClick={dismiss} aria-hidden="true" />
      <div className="d-card onboarding-card">
        <button
          type="button"
          className="d-btn onboarding-close"
          onClick={dismiss}
          aria-label={t("Onboarding.close")}
        >
          ✕
        </button>
        <h2 className="d-title onboarding-title" id="onboarding-title">
          {t("Onboarding.title")}
        </h2>
        <p className="d-hand onboarding-subtitle">{t("Onboarding.subtitle")}</p>
        <ol className="onboarding-steps">
          {STEP_KEYS.map((key, i) => (
            <li className="onboarding-step" key={key}>
              <span className="onboarding-step-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="onboarding-step-body">
                <strong className="onboarding-step-title">{t(`Onboarding.${key}.title`)}</strong>
                <span className="onboarding-step-desc t-mono">{t(`Onboarding.${key}.desc`)}</span>
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="d-btn onboarding-dismiss" onClick={dismiss}>
          {t("Onboarding.dismiss")}
        </button>
      </div>
    </div>
  );
}
