// codex 前台唤醒层（issue #899）——在**用户眼前那个会话**里唤醒，不是后台新 runner。
//
// 为什么要有这一层（#897 的方向纠正）：#893 的自动唤醒层确实能把 @ 接住，但它拉起的是
// `party serve --runner codex` 下的一个**新 runner 会话**。owner 原话：「从头到尾没出现过
// 我们的通讯记录」——消息没丢，但他在自己的界面里什么也看不见。
//
// 突破口：codex 的 Stop hook 可以 block 并让会话**继续跑一轮**。turn 结束时判断该身份在
// 频道上有没有还没处理的 @，有就 block，把一条 ≤512B 的 channel+seq 指针交回给会话——
// 正文仍然去频道读，「频道是唯一数据源」不因这条提示而破。
//
// ⚠️ 契约以本机 codex 0.145.0 **实测**为准，不是从二进制字符串反推的（#899 issue 正文里
// 那份反推契约有两处是错的，照抄会静默失效）：
//
//   ① `stop.command.output` 的 JSON Schema 是 `additionalProperties: false`，字段只有
//      `continue / decision / reason / stopReason / suppressOutput / systemMessage`——
//      **没有 `prompt`**。实测多带一个 `prompt` 字段，codex 直接判 `hook: Stop Failed`，
//      整个输出被丢弃、block 不生效、会话照常停止。注入用的 prompt 就是 `reason` 本身。
//   ② `stop.command.input` 的字段是
//      `cwd / hook_event_name / last_assistant_message / model / permission_mode /
//       session_id / stop_hook_active / transcript_path / turn_id`——
//      没有 `agent_id / agent_type / agent_transcript_path / reason`（那几个是 SubagentStop）。
//
// 实测确认的两条行为（决定了下面的防循环设计）：
//   - `{"decision":"block","reason":"…"}` 让会话继续跑一轮，模型把 `reason` 当 prompt 执行；
//   - **codex 自己不封顶**：连续 4 次无条件 block，它就老老实实跑了 4 轮。
//     `stop_hook_active` 从第 2 次起恒为 true，但 codex **不会**因此拒绝 block。
//     ⇒ 防循环 100% 是我们的责任，漏一层就是「会话永远停不下来」。
//
// 三道防循环闸（任意一道成立就放行，放行＝不 block、让会话正常停止）：
//   1. `stop_hook_active === true` → 放行。这把每个用户 turn 的注入次数硬顶在 1 次。
//   2. 同一 seq 只注入一次，seen 集合**落盘**——Stop hook 每轮是一个全新进程，内存集合等于没有。
//   3. 任何一步取不到信号/抛异常 → 放行。hook 铁律优先于唤醒。
//
// 预算（本机 hooks.json 实测 timeout=10）：本模块**全程零网络**，只做同步读盘。
// 唯一的信号源是 serve/watch 已经落在本地的欠账（StuckWake），网络那一跳早就由它们付过了。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import type { StuckWake } from "./config";

/** seen 集合的落盘目录，与 #893 的 marker 目录并列。 */
export const CODEX_STOP_WAKE_SEEN_DIR = "codex-stop-wake";
/** 每个身份+频道最多记住多少个已注入过的 seq。有界，绝不无限长。 */
export const CODEX_STOP_WAKE_SEEN_CAPACITY = 64;
/** 注入正文的硬上限——和 #841 的唤醒通知同一预算。 */
export const CODEX_STOP_WAKE_REASON_MAX_BYTES = 512;
/**
 * 超过这个岁数的欠账不再叫醒任何人（与 watch 的 WATCH_WAKE_DEBT_MAX_AGE_MS 同义）：
 * 几天前早就在别处处理过的 @，不该在用户今天的会话里跳出来。
 */
export const CODEX_STOP_WAKE_DEBT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 交回给会话的指针：只有 channel+seq，正文永远去频道读。 */
export interface CodexStopWakePointer {
  channel: string;
  seq: number;
}

