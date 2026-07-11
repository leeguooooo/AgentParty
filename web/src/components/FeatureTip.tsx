// 功能级 tips 引导（#145）。一个轻量、可复用的 hover/focus 提示：在功能旁放一个「?」小圆点，
// 指上去（或键盘聚焦）弹出一句话解释「这个按钮/区域是干嘛的」。和 #146 的首次总览浮层是两回事——
// 那个是一次性四步总览，这个是常驻在具体控件旁、按需查看、不落任何持久化标记（不造新机制）。
// 复用现成没有可用的 tooltip 组件（仓库里只有零散的原生 title= 和 PresenceBar 的专用 popover），
// 所以在这里落一个可复用的。文案走 i18n（strings/Tips.ts），en/zh 双语。
import { useId } from "react";
import { useT } from "../i18n/useT";
import "../i18n/strings/Tips";

interface Props {
  tip: string; // i18n key，对应 strings/Tips.ts 里的一条文案
  className?: string; // 可选：调用处微调定位
}

export function FeatureTip({ tip, className }: Props) {
  const t = useT();
  const bubbleId = useId();
  return (
    <span className={"feature-tip" + (className ? " " + className : "")}>
      <button
        type="button"
        className="feature-tip-dot"
        aria-label={t("Tips.ariaHelp")}
        aria-describedby={bubbleId}
      >
        ?
      </button>
      <span className="feature-tip-bubble t-mono" role="tooltip" id={bubbleId}>
        {t(tip)}
      </span>
    </span>
  );
}
