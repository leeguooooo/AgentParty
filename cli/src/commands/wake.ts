// party wake test — prove mention/wake/resume as separate phases.
import { autoWakeReachable, EXIT_TIMEOUT, type MsgFrame, type PresenceEntry, type WakeDelivery, type WakeKind } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig, resolveChannel } from "../config";
import { jsonFrame, nowTs } from "../json";
import { resolveAuth } from "../oidc-cli";
import { RestError, fetchMessages, fetchPresence, fetchWakeDeliveries, handleRestError, postMessage } from "../rest";
import { MAX_TIMEOUT_SEC, isName, isSlug, parsePositiveIntFlag } from "../validation";

const WAKE_FLAGS = ["channel", "timeout", "json"];
const DEFAULT_TIMEOUT_SEC = 30;
const STALE_MS = 60_000; // keep serve/watch wakeability aligned with `party who` and mention receipts
const HELP = `usage: party wake test @agent [channel|--channel C] [--timeout N] [--json]

Run a wake contract test. This separates mention delivery, wake adapter delivery,
and linked agent resume. Only a fresh reply/status linked to the test mention
counts as resumed.

A target that advertises no wake adapter is still probed empirically (the mention is
delivered and the reply/timeout is conclusive), because "no adapter" is not proof of
"unreachable" — the harness may be polling. Targeting your own identity fails fast
without sending a probe (serve/watch ignore self-messages).

Options:
  --channel C    test in channel C instead of the bound channel
  --timeout N    seconds to wait for linked ack/status (default: 30)
  --json         emit one structured wake_test frame`;

// #603：把笼统的 timeout 按 presence 的探活分级细分——not_listening（服务端观测到 delivery
// 租约对活连接反复过期）与 runner_failing（serve 自报 runner 连败）。处置完全不同：
// 前者重启 supervisor / 查事件循环，后者修 runner 环境（二进制/凭据/沙箱）。
// #689：headless runner（builtin claude/codex）处理一条 @ 要数分钟，30s 探测窗口内不可能有最终回复。
// 但只要 presence.current_task 指向本探针的 seq，就证明 runner 已被唤起、正在处理——这是「wake invoked: yes」
// 的明确信号，不该误报失败。wake_pending = 唤醒确凿、最终回复待定（介于 healthy 与 timeout 之间的成功态）。
type WakeResult = "not_auto_wakeable" | "healthy" | "wake_pending" | "timeout" | "self_target" | "not_listening" | "runner_failing";
type AckEvidence = "reply_to" | "status.summary_seq";

interface WakePresence {
  state: string | null;
  residency: string | null;
  wake_kind: string | null;
  wake_verified_at: number | null;
  last_seen: number | null;
  // 探活分级（#603）：缺省即无恙。
  listening?: PresenceEntry["listening"];
  runner_health?: PresenceEntry["runner_health"];
  // #689：runner 当前正在处理的触发 seq（缺省=空闲）。等于本探针 seq 即「已唤起、正在处理这条 @」。
  current_task?: PresenceEntry["current_task"];
}

interface WakeTestFrame extends Record<string, unknown> {
  type: "wake_test";
  channel: string;
  target: string;
  result: WakeResult;
  generated_at: number;
  timeout_sec: number;
  presence: WakePresence;
  phases: {
    mention_delivered: { ok: boolean; seq: number | null; evidence: string };
    wake_invoked: { ok: boolean | null; adapter: string | null; evidence: string };
    agent_resumed: { ok: boolean; seq: number | null; evidence: AckEvidence | null };
  };
  reason: string | null;
}

