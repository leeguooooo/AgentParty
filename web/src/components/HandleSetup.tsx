// 自助设置/修改可@别名（Task B2 + #165）。纯表单：输入 + 保存 + 内联错误行，不含自己的开关按钮/
// 定位逻辑——由调用方（App.tsx 的 me chip 入口）决定何时挂载、挂在哪。
// mode="handle"：人类账号 @handle（ASCII，2–32）；mode="nickname"：agent 昵称（可中文，1–64，#165）。
import { useCallback, useState } from "react";
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  setHandle,
  setNickname,
  ValidationError,
} from "../lib/api";
import { useT } from "../i18n/useT";
import "../i18n/strings/HandleSetup";

// handle：字母/数字开头，后随字母/数字/._- ，总长 2–32（唯一性后端不分大小写）。
const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;
// nickname：首字为任意 unicode 字母/数字（含中文），后随 ._- ，总长 1–64（与后端 NICKNAME_RE 对齐）。
const NICKNAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

interface Props {
  current: string | null;
  mode?: "handle" | "nickname";
  onSaved(value: string): void;
  onClose?(): void;
}

export function HandleSetup({ current, mode = "handle", onSaved, onClose }: Props) {
  const t = useT();
  const nick = mode === "nickname";
  const [value, setValue] = useState(current ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = value.trim();
  const formatOk = (nick ? NICKNAME_RE : HANDLE_RE).test(trimmed);
  // 键前缀：nickname 模式用 HandleSetup.nick.*，缺省回退到通用键（save/saving/cancel 等共用）。
  const s = (key: string) => t(nick ? `HandleSetup.nick.${key}` : `HandleSetup.${key}`);

  const submit = useCallback(async () => {
    if (!formatOk || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const saved = nick ? (await setNickname(trimmed)).nickname : (await setHandle(trimmed)).handle;
      setBusy(false);
      onSaved(saved);
    } catch (e) {
      setBusy(false);
      setErr(
        e instanceof ConflictError
          ? s("errConflict")
          : e instanceof ValidationError
            ? s("errValidation")
            : e instanceof ForbiddenError
              ? s("errForbidden")
              : e instanceof AuthError
                ? t("HandleSetup.errGeneric")
                : t("HandleSetup.errGeneric"),
      );
    }
  }, [formatOk, busy, nick, trimmed, onSaved, t]);

  return (
    <div className="handlesetup">
      <p className="handlesetup-title">{nick ? t("HandleSetup.nick.title") : t("HandleSetup.title")}</p>
      {nick && current === null && trimmed.length === 0 && (
        <p className="handlesetup-empty">{t("HandleSetup.nick.empty")}</p>
      )}
      <input
        className="t-mono handlesetup-input"
        value={value}
        autoFocus
        spellCheck={false}
        placeholder={nick ? t("HandleSetup.nick.placeholder") : t("HandleSetup.placeholder")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onClose?.();
        }}
        disabled={busy}
      />
      {value.trim().length > 0 && !formatOk && (
        <p className="handlesetup-hint">{nick ? t("HandleSetup.nick.formatHint") : t("HandleSetup.formatHint")}</p>
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
