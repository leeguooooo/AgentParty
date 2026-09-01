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

/**
 * 引导开始时的**服务端量**快照。判据一律拿服务端量比服务端量（seq / last_seen / verified_at），
 * 绝不拿浏览器 Date.now() 去比服务端时钟盖的时间戳——两边时钟差几秒，② 就会永远不打勾（浏览器快）
 * 或让陈旧行冒充新活动（浏览器慢）。浏览器时钟只用于显示相对时间（relativeAge 已 clamp 负值）。
 */
export interface JoinBaseline {
  /** true = 该身份本来就有历史（recover），只认严格更新的活动；false = 刚铸出来的新身份，它的任何一条消息都算。 */
  strict: boolean;
  /** 打开时频道已知的最大 seq。strict 且为 null ⇒ 历史还没加载出来，先不认消息证据。 */
  seq: number | null;
  /** 打开时该身份 presence 的 last_seen（服务端时钟）。 */
  seen: number | null;
  /** 打开时该身份的 wake.verified_at（服务端时钟）。 */
  verifiedAt: number | null;
}

/** 打开引导（或从「继续接入」回到引导）时拍一张服务端量的快照。 */
export function joinBaseline(
  messages: readonly MsgFrame[],
  presence: readonly PresenceEntry[],
  name: string,
  strict: boolean,
): JoinBaseline {
  const entry = presenceOf(presence, name);
  const known = maxSeq(messages);
  return {
    strict,
    seq: known === 0 ? null : known,
    seen: entry === null ? null : presenceLastSeen(entry),
    verifiedAt: typeof entry?.wake?.verified_at === "number" ? entry.wake.verified_at : null,
  };
}

/** 这条消息是否算「引导开始之后的新活动」——比 seq（服务端单调），不比时间。 */
function afterBaseline(seq: number, baseline: JoinBaseline): boolean {
  if (!baseline.strict) return true;
  return baseline.seq !== null && seq > baseline.seq;
}

/**
 * #1028：打开引导那一刻没拿到 presence 读数时，把**第一次**看到的读数收作基线。
 *
 * 单纯拒绝 `baseline.seen === null` 会带来新问题：确实没有旧行的身份后来真的重连了、
 * 但没有 live=true（例如 serve 那条腿），引导会永远停在第 ② 步。收作基线两头都对：
 * 那条三天前的旧行只当起点、不算证据；此后任何更新的读数才算重新接上。
 *
 * 返回 null 表示无需改动，调用方保留原基线。
 */
export function adoptBaselineSeen(
  baseline: JoinBaseline,
  presence: readonly PresenceEntry[],
  name: string,
): JoinBaseline | null {
  if (!baseline.strict || baseline.seen !== null) return null;
  const entry = presenceOf(presence, name);
  if (entry === null) return null;
  const seen = presenceLastSeen(entry);
  return seen === null ? null : { ...baseline, seen };
}

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
  baseline: JoinBaseline,
): CheckinEvidence | null {
  let best: CheckinEvidence | null = null;
  for (const m of messages) {
    if (m.sender.name !== name || !afterBaseline(m.seq, baseline)) continue;
    if (best === null || (best.seq !== null && m.seq < best.seq)) best = { seq: m.seq, ts: m.ts };
  }
  if (best !== null) return best;
  const entry = presenceOf(presence, name);
  if (entry === null) return null;
  const seen = presenceLastSeen(entry);
  // live=true 是服务端当场判定的活连接（不含任何时间比较），直接算数。
  if (entry.live === true) return { seq: null, ts: seen ?? entry.ts };
  // 其余在线/离线态只看 last_seen 是否比**打开时那一刻的 last_seen** 更新——服务端量对服务端量，
  // 不受浏览器时钟影响；recover 下那条陈旧 away 行的 last_seen 不会变，所以不会冒充重连成功。
  if (seen === null) return null;
  if (!baseline.strict) return { seq: null, ts: seen };
  // #1028：`baseline.seen === null` 是「打开引导那一刻还没拿到读数」，不是「随便什么读数都算」。
  // 原来把它当成后者，于是 presence 刷新后带回的一条**三天前**的离线行会被判成「刚刚重新接上」
  // （owner 实测：第 ② 步 ✓ 依据是「已报到（4637 分钟前）」，随后第 ③ 步的命令根本跑不通）。
  //
  // 没有可比基线时只能等：要么等消息 seq（服务端单调量），要么等 live=true（服务端当场判活连接）。
  // 刻意不拿浏览器时钟去和服务端 last_seen 比——那是 #1005 已经排除掉的做法。
  if (baseline.seen === null) return null;
  return seen > baseline.seen ? { seq: null, ts: seen } : null;
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

/**
 * ④ 的另一条通路：agent 自己跑 `party wake verify`（#996 的 `[wake-verify]` 帧对），
 * 或服务端亲自盖过新的 wake.verified_at。同样只比服务端量：verified_at 与打开时的快照比，
 * 帧对按 seq 过基线。
 */
export function selfVerifiedEvidence(
  messages: readonly MsgFrame[],
  presence: readonly PresenceEntry[],
  name: string,
  baseline: JoinBaseline,
  verifyPrefix: string,
): boolean {
  const entry = presenceOf(presence, name);
  const verifiedAt = entry?.wake?.verified_at;
  if (typeof verifiedAt === "number" && (baseline.verifiedAt === null || verifiedAt > baseline.verifiedAt)) return true;
  const frames = messages.filter((m) => m.sender.name === name && afterBaseline(m.seq, baseline));
  const probes = new Set(frames.filter((m) => m.body.startsWith(verifyPrefix)).map((m) => m.seq));
  return frames.some((m) => m.reply_to !== null && probes.has(m.reply_to));
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
