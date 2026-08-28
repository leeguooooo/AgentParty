// 网页「让 agent 加入」分步引导（#1005）的判据——全部纯函数，只吃服务端下发的真实数据
// （presence 帧 / 历史帧），不做任何本地猜测。组件（AgentJoin）只负责渲染这里给出的结论。
//
//   ② 报到   = 该身份在频道里出现过报到消息（sender.name 命中且晚于引导开始），或 presence 里出现
//              过它、且是引导开始之后的活动（state != offline / live / last_seen 晚于开始）。
//   ③ 可唤醒 = presence 显示该身份 live（有活连接或新鲜）且可被 @ 唤醒——与 CLI `party who` 同一口径
//              （shared 的 autoWakeReachable + wakeableState）；蛰伏档（human_driven / 无 wake layer）不算。
//   ④ 回帖   = 频道里出现该身份对测试 @ 的回帖（reply_to = 探针 seq，或探针之后它发的任意一条）；
//              超时按 presence 分层定位（服务端已投递 / 本机未收到 / 模型未回），与 CLI 第 4 步一致。
import type { MsgFrame, PresenceEntry } from "@agentparty/shared";
import { autoWakeReachable, presenceLastSeen, wakeableState } from "@agentparty/shared";

export interface CheckinEvidence {
  /** 报到消息的 seq；只有 presence 证据、没看到消息时为 null。 */
  seq: number | null;
  /** 证据时刻（消息 ts / presence last_seen）。 */
  ts: number;
}

function presenceOf(presence: readonly PresenceEntry[], name: string): PresenceEntry | null {
  return presence.find((p) => p.name === name) ?? null;
}

/**
 * 第 ② 步：报到证据。sinceTs = 引导开始（铸 token / 打开恢复引导）的时刻——铸出来但从没接入过的
 * 身份也可能在 presence 里留一条 offline 旧行，所以只认引导开始之后的活动。
 */
export function checkinEvidence(
  messages: readonly MsgFrame[],
  presence: readonly PresenceEntry[],
  name: string,
  sinceTs: number,
): CheckinEvidence | null {
  let best: CheckinEvidence | null = null;
  for (const m of messages) {
    if (m.sender.name !== name || m.ts < sinceTs) continue;
    if (best === null || (best.seq !== null && m.seq < best.seq)) best = { seq: m.seq, ts: m.ts };
  }
  if (best !== null) return best;
  const entry = presenceOf(presence, name);
  if (entry === null) return null;
  const seen = presenceLastSeen(entry);
  // live=true 是服务端当场判定的活连接，免检；其余在线态（away/busy 之类的陈旧行）必须晚于引导开始，
  // 否则 recover 形态下一条很旧的 away 行会让 ② 立刻打勾、让人以为重连成功了（coderabbit on #1006）。
  if (entry.live === true) return { seq: null, ts: seen ?? sinceTs };
  if (seen !== null && seen >= sinceTs) return { seq: null, ts: seen };
  return null;
}

export interface WakeableEvidence {
  /** 唤醒层种类（serve / watch / webhook / daemon）。 */
  kind: string;
  /** 服务端是否已亲自验证过它能被唤醒（wake.verified_at 由 DO 盖）。 */
  verified: boolean;
  live: boolean;
}

/**
 * 第 ③ 步：live 且可被 @ 唤醒。三个条件缺一不可：
 *  - 在线：state != offline 或 DO 判定有活连接（live）；
 *  - 可达：autoWakeReachable——serve/watch/daemon 需 live 或新鲜，webhook 恒可达，human_driven 恒不可达；
 *  - 有唤醒层：wakeableState != offline（wake.kind 存在且非 none）。
 */
export function wakeableEvidence(
  presence: readonly PresenceEntry[],
  name: string,
  now: number,
): WakeableEvidence | null {
  const entry = presenceOf(presence, name);
  if (entry === null) return null;
  const live = entry.live === true;
  const online = entry.state !== "offline" || live;
  if (!online) return null;
  if (!autoWakeReachable(entry, now)) return null;
  const wstate = wakeableState(entry, now);
  if (wstate === "offline") return null;
  return { kind: entry.wake?.kind ?? "unknown", verified: wstate === "wakeable_verified", live };
}

