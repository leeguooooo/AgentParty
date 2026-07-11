// 桌面版贴网页邀请链接进入频道（#297）。桌面壳没有地址栏，用户拿到的是网页版的 /join 或
// /c 链接——这里给一个粘贴入口：解析 + 校验宿主 + 按 #186 模式分流回 App 走网页同款兑换。
// 「从剪贴板检测」是 issue 里「识别到剪贴板就问是否加入」的许可友好版：读剪贴板需用户手势，
// 故做成显式按钮（点一下即读，webview 里合法），检测到就回填并提示，真正加入仍由用户点「加入」确认。
import { useCallback, useState } from "react";
import { resolveInviteForServer, type InviteResolution } from "../lib/inviteLink";
import { useT, type TFunc } from "../i18n/useT";
import "../i18n/strings/DesktopInvite";

interface Props {
  activeOrigin: string;
  onParticipate(code: string): void;
  onWatch(slug: string, token: string): void;
  onOpen(slug: string): void;
  // DI：默认读系统剪贴板（webview 内 user-gesture 触发合法）；测试注入桩。
  readClipboard?: () => Promise<string>;
}

const defaultReadClipboard = (): Promise<string> =>
  navigator.clipboard?.readText?.() ?? Promise.reject(new Error("clipboard unavailable"));

function errorMessage(t: TFunc, r: Extract<InviteResolution, { ok: false }>, activeOrigin: string): string {
  switch (r.reason) {
    case "empty":
      return t("DesktopInvite.error.empty");
    case "malformed":
      return t("DesktopInvite.error.malformed");
    case "unsupported":
      return t("DesktopInvite.error.unsupported");
    case "wrong-host":
      return t("DesktopInvite.error.wrongHost", {
        expected: r.expectedHost ?? activeOrigin,
        actual: r.actualHost ?? "?",
      });
  }
}

function detectedMessage(t: TFunc, action: Extract<InviteResolution, { ok: true }>["action"]): string {
  if (action.kind === "participate") return t("DesktopInvite.detected.participate");
  if (action.kind === "watch") return t("DesktopInvite.detected.watch", { slug: action.slug });
  return t("DesktopInvite.detected.open", { slug: action.slug });
}

export function DesktopInvitePaste({
  activeOrigin,
  onParticipate,
  onWatch,
  onOpen,
  readClipboard = defaultReadClipboard,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<string | null>(null);

  const run = useCallback(
    (raw: string) => {
      const r = resolveInviteForServer(raw, activeOrigin);
      if (!r.ok) {
        setError(errorMessage(t, r, activeOrigin));
        return;
      }
      setError(null);
      setDetected(null);
      if (r.action.kind === "participate") onParticipate(r.action.code);
      else if (r.action.kind === "watch") onWatch(r.action.slug, r.action.token);
      else onOpen(r.action.slug);
    },
    [activeOrigin, t, onParticipate, onWatch, onOpen],
  );

  const detectFromClipboard = useCallback(async () => {
    setError(null);
    setDetected(null);
    let text: string;
    try {
      text = await readClipboard();
    } catch {
      setError(t("DesktopInvite.error.clipboard"));
      return;
    }
    const r = resolveInviteForServer(text, activeOrigin);
    if (!r.ok) {
      setError(errorMessage(t, r, activeOrigin));
      return;
    }
    setValue(text.trim());
    setDetected(detectedMessage(t, r.action));
  }, [readClipboard, activeOrigin, t]);

  return (
    <div className="invite-paste joinlink">
      <button
        type="button"
        className="d-btn joinlink-btn invite-paste-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {t("DesktopInvite.button")}
      </button>
      {open && (
        <div className="joinlink-panel invite-paste-panel">
          <span className="joinlink-hint">{t("DesktopInvite.hint")}</span>
          <input
            className="invite-paste-input"
            type="text"
            value={value}
            placeholder={t("DesktopInvite.placeholder")}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
              setDetected(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") run(value);
            }}
          />
          <div className="joinlink-gen-row invite-paste-actions">
            <button
              type="button"
              className="d-btn d-btn--primary"
              disabled={value.trim() === ""}
              onClick={() => run(value)}
            >
              {t("DesktopInvite.join")}
            </button>
            <button type="button" className="d-btn invite-paste-detect" onClick={() => void detectFromClipboard()}>
              {t("DesktopInvite.detect")}
            </button>
          </div>
          {detected !== null && (
            <p className="banner invite-paste-detected" role="status" aria-live="polite">
              {detected}
            </p>
          )}
          {error !== null && (
            <p className="joinlink-error invite-paste-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
