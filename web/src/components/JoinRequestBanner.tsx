import { useState } from "react";
import { useT } from "../i18n/useT";
import { JOIN_REQUEST_NOTE_MAX_LENGTH } from "../lib/joinRequestPending";
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
  onApply?(note: string): void;
  onRetry?(): void;
  onLogin?(provider: AuthProviderConfig): void;
  onEnter?(): void;
}

export function JoinRequestBanner({ state, idleText, reason, errorMessage, providers = [], onApply, onRetry, onLogin, onEnter }: Props) {
  const t = useT();
  const [note, setNote] = useState("");
  const busy = state === "authenticating" || state === "submitting";
  const canApply = state === "idle" || state === "rejected";
  return (
    <div className={`banner banner--gray joinrequest-status joinrequest-status--${state}`} role={state === "error" ? "alert" : "status"} aria-live="polite" data-join-request-state={state}>
      <span>{state === "idle" && idleText ? idleText : state === "error" && errorMessage ? errorMessage : t(`Channel.joinRequest.${state}`)}</span>
      {state === "rejected" && reason && <span className="joinrequest-status-reason">{reason}</span>}
      {canApply && onApply && <label className="joinrequest-note-field">
        <span>{t("Channel.joinRequest.noteLabel")}</span>
        <textarea
          className="joinrequest-note-input"
          value={note}
          maxLength={JOIN_REQUEST_NOTE_MAX_LENGTH}
          rows={2}
          placeholder={t("Channel.joinRequest.notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>}
      {state === "idle" && onApply && <button type="button" className="d-btn d-btn--primary joinrequest-apply" onClick={() => onApply(note.trim())}>{t("Channel.joinRequest.apply")}</button>}
      {state === "rejected" && onApply && <button type="button" className="d-btn joinrequest-apply" onClick={() => onApply(note.trim())}>{t("Channel.joinRequest.applyAgain")}</button>}
      {state === "login_required" && <span className="joinrequest-login-options">{providers.length === 0 ? t("Channel.joinRequest.providerMissing") : t("Channel.joinRequest.chooseLogin")}{providers.map((provider) => <button key={provider.id} type="button" className="d-btn" onClick={() => onLogin?.(provider)}>{provider.label || provider.id}</button>)}</span>}
      {(state === "approved" || state === "already_member") && onEnter && <button type="button" className="d-btn d-btn--primary joinrequest-enter" onClick={onEnter}>{t("Channel.joinRequest.enter")}</button>}
      {(state === "pending" || state === "error") && onRetry && <button type="button" className="d-btn joinrequest-status-retry" onClick={onRetry}>{t("Channel.joinRequest.retry")}</button>}
      {busy && <span className="joinrequest-status-spinner" aria-hidden="true" />}
    </div>
  );
}
