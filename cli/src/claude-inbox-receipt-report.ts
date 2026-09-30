// Claude 收件箱回执 → 频道（#1130）。
//
// claude-inbox-receipt.ts 负责在本机拿到回执（held / delivered / expired / …）；这里负责两件事：
//   1. 把它上报到服务端，挂在被 @ 的那条消息上——发信人在网页和 `party history` / `party who` 里看得见，
//      不用再去翻接收端那台机器的 serve 日志；
//   2. 写死「回执对唤醒记账意味着什么」这张表（inboxReceiptWakeEffect），两条注入腿共用。
//
// 记账铁律（docs/cross-session-internals.md §6 的状态机）：@ 欠账只认对方的回复 / ack。
// 回执从不清欠账、从不重放一次注入：
//   - `accepted`（窗口内没有回执）不是已读回执：不上报、不展示、记账与没有回执功能时完全一样；
//   - `held` 证明消息**还没进对话**：不算消费，但也不许再投一次（还扣着呢）；
//   - `expired` / `refused` / `dropped` / `denied` 证明**没送达**：本机的唤醒认领让出来，恰好一次；
//   - `delivered` 证明被扣的消息进了对话——仍然不是 ack；
//   - `unknown`（扣了之后没等到终态）：结局不明，绝不重放，认领留着。
import { inboxReceiptNotDelivered, type InboxReceiptState } from "@agentparty/shared";
import type { InboxReceiptEvent } from "./claude-inbox-receipt";
import { RestError, postInboxReceipt } from "./rest";

/** 回执事件 → 可上报的状态；`accepted` 返回 null（没有回执不是一个状态）。 */
export function inboxReceiptReportState(event: Pick<InboxReceiptEvent, "status">): InboxReceiptState | null {
  return event.status === "accepted" ? null : event.status;
}

/**
 * 回执对本机唤醒记账的效果：
 * - `keep`：认领与进程内去重标记都留着（accepted / held / delivered / unknown）；
 * - `release`：证明没送达——让出认领、撤掉去重标记，让既有的重投路径（重连重放、同身份的别的
 *   runtime、Stop hook 欠账）有机会接手。本模块自己不重投。
 */
export function inboxReceiptWakeEffect(event: Pick<InboxReceiptEvent, "status">): "keep" | "release" {
  const state = inboxReceiptReportState(event);
  return state !== null && inboxReceiptNotDelivered(state) ? "release" : "keep";
}

export interface InboxReceiptRef {
  channel: string;
  seq: number;
  /** 被 @ 的名字（消息 mentions 里的那个）。 */
  target: string;
}

export interface InboxReceiptReporterOptions {
  server: string;
  token: string;
  /** 上报实现（测试注入点）；默认真实 postInboxReceipt。 */
  post?: typeof postInboxReceipt;
  /** 上报失败 / 停报的留痕；默认不打。绝不写 stdout（MCP 的 stdio 通道）。 */
  log?: (line: string) => void;
  /** 同时记着的 (channel, seq, target) 上限；超过淘汰最早的。 */
  seenLimit?: number;
}

export type InboxReceiptReporter = (ref: InboxReceiptRef, event: InboxReceiptEvent) => Promise<void>;

const REPORTER_SEEN_LIMIT = 512;

/**
 * 建一个上报器。纪律：
 * - **一次性**：每个 (channel, seq, target) 至多报一次 `held`、一次终态；重复的事件直接丢。
 * - **不重试、不订阅**：上报本身是一次普通 REST 写，失败就失败（终态上报在服务端可以不经 held
 *   直接落，所以丢一条 held 不会卡住后面的终态）。上报绝不触发新的注入或新的回执订阅。
 * - **旧服务端**：路由不存在（404 且不是「消息不存在」/ 405 / 501）⇒ 本进程此后不再上报，只留一行痕。
 * - **绝不抛错**：回执展示失败不许影响注入与清理。
 */
export function createInboxReceiptReporter(options: InboxReceiptReporterOptions): InboxReceiptReporter {
  const post = options.post ?? postInboxReceipt;
  const log = (line: string) => {
    try {
      options.log?.(line);
    } catch {
      // 留痕失败不影响任何事。
    }
  };
  const limit = Math.max(1, options.seenLimit ?? REPORTER_SEEN_LIMIT);
  /** key → 已报到哪一步。 */
  const seen = new Map<string, "held" | "terminal">();
  let unsupported = false;
  return async (ref, event) => {
    try {
      const state = inboxReceiptReportState(event);
      // `accepted`：没有回执。不上报——落库就会被读成「送达了 / 已读」。
      if (state === null) return;
      if (unsupported) return;
      const key = `${ref.channel}\u0000${ref.seq}\u0000${ref.target}`;
      const previous = seen.get(key);
      if (previous === "terminal") return;
      if (state === "held" && previous === "held") return;
      seen.delete(key);
      seen.set(key, state === "held" ? "held" : "terminal");
      while (seen.size > limit) {
        const oldest = seen.keys().next();
        if (oldest.done === true) break;
        seen.delete(oldest.value);
      }
      await post(options.server, options.token, ref.channel, ref.seq, {
        target: ref.target,
        state,
        ...(event.reason === undefined || event.reason === "" ? {} : { reason: event.reason }),
      });
    } catch (error) {
      if (error instanceof RestError && inboxReceiptRouteMissing(error)) {
        unsupported = true;
        log(
          `inbox receipt: 服务端不支持收件箱回执上报（HTTP ${error.status}）——本进程不再上报，` +
            "回执仍只在本机日志里（升级服务端后重启即恢复）",
        );
        return;
      }
      log(
        `inbox receipt: 上报失败（channel=${ref.channel} seq=${ref.seq} target=${ref.target} ` +
          `status=${event.status}）：${error instanceof Error ? error.message : String(error)}——不重试`,
      );
    }
  };
}

/**
 * 「这台服务端没有这条路由」。新服务端对不存在的**消息**也回 404，但带结构化的 `not_found` 错误码；
 * 旧服务端的路由缺失走框架默认的 404（没有错误码）。405 / 501 同理按不支持处理。
 */
export function inboxReceiptRouteMissing(error: RestError): boolean {
  if (error.status === 405 || error.status === 501) return true;
  return error.status === 404 && error.code !== "not_found";
}
