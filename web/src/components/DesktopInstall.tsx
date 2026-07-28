import { useRef, useState } from "react";
import { copyText } from "../lib/agentTokenVault";
import { useT } from "../i18n/useT";
import { useModalFocusTrap } from "./useModalFocusTrap";
import "../i18n/strings/App";

export const DESKTOP_INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install-desktop.sh | AGENTPARTY_ALLOW_UNNOTARIZED=1 sh";

const PROMPT_DISMISSED_AT_KEY = "ap_desktop_install_prompt_dismissed_at_v1";
const PROMPT_REPEAT_MS = 7 * 24 * 60 * 60 * 1_000;

interface ButtonProps {
  className?: string;
  label?: string;
}

interface DialogProps {
  onClose(): void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}

function DesktopInstallDialog({ onClose, returnFocusRef }: DialogProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const copyRef = useRef<HTMLButtonElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useModalFocusTrap({
    active: true,
    containerRef: panelRef,
    initialFocusRef: copyRef,
    returnFocusRef,
    onEscape: onClose,
  });

  const copy = async () => {
    setCopyState((await copyText(DESKTOP_INSTALL_COMMAND)) ? "copied" : "error");
  };

  return (
    <div
      className="desktop-install-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="desktop-install-title"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="desktop-install-dialog"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="desktop-install-head">
          <div>
            <p className="desktop-install-kicker t-mono">{t("App.desktop.installKicker")}</p>
            <h2 id="desktop-install-title">{t("App.desktop.installTitle")}</h2>
          </div>
          <button
            type="button"
            className="desktop-install-close"
            aria-label={t("App.desktop.installClose")}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="desktop-install-lead">{t("App.desktop.installLead")}</p>
        <ul className="desktop-install-benefits">
          <li>{t("App.desktop.installBenefitResident")}</li>
          <li>{t("App.desktop.installBenefitManage")}</li>
          <li>{t("App.desktop.installBenefitNotify")}</li>
        </ul>
        <label className="desktop-install-command-label" htmlFor="desktop-install-command">
          {t("App.desktop.installCommandLabel")}
        </label>
        <textarea
          id="desktop-install-command"
          className="desktop-install-command t-mono"
          value={DESKTOP_INSTALL_COMMAND}
          readOnly
          rows={3}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="desktop-install-actions">
          <button
            ref={copyRef}
            type="button"
            className="d-btn d-btn--primary"
            onClick={() => void copy()}
          >
            {t(copyState === "copied" ? "App.desktop.installCopied" : "App.desktop.installCopy")}
          </button>
          <button type="button" className="d-btn" onClick={onClose}>
            {t("App.desktop.installDone")}
          </button>
        </div>
        {copyState === "error" && (
          <p className="banner banner--red" role="alert">{t("App.desktop.installCopyFailed")}</p>
        )}
        <p className="desktop-install-note">{t("App.desktop.installNote")}</p>
      </div>
    </div>
  );
}

export function DesktopInstallButton({ className = "app-product-link t-mono", label }: ButtonProps) {
  const t = useT();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button ref={buttonRef} type="button" className={className} onClick={() => setOpen(true)}>
        {label ?? t("App.desktop.download")}
      </button>
      {open && <DesktopInstallDialog returnFocusRef={buttonRef} onClose={() => setOpen(false)} />}
    </>
  );
}

interface PromptProps {
  desktop: boolean;
}

function shouldShowPrompt(): boolean {
  try {
    const dismissedAt = Number(localStorage.getItem(PROMPT_DISMISSED_AT_KEY) ?? "0");
    return !Number.isFinite(dismissedAt) || Date.now() - dismissedAt >= PROMPT_REPEAT_MS;
  } catch {
    return true;
  }
}

export function DesktopInstallPrompt({ desktop }: PromptProps) {
  const t = useT();
  const [visible, setVisible] = useState(() => !desktop && shouldShowPrompt());
  if (desktop || !visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(PROMPT_DISMISSED_AT_KEY, String(Date.now()));
    } catch {
      // Storage can be unavailable in private browsing; dismiss for this page view.
    }
    setVisible(false);
  };

  return (
    <aside className="desktop-install-prompt" aria-label={t("App.desktop.promptTitle")}>
      <span className="desktop-install-prompt-copy">
        <strong>{t("App.desktop.promptTitle")}</strong>
        <span>{t("App.desktop.promptBody")}</span>
      </span>
      <DesktopInstallButton className="d-btn d-btn--primary desktop-install-prompt-action" label={t("App.desktop.promptAction")} />
      <button
        type="button"
        className="desktop-install-prompt-dismiss"
        aria-label={t("App.desktop.promptDismiss")}
        onClick={dismiss}
      >
        ×
      </button>
    </aside>
  );
}
