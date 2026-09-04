// party dm — 只凭名字选择一个确定的共同频道，再复用 party send（#1075）。
import { mentionMatchKey, type PresenceEntry } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, valueFlagError } from "../args";
import { stripTerminalControls } from "../format";
import { resolveAuth, type Auth } from "../oidc-cli";
import { fetchPresence, handleRestError, listChannels, type ChannelInfo } from "../rest";
import { isName, isSlug } from "../validation";
import { activeChannelSlugs } from "./who-global";
import { run as runSend, sendSpec } from "./send";

const HELP = `usage: party dm <name> <text|-> [--channel C] [party send options]

Send to one person without first knowing a channel. With no --channel, party
looks across your active channels:
  one matching channel   send there and print the choice
  several matches        refuse and list them; choose with --channel
  no match               print invite / join-link next steps

All message options are handled by party send after the channel is selected.`;

export interface DmSnapshot {
  slug: string;
  presence: PresenceEntry[];
}

export interface DmDeps {
  resolveAuth: () => Promise<Auth | null>;
  listChannels: (server: string, token: string) => Promise<ChannelInfo[]>;
  fetchPresence: (server: string, token: string, slug: string) => Promise<PresenceEntry[]>;
  runSend: (argv: string[]) => Promise<number>;
}

const DEFAULT_DEPS: DmDeps = { resolveAuth, listChannels, fetchPresence, runSend };

export function normalizeDmTarget(raw: string): string | null {
  const target = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!isName(target) || mentionMatchKey(target) === "system") return null;
  return target;
}

function entryMatchesTarget(entry: PresenceEntry, target: string): boolean {
  const key = mentionMatchKey(target);
  return mentionMatchKey(entry.name) === key
    || (typeof entry.handle === "string" && entry.handle !== "" && mentionMatchKey(entry.handle) === key);
}

/** Pure selection rule: exactly one channel is safe; ambiguity is never guessed. */
export function dmCandidateChannels(target: string, snapshots: readonly DmSnapshot[]): string[] {
  return snapshots
    .filter(({ presence }) => presence.some((entry) => entryMatchesTarget(entry, target)))
    .map(({ slug }) => slug)
    .sort();
}

function sendArgs(target: string, channel: string, rest: readonly string[]): string[] {
  // Force routing flags before user args so a later `--` cannot turn them into body text.
  return ["--channel", channel, "--mention", target, ...rest];
}

export async function runWithDeps(argv: string[], deps: DmDeps): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const rawTarget = argv[0];
  if (rawTarget === undefined) {
    console.error("usage: party dm <name> <text|-> [--channel C]");
    return 1;
  }
  const target = normalizeDmTarget(rawTarget);
  if (target === null) {
    console.error("dm target must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63} and cannot be system");
    return 1;
  }
  const rest = argv.slice(1);
  const parsed = parseArgs(rest, sendSpec);
  const channelFlagError = valueFlagError(parsed.flags, ["channel"]);
  if (channelFlagError !== null) {
    console.error(channelFlagError);
    return 1;
  }
  const explicitChannel = str(parsed.flags.channel);
  if (explicitChannel !== undefined) {
    if (!isSlug(explicitChannel)) {
      console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
      return 1;
    }
    console.error(`dm @${stripTerminalControls(target)} -> #${stripTerminalControls(explicitChannel)} (explicit)`);
    return deps.runSend(["--mention", target, ...rest]);
  }

  const auth = await deps.resolveAuth();
  if (auth === null) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  let channels: string[];
  try {
    channels = activeChannelSlugs(await deps.listChannels(auth.server, auth.token));
  } catch (error) {
    return handleRestError(error);
  }
  if (channels.length === 0) {
    console.error("no active channels yet — join one first: party join --server URL --channel SLUG --as NAME");
    return 1;
  }

  const snapshots: DmSnapshot[] = [];
  const failed: string[] = [];
  for (const slug of channels) {
    try {
      snapshots.push({ slug, presence: await deps.fetchPresence(auth.server, auth.token, slug) });
    } catch {
      failed.push(slug);
    }
  }
  // Partial discovery can hide a second match. Fail closed instead of claiming a unique route.
  if (failed.length > 0) {
    console.error(
      `cannot safely choose a channel for @${stripTerminalControls(target)}; presence was unavailable for: ${failed.map(stripTerminalControls).join(", ")}`,
    );
    return 1;
  }

  const candidates = dmCandidateChannels(target, snapshots);
  if (candidates.length === 0) {
    const first = channels[0]!;
    console.error(`no common channel found with @${stripTerminalControls(target)}.`);
    console.error("Invite them, then retry:");
    console.error(`  party channel join-link ${stripTerminalControls(first)}`);
    console.error(`  party channel invite-agent <owner>/<handle> ${stripTerminalControls(first)}`);
    console.error(`active channels: ${channels.map((slug) => `#${stripTerminalControls(slug)}`).join(", ")}`);
    return 1;
  }
  if (candidates.length > 1) {
    console.error(`@${stripTerminalControls(target)} appears in multiple channels: ${candidates.map((slug) => `#${stripTerminalControls(slug)}`).join(", ")}`);
    console.error(`choose one explicitly: party dm ${stripTerminalControls(target)} "<text>" --channel <channel>`);
    return 1;
  }

  const channel = candidates[0]!;
  console.error(`dm @${stripTerminalControls(target)} -> #${stripTerminalControls(channel)} (only common channel)`);
  return deps.runSend(sendArgs(target, channel, rest));
}

export async function run(argv: string[]): Promise<number> {
  return runWithDeps(argv, DEFAULT_DEPS);
}
