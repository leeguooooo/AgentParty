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
import { handleRestError, postReceipt } from "../rest";
import { isSlug } from "../validation";

type ReceiptReason = "not_in_turn" | "queued" | "seen";

const REASONS: ReceiptReason[] = ["not_in_turn", "queued", "seen"];
const FLAGS = ["channel", "reason", "message", "json"];
const HELP = `usage:
  party receipt <seq> [--reason not_in_turn|queued|seen] [-m note] [--channel C] [--json]

Mark a message as received without replying to it. The receipt is metadata on
that message — it takes no seq, stays out of the message flow, triggers no
delivery, and needs no ack. Re-receipting the same message updates in place.

Reasons:
  not_in_turn   (default) received it, but this harness is not in a turn now
  queued        it is in my queue; I am busy and will get to it
  seen          saw it; no commitment to act

Options:
  --channel C   receipt in channel C instead of the bound channel
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
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"], aliases: { m: "message" } });
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
  if (seqArg === undefined || !/^[1-9]\d*$/.test(seqArg)) {
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
    const result = await postReceipt(auth.server, auth.token, channel, Number(seqArg), {
      reason,
      ...(note === undefined || note === "" ? {} : { note }),
    });
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame(result.message as unknown as Record<string, unknown>)));
    } else {
      console.log(`receipt (${reason}) on #${seqArg}`);
      console.log(formatMsg(result.message));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
