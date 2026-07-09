// 人类账号设置/修改 @handle（Task B2）。纯表单：输入 + 保存 + 内联错误行，不含自己的开关按钮/
// 定位逻辑——由调用方（App.tsx 的 me chip 入口）决定何时挂载、挂在哪。
import { useCallback, useState } from "react";
import { AuthError, ConflictError, ForbiddenError, setHandle, ValidationError } from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/HandleSetup";

// spec：字母/数字开头，后随字母/数字/._- ，总长 2–32；大小写原样保留显示，唯一性由后端按不分大小写判定
const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

interface Props {
  current: string | null;
  onSaved(handle: string): void;
  onClose?(): void;
}

export function HandleSetup({ current, onSaved, onClose }: Props) {
  const t = useT();
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = value.trim();
  const formatOk = HANDLE_RE.test(trimmed);

  const submit = useCallback(async () => {
    if (!formatOk || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const res = await setHandle(trimmed);
      setBusy(false);
      onSaved(res.handle);
    } catch (e) {
      setBusy(false);
      setErr(
        e instanceof ConflictError
          ? t("HandleSetup.errConflict")
          : e instanceof ValidationError
            ? t("HandleSetup.errValidation")
            : e instanceof ForbiddenError
              ? t("HandleSetup.errForbidden")
              : e instanceof AuthError
                ? t("HandleSetup.errGeneric")
                : t("HandleSetup.errGeneric"),
      );
    }
  }, [formatOk, busy, trimmed, onSaved, t]);

  return (
    <div className="handlesetup">
      <p className="handlesetup-title">{t("HandleSetup.title")}</p>
      <input
        className="t-mono handlesetup-input"
        value={value}
        autoFocus
        spellCheck={false}
        placeholder={t("HandleSetup.placeholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onClose?.();
        }}
        disabled={busy}
      />
      {value.trim().length > 0 && !formatOk && (
        <p className="handlesetup-hint">{t("HandleSetup.formatHint")}</p>
      )}
      {err !== null && (
        <p className="banner banner--red handlesetup-err" role="alert">
          {err}
        </p>
      )}
      <div className="handlesetup-actions">
        {onClose !== undefined && (
          <button type="button" className="d-btn handlesetup-cancel" onClick={onClose} disabled={busy}>
            {t("HandleSetup.cancel")}
          </button>
        )}
        <button
          type="button"
          className="d-btn d-btn--primary"
          onClick={submit}
          disabled={busy || !formatOk}
        >
          {busy ? t("HandleSetup.saving") : t("HandleSetup.save")}
        </button>
      </div>
    </div>
  );
}
