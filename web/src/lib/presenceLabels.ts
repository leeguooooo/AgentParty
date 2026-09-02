import type { TFunc } from "../i18n/useT";
import "../i18n/strings/PresenceLabels";

const STATES: ReadonlySet<string> = new Set(["working", "waiting", "blocked", "done", "offline"]);
const RESIDENCIES: ReadonlySet<string> = new Set([
  "supervised", "daemon", "webhook", "episodic", "bare", "human_driven", "mixed", "unknown",
]);
const LEASES: ReadonlySet<string> = new Set(["active", "stale"]);

/**
 * 模块⑧：presence 原始枚举 → 人话。未知值原样返回（宁可露一个陌生词，也别吞掉真实状态）。
 * 与 wakeKindLabel（模块⑥）同一思路：数据层、CSS class 用原值，只在文案处过一遍。
 */
export function presenceStateLabel(state: string | null | undefined, t: TFunc): string {
  if (!state) return "";
  return STATES.has(state) ? t(`PresenceLabel.state.${state}`) : state;
}

export function residencyLabel(residency: string | null | undefined, t: TFunc): string {
  if (!residency) return "";
  return RESIDENCIES.has(residency) ? t(`PresenceLabel.residency.${residency}`) : residency;
}

export function hostLeaseLabel(lease: string | null | undefined, t: TFunc): string {
  if (!lease) return "";
  return LEASES.has(lease) ? t(`PresenceLabel.lease.${lease}`) : lease;
}
