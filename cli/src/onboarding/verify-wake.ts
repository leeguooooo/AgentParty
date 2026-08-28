// 接入引导第 4 步：真发一条 @ 验证往返（issue #990，epic #987）。
//
// 接入的最终判据是**真实唤醒**，不是「插件装了 / 锁有人持」这类间接证据（#957/#961/#979 全是间接证据
// 打 ✅、真机叫不醒）。这里以本身份发一条验证帧（`[wake-verify]` + 只 @ 自己，见 shared 的
// isWakeVerifyFrame——服务端与本机监听把它当成自 @ 的唯一放行例外），然后**复用** `party wake test`
// 的往返本体（runWakeProbe：presence 过闸 → 发探针 → 轮询 ledger/回帖 → 探活分级），不另写一套。
//
// 超时时按层定位——三层各自的证据来源不同，文案与修法也不同：
//   server_delivery  服务端没投递：presence 没登记可唤醒 / ledger 没有这条 @ 的行 / webhook 投递失败
//   local_listener   服务端已投递，本机监听没收到：没有认领文件、bridge 恢复日志、serve 任务痕迹，
//                    或 presence.listening 报 deaf/suspect，或本机根本没有武装监听
//   model_reply      本机监听已收到（有上述痕迹），模型在超时内没有回帖（或 runner 连败）
// 判层是纯函数（classifyWakeVerify），输入是往返帧 + 本机证据，方便被测、也方便 #988 的步骤机直接接。
import { WAKE_VERIFY_PREFIX } from "@agentparty/shared";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeClaudeArmedListener, type ClaudeArmedListenerProbe } from "../claude-armed-listener";
import { deliveryRecoveryJournalPath } from "../delivery-recovery-journal";
import { readHealthCache } from "../health-cache";
import { mentionWakeClaimDir, mentionWakeClaimKey } from "../mention-wake-claim";
import { runWakeProbe, type WakeProbeOptions, type WakeTestFrame } from "../commands/wake";
import { RestError } from "../rest";
import { t, type WakeLang } from "../wake-note-i18n";

export type WakeVerifyLayer = "server_delivery" | "local_listener" | "model_reply";
export type WakeVerifyHarness = "claude" | "codex" | "other";

export const DEFAULT_WAKE_VERIFY_TIMEOUT_MS = 30_000;

export interface VerifyWakeRoundTripOptions {
  server: string;
  token: string;
  channel: string;
  /** 本身份的频道 handle（mentions 里出现的那个名字）。 */
  identity: string;
  /** 等回执/回帖的上限；缺省 30s。 */
  timeoutMs?: number;
  /** 修法命令按 harness 给：claude 档给 `party claude <chan>`，其余给 `party wake check`。 */
  harness?: WakeVerifyHarness;
  /** 验证帧正文的语言（#1003，同唤醒注入一套规则）；缺省 zh（历史行为）。 */
  lang?: WakeLang;
}

/** 本机监听留下的痕迹——每一项都是「收到了这条 seq」的直接证据，任何一项为真即本机已收到。 */
export interface WakeLocalEvidence {
  /** 本机 serve 锁的活持有者（probeClaudeArmedListener）：谁在接 @、有几个蛰伏会话。 */
  listener: ClaudeArmedListenerProbe;
  /** #963 认领文件：本机某个 runtime 已为这条 seq 认领唤醒（claude-channel 蛰伏腿）。 */
  claimed: boolean;
  /** claude bridge 的 delivery 恢复日志里有这条 seq（武装 bridge 已收到 directed delivery）。 */
  journaled: boolean;
  /** serve 健康缓存记录 current_task == seq（serve 已把它交给 runner）。 */
  runnerTask: boolean;
}

