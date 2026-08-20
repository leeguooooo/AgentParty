import type { MsgFrame } from "@agentparty/shared";

export function isOwnMention(msg: MsgFrame, myHandle: string | null, myName: string | null = null): boolean {
  if (msg.kind !== "message" || msg.retracted) return false;
  const identities = new Set([myHandle, myName].filter((value): value is string => value !== null && value !== ""));
  if (identities.size === 0) return false;
  if (identities.has(msg.sender.name) || (msg.sender.handle !== undefined && identities.has(msg.sender.handle))) return false;
  return msg.mentions.some((mention) => identities.has(mention));
}

/**
 * 提醒新鲜度上限（#861）。超过这个年龄的帧一律不弹通知/toast/角标。
 *
 * 取 5 分钟的理由：live 帧从服务端 ts 到客户端 onFrame 之间只有网络往返 + 时钟偏差；
 * 唯一合法的滞后来自断线重连，而 ws.ts 的退避上限是 30s（BACKOFF_MAX_MS），
 * 加上握手探测最坏也只有几十秒。5 分钟给了 ~10× 余量——短暂掉线期间真正错过的 @
 * 仍然照弹（用户想要），但比本 issue 里那条 10 天前的老 @ 小三个数量级，
 * 足以把「历史重放冒充 live」整类问题挡在门外，且不依赖服务端是否已上线 replay 标记。
 */
export const MENTION_ALERT_MAX_AGE_MS = 5 * 60_000;

/**
 * 这一帧是否值得当作「刚发生的事」去打扰用户（#861）。两道判据：
 * ① 服务端 hello 补拉标记 replay:true 的帧一律不提醒——那是重放的历史，不是新消息；
 * ② 新鲜度兜底：帧自身 ts 太旧就不提醒，覆盖「服务端还没上线 replay 标记」「客户端游标被
 *    重新播种成 0 导致全量重放」等所有让老帧走 live 通路的情况。
 * ts 缺失/非有限值时按新鲜处理，避免旧服务端的帧被整体静音。
 */
export function isFreshDelivery(msg: MsgFrame, now: number = Date.now(), maxAgeMs = MENTION_ALERT_MAX_AGE_MS): boolean {
  if (msg.replay === true) return false;
  if (!Number.isFinite(msg.ts)) return true;
  return now - msg.ts <= maxAgeMs;
}

export function shouldNotify(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean, myName: string | null = null,
  now: number = Date.now(),
): boolean {
  return permissionGranted && documentHidden && isFreshDelivery(msg, now) && isOwnMention(msg, myHandle, myName);
}

// 页内 toast 判定（Task R5-toast）：与 shouldNotify 互补。
// 差异：① 仅标签页**聚焦**时（!documentHidden）弹——未聚焦交给 shouldNotify 的系统通知；
//       ② 门槛用 optin（铃铛开关），**不需要**浏览器通知授权（页内 toast 纯 DOM，无需 permission）。
// 其余判定（message 类型 / 未撤回 / 非自己发 / 命中 mentions）与 shouldNotify 一致。
export function shouldToast(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, optin: boolean, myName: string | null = null,
  now: number = Date.now(),
): boolean {
  return optin && !documentHidden && isFreshDelivery(msg, now) && isOwnMention(msg, myHandle, myName);
}

export function nextMentionBadgeCount(
  current: number,
  msg: MsgFrame,
  myHandle: string | null,
  documentHidden: boolean,
  myName: string | null = null,
  now: number = Date.now(),
): number {
  return documentHidden && isFreshDelivery(msg, now) && isOwnMention(msg, myHandle, myName) ? current + 1 : current;
}

export function shouldMarkSeen(documentHidden: boolean, stickBottom: boolean): boolean {
  return !documentHidden && stickBottom;
}
