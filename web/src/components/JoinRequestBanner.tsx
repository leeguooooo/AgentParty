import { useT } from "../i18n/useT";
import type { AuthProviderConfig } from "../lib/oidc";
import "../i18n/strings/Channel";

export type JoinRequestBannerState =
  | "idle"
  | "authenticating"
  | "login_required"
  | "submitting"
  | "pending"
  | "rejected"
  | "approved"
  | "already_member"
  | "error";

interface Props {
  state: JoinRequestBannerState;
  idleText?: string;
  reason?: string | null;
  errorMessage?: string | null;
  providers?: AuthProviderConfig[];
  onApply?(): void;
  onRetry?(): void;
  onLogin?(provider: AuthProviderConfig): void;
  onEnter?(): void;
}

export function JoinRequestBanner({ state, idleText, reason, errorMessage, providers = [], onApply, onRetry, onLogin, onEnter }: Props) {
  const t = useT();
  const busy = state === "authenticating" || state === "submitting";
  return (
    <div className={`banner banner--gray joinrequest-status joinrequest-status--${state}`} role={state === "error" ? "alert" : "status"} aria-live="polite" data-join-request-state={state}>
      <span>{state === "idle" && idleText ? idleText : state === "error" && errorMessage ? errorMessage : t(`Channel.joinRequest.${state}`)}</span>
      {state === "rejected" && reason && <span className="joinrequest-status-reason">{reason}</span>}
      {state === "idle" && onApply && <button type="button" className="d-btn d-btn--primary joinrequest-apply" onClick={onApply}>{t("Channel.joinRequest.apply")}</button>}
      {state === "rejected" && onApply && <button type="button" className="d-btn joinrequest-apply" onClick={onApply}>{t("Channel.joinRequest.applyAgain")}</button>}
      {state === "login_required" && <span className="joinrequest-login-options">{providers.length === 0 ? t("Channel.joinRequest.providerMissing") : t("Channel.joinRequest.chooseLogin")}{providers.map((provider) => <button key={provider.id} type="button" className="d-btn" onClick={() => onLogin?.(provider)}>{provider.label || provider.id}</button>)}</span>}
      {(state === "approved" || state === "already_member") && onEnter && <button type="button" className="d-btn d-btn--primary joinrequest-enter" onClick={onEnter}>{t("Channel.joinRequest.enter")}</button>}
      {(state === "pending" || state === "error") && onRetry && <button type="button" className="d-btn joinrequest-status-retry" onClick={onRetry}>{t("Channel.joinRequest.retry")}</button>}
      {busy && <span className="joinrequest-status-spinner" aria-hidden="true" />}
    </div>
  );
}
