import { isAbsolute } from "node:path";
import {
  CLAUDE_CROSS_SESSION_GATE_DIR_ENV,
  runClaudeCrossSessionHook,
  type ClaudeHookInput,
} from "../claude-cross-session-gate";

const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;

async function readBoundedStdin(maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function hookInput(value: unknown): value is ClaudeHookInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = (value as { hook_event_name?: unknown }).hook_event_name;
  return event === "SessionStart" || event === "PreToolUse" || event === "PostToolBatch";
}

export async function run(args: string[] = []): Promise<number> {
  let gateDirectory: string | undefined;
  if (args.length !== 0) {
    if (
      args.length !== 2 ||
      args[0] !== "--gate-directory" ||
      args[1] === "" ||
      !isAbsolute(args[1]!)
    ) {
      console.error("AgentParty Cross-session hook received invalid bridge arguments.");
      return 2;
    }
    gateDirectory = args[1];
  }
  const rawInput = await readBoundedStdin(MAX_HOOK_INPUT_BYTES);
  if (rawInput === null) {
    // The event cannot be classified safely without its complete envelope.
    // Treat every oversized input as blocking rather than risk allowing an
    // oversized PreToolUse request through Claude Code's command-hook path.
    console.error("AgentParty Cross-session hook input exceeded its 4 MiB safety limit.");
    return 2;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput) as unknown;
  } catch {
    // A malformed hook payload must not silently allow a generated AgentParty
    // target. Exit 2 is Claude Code's fail-closed hook status.
    console.error("AgentParty Cross-session hook received malformed JSON.");
    return 2;
  }
  if (!hookInput(parsed)) {
    // The command is installed only for these three Hook events. A valid JSON
    // scalar, array, empty object, or unknown event is still a malformed Hook
    // envelope and must not fall through as an unrelated no-op.
    console.error("AgentParty Cross-session hook received a malformed event envelope.");
    return 2;
  }
  const input = parsed;
  // Do not trust or forward an ambient gate variable. Only the exec-form
  // argument generated for this bridge launch can select private gate state.
  let decision;
  try {
    decision = runClaudeCrossSessionHook(input, gateDirectory === undefined
      ? {}
      : { [CLAUDE_CROSS_SESSION_GATE_DIR_ENV]: gateDirectory });
  } catch {
    // The CLI's generic uncaught-error path exits 1, but Claude Code only
    // treats exit 2 as a blocking command-hook failure. A storage or locking
    // failure during PreToolUse must therefore be translated here instead of
    // accidentally allowing the tool call to continue.
    console.error("AgentParty Cross-session hook could not verify private gate state.");
    return input.hook_event_name === "PreToolUse" ? 2 : 1;
  }
  if (decision.stdout !== "") process.stdout.write(decision.stdout);
  if (decision.stderr !== "") process.stderr.write(decision.stderr);
  return decision.exitCode;
}
