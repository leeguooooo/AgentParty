import type { MsgFrame } from "@agentparty/shared";

export function shouldNotify(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, permissionGranted: boolean,
): boolean {
  if (!permissionGranted || !documentHidden || myHandle === null) return false;
  if (msg.kind !== "message" || msg.retracted) return false;
  if (msg.sender.handle === myHandle) return false; // 自己发的
  return msg.mentions.includes(myHandle);
}

// 页内 toast 判定（Task R5-toast）：与 shouldNotify 互补。
// 差异：① 仅标签页**聚焦**时（!documentHidden）弹——未聚焦交给 shouldNotify 的系统通知；
//       ② 门槛用 optin（铃铛开关），**不需要**浏览器通知授权（页内 toast 纯 DOM，无需 permission）。
// 其余判定（message 类型 / 未撤回 / 非自己发 / 命中 mentions）与 shouldNotify 一致。
export function shouldToast(
  msg: MsgFrame, myHandle: string | null, documentHidden: boolean, optin: boolean,
): boolean {
  if (!optin || documentHidden || myHandle === null) return false;
  if (msg.kind !== "message" || msg.retracted) return false;
  if (msg.sender.handle === myHandle) return false; // 自己发的
  return msg.mentions.includes(myHandle);
}
