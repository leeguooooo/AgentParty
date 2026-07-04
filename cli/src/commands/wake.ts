// party wake test — prove mention/wake/resume as separate phases.
import { EXIT_TIMEOUT, type MsgFrame, type PresenceEntry, type WakeDelivery } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame, nowTs } from "../json";
import { resolveAuth } from "../oidc-cli";
import { RestError, fetchMessages, fetchWakeDeliveries, handleRestError, listChannels, postMessage } from "../rest";
import { MAX_TIMEOUT_SEC, isName, isSlug, parsePositiveIntFlag } from "../validation";

const WAKE_FLAGS = ["channel", "timeout", "json"];
const DEFAULT_TIMEOUT_SEC = 30;
const HELP = `usage: party wake test @agent [channel|--channel C] [--timeout N] [--json]

Run a wake contract test. This separates mention delivery, wake adapter delivery,
and linked agent resume. Only a fresh reply/status linked to the test mention
counts as resumed.

Options:
  --channel C    test in channel C instead of the bound channel
  --timeout N    seconds to wait for linked ack/status (default: 30)
  --json         emit one structured wake_test frame`;

type WakeResult = "not_auto_wakeable" | "healthy" | "timeout";
type AckEvidence = "reply_to" | "status.summary_seq";

interface WakePresence {
  state: string | null;
  residency: string | null;
  wake_kind: string | null;
  wake_verified_at: number | null;
  last_seen: number | null;
}

interface WakeTestFrame extends Record<string, unknown> {
  type: "wake_test";
  channel: string;
  target: string;
  result: WakeResult;
  generated_at: number;
  timeout_sec: number;
  presence: WakePresence;
  phases: {
    mention_delivered: { ok: boolean; seq: number | null; evidence: string };
    wake_invoked: { ok: boolean | null; adapter: string | null; evidence: string };
    agent_resumed: { ok: boolean; seq: number | null; evidence: AckEvidence | null };
  };
  reason: string | null;
}

