// party watch — 补拉错过消息，阻塞等新消息
import { EXIT_ARCHIVED, EXIT_AUTH, EXIT_LOOP_GUARD, EXIT_STREAM_ENDED, EXIT_TIMEOUT } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { connect } from "../client";
import { loadCursor, loadRevCursor, resolveChannel, saveCursor, saveRevCursor } from "../config";
import { resolveAuth } from "../oidc-cli";
import { formatMsg } from "../format";
import { MAX_TIMEOUT_SEC, isSlug, parsePositiveIntFlag } from "../validation";
import { jsonFrame, nowTs } from "../json";
import {
  clearStatuslineListener,
  heartbeatPatch,
  lastMessageFromFrame,
  localStatuslineBase,
  unreadFromCursor,
  writeStatuslineCache,
} from "../statusline-cache";

const WATCH_FLAGS = ["channel", "timeout", "follow", "once", "mentions-only", "exclude-self", "json"];
const HELP = `usage: party watch [channel|--channel C] [--timeout N] [--mentions-only] [--exclude-self] [--follow|--once] [--json]

Watch a channel for new messages. By default this waits up to 240 seconds.
With --follow, it stays attached unless --timeout N is explicit.
With --once, it stays attached until the FIRST matching message, prints it, and
exits 0 — made for harness background tasks (e.g. Claude Code run_in_background):
the process exit is the wake signal, so the mention lands in your EXISTING
session with its context intact.
Self messages are skipped by default; --exclude-self is accepted as an explicit
automation hint for scripts that want to document that behavior.

Options:
  --channel C       watch channel C instead of the bound channel
  --timeout N       stop after N seconds
  --mentions-only   print only non-self messages that mention this agent
  --exclude-self    explicitly skip this agent's own messages (default)
  --follow          keep watching after the first matching message
  --once            exit 0 right after the first matching message
  --json            emit structured NDJSON frames`;

export interface WatchOptions {
  server: string;
  token: string;
  channel: string;
  since: number;
  sinceRev?: number; // 修订游标（hello.since_rev），服务端据此限定修订重放
  timeoutSec: number;
  follow: boolean;
  mentionsOnly: boolean;
  once?: boolean; // 第一条匹配消息后立即退出 0（harness 后台任务的唤醒信号）
  json?: boolean; // 输出 NDJSON 帧而非人类格式，供 supervisor/工具消费
  onCursor?: (cursor: number) => void;
  onRevCursor?: (revCursor: number) => void;
  out?: (line: string) => void;
  backoffBaseMs?: number;
  statusline?: boolean;
}

export function resolveWatchTimeoutSec(timeout: number | undefined, indefinite: boolean): number {
  if (typeof timeout === "number") return timeout;
  return indefinite ? 0 : 240;
}

