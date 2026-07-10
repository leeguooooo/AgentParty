// party review approve/reject — settle a gated completion review.
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { advanceCursorPastOwnMessage, resolveChannel } from "../config";
import { formatMsg } from "../format";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { handleRestError, reviewCompletion } from "../rest";
import { isSlug } from "../validation";

type ReviewAction = "approve" | "reject";

const FLAGS = ["channel", "message", "json"];
const HELP = `usage:
  party review approve <seq> [--channel C] [-m note] [--json]
  party review reject <seq> -m reason [--channel C] [--json]

Review a pending gated completion. Reject requires a public reason and mentions
the original completion sender via the reviewer reply.

Options:
  --channel C   review in channel C instead of the bound channel
  -m, --message review note or reject reason
  --json        emit the reviewed completion frame`;

function isReviewAction(input: string | undefined): input is ReviewAction {
  return input === "approve" || input === "reject";
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["json"], aliases: { m: "message" } });
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel", "message"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const action = positionals[0];
  if (!isReviewAction(action)) {
    console.error("usage: party review approve|reject <seq> [-m note]");
    return 1;
  }
  const seqArg = positionals[1];
  if (seqArg === undefined || !/^[1-9]\d*$/.test(seqArg)) {
    console.error("seq must be a positive integer");
    return 1;
  }
  const reason = str(flags.message)?.trim();
  if (action === "reject" && !reason) {
    console.error("reject reason is required (-m reason)");
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
  const auth = await resolveAuth();
  if (!auth) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    const result = await reviewCompletion(auth.server, auth.token, channel, Number(seqArg), {
      action,
      ...(reason === undefined || reason === "" ? {} : { reason }),
    });
    advanceCursorPastOwnMessage(channel, result.reply.seq);
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame(result.message as unknown as Record<string, unknown>)));
    } else {
      console.log(`review ${action === "approve" ? "approved" : "rejected"} #${seqArg}`);
      console.log(formatMsg(result.message));
      console.log(formatMsg(result.reply));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
