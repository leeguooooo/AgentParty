// party digest — structured catch-up over recent history, without claiming wake/resume.
import type { MsgFrame, StatusState } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { loadCursor, resolveChannel } from "../config";
import { jsonFrame, nowTs } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchMe, fetchMessages, handleRestError } from "../rest";
import { isName, isSlug, parseNonNegativeIntFlag, parsePositiveIntFlag } from "../validation";

const DIGEST_FLAGS = ["channel", "since", "limit", "for", "json"];
const HELP = `usage: party digest [channel|--channel C] [--since seq|last-seen] [--limit n] [--for name] [--json]

Summarize channel catch-up from structured history.

Options:
  --channel C         read channel C instead of the bound channel
  --since seq         only include messages after seq
  --since last-seen   use this workspace/channel cursor
  --limit n           maximum messages to scan
  --for name          summarize mentions for name instead of current identity
  --json              emit one structured digest frame`;

interface InboxMentionDigest {
  seq: number;
  from: string;
  body: string;
  ts: number;
}

interface RespondedMentionDigest extends InboxMentionDigest {
  response_seq: number;
  evidence: "reply_to" | "status.summary_seq";
  wake_invoked: false;
}

interface StatusDigest {
  seq: number;
  owner: string;
  state: StatusState;
  note: string;
  scope: string[];
  summary_seq: number | null;
  blocked_reason: string | null;
  ts: number;
}

function firstLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 180);
}

function statusOwner(m: MsgFrame): string {
  return m.status?.owner ?? m.sender.name;
}

function statusScope(m: MsgFrame): string[] {
  return m.status?.scope ?? [];
}

function summarizeStatuses(messages: MsgFrame[]): StatusDigest[] {
  return messages
    .filter((m) => m.kind === "status" && m.state !== null)
    .map((m) => ({
      seq: m.seq,
      owner: statusOwner(m),
      state: m.state!,
      note: m.note ?? "",
      scope: statusScope(m),
      summary_seq: m.status?.summary_seq ?? null,
      blocked_reason: m.status?.blocked_reason ?? null,
      ts: m.ts,
    }));
}

function responseEvidence(mention: MsgFrame, candidate: MsgFrame): RespondedMentionDigest["evidence"] | null {
  if (candidate.reply_to === mention.seq) return "reply_to";
  if (candidate.status?.summary_seq === mention.seq) return "status.summary_seq";
  return null;
}

function summarizeMentions(
  messages: MsgFrame[],
  viewer: string | null,
): { inbox: InboxMentionDigest[]; responded: RespondedMentionDigest[] } {
  if (viewer === null) return { inbox: [], responded: [] };
  const inbox: InboxMentionDigest[] = [];
  const responded: RespondedMentionDigest[] = [];
  for (const mention of messages.filter((m) => m.mentions.includes(viewer))) {
    const base = {
      seq: mention.seq,
      from: mention.sender.name,
      body: firstLine(mention.body),
      ts: mention.ts,
    };
    const response = messages
      .filter((candidate) => candidate.seq > mention.seq && candidate.sender.name === viewer)
      .map((candidate) => ({ candidate, evidence: responseEvidence(mention, candidate) }))
      .find((item) => item.evidence !== null);
    if (response?.evidence) {
      responded.push({
        ...base,
        response_seq: response.candidate.seq,
        evidence: response.evidence,
        wake_invoked: false,
      });
    } else {
      inbox.push(base);
    }
  }
  return { inbox, responded };
}

function printHuman(input: {
  channel: string;
  since: number;
  lastSeq: number;
  viewer: string | null;
  total: number;
  statuses: StatusDigest[];
  inboxMentions: InboxMentionDigest[];
  respondedMentions: RespondedMentionDigest[];
}) {
  console.log(`digest ${input.channel} #${input.since + 1}..#${input.lastSeq} (${input.total} messages)`);
  console.log(`viewer: ${input.viewer ?? "unknown"}`);
  console.log("wake: not claimed; mentions are inbox until a wake adapter and linked fresh ack/status");
  if (input.inboxMentions.length > 0) {
    console.log("");
    console.log("inbox mentions:");
    for (const m of input.inboxMentions) {
      console.log(`- #${m.seq} ${m.from}: ${m.body}`);
    }
  }
  if (input.respondedMentions.length > 0) {
    console.log("");
    console.log("responded mentions:");
    for (const m of input.respondedMentions) {
      console.log(`- #${m.seq} ${m.from} -> #${m.response_seq} evidence=${m.evidence}`);
    }
  }
  if (input.statuses.length > 0) {
    console.log("");
    console.log("statuses:");
    for (const s of input.statuses) {
      const bits = [
        s.note,
        s.scope.length > 0 ? `scope=${s.scope.join(",")}` : "",
        s.blocked_reason ? `blocked=${s.blocked_reason}` : "",
        s.summary_seq !== null ? `summary=#${s.summary_seq}` : "",
      ].filter(Boolean);
      console.log(`- #${s.seq} ${s.owner} ${s.state}${bits.length > 0 ? ` — ${bits.join(" · ")}` : ""}`);
    }
  }
}

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
  const unknown = unknownFlagError(flags, DIGEST_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "since", "limit", "for"]);
  if (flagError !== null) {
    console.error(flagError);
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
  const sinceFlag = str(flags.since);
  const since =
    sinceFlag === undefined || sinceFlag === "last-seen"
      ? loadCursor(channel)
      : parseNonNegativeIntFlag(sinceFlag, "since");
  if (typeof since === "string") {
    console.error(since);
    return 1;
  }
  const sinceSeq = since ?? 0;
  const limit = parsePositiveIntFlag(str(flags.limit), "limit", 1000);
  if (typeof limit === "string") {
    console.error(limit);
    return 1;
  }
  const scanLimit = limit ?? 100;
  const forName = str(flags.for);
  if (forName !== undefined && !isName(forName)) {
    console.error("--for must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }

  try {
    const viewer =
      forName ??
      (await fetchMe(cfg.server, cfg.token)
        .then((me) => me.name)
        .catch(() => null));
    const messages = await fetchMessages(cfg.server, cfg.token, channel, sinceSeq, scanLimit);
    const statuses = summarizeStatuses(messages);
    const mentions = summarizeMentions(messages, viewer);
    const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), sinceSeq);
    const frame = {
      type: "digest",
      channel,
      since: sinceSeq,
      last_seq: lastSeq,
      generated_at: nowTs(),
      viewer,
      counts: {
        messages: messages.length,
        statuses: statuses.length,
        inbox_mentions: mentions.inbox.length,
        responded_mentions: mentions.responded.length,
        wake_invoked: 0,
        resumed: 0,
      },
      statuses,
      inbox_mentions: mentions.inbox,
      responded_mentions: mentions.responded,
      wake_contract: {
        mentioned: "durable inbox item only",
        wake_invoked: "not inferred by digest",
        resumed: "requires linked fresh ack/status",
      },
    };
    if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
    else
      printHuman({
        channel,
        since: sinceSeq,
        lastSeq,
        viewer,
        total: messages.length,
        statuses,
        inboxMentions: mentions.inbox,
        respondedMentions: mentions.responded,
      });
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
