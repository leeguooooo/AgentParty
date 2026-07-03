// party send — rest 一次性发消息，成功后推进游标
import { parseArgs, str, strArray, unknownFlagError, valueFlagError, type Parsed } from "../args";
import { readConfig, resolveChannel, saveCursor, type Config } from "../config";
import { handleRestError, postMessage } from "../rest";
import { isName, isSlug, parsePositiveIntFlag } from "../validation";

export const sendSpec = { repeatable: ["mention"] };
const SEND_FLAGS = ["channel", "reply-to", "mention"];

export interface SendInput {
  channel: string;
  body: string;
  mentions: string[];
  replyTo: number | null;
}

export async function resolveSendInput(parsed: Parsed): Promise<SendInput | null> {
  const { positionals, flags } = parsed;
  const unknown = unknownFlagError(flags, SEND_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return null;
  }
  const flagError = valueFlagError(flags, ["channel", "reply-to"], ["mention"]);
  if (flagError !== null) {
    console.error(flagError);
    return null;
  }
  const replyTo = parsePositiveIntFlag(str(flags["reply-to"]), "reply-to");
  if (typeof replyTo === "string") {
    console.error(replyTo);
    return null;
  }
  const explicit = str(flags.channel);
  let text = positionals.length > 0 ? positionals.join(" ") : undefined;
  const channel = resolveChannel(explicit);
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return null;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return null;
  }
  if (text === undefined) {
    console.error("missing message body (use - to read stdin)");
    return null;
  }
  if (text === "-" && (!parsed.terminated || (parsed.terminatedAt ?? 0) > 0)) {
    text = await Bun.stdin.text();
  }
  const mentions = strArray(flags.mention) ?? [];
  if (mentions.some((mention) => !isName(mention))) {
    console.error("--mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return null;
  }
  return {
    channel,
    body: text,
    mentions,
    replyTo: replyTo ?? null,
  };
}

export async function doSend(cfg: Config, input: SendInput): Promise<number | { seq: number }> {
  try {
    const { seq } = await postMessage(cfg.server, cfg.token, input.channel, {
      kind: "message",
      body: input.body,
      mentions: input.mentions,
      reply_to: input.replyTo,
    });
    saveCursor(input.channel, seq);
    return { seq };
  } catch (e) {
    return handleRestError(e);
  }
}

export async function run(argv: string[]): Promise<number> {
  const cfg = readConfig();
  if (!cfg) {
    console.error("no config, run: party init --server URL --token T");
    return 1;
  }
  const input = await resolveSendInput(parseArgs(argv, sendSpec));
  if (!input) return 1;
  const result = await doSend(cfg, input);
  if (typeof result === "number") return result;
  console.log(`sent seq=${result.seq}`);
  return 0;
}
