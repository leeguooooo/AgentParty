// party edit/retract/supersede — audited message revisions
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { formatMsg } from "../format";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { handleRestError, reviseMessage } from "../rest";
import { isSlug } from "../validation";

type Action = "edit" | "retract" | "supersede";

const FLAGS = ["channel", "json"];
const HELP = `usage:
  party edit <seq> <text|-> [--channel C] [--json]
  party retract <seq> [--channel C] [--json]
  party supersede <seq> <text|-> [--channel C] [--json]

Revise a retained message with an audit trail. Edit/retract require the original
sender or a channel moderator. Supersede posts a new correction and marks the
old message as superseded.

Options:
  --channel C   revise in channel C instead of the bound channel
  --json        emit the revised message frame`;

function isAction(cmd: string): cmd is Action {
  return cmd === "edit" || cmd === "retract" || cmd === "supersede";
}

function revisionLine(action: Action, seq: number, messageSeq: number): string {
  if (action === "supersede") return `superseded #${seq} with #${messageSeq}`;
  return `${action === "edit" ? "edited" : "retracted"} #${seq}`;
}

async function bodyFromPositionals(positionals: string[]): Promise<string | null> {
  if (positionals.length === 1 && positionals[0] === "-") return Bun.stdin.text();
  const body = positionals.join(" ");
  return body.trim() === "" ? null : body;
}

export async function run(action: Action, argv: string[]): Promise<number> {
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
  const unknown = unknownFlagError(flags, FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["channel"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const seqArg = positionals[0];
  if (seqArg === undefined) {
    console.error("seq must be a positive integer");
    return 1;
  }
  if (!/^[1-9]\d*$/.test(seqArg)) {
    console.error("seq must be a positive integer");
    return 1;
  }
  const seq = Number(seqArg);
  const channel = resolveChannel(str(flags.channel));
  if (!channel) {
    console.error("no channel, pass --channel C or bind with: party init --channel C");
    return 1;
  }
  if (!isSlug(channel)) {
    console.error("channel must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  const text = action === "retract" ? null : await bodyFromPositionals(positionals.slice(1));
  if (action !== "retract" && text === null) {
    console.error("body is required (use - to read stdin)");
    return 1;
  }
  try {
    const result = await reviseMessage(
      cfg.server,
      cfg.token,
      channel,
      seq,
      action,
      text === null ? undefined : { body: text },
    );
    if (flags.json === true) {
      console.log(JSON.stringify(jsonFrame(result.message as unknown as Record<string, unknown>)));
    } else {
      console.log(revisionLine(action, seq, result.message.seq));
      console.log(formatMsg(result.message));
    }
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}

export function commandFromArg(cmd: string): Action | null {
  return isAction(cmd) ? cmd : null;
}
