// 私有频道邀请链接（issue #38 web）。只对 moderator（房主）渲染——隐私性靠「只有创建者能生成」，
// 服务端 isChannelModerator 再强制。生成 /join/<code> 链接：对方点开 → OIDC 登录 → 加入为成员。
// 折叠面板：生成（可选有效期）+ 一键复制 + 列出未撤销链接 + 撤销。
import { useCallback, useState } from "react";
import { AuthError, createJoinLink, type JoinLinkInfo, listJoinLinks, revokeJoinLink } from "../lib/api";
import { useT, type TFunc } from "../i18n/useT";
import "../i18n/strings/JoinLink";

interface Props {
  slug: string;
  token: string;
  onAuthFailed(message: string): void;
  active?: boolean;
  onActiveChange?(open: boolean): void;
}

function expiryOptions(t: TFunc): { label: string; sec?: number }[] {
  return [
    { label: t("JoinLink.expiry.7d"), sec: 7 * 86400 },
    { label: t("JoinLink.expiry.1d"), sec: 86400 },
    { label: t("JoinLink.expiry.30d"), sec: 30 * 86400 },
    { label: t("JoinLink.expiry.never") }, // sec undefined
  ];
}

// 默认单次失效（一个链接只能一个人用）——私有频道更看重隐私。用尽即失效。
function usesOptions(t: TFunc): { label: string; max?: number }[] {
  return [
    { label: t("JoinLink.uses.single"), max: 1 },
    { label: t("JoinLink.uses.5"), max: 5 },
    { label: t("JoinLink.uses.unlimited") }, // max undefined
  ];
}

function linkUrl(link: JoinLinkInfo): string {
  return link.url ?? `${location.origin}/join/${link.code}`;
}

function expiryLabel(link: JoinLinkInfo, t: TFunc): string {
  if (link.expires_at === null) return t("JoinLink.neverExpires");
  const left = link.expires_at - Date.now();
  if (left <= 0) return t("JoinLink.expired");
  const days = Math.floor(left / 86400000);
  if (days >= 1) return t("JoinLink.expiresInDays", { days });
  return t("JoinLink.expiresInHours", { hours: Math.max(1, Math.floor(left / 3600000)) });
}

export function JoinLink({ slug, token, onAuthFailed, active, onActiveChange }: Props) {
  const t = useT();
  const EXPIRY_OPTIONS = expiryOptions(t);
  const USES_OPTIONS = usesOptions(t);
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<JoinLinkInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [usesIdx, setUsesIdx] = useState(0); // 默认单次
  const [copied, setCopied] = useState<string | null>(null);
  const isOpen = active ?? open;

  const handleErr = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) {
        onAuthFailed(e.message);
        return;
      }
      setError(e instanceof Error ? e.message : "failed");
    },
    [onAuthFailed],
  );

  const refresh = useCallback(async () => {
    try {
      setLinks(await listJoinLinks(token, slug));
    } catch (e) {
      handleErr(e);
    }
  }, [token, slug, handleErr]);

  const toggle = useCallback(() => {
    const next = !isOpen;
    if (active === undefined) setOpen(next);
    onActiveChange?.(next);
    if (next && links === null) void refresh();
  }, [active, isOpen, links, onActiveChange, refresh]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const link = await createJoinLink(token, slug, {
        expiresInSec: EXPIRY_OPTIONS[expiryIdx]?.sec,
        maxUses: USES_OPTIONS[usesIdx]?.max,
      });
      await refresh(); // 先把新链接列出来（关键路径）
      setBusy(false);
      copy(linkUrl(link)); // best-effort：剪贴板在非聚焦标签会挂起/拒绝，绝不能阻塞上面的列表刷新
      return;
    } catch (e) {
      handleErr(e);
      setBusy(false);
    }
  }

  // 不 await、不阻塞调用方：writeText 在未聚焦文档会 reject 甚至挂起，失败只提示手动复制。
  function copy(url: string) {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => {
        setCopied(url);
        setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
      })
      .catch(() => setError(t("JoinLink.copyFailed")));
  }

  async function revoke(code: string) {
    setBusy(true);
    try {
      await revokeJoinLink(token, slug, code);
      await refresh();
    } catch (e) {
      handleErr(e);
    } finally {
      setBusy(false);
    }
  }

  const activeLinks = (links ?? []).filter((l) => l.revoked_at === null && (l.expires_at === null || l.expires_at > Date.now()));

  return (
    <div className="joinlink">
      <button type="button" className="d-btn joinlink-btn" onClick={toggle} aria-expanded={isOpen}>
        {t("JoinLink.button")}
      </button>
      {isOpen && (
        <div className="joinlink-panel">
          <div className="joinlink-gen">
            <span className="joinlink-hint">{t("JoinLink.hint")}</span>
            <div className="joinlink-gen-row">
              <label className="joinlink-expiry">
                {t("JoinLink.usesLabel")}
                <select value={usesIdx} onChange={(e) => setUsesIdx(Number(e.target.value))} disabled={busy}>
                  {USES_OPTIONS.map((o, i) => (
                    <option key={o.label} value={i}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="joinlink-expiry">
                {t("JoinLink.expiryLabel")}
                <select value={expiryIdx} onChange={(e) => setExpiryIdx(Number(e.target.value))} disabled={busy}>
                  {EXPIRY_OPTIONS.map((o, i) => (
                    <option key={o.label} value={i}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="d-btn d-btn--primary" disabled={busy} onClick={generate}>
                {busy ? t("JoinLink.generating") : t("JoinLink.generate")}
              </button>
            </div>
          </div>
          {error !== null && <p className="joinlink-error">{error}</p>}
          {activeLinks.length > 0 && (
            <ul className="joinlink-list">
              {activeLinks.map((l) => {
                const url = linkUrl(l);
                return (
                  <li key={l.code} className="joinlink-item">
                    <code className="joinlink-url t-mono">{url}</code>
                    <span className="joinlink-meta">
                      {expiryLabel(l, t)}
                      {" · "}
                      {l.max_uses !== null
                        ? t("JoinLink.usesOf", { uses: l.uses, max: l.max_uses })
                        : t("JoinLink.usesCount", { uses: l.uses })}
                    </span>
                    <button type="button" className="d-btn joinlink-copy" onClick={() => copy(url)}>
                      {copied === url ? t("JoinLink.copied") : t("JoinLink.copy")}
                    </button>
                    <button type="button" className="d-btn joinlink-revoke" disabled={busy} onClick={() => revoke(l.code)}>
                      {t("JoinLink.revoke")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {links !== null && activeLinks.length === 0 && <p className="joinlink-empty">{t("JoinLink.empty")}</p>}
        </div>
      )}
    </div>
  );
}
