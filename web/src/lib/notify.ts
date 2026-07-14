import type { MsgFrame } from "@agentparty/shared";

export function isOwnMention(msg: MsgFrame, myHandle: string | null, myName: string | null = null): boolean {
  if (msg.kind !== "message" || msg.retracted) return false;
  const identities = new Set([myHandle, myName].filter((value): value is string => value !== null && value !== ""));
  if (identities.size === 0) return false;
  if (identities.has(msg.sender.name) || (msg.sender.handle !== undefined && identities.has(msg.sender.handle))) return false;
  return msg.mentions.some((mention) => identities.has(mention));
}

export function shouldNotify(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean, myName: string | null = null,
): boolean {
  return permissionGranted && documentHidden && isOwnMention(msg, myHandle, myName);
}

// 页内 toast 判定（Task R5-toast）：与 shouldNotify 互补。
// 差异：① 仅标签页**聚焦**时（!documentHidden）弹——未聚焦交给 shouldNotify 的系统通知；
//       ② 门槛用 optin（铃铛开关），**不需要**浏览器通知授权（页内 toast 纯 DOM，无需 permission）。
// 其余判定（message 类型 / 未撤回 / 非自己发 / 命中 mentions）与 shouldNotify 一致。
export function shouldToast(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, optin: boolean, myName: string | null = null,
): boolean {
  return optin && !documentHidden && isOwnMention(msg, myHandle, myName);
}

export function nextMentionBadgeCount(
  current: number,
  msg: MsgFrame,
  myHandle: string | null,
  documentHidden: boolean,
  myName: string | null = null,
): number {
  return documentHidden && isOwnMention(msg, myHandle, myName) ? current + 1 : current;
}

export function shouldMarkSeen(documentHidden: boolean, stickBottom: boolean): boolean {
  return !documentHidden && stickBottom;
}
