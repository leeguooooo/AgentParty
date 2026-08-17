import { runAgentPartyClaudeCrossSessionAcceptance } from "../../../scripts/verify-agentparty-claude-cross-session";
import { selfCommand } from "./bridge";

/** Expose the repository's full verifier through source and compiled party builds. */
export async function run(argv: string[]): Promise<number> {
  return await runAgentPartyClaudeCrossSessionAcceptance(argv, {
    bridgeSelfCommand: selfCommand(),
    workspacePath: process.cwd(),
    usageCommand: "party bridge claude --verify",
  });
}