/** 探针（弹窗里以当前用户身份发出的那条 `@name ping`）。 */
export interface VerifyProbe {
  /** 发出探针时本地已见的最大 seq；探针本身与回帖都必然大于它。 */
  baselineSeq: number;
  sentAt: number;
  body: string;
}

/** 在历史里找到探针自己的 seq（服务端接受即「已投递」）；还没落地 → null。 */
export function findProbeSeq(messages: readonly MsgFrame[], probe: VerifyProbe): number | null {
  for (const m of messages) {
    if (m.seq > probe.baselineSeq && m.sender.kind !== "agent" && m.body === probe.body) return m.seq;
  }
  return null;
}

export interface ReplyEvidence {
  seq: number;
  ts: number;
  /** 从探针发出到回帖落地的耗时（ms）。 */
  elapsedMs: number;
}

/** 第 ④ 步：该身份对探针的回帖——reply_to 指向探针，或探针之后它发的任意一条（30s 窗口由调用方控制）。 */
export function replyEvidence(
  messages: readonly MsgFrame[],
  name: string,
  probe: VerifyProbe,
  probeSeq: number | null,
): ReplyEvidence | null {
  let best: ReplyEvidence | null = null;
  for (const m of messages) {
    if (m.sender.name !== name) continue;
    const linked = probeSeq !== null && m.reply_to === probeSeq;
    const after = m.seq > (probeSeq ?? probe.baselineSeq) && m.ts >= probe.sentAt;
    if (!linked && !after) continue;
    if (best === null || m.seq < best.seq) best = { seq: m.seq, ts: m.ts, elapsedMs: Math.max(0, m.ts - probe.sentAt) };
  }
  return best;
}

/**
 * 第 ④ 步超时的分层定位（与 CLI `party wake verify` 同口径，#603/#689）：
 *  - not_delivered：探针没进历史（服务端没接受）。
 *  - wake_pending：presence.current_task 就是探针 seq——唤醒确凿、模型还在处理（headless 可能要数分钟）。
 *  - runner_failing：runner_health 报连败——唤醒了但起不来，修 runner 环境。
 *  - not_listening：listening=deaf/suspect 或没有活连接——服务端已投递、本机没在收。
 *  - no_reply：服务端已投递、本机连接活着、模型没回。
 */
export type VerifyTimeoutTier = "not_delivered" | "wake_pending" | "runner_failing" | "not_listening" | "no_reply";

export function verifyTimeoutTier(
  presence: readonly PresenceEntry[],
  name: string,
  probeSeq: number | null,
): VerifyTimeoutTier {
  if (probeSeq === null) return "not_delivered";
  const entry = presenceOf(presence, name);
  if (entry === null) return "not_listening";
  if (entry.current_task === probeSeq) return "wake_pending";
  const health = entry.runner_health;
  if (health !== undefined && !health.ok) return "runner_failing";
  if (entry.listening === "deaf" || entry.listening === "suspect") return "not_listening";
  const live = entry.live === true || entry.state !== "offline";
  return live ? "no_reply" : "not_listening";
}

export type StepId = 1 | 2 | 3 | 4;
export type StepStatus = "done" | "active" | "pending";

/** 四步的展示状态：前面的没过，后面的一律 pending；① 与 ② 同时亮，② 过了 ① 一起打勾（报到即证明装了）。 */
export function stepStatuses(input: { checkin: boolean; wakeable: boolean; verified: boolean }): Record<StepId, StepStatus> {
  const { checkin, wakeable, verified } = input;
  return {
    1: checkin ? "done" : "active",
    2: checkin ? "done" : "active",
    3: !checkin ? "pending" : wakeable ? "done" : "active",
    4: !checkin || !wakeable ? "pending" : verified ? "done" : "active",
  };
}

/** 最大已知 seq（探针基线）。 */
export function maxSeq(messages: readonly MsgFrame[]): number {
  let max = 0;
  for (const m of messages) if (m.seq > max) max = m.seq;
  return max;
}
