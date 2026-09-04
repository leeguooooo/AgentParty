// party reply — `party send --reply-to` 的短入口（#1076）。
import { isHelpArg, parseArgs } from "../args";
import { parseReplyToList, run as runSend, sendSpec } from "./send";

const HELP = `usage: party reply <seq> <text|-> [--channel C] [party send options]

Reply to one message. The channel comes from --channel or the current workspace
binding; all remaining options are handled by party send.`;

export function replyToSendArgs(argv: readonly string[]): string[] | null {
  const seq = argv[0];
  if (seq === undefined) return null;
  const parsed = parseReplyToList(seq);
  if (
    seq.includes(",") ||
    typeof parsed === "string" ||
    parsed.replyTo === null ||
    parsed.alsoResolves.length > 0
  ) return null;
  if (parseArgs([...argv.slice(1)], sendSpec).flags["reply-to"] !== undefined) return null;
  return ["--reply-to", seq, ...argv.slice(1)];
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const sendArgs = replyToSendArgs(argv);
  if (sendArgs === null) {
    console.error("usage: party reply <seq> <text|-> [--channel C]");
    return 1;
  }
  return runSend(sendArgs);
}
