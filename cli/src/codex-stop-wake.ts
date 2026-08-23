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
// 信号来源（#903 纠正）：早先这里写死「全程零网络、唯一信号源是 serve/watch 落盘的欠账」，
// 结果是自咬尾巴——**本 hook 存在的意义正是「用户没挂 serve/bridge」，却要靠 serve 写的欠账
// 才知道有 @**，于是在目标场景下恒不触发。现在的分工：
//   - 本地欠账（StuckWake）降级为**可选快路径**：有就用，省掉这次网络；
//   - 没有就自己问一次 `GET /api/channels/:slug/next-mention?since=<cursor>`——只问 seq、
//     不拉正文，正文仍旧由会话去 `party history` 读，「频道是唯一数据源」不破。
// 预算（本机 hooks.json 实测 timeout=10s）：那一跳独立超时 CODEX_STOP_WAKE_QUERY_TIMEOUT_MS，
// 绝不吃满预算；失败/超时/任何异常一律放行——fail-open 铁律高于唤醒。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./atomic-json";
import type { StuckWake } from "./config";

/** seen 集合的落盘目录，与 #893 的 marker 目录并列。 */
export const CODEX_STOP_WAKE_SEEN_DIR = "codex-stop-wake";
/** 每个身份+频道最多记住多少个已注入过的 seq。有界，绝不无限长。 */
export const CODEX_STOP_WAKE_SEEN_CAPACITY = 64;
/**
 * seen 条目的时效（#922）。
 *
 * 为什么必须有它：`next-mention` 返回的永远是「游标之后**最早**一条未处理的 @」，而注入
 * ≠ 处理——游标不会因为注入而前进。于是一旦某条 @ 被注入过却没被处理，它就永久占住队首：
 * 查询恒返回它 → seen 命中 → 跳过 → 后续所有 @ **永远够不着**。真机实测（owner 的
 * codex1）：游标 1899、seen=[1902]，频道里 1910/1923 一条都叫不醒，且**完全静默**。
 *
 * 修法两条，缺一不可：
 *   ① 查询的 `since` 抬到 `max(游标, 活着的 seen 里最大的 seq)`——直接绕过已提示过的队首；
 *   ② seen 的职责从「永不再提」弱化为「短期内不重复打扰」——过了时效可以再提一次。
 * 防循环并不依赖 seen 的永久性：`stop_hook_active` 已经把每个用户 turn 硬顶在 1 次注入
 * （#899 铁律，一条未松），seen 只是「同一个 turn 之外别刷屏」。
 */
export const CODEX_STOP_WAKE_SEEN_TTL_MS = 30 * 60 * 1000;
/** 注入正文的硬上限——和 #841 的唤醒通知同一预算。 */
export const CODEX_STOP_WAKE_REASON_MAX_BYTES = 512;
/**
 * 超过这个岁数的欠账不再叫醒任何人（与 watch 的 WATCH_WAKE_DEBT_MAX_AGE_MS 同义）：
 * 几天前早就在别处处理过的 @，不该在用户今天的会话里跳出来。
 */
export const CODEX_STOP_WAKE_DEBT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * 问「有没有未处理的 @」那一跳的独立超时（#903）。
 * codex 给整个 Stop hook 的预算是 10s；这里取 3s，剩下的 7s 留给读盘、落盘和进程启动，
 * 网络再慢也只是这一次不叫醒（下一轮 Stop 会再问），绝不把用户的会话卡住。
 *
 * 为什么不是更短：真机实测热路径 ~0.25–0.6s，但 DO 冷启动那一次量到过 2.1s——
 * 2s 级的超时会把「今天第一次被 @」这种最该叫醒的场景恰好卡掉。
 */
export const CODEX_STOP_WAKE_QUERY_TIMEOUT_MS = 3_000;

/** 交回给会话的指针：只有 channel+seq，正文永远去频道读。 */
export interface CodexStopWakePointer {
  channel: string;
  seq: number;
}

