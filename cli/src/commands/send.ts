// party send — rest 一次性发消息，成功后推进游标
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError, type Parsed } from "../args";
import { resolveChannel, saveCursor, type Config } from "../config";
import { formatAuthDebugLine, resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, fetchPresence, handleRestError, postMessage } from "../rest";
import { formatReachLine, reachOf } from "../reach";
import { localStatuslineBase, statuslinePreview, unreadFromCursor, writeStatuslineCache } from "../statusline-cache";
import { isName, isSlug, parsePositiveIntFlag } from "../validation";

export const sendSpec = { repeatable: ["mention"], booleans: ["debug-auth", "reach", "no-reach"] };
const SEND_FLAGS = ["channel", "reply-to", "mention", "debug-auth", "reach", "no-reach"];
const HELP = `usage: party send <text|-> [--channel C] [--mention name]... [--reply-to seq] [--debug-auth]

Send one message to a channel. Use "-" as the body to read stdin.

After a send with --mention, a reachability line prints to stderr — whether each
target is ● online / ◐ wakeable / ○ offline (won't reach until it reconnects).
On by default in an interactive terminal; --reach forces it, --no-reach silences it.

Options:
  --channel C      send to channel C instead of the bound channel
  --mention name   mention a user or agent; repeatable
  --reply-to seq   attach this message as a reply to seq
  --reach          show mention reachability even when not a TTY (agent loops)
  --no-reach       never show mention reachability
  --debug-auth     print resolved auth/config source to stderr`;

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
  // 尾部裸 `-`（未被 `--` 字面化）表示正文来自 stdin；仅在此 stdin 语境下首个 positional 才可作 channel，
  // 即 `send <slug> -`，不给普通 `send <body...>` 重新引入隐式 channel 歧义
  const lastIdx = positionals.length - 1;
  const trailingStdin =
    positionals.length > 0 &&
    positionals[lastIdx] === "-" &&
    !(parsed.terminated && lastIdx >= (parsed.terminatedAt ?? 0));

  let channelArg = explicit;
  let text: string | undefined;
  let readStdin = false;
  if (trailingStdin && !explicit && positionals.length === 2) {
    channelArg = positionals[0]; // send <slug> -
    readStdin = true;
  } else if (trailingStdin && positionals.length === 1) {
    readStdin = true; // send -、send --channel C -、send - --
  } else {
    text = positionals.length > 0 ? positionals.join(" ") : undefined;
  }

  const channel = resolveChannel(channelArg);
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return null;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return null;
  }
  if (readStdin) {
    text = await Bun.stdin.text();
  } else if (text === undefined) {
    console.error("missing message body (use - to read stdin)");
    return null;
  }
  // send footgun 软提示（#6）：无 --channel、≥2 个裸 positional、首个像 slug 且 ≠ 目标频道 →
  // 很可能误把「send <频道> <正文>」当成了子命令用法（首个词其实被并进了正文，发到了绑定频道）。
  // 只提示不拦截：消息照发，仅 stderr 一行帮用户下次用 --channel。
  if (!explicit && !readStdin && positionals.length >= 2 && isSlug(positionals[0]) && positionals[0] !== channel) {
    console.error(
      `note: 正发到绑定频道「${channel}」；若想发到「${positionals[0]}」，用：party send --channel ${positionals[0]} "..."（首个词已被当作正文的一部分）`,
    );
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
    writeStatuslineCache({
      ...localStatuslineBase(input.channel),
      unread: unreadFromCursor(seq, input.channel),
      last_message: {
        from: readLocalIdentityName(cfg) ?? "me",
        ts: Date.now(),
        preview: statuslinePreview(input.body),
      },
    });
    return { seq };
  } catch (e) {
    return handleRestError(e);
  }
}

function readLocalIdentityName(cfg: Config): string | null {
  return cfg.identity?.name ?? null;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv)) {
    console.log(HELP);
    return 0;
  }
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const parsed = parseArgs(argv, sendSpec);
  const input = await resolveSendInput(parsed);
  if (!input) return 1;
  if (parsed.flags["debug-auth"] === true || process.env.AGENTPARTY_DEBUG_AUTH === "1") {
    try {
      console.error(formatAuthDebugLine(auth, await fetchMe(auth.server, auth.token)));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${formatAuthDebugLine(auth)} runtime-error=${message}`);
    }
  }
  const result = await doSend({ server: auth.server, token: auth.token }, input);
  if (typeof result === "number") return result;
  console.log(`sent seq=${result.seq}`);
  await showReach(auth.server, auth.token, parsed, input);
  return 0;
}

// 发送后的可达性反馈：@ 的目标现在能不能收到。默认仅交互终端下开（脚本/agent 循环不额外拉 presence），
// --reach 强开、--no-reach 关。拉不到 presence 不影响已发成功（只是没这行提示）。
async function showReach(server: string, token: string, parsed: Parsed, input: SendInput): Promise<void> {
  const want =
    parsed.flags.reach === true ? true : parsed.flags["no-reach"] === true ? false : Boolean(process.stdout.isTTY);
  if (!want || input.mentions.length === 0) return;
  try {
    const presence = await fetchPresence(server, token, input.channel);
    const now = Date.now();
    console.error(formatReachLine(input.mentions.map((m) => reachOf(m, presence, now))));
  } catch {
    /* 锦上添花：presence 拉取失败不报错，消息已发成功 */
  }
}
