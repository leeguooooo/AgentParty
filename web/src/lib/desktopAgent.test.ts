// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import { createDesktopAgentAdapter, type DesktopAgentInvoker } from "./desktopAgent";

describe("desktop agent native adapter", () => {
  test("maps the public adapter to the native invoke contract", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoke: DesktopAgentInvoker = async (command, args) => {
      calls.push({ command, args });
      if (command === "desktop_agent_list_configs") {
        return [{
          configId: "local-main",
          name: "Leo Codex",
          serverOrigin: "https://party.example.com",
          channel: "agentparty",
          kind: "project",
          role: "worker",
        }];
      }
      if (command === "desktop_agent_logs") return ["ready", "watching #agentparty"];
      return {
        state: command === "desktop_agent_start" ? "running" : "stopped",
        pid: command === "desktop_agent_start" ? 42 : null,
        configId: command === "desktop_agent_start" ? "local-main" : null,
        name: command === "desktop_agent_start" ? "Leo Codex" : null,
        channel: command === "desktop_agent_start" ? "agentparty" : null,
        runner: command === "desktop_agent_start" ? "codex" : null,
        startedAt: command === "desktop_agent_start" ? 1234 : null,
        exitCode: null,
        lastError: null,
      };
    };
    const adapter = createDesktopAgentAdapter(invoke);

    expect(await adapter.listConfigs()).toHaveLength(1);
    expect((await adapter.status()).state).toBe("stopped");
    expect((await adapter.start({ configId: "local-main", channel: "agentparty", runner: "codex" })).pid).toBe(42);
    expect((await adapter.stop()).state).toBe("stopped");
    expect(await adapter.logs()).toEqual(["ready", "watching #agentparty"]);
    expect(calls).toEqual([
      { command: "desktop_agent_list_configs", args: undefined },
      { command: "desktop_agent_status", args: undefined },
      { command: "desktop_agent_start", args: { configId: "local-main", channel: "agentparty", runner: "codex" } },
      { command: "desktop_agent_stop", args: undefined },
      { command: "desktop_agent_logs", args: undefined },
    ]);
  });

  test("rejects malformed native data instead of exposing unchecked values", async () => {
    const invalidStatus = createDesktopAgentAdapter(async () => ({ state: "unknown", token: "secret" }));
    const invalidConfigs = createDesktopAgentAdapter(async () => [{ configId: "x", configPath: "/private/config" }]);
    const invalidLogs = createDesktopAgentAdapter(async () => ["ok", 42]);

    expect(invalidStatus.status()).rejects.toThrow("invalid desktop agent status");
    expect(invalidConfigs.listConfigs()).rejects.toThrow("invalid desktop agent config list");
    expect(invalidLogs.logs()).rejects.toThrow("invalid desktop agent logs");
  });

  test("accepts the native stopping state while termination is pending", async () => {
    const adapter = createDesktopAgentAdapter(async () => ({
      state: "stopping",
      pid: 42,
      configId: "local-main",
      name: "Leo Codex",
      channel: "agentparty",
      runner: "codex",
      startedAt: 1234,
      exitCode: null,
      lastError: null,
    }));

    expect((await adapter.status()).state).toBe("stopping");
  });
});
