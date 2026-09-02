// party notify-when-idle <agent> [--channel C]（#1052 #5，wake protocol v2 §2）。
//
// 一次性订阅：<agent> 下一次由忙转闲（或离线）时，给我的会话注入一条
// `[Cross-session idle notice] …`——不发消息、不进频道、不用轮询。目标此刻已空闲 ⇒ 立即触发；
// 6 小时到期未触发 ⇒ 发一条过期通知。语义与 Claude Code 内置 SendMessage 的 notify_when_idle 一致。
// 顺带发消息用 `party send … --notify-when-idle`。
import { mentionMatchKey } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuthDetailed } from "../oidc-cli";
import { isName, isSlug } from "../validation";
import { subscribeIdleNotices } from "./send";

export const notifyWhenIdleSpec = { booleans: ["json"] };
const FLAGS = ["channel", "json"];
const HELP = `usage: party notify-when-idle <agent> [--channel C] [--json]

Subscribe ONCE to <agent>'s next busy→idle transition in the channel. When it flips
(or exits), one "[Cross-session idle notice]" is injected into your own session — the
same path an @-mention wake uses — and nothing is posted to the channel. If <agent>
is already idle the notice arrives immediately. The subscription expires after 6h
with an "expired" notice. Sends no message; to send and subscribe in one go use
party send <text> --mention <agent> --notify-when-idle.

Options:
  --channel C   channel to watch in (defaults to the bound channel)
  --json        print the server result as JSON`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv)) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseArgs(argv, notifyWhenIdleSpec);
  const unknown = unknownFlagError(parsed.flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(parsed.flags, ["channel"], []);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const target = parsed.positionals[0];
  if (target === undefined || parsed.positionals.length !== 1) {
    console.error(HELP);
    return 1;
  }
  if (!isName(target)) {
    console.error("agent must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  if (mentionMatchKey(target) === "system") {
    console.error("cannot subscribe to reserved name system");
    return 1;
  }
  const channel = resolveChannel(str(parsed.flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const [result] = await subscribeIdleNotices(auth.server, auth.token, channel, [target]);
  if (result === undefined) return 1;
  if (parsed.flags.json === true) {
    console.log(JSON.stringify({ target, channel, ok: result.ok, detail: result.line }));
  } else {
    (result.ok ? console.log : console.error)(result.line);
  }
  return result.ok ? 0 : 1;
}
