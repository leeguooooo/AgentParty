import { runBusyClaudeChannelAcceptance } from "../../../scripts/verify-agentparty-claude-channel";
import { selfCommand } from "./bridge";

/** Expose the busy Marketplace Channel verifier through source and compiled party builds. */
export async function run(argv: string[]): Promise<number> {
  return await runBusyClaudeChannelAcceptance(argv, {
    selfCommand: selfCommand(),
    workspacePath: process.cwd(),
    usageCommand: "party claude --verify",
  });
}
