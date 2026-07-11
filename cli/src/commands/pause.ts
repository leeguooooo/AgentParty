// party pause / party resume（issue #180）——人为暂停/恢复某个 agent 在频道里的「接待」。
// 场景：某 agent 的 token/额度快用完了，人想让它先别再被 @ 唤醒，过一阵或到点再自动恢复。
// 暂停期：该 agent 被 @ 也不投 webhook、serve/watch 收到 paused presence 帧后自我抑制唤醒；
// 但消息照进频道历史，恢复后可从历史补看。moderator（频道房主 / ap_ token）才能操作。
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { resolveAuth } from "../oidc-cli";
import { handleRestError, pauseAgent, resumeAgent } from "../rest";
import { isSlug } from "../validation";

const PAUSE_FLAGS = ["channel", "resume-at", "for", "in"];
const HELP = `usage: party pause <name> [channel|--channel C] [--resume-at <ISO>|--for <dur>]
       party resume <name> [channel|--channel C]

Pause or resume an agent's reception in a channel (moderator only, issue #180).
While paused, the agent is NOT woken by @-mentions (webhook not fired, serve/watch
self-suppress), but messages still land in channel history for it to catch up on
after resuming.

Options:
  --channel C     act on channel C instead of the bound channel
  --resume-at T   auto-resume at ISO-8601 time T (e.g. 2026-07-11T18:00:00Z)
  --for D         auto-resume after a relative duration: 30m / 2h / 1d / 90s
Without --resume-at/--for the pause is open-ended (resume manually with: party resume <name>).`;

// +时长解析：90s / 30m / 2h / 1d → 毫秒。返回 null 表示格式非法。导出仅为单测。
export function parseDurationMs(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

// --resume-at ISO / --for dur → 绝对 epoch ms（未来）。0 = 没指定（开放式暂停）；null = 非法输入。
// 导出仅为单测。
export function resolveResumeAt(resumeAt: string | undefined, inDur: string | undefined, now: number): number | null {
  if (resumeAt !== undefined && inDur !== undefined) return null; // 两者互斥
  if (resumeAt !== undefined) {
    const ms = Date.parse(resumeAt);
    if (!Number.isFinite(ms) || ms <= now) return null;
    return ms;
  }
  if (inDur !== undefined) {
    const d = parseDurationMs(inDur);
    if (d === null || d <= 0) return null;
    return now + d;
  }
  return 0; // 0 = 没指定，开放式暂停（区别于「非法」的 null）
}

export async function run(cmd: "pause" | "resume", argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {});
  const unknown = unknownFlagError(flags, PAUSE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "resume-at", "for", "in"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const name = positionals[0];
  if (!name) {
    console.error(cmd === "pause" ? "usage: party pause <name> [--resume-at T|--in D]" : "usage: party resume <name>");
    return 1;
  }
  // 第二个位置参数（若非 name）可作频道，与其它命令一致
  const channel = resolveChannel(str(flags.channel) ?? positionals[1]);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  try {
    if (cmd === "resume") {
      await resumeAgent(cfg.server, cfg.token, channel, name);
      console.log(`resumed ${name} in ${channel}`);
      return 0;
    }
    const resumeAtStr = str(flags["resume-at"]);
    const durStr = str(flags.for) ?? str(flags.in);
    const resumeAt = resolveResumeAt(resumeAtStr, durStr, Date.now());
    if (resumeAt === null) {
      console.error("invalid time: use --resume-at <future ISO-8601> or --for <30m|2h|1d|90s> (not both)");
      return 1;
    }
    await pauseAgent(cfg.server, cfg.token, channel, name, resumeAt === 0 ? undefined : resumeAt);
    const when = resumeAt === 0 ? "" : ` until ${new Date(resumeAt).toISOString()}`;
    console.log(`paused ${name} in ${channel}${when} — @-mentions won't wake it${resumeAt === 0 ? " (resume with: party resume " + name + ")" : ""}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
