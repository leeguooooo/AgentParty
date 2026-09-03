import { type ReactNode, useEffect, useRef } from "react";
import { useT } from "../../i18n/useT";

/**
 * 团队面板外壳（#1060 PR B）：一个标题 + 关闭按钮 + 单一内容区 + 可切入的成员详情。
 * 取代 #504 的「博客风两页签」TeamTabs——成员与工作不再分页，看板一屏看完。
 * class 名沿用 team-blog-*：焦点陷阱、路由测试与样式都认这些名字。
 */
export interface TeamShellProps {
  children: ReactNode;
  detail?: ReactNode;
  detailBackLabel?: string;
  onBackFromDetail?: () => void;
  onClose?: () => void;
  closeDisabled?: boolean;
}

export function TeamShell({
  children,
  detail,
  detailBackLabel = "Back",
  onBackFromDetail,
  onClose,
  closeDisabled = false,
}: TeamShellProps) {
  const t = useT();
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const showingDetail = detail !== undefined && detail !== null;
  const detailWasOpenRef = useRef(false);
  // 进详情把焦点放到「返回」上；出详情把焦点还给面板容器，别让焦点掉到 body。
  const rootRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!detailWasOpenRef.current && showingDetail) {
      detailBackRef.current?.focus();
    } else if (detailWasOpenRef.current && !showingDetail) {
      rootRef.current?.querySelector<HTMLElement>(".team-board")?.focus();
    }
    detailWasOpenRef.current = showingDetail;
  }, [showingDetail]);

  return (
    <section ref={rootRef} className="team-blog team-shell" aria-label={t("Channel.tools.team")}>
      <header className="team-blog-head team-shell-head">
        {onClose !== undefined && (
          <button
            type="button"
            className="d-btn team-blog-close"
            disabled={closeDisabled}
            onClick={() => {
              if (!closeDisabled) onClose();
            }}
          >
            {t("Channel.tools.close")} ✕
          </button>
        )}
      </header>
      <div className="team-blog-panel team-shell-body" hidden={showingDetail}>
        {children}
      </div>
      {showingDetail && (
        <div className="team-blog-panel team-blog-detail">
          <button ref={detailBackRef} type="button" className="d-btn team-blog-detail-back" onClick={onBackFromDetail}>
            ← {detailBackLabel}
          </button>
          {detail}
        </div>
      )}
    </section>
  );
}