export interface VerifyWakeRoundTripResult {
  ok: boolean;
  elapsedMs: number;
  /** ok=false 时哪一层没通；发送本身失败（网络/loop guard）时也没有层——那是「探针没发出去」。 */
  layer?: WakeVerifyLayer;
  /** 一句人话结论（不含「第 4 步」前缀，由 formatWakeVerifyStep 拼）。 */
  detail: string;
  /** ok=false 时的一条修法命令。 */
  fix?: string;
  /** 验证帧的 seq；探针没发出去为 null。 */
  seq: number | null;
  /** 原始往返帧（wake_test），--json 时原样带出。 */
  probe: WakeTestFrame | null;
  /** 超时时读到的本机证据；ok 或探针没发出去时为 null。 */
  local: WakeLocalEvidence | null;
}

export interface VerifyWakeDeps {
  probe: (opts: WakeProbeOptions) => Promise<WakeTestFrame>;
  localEvidence: (input: { server: string; token: string; channel: string; identity: string; seq: number }) => WakeLocalEvidence;
  now: () => number;
}

/**
 * 验证帧正文：前缀是判据（isWakeVerifyFrame，服务端与本机监听都按它放行自 @）——**不本地化**；
 * 其余是给被唤醒的模型看的一句话，按接收方语言取（#1003）。
 */
