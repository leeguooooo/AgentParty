// party history — rest 拉历史消息
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, fetchRecentMessages, handleRestError } from "../rest";
import { formatMsg } from "../format";
import { isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";
import { jsonFrame } from "../json";

const HISTORY_FLAGS = ["channel", "since", "before", "limit", "json", "completion"];
const HELP = `usage: party history [channel|--channel C] [--since seq | --before seq] [--limit n] [--json] [--completion]

Fetch channel messages over REST. By default returns the MOST RECENT --limit messages.

Options:
  --channel C   read channel C instead of the bound channel
  --since seq   only return messages after seq (use --since 0 to read from the very beginning)
  --before seq  return the most recent messages before seq (mutually exclusive with --since)
  --limit n     maximum messages to return (default 100)
  --json        emit structured NDJSON frames
  --completion  only return final synthesis completion artifacts`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"] });
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
  const flagError = valueFlagError(flags, ["channel", "since", "before", "limit"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  // --since 与 --before 互斥：分页方向不能同时指定两端，否则语义不明确
  if (flags.since !== undefined && flags.before !== undefined) {
    console.error("--since and --before are mutually exclusive");
    return 1;
  }
  const since = parseNonNegativeIntFlag(str(flags.since), "since");
  if (typeof since === "string") {
    console.error(since);
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
  try {
    const resolvedLimit = limit ?? 100;
    const opts = { completion: flags.completion === true };
    // flag 是否存在才决定走向——显式 --since 0 仍是「从头读」，不能用值是否为 0 来判断
    const messages =
      flags.since !== undefined
        ? await fetchMessages(cfg.server, cfg.token, channel, since ?? 0, resolvedLimit, opts)
        : flags.before !== undefined
          ? await fetchMessages(cfg.server, cfg.token, channel, 0, resolvedLimit, { ...opts, before: before ?? 0 })
          : await fetchRecentMessages(cfg.server, cfg.token, channel, resolvedLimit, opts);
    // --json：每条一行 NDJSON（原始 msg 帧 + schema），供 supervisor/工具消费，免 scrape 人类格式
    for (const m of messages) {
      console.log(flags.json === true ? JSON.stringify(jsonFrame(m as unknown as Record<string, unknown>)) : formatMsg(m));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
