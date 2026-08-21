// #919：403 的真实原因过去被前端一句本地文案盖掉（建频道撞配额，UI 却说「需人类账号登录」），
// 用户被导向一个根本不存在的问题。这里是所有 403 渲染的共同规则：
//   1) 服务端给了 code → 渲染这个 code 对应的、可执行的中文文案，并把服务端原文作为 detail 附上；
//   2) 服务端只给了 message → 至少把 message 透出来，不许用本地兜底盖掉；
//   3) 什么都没有 → 才用调用方的兜底 key。
import type { TFunc } from "../i18n/useT";
import { ForbiddenError } from "./api";
import "../i18n/strings/Forbidden";

// 有专属文案的 code。其余 code 走「透出服务端原文」这条通用路径。
const CODE_KEYS: Record<string, string> = {
  quota_exceeded: "Forbidden.quotaExceeded",
  unauthorized: "Forbidden.readonly",
};

export function forbiddenText(err: unknown, t: TFunc, fallbackKey: string): string {
  if (!(err instanceof ForbiddenError)) return t(fallbackKey);
  const detail = err.serverMessage;
  const key = err.code === null ? undefined : CODE_KEYS[err.code];
  if (key !== undefined) return t(key, { detail: detail ?? "" });
  // channel-scoped token 在服务端复用了通用的 forbidden code，只有 message 能区分。
  if (detail !== null && detail.includes("channel-scoped token")) {
    return t("Forbidden.scopedToken", { detail });
  }
  if (detail !== null && detail !== "") return t("Forbidden.withDetail", { detail });
  return t(fallbackKey);
}
