import type { WakeKind } from "@agentparty/shared";
import type { TFunc } from "../i18n/useT";

const KNOWN: ReadonlySet<string> = new Set(["serve", "watch", "daemon", "webhook", "none"]);

/**
 * 模块⑥：唤醒方式给用户看时用人话，不露 serve / watch / daemon / webhook 这些实现名。
 * 数据层（wakeReceipt.detail、DraftMentionStatus.wakeKind）保持原值，只在渲染处过一遍。
 * 未知值原样返回——宁可露一个陌生词，也别把真实状态吞掉。
 */
export function wakeKindLabel(kind: WakeKind | string | null | undefined, t: TFunc): string {
  if (kind === null || kind === undefined || kind === "") return "";
  return KNOWN.has(kind) ? t(`WakeKind.${kind as WakeKind}`) : kind;
}
