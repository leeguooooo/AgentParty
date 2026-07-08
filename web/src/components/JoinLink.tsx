// 私有频道邀请链接（issue #38 web）。只对 moderator（房主）渲染——隐私性靠「只有创建者能生成」，
// 服务端 isChannelModerator 再强制。生成 /join/<code> 链接：对方点开 → OIDC 登录 → 加入为成员。
// 折叠面板：生成（可选有效期）+ 一键复制 + 列出未撤销链接 + 撤销。
import { useCallback, useState } from "react";
import { AuthError, createJoinLink, type JoinLinkInfo, listJoinLinks, revokeJoinLink } from "../lib/api";

interface Props {
  slug: string;
  token: string;
  onAuthFailed(message: string): void;
}

const EXPIRY_OPTIONS: { label: string; sec?: number }[] = [
  { label: "7 天", sec: 7 * 86400 },
  { label: "1 天", sec: 86400 },
  { label: "30 天", sec: 30 * 86400 },
  { label: "永不过期" }, // sec undefined
];

// 默认单次失效（一个链接只能一个人用）——私有频道更看重隐私。用尽即失效。
const USES_OPTIONS: { label: string; max?: number }[] = [
  { label: "单次（一人）", max: 1 },
  { label: "5 次", max: 5 },
  { label: "不限次数" }, // max undefined
];

function linkUrl(link: JoinLinkInfo): string {
  return link.url ?? `${location.origin}/join/${link.code}`;
}

function expiryLabel(link: JoinLinkInfo): string {
  if (link.expires_at === null) return "永不过期";
  const left = link.expires_at - Date.now();
  if (left <= 0) return "已过期";
  const days = Math.floor(left / 86400000);
  if (days >= 1) return `${days} 天后过期`;
  return `${Math.max(1, Math.floor(left / 3600000))} 小时后过期`;
}

export function JoinLink({ slug, token, onAuthFailed }: Props) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<JoinLinkInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [usesIdx, setUsesIdx] = useState(0); // 默认单次
  const [copied, setCopied] = useState<string | null>(null);

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
    const next = !open;
    setOpen(next);
    if (next && links === null) void refresh();
  }, [open, links, refresh]);

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
      .catch(() => setError("已生成，但自动复制失败——请手动选中链接复制"));
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

  const active = (links ?? []).filter((l) => l.revoked_at === null && (l.expires_at === null || l.expires_at > Date.now()));

  return (
    <div className="joinlink">
      <button type="button" className="d-btn joinlink-btn" onClick={toggle} aria-expanded={open}>
        🔗 邀请链接
      </button>
      {open && (
        <div className="joinlink-panel">
          <div className="joinlink-gen">
            <span className="joinlink-hint">生成一条邀请链接，对方点开登录即加入本私有频道。仅你（房主）可管理。</span>
            <div className="joinlink-gen-row">
              <label className="joinlink-expiry">
                使用次数
                <select value={usesIdx} onChange={(e) => setUsesIdx(Number(e.target.value))} disabled={busy}>
                  {USES_OPTIONS.map((o, i) => (
                    <option key={o.label} value={i}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="joinlink-expiry">
                有效期
                <select value={expiryIdx} onChange={(e) => setExpiryIdx(Number(e.target.value))} disabled={busy}>
                  {EXPIRY_OPTIONS.map((o, i) => (
                    <option key={o.label} value={i}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="d-btn d-btn--primary" disabled={busy} onClick={generate}>
                {busy ? "…" : "生成并复制"}
              </button>
            </div>
          </div>
          {error !== null && <p className="joinlink-error">{error}</p>}
          {active.length > 0 && (
            <ul className="joinlink-list">
              {active.map((l) => {
                const url = linkUrl(l);
                return (
                  <li key={l.code} className="joinlink-item">
                    <code className="joinlink-url t-mono">{url}</code>
                    <span className="joinlink-meta">
                      {expiryLabel(l)}
                      {l.max_uses !== null ? ` · ${l.uses}/${l.max_uses} 次` : ` · 已用 ${l.uses}`}
                    </span>
                    <button type="button" className="d-btn joinlink-copy" onClick={() => copy(url)}>
                      {copied === url ? "已复制" : "复制"}
                    </button>
                    <button type="button" className="d-btn joinlink-revoke" disabled={busy} onClick={() => revoke(l.code)}>
                      撤销
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {links !== null && active.length === 0 && <p className="joinlink-empty">还没有有效邀请链接</p>}
        </div>
      )}
    </div>
  );
}
