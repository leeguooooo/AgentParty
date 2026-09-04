// party receipt — 「收到了，但我现在不在轮次里」的一等表达（#828）。
//
// 这是官方替代品，取代各家用 `party send` 手搓的自动回执。手搓版实测有两种失效，这里都不可能发生：
//  - 模板插值失败发出 `收到（seq ）`：这里 seq 是位置参数、经 URL 路径由服务端取，没有可拼错的文案；
//  - 回执与实质消息同权（占 seq、进 history、触发 delivery、要 ack），零信息量却堵住真消息：
//    这里回执是目标消息的元数据，不占 seq、不进正文流、不触发 delivery。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { formatMsg } from "../format";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { ackDelivery, handleRestError, postReceipt } from "../rest";
import { settleClaudeDeliveryRecovery } from "../delivery-recovery-journal";
import { isSlug } from "../validation";

type ReceiptReason = "not_in_turn" | "queued" | "seen";

const REASONS: ReceiptReason[] = ["not_in_turn", "queued", "seen"];
const FLAGS = ["channel", "reason", "message", "json", "no-reply"];
const HELP = `usage:
  party receipt <seq> [--reason not_in_turn|queued|seen] [--no-reply] [-m note] [--channel C] [--json]

Mark a message as received without replying to it. The receipt is metadata on
that message — it takes no seq, stays out of the message flow, triggers no
delivery, and needs no ack. Re-receipting the same message updates in place.

It reports reception only; it never means "done". A finished result is a
party send, sent once — and never followed by a second message restating it.
Add --no-reply only when the accepted server execution is complete and no
channel response is warranted. That atomically settles the delivery as
acknowledged_no_reply, creates no message, and clears a disconnected Claude
Channel's Stop-guard debt.

Reasons:
  not_in_turn   (default) received it, but this harness is not in a turn now
  queued        it is in my queue; I am busy and will get to it
  seen          saw it; no commitment to act

Options:
  --channel C   receipt in channel C instead of the bound channel
  --no-reply    terminally settle this seq without posting or waking a peer
  -m, --message short note (e.g. "will pick this up next turn")
  --json        emit the receipted message frame`;

function isReason(input: string | undefined): input is ReceiptReason {
  return input !== undefined && (REASONS as string[]).includes(input);
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json", "no-reply"], aliases: { m: "message" } });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "reason", "message"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const seqArg = positionals[0];
  // 正则只保证「一串数字」，不保证它落在安全整数内：20 位数字过 Number() 会变成 1e+20，
  // 拼进 URL 就成了一个根本不存在的 seq。在这里判掉，别把垃圾丢给服务端再靠 404 兜。
  const seq = seqArg === undefined ? Number.NaN : Number(seqArg);
  if (seqArg === undefined || !/^[1-9]\d*$/.test(seqArg) || !Number.isSafeInteger(seq)) {
    console.error("usage: party receipt <seq> [--reason not_in_turn|queued|seen] [-m note]");
    return 1;
  }
  const rawReason = str(flags.reason)?.trim();
  // 默认 not_in_turn：这个命令存在的理由就是按轮执行的 harness 表达「人不在轮次里」。
  const reason: ReceiptReason = rawReason === undefined || rawReason === "" ? "not_in_turn" : (rawReason as ReceiptReason);
  if (!isReason(reason)) {
    console.error(`reason must be one of: ${REASONS.join(", ")}`);
    return 1;
  }
  const note = str(flags.message)?.trim();
  const channel = resolveChannel(str(flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    if (flags["no-reply"] === true) {
      const result = await ackDelivery(auth.server, auth.token, channel, seq);
      settleClaudeDeliveryRecovery(auth.server, auth.token, channel, result.delivery.id);
      if (flags.json === true) {
        console.log(JSON.stringify({
          type: "delivery_ack",
          channel,
          seq,
          delivery_id: result.delivery.id,
          state: result.delivery.state,
          terminal_reason: "acknowledged_no_reply",
          deduped: result.deduped === true,
        }));
      } else {
        console.log(
          `receipt (acknowledged_no_reply) on #${seq}; no channel message was created` +
            (result.deduped === true ? " (already settled)" : ""),
        );
      }
      return 0;
    }
    const result = await postReceipt(auth.server, auth.token, channel, seq, {
      reason,
      ...(note === undefined || note === "" ? {} : { note }),
    });
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame(result.message as unknown as Record<string, unknown>)));
    } else {
      console.log(`receipt (${reason}) on #${seq}`);
      console.log(formatMsg(result.message));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
