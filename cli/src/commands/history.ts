// party history — rest 拉历史消息
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, fetchRecentMessages, handleRestError } from "../rest";
import {
  DEFAULT_HEADER_PREVIEW,
  collapseRuns,
  formatHistoryTs,
  formatMsg,
  formatMsgHeader,
  historyCollapseKey,
  msgHeader,
  stripSeqPrefix,
} from "../format";
import type { MsgFrame } from "@agentparty/shared";
import { isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";
import { jsonFrame } from "../json";

const HISTORY_FLAGS = [
  "channel",
  "since",
  "before",
  "limit",
  "json",
  "completion",
  "headers",
  "preview",
  "seq",
  "exclude-status",
  "no-ts",
  "no-collapse",
];
const HELP = `usage: party history [channel|--channel C] [--since seq | --before seq | --seq N] [--limit n]
                    [--headers [--preview n]] [--exclude-status] [--no-ts] [--no-collapse]
                    [--json] [--completion]

Fetch channel messages over REST. By default returns the MOST RECENT --limit messages.
Plain-text lines start with a local-time HH:MM:SS stamp (a date is added when the day changes or
is not today). Consecutive frames from the same sender with identical content are folded into one
line like "[3–15] ×13 sender: …" so a flood reads as "one note, repeated 13 times".

Options:
  --channel C        read channel C instead of the bound channel
  --since seq        only return messages after seq (use --since 0 to read from the very beginning)
  --before seq       return the most recent messages before seq (mutually exclusive with --since)
  --seq N            return only message N, in full (the "expand one header" path)
  --limit n          maximum messages to return (default 100)
  --headers          one line per message: seq/sender/kind/mentions/reply_to/length + a body preview.
                     Rebuilding channel context every turn costs far less this way; expand the ones
                     that matter with --seq N.
  --preview n        preview characters per message in --headers mode (default ${DEFAULT_HEADER_PREVIEW}, 0 = none)
  --exclude-status   drop status frames (presence churn, usually repeated notes)
  --no-ts            drop the per-line timestamp (plain text only; --json always carries raw ts)
  --no-collapse      print every frame on its own line instead of folding identical runs
                     (plain text only; --json never folds)
  --json             emit structured NDJSON frames (in --headers mode: one header object per line)
  --completion       only return final synthesis completion artifacts`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {
    booleans: ["json", "headers", "exclude-status", "no-ts", "no-collapse"],
  });
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, HISTORY_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "since", "before", "limit", "preview", "seq"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  // --since 与 --before 互斥：分页方向不能同时指定两端，否则语义不明确
  if (flags.since !== undefined && flags.before !== undefined) {
    console.error("--since and --before are mutually exclusive");
    return 1;
  }
  // --seq 是「按 header 挑出来的那条展开看全文」，自带定位，和分页 flag 同时给语义冲突。
  if (flags.seq !== undefined && (flags.since !== undefined || flags.before !== undefined)) {
    console.error("--seq is exclusive with --since/--before (it already selects one message)");
    return 1;
  }
  if (flags.seq !== undefined && flags.headers === true) {
    console.error("--seq returns one message in full; drop --headers (that is the point of --seq)");
    return 1;
  }
  const seqOnly = parsePositiveIntFlag(str(flags.seq), "seq");
  if (typeof seqOnly === "string") {
    console.error(seqOnly);
    return 1;
  }
  // --preview 0 = 只要元数据、一个字正文都不要，所以下界是 0 而非 1。
  const preview = parseNonNegativeIntFlag(str(flags.preview), "preview");
  if (typeof preview === "string") {
    console.error(preview);
    return 1;
  }
  if (preview !== undefined && flags.headers !== true) {
    console.error("--preview only applies to --headers");
    return 1;
  }
  const since = parseNonNegativeIntFlag(str(flags.since), "since");
  if (typeof since === "string") {
    // #714：--since 收的是消息 seq（整数），不是时间戳。「since」这词强烈暗示时间，报错要点破语义，
    // 别只甩「必须是非负整数」让人一头雾水。
    console.error(`${since} — --since 需要消息 seq（整数），不是时间戳；先跑 party history <channel> 看当前 seq`);
    return 1;
  }
  const before = parseNonNegativeIntFlag(str(flags.before), "before");
  if (typeof before === "string") {
    console.error(before);
    return 1;
  }
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 1000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? positionals[0]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  // #962：纯文本每行的时间戳前缀。now 取一次，整页输出的「今天」口径一致。
  const now = Date.now();
  const stamp = (ts: number, prevTs: number | undefined): string =>
    flags["no-ts"] === true ? "" : `${formatHistoryTs(ts, prevTs, now)} `;
  try {
    const resolvedLimit = limit ?? 100;
    const opts = { completion: flags.completion === true };
    // flag 是否存在才决定走向——显式 --since 0 仍是「从头读」，不能用值是否为 0 来判断
    const fetched =
      seqOnly !== undefined
        ? // 目标那一条：since = N-1 取 1 条。服务端可能因过滤（如 --completion）返回别的，下面再核 seq。
          await fetchMessages(cfg.server, cfg.token, channel, seqOnly - 1, 1, opts)
        : flags.since !== undefined
          ? await fetchMessages(cfg.server, cfg.token, channel, since ?? 0, resolvedLimit, opts)
          : flags.before !== undefined
            ? await fetchMessages(cfg.server, cfg.token, channel, 0, resolvedLimit, { ...opts, before: before ?? 0 })
            : await fetchRecentMessages(cfg.server, cfg.token, channel, resolvedLimit, opts);
    if (seqOnly !== undefined) {
      const hit = fetched.find((m) => m.seq === seqOnly);
      if (!hit) {
        console.error(`no message ${seqOnly} in ${channel} (retracted, filtered, or out of range)`);
        return 1;
      }
      console.log(
        flags.json === true
          ? JSON.stringify(jsonFrame(hit as unknown as Record<string, unknown>))
          : `${stamp(hit.ts, undefined)}${formatMsg(hit)}`,
      );
      return 0;
    }
    // #819：status 帧的 note 常常是重复的同一句，混在 history 里逐条读没有信息量。
    const messages = flags["exclude-status"] === true ? fetched.filter((m) => m.kind !== "status") : fetched;
    const previewChars = preview ?? DEFAULT_HEADER_PREVIEW;
    // --json：每条一行 NDJSON（原始 msg 帧 + schema），供 supervisor/工具消费，免 scrape 人类格式。
    // 不折叠、不加时间戳前缀——帧里本来就带原始 ts。
    if (flags.json === true) {
      for (const m of messages) {
        console.log(
          flags.headers === true
            ? JSON.stringify(msgHeader(m, previewChars))
            : JSON.stringify(jsonFrame(m as unknown as Record<string, unknown>)),
        );
      }
      return 0;
    }
    // 纯文本（#962）：每行带时间戳；连续「同 sender、内容完全相同」的帧折叠成 `[a–b] ×n`。
    const render = (m: MsgFrame): string => (flags.headers === true ? formatMsgHeader(m, previewChars) : formatMsg(m));
    const runs =
      flags["no-collapse"] === true ? messages.map((m) => ({ items: [m] })) : collapseRuns(messages, historyCollapseKey);
    let prevTs: number | undefined;
    for (const run of runs) {
      const first = run.items[0]!;
      const last = run.items[run.items.length - 1]!;
      if (run.items.length === 1) {
        console.log(`${stamp(first.ts, prevTs)}${render(first)}`);
      } else {
        // 折叠行给首尾两个时间戳：「这 13 条隔多久来一条」正是这个 issue 要回答的问题。
        const span = flags["no-ts"] === true ? "" : `${formatHistoryTs(first.ts, prevTs, now)}–${formatHistoryTs(last.ts, first.ts, now)} `;
        console.log(`${span}[${first.seq}–${last.seq}] ×${run.items.length} ${stripSeqPrefix(render(first), first.seq)}`);
      }
      prevTs = last.ts;
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
