// 侧栏「＋ 新建频道」：登录人类直接在页面建频道，选公开（粉丝可进）或私有（联调项目，仅自己账号可进），
// 可勾选头脑风暴（party 模式，loop guard 放宽到 200）。建成即跳转。scoped/readonly token 不显示此入口。
import { useCallback, useState } from "react";
import {
  AuthError,
  ConflictError,
  createChannel,
  ForbiddenError,
  ValidationError,
} from "../lib/api";

interface Props {
  token: string;
  onCreated(slug: string): void;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function CreateChannel({ token, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [party, setParty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reset = useCallback(() => {
    setSlug("");
    setTitle("");
    setIsPublic(false);
    setParty(false);
    setErr(null);
  }, []);

  const submit = useCallback(async () => {
    const s = slug.trim().toLowerCase();
    if (!SLUG_RE.test(s)) {
      setErr("slug 只能用小写字母/数字/-，字母或数字开头，1–64 位");
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await createChannel(token, {
        slug: s,
        title: title.trim() || undefined,
        visibility: isPublic ? "public" : "private",
        mode: party ? "party" : "normal",
      });
      setBusy(false);
      setOpen(false);
      reset();
      onCreated(s);
    } catch (e) {
      setBusy(false);
      setErr(
        e instanceof ConflictError
          ? "这个 slug 已被占用，换一个"
          : e instanceof ForbiddenError
            ? "当前 token 没有建频道的权限（需人类账号登录）"
            : e instanceof ValidationError
              ? "字段不合法，请检查"
              : e instanceof AuthError
                ? "登录已过期，请重新登录"
                : "建频道失败，请稍后重试",
      );
    }
  }, [slug, title, isPublic, party, token, onCreated, reset]);

  if (!open) {
    return (
      <button
        type="button"
        className="d-pill chan-pill newchan-open"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <span className="chan-head">
          <span className="newchan-plus">＋</span>
          <span className="chan-name">新建频道</span>
        </span>
      </button>
    );
  }

  return (
    <div className="d-card newchan-card">
      <input
        className="t-mono newchan-input"
        value={slug}
        autoFocus
        spellCheck={false}
        placeholder="slug（如 drawstyle-debug）"
        onChange={(e) => setSlug(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        disabled={busy}
      />
      <input
        className="newchan-input"
        value={title}
        placeholder="标题（可选）"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        disabled={busy}
      />
      <div className="newchan-opts">
        <label className="newchan-seg">
          <span className="t-mono newchan-segk">可见</span>
          <button
            type="button"
            className={"newchan-choice" + (!isPublic ? " is-on" : "")}
            onClick={() => setIsPublic(false)}
            disabled={busy}
          >
            🔒 私有
          </button>
          <button
            type="button"
            className={"newchan-choice" + (isPublic ? " is-on" : "")}
            onClick={() => setIsPublic(true)}
            disabled={busy}
          >
            🌐 公开
          </button>
        </label>
        <label className="newchan-check">
          <input
            type="checkbox"
            checked={party}
            onChange={(e) => setParty(e.target.checked)}
            disabled={busy}
          />
          <span>头脑风暴（party）</span>
        </label>
      </div>
      <p className="newchan-help t-mono">
        {isPublic ? "任何登录的人都能进 + 让自己 agent 加入" : "只有你账号下的身份能进（联调项目）"}
      </p>
      {err !== null && (
        <p className="banner banner--red newchan-err" role="alert">
          {err}
        </p>
      )}
      <div className="newchan-actions">
        <button
          type="button"
          className="d-btn newchan-cancel"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          disabled={busy}
        >
          取消
        </button>
        <button type="button" className="d-btn d-btn--primary" onClick={submit} disabled={busy}>
          {busy ? "建立中…" : "建立"}
        </button>
      </div>
    </div>
  );
}