function normalizeTarget(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function summarizePresence(p: PresenceEntry | null): WakePresence {
  return {
    state: p?.state ?? null,
    residency: p?.residency ?? null,
    wake_kind: p?.wake?.kind ?? null,
    wake_verified_at: p?.wake?.verified_at ?? null,
    last_seen: p?.last_seen ?? p?.ts ?? null,
    ...(p?.listening === undefined ? {} : { listening: p.listening }),
    ...(p?.runner_health === undefined ? {} : { runner_health: p.runner_health }),
    ...(p?.current_task === undefined ? {} : { current_task: p.current_task }),
  };
}

// wake test 的探针闸门（issue #181）。把「送不送探针」和「heartbeat 怎么判」拆开：
//  - block !== null  → 不发探针，直接结论 not_auto_wakeable（沿用旧语义 + 现有测试）。
//    仅在「探针无处可去」时 block：没 presence（不在频道）、human_driven（只进收件箱）、
//    声明了适配器却无心跳、或适配器陈旧（serve/watch 的常驻 supervisor 已死，#47/#97）。
//  - advisory !== null → 仍发探针，但 heartbeat 视角是负面的（没声明任何适配器）。#181 的实锤：
//    没声明适配器 ≠ 不可达——agent 可能在轮询或人盯着，是 wake 模型没表达的模式。此时从
//    self-reported 元数据下「不可达」结论是不可证伪的，必须发探针、按「观测到的答复」定论。
//  - 两者皆 null → 声明了新鲜适配器，正常发探针。
function wakeProbeGate(p: PresenceEntry | null, now: number): { block: string | null; advisory: string | null } {
  if (p === null) return { block: "no presence for target", advisory: null };
  if (p.residency === "human_driven") return { block: "target is human-driven; mention is inbox only", advisory: null };
  if (p.wake === undefined || p.wake.kind === "none") {
    const advisory =
      p.residency === "bare"
        ? "target has bare residency and advertises no wake adapter"
        : "target advertises no wake adapter";
    return { block: null, advisory };
  }
  const seen = p.last_seen ?? p.ts ?? null;
  if (seen === null) return { block: "target wake adapter has no last_seen heartbeat", advisory: null };
  if (!autoWakeReachable(p, now, STALE_MS)) {
    return { block: `target ${p.wake.kind} wake adapter is stale; last seen ${Math.max(0, now - seen)}ms ago`, advisory: null };
  }
  return { block: null, advisory: null };
}

function ackEvidence(mentionSeq: number, candidate: MsgFrame): AckEvidence | null {
  if (candidate.reply_to === mentionSeq) return "reply_to";
  if (candidate.status?.summary_seq === mentionSeq) return "status.summary_seq";
  return null;
}

function findLinkedAck(messages: MsgFrame[], target: string, mentionSeq: number): { seq: number; evidence: AckEvidence } | null {
  for (const m of messages) {
    if (m.seq <= mentionSeq || m.sender.name !== target) continue;
    const evidence = ackEvidence(mentionSeq, m);
    if (evidence !== null) return { seq: m.seq, evidence };
  }
  return null;
}

function ackFromWakeDelivery(delivery: WakeDelivery | null): { seq: number; evidence: AckEvidence } | null {
  if (delivery === null) return null;
  if (delivery.ack_seq !== null) return { seq: delivery.ack_seq, evidence: "reply_to" };
  if (delivery.resume_seq !== null) return { seq: delivery.resume_seq, evidence: "status.summary_seq" };
  return null;
}

function summarizeWakeDelivery(delivery: WakeDelivery | null, adapter: string | null): { ok: boolean | null; adapter: string | null; evidence: string } {
  if (delivery === null) {
    return {
      ok: null,
      adapter,
      evidence: "adapter delivery is not audited by the worker yet; only linked resume is conclusive",
    };
  }
  if (delivery.result === "ok") {
    const status = delivery.http_status === null ? "" : ` status=${delivery.http_status}`;
    return {
      ok: true,
      adapter,
      evidence: `webhook delivery attempt ${delivery.attempt}${status} for mention #${delivery.mention_seq}`,
    };
  }
  const status = delivery.http_status === null ? "" : ` status=${delivery.http_status}`;
  const error = delivery.error ? ` error=${delivery.error}` : "";
  return {
    ok: false,
    adapter,
    evidence: `webhook delivery attempt ${delivery.attempt} failed${status}${error} for mention #${delivery.mention_seq}`,
  };
}

// #107：serve/watch 是拉模型——服务端从不主动投递，只能记「这条 @ 已广播给已登记 serve/watch 的可唤醒
// 目标」(result='broadcast')；该 agent resume 引用这条 @ 后升级为 'consumed'。故 wake_invoked 相位映射为：
//  - null delivery         → ok:null，标注「尚未审计」（沿用旧语义，仅在 ledger 缺行/端点不支持时）。
//  - result='broadcast'    → ok:null，但给出真实审计证据（已广播、待 resume 确认消费），而不是笼统的「未审计」。
//  - result='consumed'     → ok:true，唤醒闭环（resume 已引用这条 @）。
function summarizeServeWatchDelivery(delivery: WakeDelivery | null, adapter: string | null): { ok: boolean | null; adapter: string | null; evidence: string } {
  if (delivery === null) {
    return {
      ok: null,
      adapter,
      evidence: "serve/watch broadcast is not audited by the worker yet; only linked resume is conclusive",
    };
  }
  const kind = delivery.adapter_kind;
  if (delivery.result === "consumed") {
    const via = delivery.ack_seq !== null ? `reply #${delivery.ack_seq}` : delivery.resume_seq !== null ? `status #${delivery.resume_seq}` : "linked resume";
    return {
      ok: true,
      adapter,
      evidence: `${kind} client consumed the broadcast for mention #${delivery.mention_seq} (${via})`,
    };
  }
  // result='broadcast'：服务端已把这条 @ 广播给可唤醒的拉客户端，但尚未观测到引用它的 resume。
  return {
    ok: null,
    adapter,
    evidence: `${kind} broadcast delivered for mention #${delivery.mention_seq}; awaiting linked resume to confirm consumption`,
  };
}

// #107：webhook 由服务端主动投递、天然可审计；serve/watch 的广播同样落 ledger（adapter_kind='serve'|'watch'）。
// 按目标当前登记的 wake 层挑对应的 adapter_kind 读最新一行——webhook 只认 'webhook'，serve/watch 认两者。
function ledgerKindsFor(adapter: string | null): readonly WakeKind[] | null {
  if (adapter === "webhook") return ["webhook"];
  if (adapter === "serve" || adapter === "watch") return ["serve", "watch"];
  return null;
}

async function fetchLatestLedgerDelivery(
  server: string,
  token: string,
  channel: string,
  target: string,
  mentionSeq: number,
  kinds: readonly WakeKind[],
): Promise<WakeDelivery | null> {
  try {
    const deliveries = await fetchWakeDeliveries(server, token, channel, { since: mentionSeq, target, limit: 20 });
    return deliveries
      .filter((d) => d.mention_seq === mentionSeq && kinds.includes(d.adapter_kind))
      .at(-1) ?? null;
  } catch (e) {
    if (e instanceof RestError && (e.status === 404 || e.status === 501)) return null;
    throw e;
  }
}

function printHuman(frame: WakeTestFrame) {
  console.log(`wake test ${frame.channel} @${frame.target}: ${frame.result}`);
  if (frame.reason) console.log(`reason: ${frame.reason}`);
  const presenceBits = [
    frame.presence.state ? `state=${frame.presence.state}` : null,
    frame.presence.residency ? `residency=${frame.presence.residency}` : null,
    frame.presence.wake_kind ? `wake=${frame.presence.wake_kind}` : null,
    // 探活分级（#603）：有负面证据才展示，缺省即无恙。
    frame.presence.listening ? `listening=${frame.presence.listening}` : null,
    frame.presence.runner_health && !frame.presence.runner_health.ok
      ? `runner=failing x${frame.presence.runner_health.consecutive_failures}`
      : null,
  ].filter((bit): bit is string => bit !== null);
  if (presenceBits.length > 0) console.log(`presence: ${presenceBits.join(" ")}`);
  console.log(
    `mention: ${frame.phases.mention_delivered.ok ? `delivered #${frame.phases.mention_delivered.seq}` : "not sent"}`,
  );
  // #107：ok===null 时别一律印死板的「not audited」——serve/watch 的 broadcast 行已是真实审计结果，
  // 直接摊出 evidence（broadcast 已投递/待 resume 确认），只有 ledger 真无行时 evidence 才是「未审计」。
  console.log(
    `wake invoked: ${
      frame.phases.wake_invoked.ok === null
        ? frame.phases.wake_invoked.evidence
        : frame.phases.wake_invoked.ok
          ? // #689：唤起确凿但最终回复未到（headless runner 数分钟）——明说 reply pending，别让读者误当彻底成功或失败。
            frame.result === "wake_pending"
            ? "yes (reply pending)"
            : "yes"
          : "no"
    }`,
  );
  console.log(
    `resumed: ${
      frame.phases.agent_resumed.ok
        ? `yes #${frame.phases.agent_resumed.seq} evidence=${frame.phases.agent_resumed.evidence}`
        : frame.result === "wake_pending"
          ? "pending (runner still working)"
          : "no"
    }`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseArgs(argv, { booleans: ["json"] });
  const [subcmd, targetArg, channelArg, ...extra] = parsed.positionals;
  if (subcmd !== "test" || extra.length > 0) {
    console.error("usage: party wake test @agent [channel|--channel C] [--timeout N] [--json]");
    return 1;
  }
  const { flags } = parsed;
  const unknown = unknownFlagError(flags, WAKE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "timeout"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const target = normalizeTarget(targetArg);
  if (target === null || !isName(target)) {
    console.error("target must be a valid name, e.g. @agent");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? channelArg);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const timeout = parsePositiveIntFlag(str(flags.timeout), "timeout", MAX_TIMEOUT_SEC);
  if (typeof timeout === "string") {
    console.error(timeout);
    return 1;
  }
  const timeoutSec = timeout ?? DEFAULT_TIMEOUT_SEC;
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  // #194: 目标解析为自己身份时立刻失败——serve/watch 按设计忽略发送者自己的消息，
  // 自测必然 resumed:no。这个条件用本地缓存身份即可在发探针前判定，不必真往频道发一条
  // mention（白烧 loop-guard 名额），更不必空等满 --timeout（把「误用」伪装成「agent 死了」）。
  // 仅凭本地缓存身份判定（零网络请求）；身份未缓存时优雅降级到旧路径（发探针→timeout）。
  const selfName = readConfig()?.identity?.name ?? null;
  if (selfName !== null && selfName === target) {
    const reason =
      `wake test: @${target} is your own identity; serve/watch ignore self-messages. ` +
      "Ask another identity to run this test.";
    if (flags.json === true) {
      const frame: WakeTestFrame = {
        type: "wake_test",
        channel,
        target,
        result: "self_target",
        generated_at: nowTs(),
        timeout_sec: timeoutSec,
        presence: summarizePresence(null),
        phases: {
          mention_delivered: { ok: false, seq: null, evidence: "not sent because target is the caller's own identity" },
          wake_invoked: { ok: false, adapter: null, evidence: reason },
          agent_resumed: { ok: false, seq: null, evidence: null },
        },
        reason,
      };
      console.log(JSON.stringify(jsonFrame(frame)));
    } else {
      console.error(reason);
    }
    return 1;
  }

  try {
    const presenceList = await fetchPresence(cfg.server, cfg.token, channel);
    const presence = presenceList.find((p) => p.name === target) ?? null;
    const generatedAt = nowTs();
    const gate = wakeProbeGate(presence, generatedAt);
    const adapter = presence?.wake?.kind ?? null;
    if (gate.block !== null) {
      const frame: WakeTestFrame = {
        type: "wake_test",
        channel,
        target,
        result: "not_auto_wakeable",
        generated_at: generatedAt,
        timeout_sec: timeoutSec,
        presence: summarizePresence(presence),
        phases: {
          mention_delivered: { ok: false, seq: null, evidence: "not sent because target is not auto-wakeable" },
          wake_invoked: { ok: false, adapter, evidence: gate.block },
          agent_resumed: { ok: false, seq: null, evidence: null },
        },
        reason: gate.block,
      };
      if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
      else printHuman(frame);
      return EXIT_TIMEOUT;
    }

    const { seq } = await postMessage(cfg.server, cfg.token, channel, {
      kind: "message",
      body: `@${target} wake test: please reply to this message or post a status linked with summary_seq`,
      mentions: [target],
      reply_to: null,
    });
    const deadline = Date.now() + timeoutSec * 1000;
    const ledgerKinds = ledgerKindsFor(adapter);
    let ack: { seq: number; evidence: AckEvidence } | null = null;
    let wakeDelivery: WakeDelivery | null = null;
    do {
      if (ledgerKinds !== null) {
        wakeDelivery = await fetchLatestLedgerDelivery(cfg.server, cfg.token, channel, target, seq, ledgerKinds);
        ack = ackFromWakeDelivery(wakeDelivery);
        if (ack !== null) break;
      }
      ack = findLinkedAck(await fetchMessages(cfg.server, cfg.token, channel, seq, 100), target, seq);
      if (ack !== null) break;
      await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
    } while (Date.now() < deadline);
    if (ledgerKinds !== null && wakeDelivery === null) {
      wakeDelivery = await fetchLatestLedgerDelivery(cfg.server, cfg.token, channel, target, seq, ledgerKinds);
    }

    // serve/watch are local supervisors reading the channel stream; they filter out the
    // sender's own messages to avoid self-trigger loops. So a self-test (mentioning your own
    // agent) always times out even when the supervisor is healthy — spell that out so the next
    // person doesn't burn a debugging session on it (as happened with serve+bare self-tests).
    const selfTestProne = adapter === "serve" || adapter === "watch";
    const timeoutReason = selfTestProne
      ? "timed out waiting for linked reply_to/status.summary_seq (serve/watch ignore the sender's own messages — if @" +
        target +
        " is your own identity, retry from a different one)"
      : "timed out waiting for linked reply_to/status.summary_seq";
    // #181: 探针已投递，按观测定论。收到 ack → healthy（哪怕它没声明任何 wake 适配器，
    // 只要它真的答复了就是可达的）。没 ack 时，若 heartbeat 视角本就负面（没声明适配器），
    // 结论仍是 not_auto_wakeable 但标注「探针已投递、未答复、未确认」——把 heartbeat 判定
    // 和投递判定摊开，而不是当初那句不可证伪的 mention: not sent。
    let result: WakeResult = ack !== null ? "healthy" : gate.advisory !== null ? "not_auto_wakeable" : "timeout";
    let frameReason =
      ack !== null
        ? null
        : gate.advisory !== null
          ? `${gate.advisory} (unconfirmed — probe delivered #${seq}, no reply within ${timeoutSec}s)`
          : timeoutReason;
    // 探活分级（#603/#689）：没收到最终回复不再一锅端。重取一次 presence——若服务端/自报已给出证据，
    // 细分为可处置的结论。优先级（先真、再故障、后不消费）：
    //   ① current_task==本探针 seq → runner 已唤起、正在处理这条 @：wake_pending（唤醒确凿，reply pending）。
    //      #689：headless runner 跑一条要数分钟，30s 内没有最终回复是正常的，绝不能误报「no wake adapter」/失败。
    //      这条对「没声明适配器」(advisory) 与「timeout」两条路径都适用——current_task 是活体执行的直接证据，
    //      不依赖 presence 是否同步了 wake 适配器声明。
    //   ② runner_health 报连败 → runner_failing（修 runner 环境，优先于不消费——「唤醒了起不来」更接近根因）。
    //   ③ listening=deaf/suspect → not_listening（重启 supervisor）。
    let finalPresence = presence;
    if (ack === null) {
      try {
        finalPresence = (await fetchPresence(cfg.server, cfg.token, channel)).find((p) => p.name === target) ?? presence;
      } catch {
        /* 刷新失败就用探针前的快照定级 */
      }
      if (finalPresence?.current_task === seq) {
        result = "wake_pending";
        frameReason =
          `probe delivered #${seq}; target's runner is actively processing it (presence.current_task=#${seq}) — ` +
          "wake invoked, final reply pending (a headless builtin runner may take minutes to reply)";
      } else if (result === "timeout") {
        const health = finalPresence?.runner_health;
        if (health !== undefined && !health.ok) {
          result = "runner_failing";
          frameReason =
            `probe delivered #${seq} but the target's runner keeps failing (x${health.consecutive_failures}` +
            `${health.last_error !== undefined ? `: ${health.last_error}` : ""}) — fix the runner environment ` +
            "(binary/credentials/sandbox) instead of re-mentioning";
        } else if (finalPresence?.listening === "deaf" || finalPresence?.listening === "suspect") {
          result = "not_listening";
          frameReason =
            `probe delivered #${seq} but the target's live connection is not consuming deliveries ` +
            `(listening=${finalPresence.listening}) — restart its serve/watch supervisor instead of re-mentioning`;
        }
      }
    }
    // #689：runner 正在处理本探针（current_task 命中）是唤醒确凿的最强证据——盖过「没声明适配器」的负面 heartbeat
    // 视角与 ledger 未审计。此时 wake_invoked 直接判 yes、reply pending。
    const wakeInvoked =
      result === "wake_pending"
        ? {
            ok: true as const,
            adapter,
            evidence: `target's runner is processing mention #${seq} (presence.current_task) — wake invoked; final reply pending`,
          }
        : gate.advisory !== null && wakeDelivery === null
          ? { ok: false as const, adapter, evidence: gate.advisory }
          : adapter === "serve" || adapter === "watch"
            ? summarizeServeWatchDelivery(wakeDelivery, adapter)
            : summarizeWakeDelivery(wakeDelivery, adapter);
    const frame: WakeTestFrame = {
      type: "wake_test",
      channel,
      target,
      result,
      generated_at: nowTs(),
      timeout_sec: timeoutSec,
      presence: summarizePresence(finalPresence),
      phases: {
        mention_delivered: { ok: true, seq, evidence: "message accepted by channel history" },
        wake_invoked: wakeInvoked,
        agent_resumed: { ok: ack !== null, seq: ack?.seq ?? null, evidence: ack?.evidence ?? null },
      },
      reason: frameReason,
    };
    if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
    else printHuman(frame);
    // #689：wake_pending（唤醒确凿、reply pending）与 healthy 同为成功——不再退 EXIT_TIMEOUT 误报失败。
    return ack !== null || result === "wake_pending" ? 0 : EXIT_TIMEOUT;
  } catch (e) {
    return handleRestError(e);
  }
}