export function verifyWakeBody(identity: string, lang: WakeLang = "zh"): string {
  return `${WAKE_VERIFY_PREFIX} ${t(lang, "verify.body", { identity })}`;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** 本机证据的真实读法：只读盘 + 一次 ps，任何一项读不出都按「没有」算（宁可判监听没收到，也不伪造收到）。 */
export function readWakeLocalEvidence(input: {
  server: string;
  token: string;
  channel: string;
  identity: string;
  seq: number;
  cwd?: string;
}): WakeLocalEvidence {
  const { server, token, channel, identity, seq } = input;
  let listener: ClaudeArmedListenerProbe;
  try {
    listener = probeClaudeArmedListener({ config: { server, token, identity: { name: identity } }, channel });
  } catch {
    listener = { live: null, sessions: 0 };
  }
  let claimed = false;
  try {
    claimed = existsSync(join(mentionWakeClaimDir(), `${mentionWakeClaimKey({ server, identity, channel, seq })}.json`));
  } catch {
    claimed = false;
  }
  let journaled = false;
  try {
    const journal = readJson(deliveryRecoveryJournalPath("claude", server, token, channel)) as
      | { entries?: Array<{ message?: { seq?: unknown } }> }
      | null;
    journaled = Array.isArray(journal?.entries) && journal.entries.some((e) => e?.message?.seq === seq);
  } catch {
    journaled = false;
  }
  let runnerTask = false;
  try {
    runnerTask = readHealthCache(input.cwd ?? process.cwd(), channel)?.current_task === seq;
  } catch {
    runnerTask = false;
  }
  return { listener, claimed, journaled, runnerTask };
}

function fixFor(harness: WakeVerifyHarness, channel: string, layer: WakeVerifyLayer): string {
  if (layer === "model_reply") {
    return harness === "claude"
      ? `看那个会话是不是卡住/在等权限；常驻档看 runner 日志：party health ${channel}`
      : `party health ${channel}   （看 runner 为什么没回；codex 档看 ~/.agentparty/logs/codex-auto-wake.log）`;
  }
  if (layer === "local_listener") {
    return harness === "claude"
      ? `party claude ${channel}   （重新起一个武装监听；常驻：party serve ${channel} --runner claude）`
      : `party wake check   （codex 档：唤醒层进程/hook 信任闸逐项核）`;
  }
  return harness === "claude"
    ? `party claude ${channel}   （起武装监听后服务端才会把你登记成可唤醒）`
    : `party wake check`;
}

function fmtSec(ms: number): string {
  const sec = ms / 1000;
  return sec >= 10 ? `${Math.round(sec)}s` : `${sec.toFixed(1)}s`;
}

function localTrace(local: WakeLocalEvidence): string | null {
  if (local.runnerTask) return "serve 已把它交给 runner";
  if (local.journaled) return "bridge 恢复日志已记下这条 delivery";
  if (local.claimed) return "本机 runtime 已认领这条唤醒";
  return null;
}

/**
 * 判层（纯函数）。ok 的两种：healthy（收到回帖/linked status）与 wake_pending（runner 正在处理，#689）。
 * 其余按「服务端投了没 → 本机收到没 → 模型回了没」的顺序落到第一层没通的地方。
 */
export function classifyWakeVerify(
  frame: WakeTestFrame,
  local: WakeLocalEvidence,
  input: { identity: string; channel: string; elapsedMs: number; timeoutMs: number; harness: WakeVerifyHarness },
): { ok: boolean; layer?: WakeVerifyLayer; detail: string; fix?: string } {
  const { identity, channel, elapsedMs, timeoutMs, harness } = input;
  const resumed = frame.phases.agent_resumed;
  if (resumed.ok) {
    const via = resumed.evidence === "status.summary_seq" ? "linked status" : "回帖";
    return { ok: true, detail: `@${identity} ping → ${fmtSec(elapsedMs)} 收到回执 ✓（${via} #${resumed.seq}）` };
  }
  if (frame.result === "wake_pending") {
    // #997：wake_pending 理论上必带 seq（探针已发出），但判层是纯函数、输入来自网络帧——seq 为 null 时不拼 "#null"。
    const pendingSeq = frame.phases.mention_delivered.seq;
    return {
      ok: true,
      detail:
        `@${identity} ping → ${fmtSec(elapsedMs)} 收到回执 ✓（runner 已接手${pendingSeq === null ? "" : ` #${pendingSeq}`}，` +
        "回帖待定——headless runner 处理一条要数分钟）",
    };
  }
  const head = `✗ ${fmtSec(timeoutMs)} 未收到`;
  const invoked = frame.phases.wake_invoked;
  // ① 服务端这层：探针根本没发（presence 过闸失败）/ 没有唤醒层 / ledger 没行 / webhook 投递失败。
  if (!frame.phases.mention_delivered.ok) {
    const layer: WakeVerifyLayer = "server_delivery";
    return {
      ok: false,
      layer,
      detail: `${head}：服务端没把 @${identity} 当成可唤醒目标（${frame.reason ?? invoked.evidence}），验证帧没发`,
      fix: fixFor(harness, channel, layer),
    };
  }
  if (invoked.status === "not_invoked" || invoked.status === "not_audited") {
    const layer: WakeVerifyLayer = "server_delivery";
    const why =
      invoked.status === "not_audited"
        ? `服务端账本没有这条 @ 的投递记录（登记的唤醒层：${invoked.adapter ?? "无"}）——可能被暂停接待，或服务端版本过旧不认验证帧`
        : invoked.evidence;
    return {
      ok: false,
      layer,
      detail: `${head}：验证帧已发（#${frame.phases.mention_delivered.seq}），服务端未投递 → ${why}`,
      fix: fixFor(harness, channel, layer),
    };
  }
  // ② 服务端已投递（broadcast/claimed/webhook ok）。本机有没有收到的直接痕迹？
  const trace = localTrace(local);
  if (trace !== null || frame.result === "runner_failing") {
    const layer: WakeVerifyLayer = "model_reply";
    const health = frame.presence.runner_health;
    const why =
      frame.result === "runner_failing" && health !== undefined && !health.ok
        ? `runner 连败 x${health.consecutive_failures}${health.last_error !== undefined ? `（${health.last_error}）` : ""}`
        : `${trace}，模型没有在 ${fmtSec(timeoutMs)} 内回帖`;
    return {
      ok: false,
      layer,
      detail: `${head}：服务端已投递、本机监听已收到，模型未回 → ${why}`,
      fix: fixFor(harness, channel, layer),
    };
  }
  const layer: WakeVerifyLayer = "local_listener";
  const why =
    frame.result === "not_listening"
      ? `本机连接没在消费投递（服务端判 listening=${frame.presence.listening ?? "suspect"}）`
      : local.listener.live === null
        ? `本机没有武装监听${local.listener.sessions > 0 ? `（有 ${local.listener.sessions} 个蛰伏会话，普通 claude 起的会话不接 @）` : ""}`
        : `本机监听 pid ${local.listener.live.pid}（${local.listener.live.launch}）没留下收到这条 @ 的痕迹`;
  return {
    ok: false,
    layer,
    detail: `${head}：服务端已投递、本机监听未收到 → ${why}`,
    fix: fixFor(harness, channel, layer),
  };
}

/** 限频错误体里的 retry_after_ms → 整秒（向上取整，至少 1s）；体不合形状为 null。 */
export function wakeVerifyRetryAfterSec(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return null;
  const ms = (err as { retry_after_ms?: unknown }).retry_after_ms;
  return typeof ms === "number" && Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 1000)) : null;
}

