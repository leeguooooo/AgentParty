// 成员面板「本机可介入」分组（#1113）：每台上报机器（= 一个上报的 party 身份）一组，
// 每行给可复制的 `ocs dm <addr> "…"`；该会话在本频道有 party 身份时再给一个 @ 动作。
// 可见性由服务端裁剪：非 owner 成员收到的帧里根本没有 cwd，这里只按 frame.full 决定怎么说明。
import { useEffect, useRef, useState } from "react";
import { ocsDmCommand, type OcsRosterFrame, type OcsSessionView } from "@agentparty/shared";
import { useT } from "../i18n/useT";
import "../i18n/strings/LocalOcs";

/** 未过期、非空的分组，按上报者名排序。 */
export function visibleOcsGroups(rosters: Record<string, OcsRosterFrame>, now: number): OcsRosterFrame[] {
  return Object.values(rosters)
    .filter((r) => r.expires_at > now && r.sessions.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 把 `@name` 放到草稿开头；草稿里已经 @ 过同名就原样返回。 */
export function draftWithMention(draft: string, name: string): string {
  const token = `@${name}`;
  if (draft.split(/\s+/).includes(token)) return draft;
  return draft.trim() === "" ? `${token} ` : `${token} ${draft}`;
}

function shortCwd(cwd: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(cwd);
  return m === null ? cwd : `~${m[1] ?? ""}`;
}

function OcsRow({
  session,
  full,
  canMention,
  onMention,
}: {
  session: OcsSessionView;
  full: boolean;
  canMention: boolean;
  onMention?: (name: string) => void;
}) {
  const t = useT();
  const cmd = ocsDmCommand(session.addr);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopy("idle"), 2_000);
  };
  const partyName = session.party_name;
  return (
    <li className="ocs-row" data-harness={session.harness}>
      <div className="ocs-row-head">
        <span className="t-mono ocs-harness">{session.harness}</span>
        <span className="t-mono ocs-addr">{session.addr}</span>
        {session.same_project && <span className="t-mono ocs-badge">{t("LocalOcs.sameProject")}</span>}
        {session.self === true && <span className="t-mono ocs-badge">{t("LocalOcs.self")}</span>}
        <span className="t-mono ocs-host">{t(`LocalOcs.host.${session.host_kind}`)}</span>
        {session.status !== undefined && <span className="t-mono ocs-status">{session.status}</span>}
      </div>
      {full ? (
        <div className="t-mono ocs-cwd" title={session.cwd ?? undefined}>
          {session.cwd === null || session.cwd === undefined ? t("LocalOcs.cwdUnknown") : shortCwd(session.cwd)}
          {session.label !== undefined && <span className="ocs-label"> · {session.label}</span>}
        </div>
      ) : (
        <div className="t-mono ocs-cwd ocs-cwd--hidden">{t("LocalOcs.cwdHidden")}</div>
      )}
      <div className="ocs-actions">
        <code className="t-mono ocs-cmd">{cmd}</code>
        <button type="button" className="d-btn ocs-copy" title={t("LocalOcs.copyTitle", { cmd })} onClick={() => void doCopy()}>
          {copy === "copied" ? t("LocalOcs.copied") : copy === "failed" ? t("LocalOcs.copyFailed") : t("LocalOcs.copy")}
        </button>
        {partyName !== undefined && canMention && onMention !== undefined && (
          <button
            type="button"
            className="d-btn ocs-mention"
            title={t("LocalOcs.mentionTitle", { name: partyName })}
            onClick={() => onMention(partyName)}
          >
            {t("LocalOcs.mention", { name: partyName })}
          </button>
        )}
      </div>
    </li>
  );
}

export function LocalOcsSessions({
  rosters,
  now,
  displayOf,
  isMentionable,
  onMention,
}: {
  rosters: Record<string, OcsRosterFrame>;
  now: number;
  displayOf: (name: string) => string;
  /** 该 party 身份当前是否在本频道可 @（在 presence/participants 里）。 */
  isMentionable: (name: string) => boolean;
  onMention?: (name: string) => void;
}) {
  const t = useT();
  const groups = visibleOcsGroups(rosters, now);
  if (groups.length === 0) return null;
  return (
    <div className="ocs-local">
      <h3 className="t-mono ocs-title">{t("LocalOcs.title")}</h3>
      <p className="t-mono ocs-hint">{t("LocalOcs.hint")}</p>
      {groups.map((g) => {
        const display = displayOf(g.name);
        return (
          <div className="ocs-group" key={g.name}>
            <div className="t-mono ocs-group-head">
              {t("LocalOcs.group", { name: display })} · {t("LocalOcs.count", { count: g.sessions.length })}
            </div>
            <ul className="ocs-list" aria-label={t("LocalOcs.groupLabel", { name: display })}>
              {g.sessions.map((s) => (
                <OcsRow
                  key={s.addr}
                  session={s}
                  full={g.full}
                  canMention={s.party_name !== undefined && isMentionable(s.party_name)}
                  {...(onMention === undefined ? {} : { onMention })}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
