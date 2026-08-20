// party ack — 显式了结 watch 欠账（#594）：纯读场景（读到别人的 status/不需要回应的消息）
// 没有合法的清账手段，被迫发一条无信息量的消息——这正是频道礼仪劝阻的行为。
// 只清 watch 源的债；serve 的 directed 债由 serve 闭环自己管（误清=静默丢 @，#198 红线）。
//
// #668/#674：深积压场景下逐条 `ack --seq N` 是 O(n) 空转。加 --all / --through / --before：
// 一条命令把游标推到（head / 指定 seq）并清掉这之前的全部 pending watch 债，「从现在起只看新的」。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { ackWatchStuck, drainWatchStuck, resolveChannel } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { fetchRecentMessages, handleRestError } from "../rest";
import { isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const FLAGS = ["channel", "seq", "all", "through", "before"];
// #860①：同族命令（receipt/revise/capture/decision）的位置参数都是 seq，只有 ack 是频道 slug，
// 而 SLUG_RE 收下纯数字串 → `party ack 1841` 曾静默读一个不存在的频道并 exit 0（用户以为债清了）。
export const NUMERIC_POSITIONAL_ERROR =
  "party ack takes a CHANNEL as its positional argument, not a seq — " +
  "`party ack <seq>` would silently read a channel named after that number. " +
  "Did you mean: party ack --seq N (or: party ack --channel C)?";
// #860②：--seq 从来不是 repeatable（本地 watch 债本身就是单值的），旧行为是后者覆盖前者，
// 于是 `--seq 5 --seq 7` 静默只 ack 7。宁可报错，也不静默丢一条。
export const REPEATED_SEQ_ERROR =
  "--seq may be given only once: party ack clears a single local watch wake debt, " +
  "so `--seq A --seq B` would silently drop A. Use `party ack --through B` to clear everything up to B.";
const HELP = `usage: party ack [channel|--channel C] [--seq N | --all | --through N | --before N]

Acknowledge the pending watch wake debt without posting a message. Use it after
a watch --once delivered a frame that warrants no reply (someone else's status,
FYI messages) — replying with empty acks burns the loop guard; leaving the debt
unacknowledged makes every later watch replay the same frame (#594).

For a deep backlog, --all / --through / --before drain in one command instead of
acking one seq per re-mount (#668/#674): they advance the read cursor and clear
all pending watch wake debt up through the target, so watch only wakes on NEW
messages from there.

Only watch-sourced debt can be acked. Debt owned by party serve is never touched
here: serve replays it durably and clearing it by hand would silently drop an @.

LOCAL ONLY — this does NOT clear \`pending_mention_seqs\` (#859). There are two
separate ledgers and this command writes only the first:
  · LOCAL watch replay state (a file next to your config) — what \`party ack\` clears.
    Clearing it stops YOUR watch from replaying that frame.
  · SERVER-side @ delivery debt — what \`party who --json\` reports as
    unhandled_mention_count / pending_mention_seqs. \`party ack\` sends no request
    to the server and can never change it.
To settle the server ledger you must answer the @: \`party send "…" --reply-to N\`
(list several when one reply settles them all: \`--reply-to A,B\`). An @ you ack
locally but never reply to stays owed server-side until its delivery lease expires,
and is then recorded as a FAILED delivery with terminal_reason=unknown_outcome —
so for an @ that deserves a one-liner, send the one-liner with --reply-to.

Options:
  --channel C   channel to ack in (defaults to the bound channel)
  --seq N       acknowledge through exactly N; a newer pending wake is preserved
                (single-valued: repeating --seq is an error, not a merge)
  --all         drain: advance cursor to channel head + clear all pending watch debt
  --through N   drain everything up to and including seq N (advance cursor to N)
  --before N    drain everything strictly before seq N (advance cursor to N-1)

A successful later \`party send\` or status update acknowledges an earlier watch wake.
Use \`party ack --seq N\` when no channel message is warranted (and remember: that
leaves the server-side @ debt for seq N standing — see LOCAL ONLY above).`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  // #860②：把 --seq 收成数组只为「重复给了几次」可见——重复即报错，绝不静默取最后一个。
  const { positionals, flags } = parseArgs(argv, { booleans: ["all"], repeatable: ["seq"] });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const seqValues = Array.isArray(flags.seq) ? flags.seq : flags.seq === undefined ? [] : [flags.seq];
  if (seqValues.length > 1) {
    console.error(REPEATED_SEQ_ERROR);
    return 1;
  }
  // 归一回单值，后续（互斥判定、parsePositiveIntFlag）保持原语义。
  if (seqValues.length === 1) flags.seq = seqValues[0]!;
  else delete flags.seq;
  const flagError = valueFlagError(flags, ["channel", "seq", "through", "before"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  // #860①：纯数字位置参数几乎一定是 seq 被当成频道名了——静默 no-op + exit 0 是最坏的结果。
  const positional = positionals[0];
  if (positional !== undefined && /^[0-9]+$/.test(positional)) {
    console.error(NUMERIC_POSITIONAL_ERROR);
    return 1;
  }
  // --seq / --all / --through / --before 互斥：混用语义含糊，直接拒绝。
  const drainSelectors = [
    flags.all === true ? "--all" : null,
    flags.through !== undefined ? "--through" : null,
    flags.before !== undefined ? "--before" : null,
    flags.seq !== undefined ? "--seq" : null,
  ].filter((f): f is string => f !== null);
  if (drainSelectors.length > 1) {
    console.error(`mutually exclusive selectors: ${drainSelectors.join(", ")} — pass at most one`);
    return 1;
  }
  const seqFlag = parsePositiveIntFlag(str(flags.seq), "seq");
  if (typeof seqFlag === "string") {
    console.error(seqFlag);
    return 1;
  }
  const throughFlag = parsePositiveIntFlag(str(flags.through), "through");
  if (typeof throughFlag === "string") {
    console.error(throughFlag);
    return 1;
  }
  const beforeFlag = parseNonNegativeIntFlag(str(flags.before), "before");
  if (typeof beforeFlag === "string") {
    console.error(beforeFlag);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }

  // --all / --through / --before：批量排空（#668/#674）。
  if (flags.all === true || throughFlag !== undefined || beforeFlag !== undefined) {
    let throughSeq: number;
    if (flags.all === true) {
      // --all：查频道 head，把游标推到 head，清 head 及之前的全部 watch 债。
      const auth = await resolveAuthDetailed();
      if (!auth.server || !auth.token) {
        console.error("no config, run: party login or party init --server URL --token T");
        return 1;
      }
      try {
        const tail = await fetchRecentMessages(auth.server, auth.token, channel, 1);
        throughSeq = tail.at(-1)?.seq ?? 0;
      } catch (e) {
        return handleRestError(e);
      }
    } else if (throughFlag !== undefined) {
      throughSeq = throughFlag;
    } else {
      // --before N：清严格早于 N 的债，游标推到 N-1。
      throughSeq = Math.max(0, (beforeFlag as number) - 1);
    }
    const drained = drainWatchStuck(channel, throughSeq);
    if (drained.outcome === "serve_owned") {
      console.log(
        `advanced cursor to seq=${drained.cursor} in #${channel}, but pending debt at seq=${drained.seq} is ` +
          `owned by party serve (source=${drained.source}) — preserved, not cleared (serve replays it durably).`,
      );
      return 0;
    }
    console.log(
      drained.clearedSeq !== null
        ? `drained #${channel}: cleared pending watch wake seq=${drained.clearedSeq}, cursor advanced to seq=${drained.cursor}`
        : `drained #${channel}: no pending watch wake debt, cursor advanced to seq=${drained.cursor}`,
    );
    return 0;
  }

  // 单条 ack（默认）：校验与清除同处一个跨进程临界区（ackWatchStuck）：读后清会误吞窗口内新落的债（#599 评审）。
  const acked = ackWatchStuck(channel, seqFlag);
  switch (acked.outcome) {
    case "none":
      console.log(`no pending wake debt in #${channel}`);
      return 0;
    case "serve_owned":
      console.error(
        `refusing to ack: pending debt at seq=${acked.seq} is owned by party serve (source=${acked.source}); ` +
          "serve replays it durably — clearing it by hand would silently drop that @",
      );
      return 1;
    case "seq_mismatch":
      console.error(
        `refusing to ack seq=${seqFlag}: older pending watch debt seq=${acked.seq} must be handled first` +
          " (or explicitly drain with --through)",
      );
      return 1;
    case "acknowledged_prior":
      console.log(
        `acked watch wake through seq=${acked.seq} in #${channel}; ` +
          `newer pending wake seq=${acked.pendingSeq} was preserved`,
      );
      return 0;
    case "cleared":
      console.log(`acked watch wake seq=${acked.seq} in #${channel}`);
      return 0;
  }
}
