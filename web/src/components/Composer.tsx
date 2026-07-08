// 底部插话框：Markdown、@name mention（动态在线列表补全，issue #39）、Cmd/Ctrl+Enter 发送（spec §9 第 4 块）。
// readonly / archived 时由页面层直接不渲染本组件（错误内联为条幅）。
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, KeyboardEvent } from "react";
import { agentHue } from "../lib/agentColor";
import {
  activeMentionQuery,
  filterCandidates,
  type MentionCandidate,
  type MentionTier,
} from "../lib/mentions";

interface Props {
  draft: string;
  setDraft(value: string): void;
  onSend(): void;
  ready: boolean; // ws open 才能发
  candidates: MentionCandidate[]; // @ 补全候选（participants ∪ presence，已分档排序）
}

const TIER_LABEL: Record<MentionTier, string> = { online: "在线", wakeable: "可唤醒", recent: "最近" };
const TIER_DOT: Record<MentionTier, string> = { online: "●", wakeable: "◐", recent: "○" };

export function Composer({ draft, setDraft, onSend, ready, candidates }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [menu, setMenu] = useState<{ start: number; items: MentionCandidate[]; active: number } | null>(null);

  // 光标处是否在打 @<prefix> → 算候选菜单
  const recompute = useCallback(
    (text: string, caret: number) => {
      const q = activeMentionQuery(text, caret);
      if (q === null) {
        setMenu(null);
        return;
      }
      const items = filterCandidates(candidates, q.query);
      setMenu(items.length > 0 ? { start: q.start, items, active: 0 } : null);
    },
    [candidates],
  );

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  // 选中候选：把 @<query> 替换成 @<name> + 空格，光标移到其后
  const choose = useCallback(
    (cand: MentionCandidate) => {
      const ta = taRef.current;
      if (ta === null || menu === null) return;
      const caret = ta.selectionStart ?? draft.length;
      const before = draft.slice(0, menu.start);
      const after = draft.slice(caret);
      const inserted = `@${cand.name} `;
      const next = before + inserted + after;
      setDraft(next);
      setMenu(null);
      const pos = before.length + inserted.length;
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(pos, pos);
      });
    },
    [draft, menu, setDraft],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu !== null) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenu({ ...menu, active: (menu.active + 1) % menu.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenu({ ...menu, active: (menu.active - 1 + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(menu.items[menu.active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="composer">
      {menu !== null && (
        <ul className="mention-menu" role="listbox" aria-label="mention suggestions">
          {menu.items.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === menu.active}
              className={"mention-item" + (i === menu.active ? " is-active" : "")}
              style={{ "--ah": agentHue(c.name) } as CSSProperties}
              // hover 看「是谁 + 职责」：显示名 + 账号 + 协作角色（issue #38/#39）
              title={
                [c.display, c.account && c.account !== c.display ? c.account : "", c.role ? `职责: ${c.role}` : ""]
                  .filter(Boolean)
                  .join(" · ")
              }
              onMouseDown={(e) => {
                e.preventDefault();
                choose(c);
              }}
            >
              <span className="mention-dot" aria-hidden="true" />
              <span className="mention-name t-mono">{c.display}</span>
              {c.role && <span className="mention-role">{c.role}</span>}
              <span className={`mention-tier mention-tier--${c.tier}`}>
                {TIER_DOT[c.tier]} {TIER_LABEL[c.tier]}
              </span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={taRef}
        className="composer-input t-mono"
        rows={3}
        placeholder="chime in… markdown ok · @name to mention · ⌘⏎ to send"
        value={draft}
        onChange={onChange}
        onKeyUp={(e) => recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onClick={(e) => recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setMenu(null), 120)}
      />
      <button
        type="button"
        className="d-btn d-btn--primary composer-send"
        onClick={onSend}
        disabled={!ready || draft.trim() === ""}
        title={ready ? "send (⌘⏎)" : "connecting…"}
      >
        send
      </button>
    </div>
  );
}