export const defaultVerifyWakeDeps: VerifyWakeDeps = {
  probe: runWakeProbe,
  localEvidence: readWakeLocalEvidence,
  now: () => Date.now(),
};

/**
 * 真发一条 @ 验证往返。发送失败（网络 / 频道 loop guard 熔断）不抛：ok=false、无 layer、detail 说清
 * 「探针没发出去」——那不是三层里的任何一层，是频道现在根本发不了消息。
 */
export async function verifyWakeRoundTrip(
  opts: VerifyWakeRoundTripOptions,
  deps: VerifyWakeDeps = defaultVerifyWakeDeps,
): Promise<VerifyWakeRoundTripResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAKE_VERIFY_TIMEOUT_MS;
  const harness = opts.harness ?? "other";
  const startedAt = deps.now();
  let frame: WakeTestFrame;
  try {
    frame = await deps.probe({
      server: opts.server,
      token: opts.token,
      channel: opts.channel,
      target: opts.identity,
      timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
      body: verifyWakeBody(opts.identity, opts.lang ?? "zh"),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const elapsedMs = deps.now() - startedAt;
    // #997：服务端按发送者限频验证帧（同一身份 30s 一条）——不是三层里的任何一层，也不是熔断；说清等多久。
    if (e instanceof RestError && e.code === "wake_verify_rate_limited") {
      const waitSec = wakeVerifyRetryAfterSec(e.body);
      return {
        ok: false,
        elapsedMs,
        detail: `✗ 验证帧被服务端限频：同一身份 30s 内只能发一条${waitSec === null ? "" : `，${waitSec}s 后可再发`}`,
        // 修法必须是能直接跑的命令：没拿到重试时间就只给验证命令本身，别拼一个不存在的「稍等片刻」进 shell。
        fix: waitSec === null ? `party wake verify ${opts.channel}` : `sleep ${waitSec} && party wake verify ${opts.channel}`,
        seq: null,
        probe: null,
        local: null,
      };
    }
    return {
      ok: false,
      elapsedMs,
      detail: `✗ 验证帧没发出去：${message}`,
      fix: /loop.guard/i.test(message) ? `party channel reset-guard ${opts.channel}   （频道已熔断，@ 现在到不了任何 agent）` : "party doctor",
      seq: null,
      probe: null,
      local: null,
    };
  }
  const elapsedMs = deps.now() - startedAt;
  const seq = frame.phases.mention_delivered.seq;
  const local =
    seq === null
      ? { listener: { live: null, sessions: 0 }, claimed: false, journaled: false, runnerTask: false }
      : deps.localEvidence({ server: opts.server, token: opts.token, channel: opts.channel, identity: opts.identity, seq });
  const verdict = classifyWakeVerify(frame, local, { identity: opts.identity, channel: opts.channel, elapsedMs, timeoutMs, harness });
  return {
    ok: verdict.ok,
    elapsedMs,
    ...(verdict.layer === undefined ? {} : { layer: verdict.layer }),
    detail: verdict.detail,
    ...(verdict.fix === undefined ? {} : { fix: verdict.fix }),
    seq,
    probe: frame,
    local: verdict.ok ? null : local,
  };
}

/** epic #987 里第 4 步那一行（加修法一行）。 */
export function formatWakeVerifyStep(result: VerifyWakeRoundTripResult): string[] {
  const lines = [`第 4 步  真发一条 @ 验证 · ${result.detail}`];
  if (!result.ok && result.fix !== undefined) lines.push(`         → 修法：${result.fix}`);
  return lines;
}