export function codexStopWakeSeenPath(home: string, target: string): string {
  return join(home, CODEX_STOP_WAKE_SEEN_DIR, `${target.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

/** 读已注入过的 seq 集合。文件坏了/不存在都当空集——读不到只会多注入一次，不会卡死会话。 */
export function readCodexStopWakeSeen(path: string): number[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const seqs = value.seqs;
    if (!Array.isArray(seqs)) return [];
    return seqs.filter((seq): seq is number =>
      typeof seq === "number" && Number.isFinite(seq) && seq > 0
    );
  } catch {
    return [];
  }
}

export function hasCodexStopWakeSeen(seen: readonly number[], seq: number): boolean {
  return seen.includes(seq);
}

/** 追加一个已注入的 seq 并截断到容量上限（保留最新的 N 个）。纯函数，便于单测。 */
export function appendCodexStopWakeSeen(
  seen: readonly number[],
  seq: number,
  capacity: number = CODEX_STOP_WAKE_SEEN_CAPACITY,
): number[] {
  const next = seen.includes(seq) ? [...seen] : [...seen, seq];
  return next.length <= capacity ? next : next.slice(next.length - capacity);
}

/**
 * 落盘「这条 seq 我注入过了」。**必须在打印 block 之前调用**：
 * 先打印再落盘的话，中间崩一次就会对同一条 @ 反复注入。
 */
export function recordCodexStopWakeSeen(
  path: string,
  seq: number,
  capacity: number = CODEX_STOP_WAKE_SEEN_CAPACITY,
): void {
  atomicWriteJson(path, {
    version: 1,
    seqs: appendCodexStopWakeSeen(readCodexStopWakeSeen(path), seq, capacity),
  });
}

function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = text;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * block 时交回会话的 `reason`——它同时是给用户看的说明**和**注入给模型的 prompt
 * （契约只有这一个字段，见文件头 ①）。所以措辞要同时满足两件事：
 *   - 用户一眼看出是 AgentParty 在唤醒他，而不是模型自己不肯停；
 *   - 模型知道正文要去频道读，不许照着这条提示编内容。
 */
export function codexStopWakeReason(pointer: CodexStopWakePointer): string {
  return clampUtf8(
    `[AgentParty] 频道 #${pointer.channel} 有一条 @ 你的消息还没处理（seq ${pointer.seq}）。` +
      `请先执行 \`party history ${pointer.channel} --since ${Math.max(0, pointer.seq - 1)}\` 读到正文，` +
      `再按正文内容处理并用 \`party send\` 回到该频道。` +
      `频道是唯一数据源：这条提示只给了指针，不要凭它猜测消息内容。处理完正常结束本轮即可。`,
    CODEX_STOP_WAKE_REASON_MAX_BYTES,
  );
}

export type CodexStopWakeSkip =
  | "not_stop"
  | "continuation"
  | "disabled"
  | "no_channel"
  | "no_pending"
  | "stale_debt"
  | "already_woken";

export type CodexStopWakeDecision =
  | { wake: false; skip: CodexStopWakeSkip }
  | { wake: true; pointer: CodexStopWakePointer };

export interface CodexStopWakeInput {
  /** codex 递进来的原始 Stop payload。 */
  payload: Record<string, unknown>;
  /** 本 cwd 绑定的频道；没绑定为 null。 */
  channel: string | null;
  /** #893 的开关：显式 off 时前台这层也一起关（同一个「别自动打扰我」的意思）。 */
  enabled: boolean;
  /** serve/watch 落在本地的欠账；没有为 null。 */
  stuck: Pick<StuckWake, "seq" | "first_wake_ts"> | null;
  /** 本频道游标：说到哪条为止已经了结了。 */
  cursor: number;
  /** 已注入过的 seq 集合。 */
  seen: readonly number[];
  now: number;
}

/**
 * 纯判定：这一次 Stop 该不该 block。
 *
 * 顺序即优先级——最便宜、最致命的闸放在最前面。`stop_hook_active` 尤其不能后移：
 * 它是唯一能保证「一个用户 turn 最多注入一次」的硬顶（实测 codex 自己不封顶）。
 */
export function decideCodexStopWake(input: CodexStopWakeInput): CodexStopWakeDecision {
  const { payload } = input;
  if (payload.hook_event_name !== "Stop") return { wake: false, skip: "not_stop" };
  // 防循环第 1 闸。注意只认严格的 `false`：字段缺失/类型不对一律当「可能是续跑」放行，
  // 宁可漏叫一次，也绝不冒「会话永远停不下来」的险。
  if (payload.stop_hook_active !== false) return { wake: false, skip: "continuation" };
  if (!input.enabled) return { wake: false, skip: "disabled" };
  if (input.channel === null || input.channel === "") return { wake: false, skip: "no_channel" };
  const stuck = input.stuck;
  if (stuck === null || !Number.isFinite(stuck.seq) || stuck.seq <= 0) {
    return { wake: false, skip: "no_pending" };
  }
  // 游标说「这条我已经了结了」——了结过的不再叫。
  if (stuck.seq <= input.cursor) return { wake: false, skip: "no_pending" };
  if (
    typeof stuck.first_wake_ts === "number" &&
    Number.isFinite(stuck.first_wake_ts) &&
    input.now - stuck.first_wake_ts > CODEX_STOP_WAKE_DEBT_MAX_AGE_MS
  ) {
    return { wake: false, skip: "stale_debt" };
  }
  // 防循环第 2 闸：同一条 @ 只注入一次。seen 是落盘的，跨进程有效。
  if (hasCodexStopWakeSeen(input.seen, stuck.seq)) return { wake: false, skip: "already_woken" };
  return { wake: true, pointer: { channel: input.channel, seq: stuck.seq } };
}