function normalizeTarget(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function summarizePresence(p: PresenceEntry | null): WakePresence {
  return {
    state: p?.state ?? null,
    residency: p?.residency ?? null,
    wake_kind: p?.wake?.kind ?? null,
    wake_verified_at: p?.wake?.verified_at ?? null,
    last_seen: p?.last_seen ?? p?.ts ?? null,
  };
}

function notWakeableReason(p: PresenceEntry | null): string | null {
  if (p === null) return "no presence for target";
  if (p.residency === "human_driven") return "target is human-driven; mention is inbox only";
  if (p.residency === "bare") return "target has bare residency; no wake adapter is advertised";
  if (p.wake === undefined || p.wake.kind === "none") return "target advertises no wake adapter";
  return null;
}

function ackEvidence(mentionSeq: number, candidate: MsgFrame): AckEvidence | null {
  if (candidate.reply_to === mentionSeq) return "reply_to";
  if (candidate.status?.summary_seq === mentionSeq) return "status.summary_seq";
  return null;
}

function findLinkedAck(messages: MsgFrame[], target: string, mentionSeq: number): { seq: number; evidence: AckEvidence } | null {
  for (const m of messages) {
    if (m.seq <= mentionSeq || m.sender.name !== target) continue;
    const evidence = ackEvidence(mentionSeq, m);
    if (evidence !== null) return { seq: m.seq, evidence };
  }
  return null;
}

function ackFromWakeDelivery(delivery: WakeDelivery | null): { seq: number; evidence: AckEvidence } | null {
  if (delivery === null) return null;
  if (delivery.ack_seq !== null) return { seq: delivery.ack_seq, evidence: "reply_to" };
  if (delivery.resume_seq !== null) return { seq: delivery.resume_seq, evidence: "status.summary_seq" };
  return null;
}

function summarizeWakeDelivery(delivery: WakeDelivery | null, adapter: string | null): { ok: boolean | null; adapter: string | null; evidence: string } {
  if (delivery === null) {
    return {
      ok: null,
      adapter,
      evidence: "adapter delivery is not audited by the worker yet; only linked resume is conclusive",
    };
  }
  if (delivery.result === "ok") {
    const status = delivery.http_status === null ? "" : ` status=${delivery.http_status}`;
    return {
      ok: true,
      adapter,
      evidence: `webhook delivery attempt ${delivery.attempt}${status} for mention #${delivery.mention_seq}`,
    };
  }
  const status = delivery.http_status === null ? "" : ` status=${delivery.http_status}`;
  const error = delivery.error ? ` error=${delivery.error}` : "";
  return {
    ok: false,
    adapter,
    evidence: `webhook delivery attempt ${delivery.attempt} failed${status}${error} for mention #${delivery.mention_seq}`,
  };
}

async function fetchLatestWebhookDelivery(
  server: string,
  token: string,
  channel: string,
  target: string,
  mentionSeq: number,
): Promise<WakeDelivery | null> {
  try {
    const deliveries = await fetchWakeDeliveries(server, token, channel, { since: mentionSeq, target, limit: 20 });
    return deliveries
      .filter((d) => d.mention_seq === mentionSeq && d.adapter_kind === "webhook")
      .at(-1) ?? null;
  } catch (e) {
    if (e instanceof RestError && (e.status === 404 || e.status === 501)) return null;
    throw e;
  }
}

function printHuman(frame: WakeTestFrame) {
  console.log(`wake test ${frame.channel} @${frame.target}: ${frame.result}`);
  if (frame.reason) console.log(`reason: ${frame.reason}`);
  const presenceBits = [
    frame.presence.state ? `state=${frame.presence.state}` : null,
    frame.presence.residency ? `residency=${frame.presence.residency}` : null,
    frame.presence.wake_kind ? `wake=${frame.presence.wake_kind}` : null,
  ].filter((bit): bit is string => bit !== null);
  if (presenceBits.length > 0) console.log(`presence: ${presenceBits.join(" ")}`);
  console.log(
    `mention: ${frame.phases.mention_delivered.ok ? `delivered #${frame.phases.mention_delivered.seq}` : "not sent"}`,
  );
  console.log(`wake invoked: ${frame.phases.wake_invoked.ok === null ? "not audited" : frame.phases.wake_invoked.ok ? "yes" : "no"}`);
  console.log(
    `resumed: ${
      frame.phases.agent_resumed.ok
        ? `yes #${frame.phases.agent_resumed.seq} evidence=${frame.phases.agent_resumed.evidence}`
        : "no"
    }`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const parsed = parseArgs(argv, { booleans: ["json"] });
  const [subcmd, targetArg, channelArg, ...extra] = parsed.positionals;
  if (subcmd !== "test" || extra.length > 0) {
    console.error("usage: party wake test @agent [channel|--channel C] [--timeout N] [--json]");
    return 1;
  }
  const { flags } = parsed;
  const unknown = unknownFlagError(flags, WAKE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "timeout"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const target = normalizeTarget(targetArg);
  if (target === null || !isName(target)) {
    console.error("target must be a valid name, e.g. @agent");
    return 1;
  }
  const channel = resolveChannel(str(flags.channel) ?? channelArg);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const timeout = parsePositiveIntFlag(str(flags.timeout), "timeout", MAX_TIMEOUT_SEC);
  if (typeof timeout === "string") {
    console.error(timeout);
    return 1;
  }
  const timeoutSec = timeout ?? DEFAULT_TIMEOUT_SEC;
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }

  try {
    const channels = await listChannels(cfg.server, cfg.token);
    const info = channels.find((c) => c.slug === channel);
    const presence = info?.presence?.find((p) => p.name === target) ?? null;
    const reason = notWakeableReason(presence);
    const adapter = presence?.wake?.kind ?? null;
    if (reason !== null) {
      const frame: WakeTestFrame = {
        type: "wake_test",
        channel,
        target,
        result: "not_auto_wakeable",
        generated_at: nowTs(),
        timeout_sec: timeoutSec,
        presence: summarizePresence(presence),
        phases: {
          mention_delivered: { ok: false, seq: null, evidence: "not sent because target is not auto-wakeable" },
          wake_invoked: { ok: false, adapter, evidence: reason },
          agent_resumed: { ok: false, seq: null, evidence: null },
        },
        reason,
      };
      if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
      else printHuman(frame);
      return EXIT_TIMEOUT;
    }

    const { seq } = await postMessage(cfg.server, cfg.token, channel, {
      kind: "message",
      body: `@${target} wake test: please reply to this message or post a status linked with summary_seq`,
      mentions: [target],
      reply_to: null,
    });
    const deadline = Date.now() + timeoutSec * 1000;
    let ack: { seq: number; evidence: AckEvidence } | null = null;
    let wakeDelivery: WakeDelivery | null = null;
    do {
      if (adapter === "webhook") {
        wakeDelivery = await fetchLatestWebhookDelivery(cfg.server, cfg.token, channel, target, seq);
        ack = ackFromWakeDelivery(wakeDelivery);
        if (ack !== null) break;
      }
      ack = findLinkedAck(await fetchMessages(cfg.server, cfg.token, channel, seq, 100), target, seq);
      if (ack !== null) break;
      await sleep(Math.min(1000, Math.max(100, deadline - Date.now())));
    } while (Date.now() < deadline);
    if (adapter === "webhook" && wakeDelivery === null) {
      wakeDelivery = await fetchLatestWebhookDelivery(cfg.server, cfg.token, channel, target, seq);
    }

    const frame: WakeTestFrame = {
      type: "wake_test",
      channel,
      target,
      result: ack === null ? "timeout" : "healthy",
      generated_at: nowTs(),
      timeout_sec: timeoutSec,
      presence: summarizePresence(presence),
      phases: {
        mention_delivered: { ok: true, seq, evidence: "message accepted by channel history" },
        wake_invoked: summarizeWakeDelivery(wakeDelivery, adapter),
        agent_resumed: { ok: ack !== null, seq: ack?.seq ?? null, evidence: ack?.evidence ?? null },
      },
      reason: ack === null ? "timed out waiting for linked reply_to/status.summary_seq" : null,
    };
    if (flags.json === true) console.log(JSON.stringify(jsonFrame(frame)));
    else printHuman(frame);
    return ack === null ? EXIT_TIMEOUT : 0;
  } catch (e) {
    return handleRestError(e);
  }
}