export function codexStopWakeSeenPath(home: string, target: string): string {
  return join(home, CODEX_STOP_WAKE_SEEN_DIR, `${target.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

/** 一条「我在什么时候提示过这个 seq」。时间戳是 #922 让 seen 可过期的前提。 */
export interface CodexStopWakeSeenEntry {
  seq: number;
  ts: number;
}

/**
 * 读已注入过的 seq 集合。文件坏了/不存在都当空集——读不到只会多注入一次，不会卡死会话。
 *
 * 兼容 v1（`{version:1, seqs:[…]}`，没有时间戳）：一律按 ts=0 读入 ＝ 立即过期。
 * 这正是升级后**自愈**那条永久饿死的路径：被卡住的队首会被再提示一次，此后走 v2 的时效逻辑。
 */
export function readCodexStopWakeSeen(path: string): CodexStopWakeSeenEntry[] {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const entries = value.entries;
    if (Array.isArray(entries)) {
      const out: CodexStopWakeSeenEntry[] = [];
      for (const row of entries) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
        const seq = (row as Record<string, unknown>).seq;
        const ts = (row as Record<string, unknown>).ts;
        if (typeof seq !== "number" || !Number.isFinite(seq) || seq <= 0) continue;
        out.push({ seq, ts: typeof ts === "number" && Number.isFinite(ts) ? ts : 0 });
      }
      return out;
    }
    const seqs = value.seqs;
    if (!Array.isArray(seqs)) return [];
    return seqs
      .filter((seq): seq is number => typeof seq === "number" && Number.isFinite(seq) && seq > 0)
      .map((seq) => ({ seq, ts: 0 }));
  } catch {
    return [];
  }
}

/** 时效内还算数的那些 seq。过期的不再挡路（#922：seen 是「短期内别重复打扰」，不是「永不再提」）。 */
export function liveCodexStopWakeSeen(
  entries: readonly CodexStopWakeSeenEntry[],
  now: number,
  ttlMs: number = CODEX_STOP_WAKE_SEEN_TTL_MS,
): number[] {
  return entries.filter((entry) => now - entry.ts < ttlMs).map((entry) => entry.seq);
}

/**
 * 查询 `next-mention` 该用的 `since`（#922 的核心修复）。
 *
 * 取 `max(游标, 活着的 seen 里最大的 seq)`：已经提示过的队首直接被跳过，后面那些 @ 才够得着。
 * 绝不会漏消息——seq 单调递增，比「提示过的最大 seq」还小的必然已经提示过或已被游标了结。
 */
export function codexStopWakeQuerySince(cursor: number, liveSeen: readonly number[]): number {
  let since = cursor;
  for (const seq of liveSeen) {
    if (seq > since) since = seq;
  }
  return since;
}

export function hasCodexStopWakeSeen(seen: readonly number[], seq: number): boolean {
  return seen.includes(seq);
}

/** 追加一个已注入的 seq 并截断到容量上限（保留最新的 N 个）。纯函数，便于单测。 */
export function appendCodexStopWakeSeen(
  entries: readonly CodexStopWakeSeenEntry[],
  seq: number,
  now: number,
  capacity: number = CODEX_STOP_WAKE_SEEN_CAPACITY,
): CodexStopWakeSeenEntry[] {
  const next = [...entries.filter((entry) => entry.seq !== seq), { seq, ts: now }];
  return next.length <= capacity ? next : next.slice(next.length - capacity);
}

/**
 * 落盘「这条 seq 我注入过了」。**必须在打印 block 之前调用**：
 * 先打印再落盘的话，中间崩一次就会对同一条 @ 反复注入。
 */
export function recordCodexStopWakeSeen(
  path: string,
  seq: number,
  now: number = Date.now(),
  capacity: number = CODEX_STOP_WAKE_SEEN_CAPACITY,
): void {
  atomicWriteJson(path, {
    version: 2,
    entries: appendCodexStopWakeSeen(readCodexStopWakeSeen(path), seq, now, capacity),
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

/** 便宜闸门的入参：这三样都不用花一次网络就能拿到。 */
export interface CodexStopWakeGateInput {
  /** codex 递进来的原始 Stop payload。 */
  payload: Record<string, unknown>;
  /** 本 cwd 绑定的频道；没绑定为 null。 */
  channel: string | null;
  /** #893 的开关：显式 off 时前台这层也一起关（同一个「别自动打扰我」的意思）。 */
  enabled: boolean;
}

export type CodexStopWakeGate = { ok: true } | { ok: false; skip: CodexStopWakeSkip };

/**
 * 先于任何信号获取的三道便宜闸（#903 把它单独拆出来，就是为了**先过闸再花网络**：
 * 不是 Stop、是续跑、被关掉、没绑频道——这四种情况一次网络都不该发）。
 */
export function codexStopWakeGate(input: CodexStopWakeGateInput): CodexStopWakeGate {
  const { payload } = input;
  if (payload.hook_event_name !== "Stop") return { ok: false, skip: "not_stop" };
  // 防循环第 1 闸。注意只认严格的 `false`：字段缺失/类型不对一律当「可能是续跑」放行，
  // 宁可漏叫一次，也绝不冒「会话永远停不下来」的险。
  if (payload.stop_hook_active !== false) return { ok: false, skip: "continuation" };
  if (!input.enabled) return { ok: false, skip: "disabled" };
  if (input.channel === null || input.channel === "") return { ok: false, skip: "no_channel" };
  return { ok: true };
}

export interface CodexStopWakeInput extends CodexStopWakeGateInput {
  /**
   * 「本身份有一条还没处理的 @，seq 是它」——**信号来源不限**（#903）：
   * 可以是 serve/watch 落在本地的欠账（快路径），也可以是本 hook 自己问服务端问来的。
   * 早先这里写死只认本地欠账，而 Stop hook 存在的场景恰恰是「没人挂 serve」⇒ 恒不触发。
   */
  pending: Pick<StuckWake, "seq" | "first_wake_ts"> | null;
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
  const gate = codexStopWakeGate(input);
  if (!gate.ok) return { wake: false, skip: gate.skip };
  const pending = input.pending;
  if (pending === null || !Number.isFinite(pending.seq) || pending.seq <= 0) {
    return { wake: false, skip: "no_pending" };
  }
  // 游标说「这条我已经了结了」——了结过的不再叫。
  if (pending.seq <= input.cursor) return { wake: false, skip: "no_pending" };
  if (
    typeof pending.first_wake_ts === "number" &&
    Number.isFinite(pending.first_wake_ts) &&
    input.now - pending.first_wake_ts > CODEX_STOP_WAKE_DEBT_MAX_AGE_MS
  ) {
    return { wake: false, skip: "stale_debt" };
  }
  // 防循环第 2 闸：同一条 @ 只注入一次。seen 是落盘的，跨进程有效。
  if (hasCodexStopWakeSeen(input.seen, pending.seq)) return { wake: false, skip: "already_woken" };
  return { wake: true, pointer: { channel: input.channel as string, seq: pending.seq } };
}
