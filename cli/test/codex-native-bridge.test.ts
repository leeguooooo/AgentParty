import { describe, expect, test } from "bun:test";
import { runCodexNativeBridge } from "../src/commands/codex-native-bridge";

const SOURCE = "01a0499f-2ce2-76e1-8734-733f8f169c28";
const TARGET = "01a04eb6-6349-7871-9c05-8eb15d68635f";

describe("ChatGPT native AgentParty bridge preflight", () => {
  test("fails before claiming delivery when the current app-server has not loaded the broker", async () => {
    const lines: string[] = [];
    let connected = false;
    const code = await runCodexNativeBridge({
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
      resolveRuntime: () => ({
        appServerPid: 77305,
        codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        nodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
        pipePath: "/tmp/codex-app-tools.sock",
      }),
      connectAgentParty: (() => {
        connected = true;
        throw new Error("must not connect");
      }) as never,
      log: (line) => lines.push(line),
      installSignalHandlers: () => () => {},
    });
    expect(code).toBe(1);
    expect(connected).toBe(false);
    expect(lines.join("\n")).toContain("agentparty_native");
    expect(lines.join("\n")).toContain("重开/刷新 ChatGPT");
  });
});