export async function runWatch(o: WatchOptions): Promise<number> {
  const out = o.out ?? ((line: string) => console.log(line));
  const conn = connect(o.server, o.token, o.channel, o.since, {
    onCursor: o.onCursor,
    sinceRev: o.sinceRev,
    onRevCursor: o.onRevCursor,
    backoffBaseMs: o.backoffBaseMs,
  });

  let self = "";
  let lastSeq = 0;
  let printed = 0;
  let timedOut = false;
  let onceDone = false;
  let code = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (o.timeoutSec > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      conn.close();
    }, o.timeoutSec * 1000);
  }

  try {
    for await (const frame of conn.frames) {
      if (frame.type === "welcome") {
        self = frame.self;
        lastSeq = frame.last_seq;
        if (o.statusline === true) {
          writeStatuslineCache({
            ...localStatuslineBase(o.channel),
            ...heartbeatPatch("watch"),
            unread: unreadFromCursor(lastSeq, o.channel),
          });
        }
        continue;
      }
      if (frame.type === "error") {
        if (o.json) {
          out(JSON.stringify(jsonFrame({ ...frame, retryable: false, ts: nowTs() })));
        }
        else console.error(`error: ${frame.code} ${frame.message}`);
        if (frame.code === "unauthorized") code = EXIT_AUTH;
        else if (frame.code === "loop_guard") code = EXIT_LOOP_GUARD;
        else if (frame.code === "archived") code = EXIT_ARCHIVED;
        else code = 1;
        break;
      }
      const msg = frame.type === "message_update" ? frame.message : frame;
      if (msg.type !== "msg" && msg.type !== "status") continue;
      const fromSelf = msg.sender.name === self;
      const qualifies = !fromSelf && (!o.mentionsOnly || msg.mentions.includes(self));
      if (qualifies) {
        out(o.json ? JSON.stringify(jsonFrame(frame as unknown as Record<string, unknown>)) : formatMsg(msg));
        printed++;
      }
      // fresh = 游标之上的新消息。重放的历史修订快照（seq 早已消费过）会穿透去重进来
      // ——它们可以照常打印（展示编辑是 feature），但绝不能算「唤醒」（曾把 --once 假唤醒）
      const fresh = msg.seq > conn.cursor;
      // 打印（或有意跳过）之后才推进游标，退出时入队未消费的消息留给下次补拉
      if (msg.seq > 0) conn.ack(msg.seq);
      if (o.statusline === true) {
        const latestSeq = Math.max(lastSeq, msg.seq);
        writeStatuslineCache({
          ...localStatuslineBase(o.channel),
          ...heartbeatPatch("watch"),
          unread: unreadFromCursor(latestSeq, o.channel),
          last_message: lastMessageFromFrame(msg),
        });
      }
      // watch --follow 是流式在读整个频道：把已读游标回给服务端，agent 的已读状态因此成立（Phase 2）。
      // 只在 follow 下发；--once / 非 follow 是「查有没有 @ 我再退」的事件驱动路径，不算逐条已读，
      // 其送达/唤醒由 wake 回执表达（不假装 agent 逐条读了频道）。只对游标之上的新消息发。
      if (o.follow && fresh && msg.seq > 0) conn.send({ type: "seen", seq: msg.seq });
      // --once：第一条匹配的【新】消息即完成——游标已推进，进程退出就是 harness 的唤醒信号
      if (o.once && qualifies && fresh) {
        onceDone = true;
        break;
      }
      // 补拉排空（seq 追平 welcome.last_seq）且已有输出即视为收到新消息；自己的消息也参与排空判定
      if (!o.follow && !o.once && printed > 0 && msg.seq >= lastSeq) break;
    }
  } finally {
    if (timer) clearTimeout(timer);
    conn.close();
    if (o.statusline === true) clearStatuslineListener();
  }

  // 超时判定：--once 只有 onceDone 才算被唤醒（打印过重放的修订快照不算）；
  // 非 follow/once 沿用「打印过即成功」；follow 超时一律 TIMEOUT
  const unfulfilled = o.once === true ? !onceDone : printed === 0;
  if (timedOut && (o.follow || unfulfilled)) {
    out(o.json ? JSON.stringify(jsonFrame({ type: "timeout", channel: o.channel, timeout_sec: o.timeoutSec, ts: nowTs() })) : "TIMEOUT");
    return EXIT_TIMEOUT;
  }
  // --follow / 未完成的 --once：迭代器结束却既非超时也非终局 error，意味着连接层彻底放弃 /
  // 帧流意外中断。静默 return 0 会让 supervisor（或把退出当唤醒信号的 harness）误判为正常
  // 收尾（issue #29）。输出机器可读的退出原因并返回非零码，让上游能看到失败并重启。
  if ((o.follow || (o.once === true && !onceDone)) && !timedOut && code === 0) {
    if (o.json) {
      out(JSON.stringify(jsonFrame({ type: "watch_exited", reason: "stream_ended", channel: o.channel, ts: nowTs() })));
    } else {
      console.error("watch exited: stream ended unexpectedly");
    }
    return EXIT_STREAM_ENDED;
  }
  return code;
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["follow", "once", "mentions-only", "exclude-self", "json"] });
  if (flags.follow === true && flags.once === true) {
    console.error("--follow and --once are mutually exclusive: follow keeps watching, once exits after the first match");
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, WATCH_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "timeout"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const timeout = parsePositiveIntFlag(str(flags.timeout), "timeout", MAX_TIMEOUT_SEC);
  if (typeof timeout === "string") {
    console.error(timeout);
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
  return runWatch({
    server: cfg.server,
    token: cfg.token,
    channel,
    since: loadCursor(channel),
    sinceRev: loadRevCursor(channel),
    timeoutSec: resolveWatchTimeoutSec(timeout, flags.follow === true || flags.once === true),
    follow: flags.follow === true,
    once: flags.once === true,
    mentionsOnly: flags["mentions-only"] === true,
    json: flags.json === true,
    onCursor: (c) => saveCursor(channel, c),
    onRevCursor: (r) => saveRevCursor(channel, r),
    statusline: true,
  });
}
