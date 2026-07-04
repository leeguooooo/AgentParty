// party status — 发 status 消息（rest）
import type { CollaborationRole, Residency, StatusState, WakeKind } from "@agentparty/shared";
import { isHelpArg, parseArgs, str, strArray, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel, saveCursor } from "../config";
import { formatAuthDebugLine, resolveAuthDetailed } from "../oidc-cli";
import { fetchMe, handleRestError, postMessage } from "../rest";
import { isName, isSlug } from "../validation";

const STATES: StatusState[] = ["working", "waiting", "blocked", "done"];
const COLLAB_ROLES: CollaborationRole[] = ["host", "worker", "reviewer", "observer"];
const RESIDENCIES: Residency[] = ["supervised", "webhook", "bare", "human_driven", "unknown"];
const WAKE_KINDS: WakeKind[] = ["none", "watch", "serve", "webhook"];
const STATUS_FLAGS = ["channel", "note", "mention", "role", "residency", "wake-kind", "debug-auth"];
const HELP = `usage: party status [channel|--channel C] working|waiting|blocked|done [-m note] [--mention name]... [--debug-auth]

Publish agent status/presence into a channel.

Options:
  --channel C      post status in channel C
  -m, --note text  status note
  --mention name   mention a user or agent; repeatable
  --role role      collaboration role: host|worker|reviewer|observer
  --residency r    wake residency: supervised|webhook|bare|human_driven|unknown
  --wake-kind k    wake layer kind: none|watch|serve|webhook
  --debug-auth     print resolved auth/config source to stderr`;

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {
    aliases: { m: "note" },
    booleans: ["debug-auth"],
    repeatable: ["mention"],
  });
  const auth = await resolveAuthDetailed();
  if (!auth.server || !auth.token) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  const unknown = unknownFlagError(flags, STATUS_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  let explicit: string | undefined;
  let state: string | undefined;
  const flagError = valueFlagError(flags, ["channel", "note", "role", "residency", "wake-kind"], ["mention"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const flagChannel = str(flags.channel);
  if (flagChannel) {
    explicit = flagChannel;
    state = positionals[0];
  } else if (positionals.length >= 2) {
    explicit = positionals[0];
    state = positionals[1];
  } else {
    state = positionals[0];
  }
  if (!state || !STATES.includes(state as StatusState)) {
    console.error(`state must be one of: ${STATES.join("|")}`);
    return 1;
  }
  const channel = resolveChannel(explicit);
  if (!channel) {
    console.error("no channel, pass one or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const mentions = strArray(flags.mention) ?? [];
  if (mentions.some((mention) => !isName(mention))) {
    console.error("--mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  const role = str(flags.role);
  if (role !== undefined && !COLLAB_ROLES.includes(role as CollaborationRole)) {
    console.error(`--role must be one of: ${COLLAB_ROLES.join("|")}`);
    return 1;
  }
  const residency = str(flags.residency);
  if (residency !== undefined && !RESIDENCIES.includes(residency as Residency)) {
    console.error(`--residency must be one of: ${RESIDENCIES.join("|")}`);
    return 1;
  }
  const wakeKind = str(flags["wake-kind"]);
  if (wakeKind !== undefined && !WAKE_KINDS.includes(wakeKind as WakeKind)) {
    console.error(`--wake-kind must be one of: ${WAKE_KINDS.join("|")}`);
    return 1;
  }
  try {
    if (flags["debug-auth"] === true || process.env.AGENTPARTY_DEBUG_AUTH === "1") {
      try {
        console.error(formatAuthDebugLine(auth, await fetchMe(auth.server, auth.token)));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`${formatAuthDebugLine(auth)} runtime-error=${message}`);
      }
    }
    const { seq } = await postMessage(auth.server, auth.token, channel, {
      kind: "status",
      state: state as StatusState,
      note: str(flags.note) ?? "",
      mentions,
      ...(role !== undefined ? { role: role as CollaborationRole } : {}),
      ...(residency !== undefined ? { residency: residency as Residency } : {}),
      ...(wakeKind !== undefined ? { wake: { kind: wakeKind as WakeKind } } : {}),
    });
    saveCursor(channel, seq);
    console.log(`status seq=${seq}`);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
