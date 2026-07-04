// party search — 在频道历史里按子串搜（客户端过滤，复用 REST history）。#25 的 CLI 半边。
// 大频道消息一多，人和 supervisor 都得能定位——body/note/sender 命中即返回，支持 --json。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { fetchMessages, handleRestError } from "../rest";
import { formatMsg } from "../format";
import { isSlug, parsePositiveIntFlag } from "../validation";
import { jsonFrame } from "../json";

const SEARCH_FLAGS = ["channel", "limit", "json"];
const HELP = `usage: party search <query> [--channel C] [--limit n] [--json]

Search a channel's history for messages whose body/note or sender contains <query> (case-insensitive).

Options:
  --channel C   search channel C instead of the bound channel
  --limit n     max messages to fetch and scan (default 1000, max 5000)
  --json        emit matching messages as agentparty.v1 NDJSON frames`;

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
  const unknown = unknownFlagError(flags, SEARCH_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "limit"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  // 首个 positional 是 query（不是 channel——channel 走 --channel 或绑定频道）
  const query = positionals[0];
  if (!query) {
    console.error("need a query: party search <query> [--channel C]");
    return 1;
  }
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 5000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const channel = resolveChannel(str(flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  try {
    const messages = await fetchMessages(cfg.server, cfg.token, channel, 0, limit ?? 1000);
    const q = query.toLowerCase();
    const hits = messages.filter((m) => {
      const text = m.kind === "message" ? m.body : (m.note ?? "");
      return text.toLowerCase().includes(q) || m.sender.name.toLowerCase().includes(q);
    });
    for (const m of hits) {
      console.log(
        flags.json === true
          ? JSON.stringify(jsonFrame(m as unknown as Record<string, unknown>))
          : formatMsg(m),
      );
    }
    // 人类模式无命中给条 stderr 提示；--json 模式保持 stdout 干净（0 行即无命中）
    if (flags.json !== true && hits.length === 0) {
      console.error(`no matches for "${query}" in #${channel}`);
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
