import { describe, expect, test } from "bun:test";
import { runCodexNativeBridge } from "../src/commands/codex-native-bridge";

const SOURCE = "01a0499f-2ce2-76e1-8734-733f8f169c28";
const TARGET = "01a04eb6-6349-7871-9c05-8eb15d68635f";

describe("ChatGPT native AgentParty bridge preflight", () => {
  test("fails before claiming delivery when Desktop IPC cannot discover the target owner", async () => {
    let connected = false;
    const run = runCodexNativeBridge({
      channel: "agentparty",
      sourceThreadId: SOURCE,
      targetThreadId: TARGET,
      env: {},
    }, {
      resolveAuth: async () => ({
        server: "https://agentparty.example.com",
        token: "agent-token",
        auth_source: "runtime_config",
        config: { kind: "explicit", path: "/tmp/agentparty.json" },
        account: { present: false, path: "/tmp/account.json" },
      }),
      probeIpc: async () => { throw new Error("no ChatGPT renderer owns target"); },
      connectAgentParty: (() => {
        connected = true;
        throw new Error("must not connect");
      }) as never,
      installSignalHandlers: () => () => {},
    });
    await expect(run).rejects.toThrow("no ChatGPT renderer owns target");
    expect(connected).toBe(false);
  });
});
