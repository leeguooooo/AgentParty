import { describe, expect, test } from "bun:test";
import {
  callCodexAppNativeTool,
  CodexAppNativeUnavailableError,
  nativeToolTextJson,
  parseCodexAppNativeRuntimeCommand,
  resolveCodexAppNativeRuntime,
  selectCodexAppNativeRoute,
  type CodexAppNativeRuntime,
} from "../src/codex-app-native";

const THREAD_ID = "01a04eb6-6349-7871-9c05-8eb15d68635f";
const RUNTIME: CodexAppNativeRuntime = {
  appServerPid: 77305,
  codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  nodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
  pipePath: "/tmp/codex-browser-use/native.sock",
};

describe("ChatGPT native app tools runtime", () => {
  test("parses the real packaged app-server command shape", () => {
    const command =
      `/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server ` +
      `-c mcp_servers.codex_app={"env"={"CODEX_APP_TOOLS_PIPE_PATH"="/tmp/codex-browser-use/abc.sock",` +
      `"CODEX_MCP_NODE_PATH"="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"}}`;
    expect(parseCodexAppNativeRuntimeCommand(command, 77305)).toEqual({
      appServerPid: 77305,
      codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      nodePath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      pipePath: "/tmp/codex-browser-use/abc.sock",
    });
  });

  test("rejects a generic codex process or a command without the private pipe", () => {
    expect(parseCodexAppNativeRuntimeCommand("/opt/homebrew/bin/codex app-server", 1)).toBeNull();
    expect(parseCodexAppNativeRuntimeCommand(
      "/Applications/ChatGPT.app/Contents/Resources/codex app-server",
      1,
    )).toBeNull();
  });

  test("resolves the exact thread registry entry and validates its runtime", () => {
    const validated: CodexAppNativeRuntime[] = [];
    const command =
      `/Applications/ChatGPT.app/Contents/Resources/codex app-server ` +
      `-c x={"CODEX_APP_TOOLS_PIPE_PATH"="/tmp/codex-browser-use/native.sock"}`;
    const resolved = resolveCodexAppNativeRuntime(THREAD_ID, {}, {
      sessions: () => [{
        version: 1,
        harness: "codex",
        session_id: THREAD_ID,
        pid: 77305,
        display_name: null,
        channel: "agentparty",
        server: "https://agentparty.example.com",
        identity: "leo-codex",
        cwd: "/repo",
        registered_at: 1,
      }],
      commandForPid: (pid) => {
        expect(pid).toBe(77305);
        return command;
      },
      brokerPath: () => null,
      validateRuntime: (runtime) => validated.push(runtime),
    });
    expect(resolved).toEqual(RUNTIME);
    expect(validated).toEqual([RUNTIME]);
  });

  test("missing exact thread fails closed instead of choosing another task on the shared pid", () => {
    expect(() => resolveCodexAppNativeRuntime(THREAD_ID, {}, {
      sessions: () => [{
        version: 1,
        harness: "codex",
        session_id: "01a0499f-2ce2-76e1-8734-733f8f169c28",
        pid: 77305,
        display_name: null,
        channel: "agentparty",
        cwd: "/repo",
        registered_at: 1,
      }],
    })).toThrow(CodexAppNativeUnavailableError);
  });

  test("selects a second task only inside the same app-server and AgentParty identity", () => {
    const base = {
      version: 1 as const,
      harness: "codex" as const,
      pid: 77305,
      display_name: null,
      channel: "agentparty",
      server: "https://agentparty.example.com",
      identity: "leo-codex",
      cwd: "/repo",
      registered_at: 1,
    };
    const sourceThreadId = "01a0499f-2ce2-76e1-8734-733f8f169c28";
    expect(selectCodexAppNativeRoute(THREAD_ID, 77305, [
      { ...base, session_id: THREAD_ID },
      { ...base, session_id: sourceThreadId, registered_at: 2 },
      { ...base, session_id: "01a0499f-2ce2-76e1-8734-733f8f169c29", identity: "other", registered_at: 3 },
    ])).toEqual({ targetThreadId: THREAD_ID, sourceThreadId });
    expect(selectCodexAppNativeRoute(THREAD_ID, 77305, [
      { ...base, session_id: THREAD_ID },
      { ...base, session_id: sourceThreadId, pid: 99999 },
    ])).toBeNull();
  });
});

describe("ChatGPT native app tool call", () => {
  test("puts prompt and thread metadata in the framed request body, never process argv", async () => {
    let captured: unknown = null;
    const result = await callCodexAppNativeTool({
      runtime: RUNTIME,
      sourceThreadId: THREAD_ID,
      tool: "send_message_to_thread",
      arguments: {
        threadId: "01a0499f-2ce2-76e1-8734-733f8f169c28",
        prompt: "secret body",
      },
    }, {
      invoke: async (runtime, request) => {
        expect(runtime).toBe(RUNTIME);
        captured = request;
        return {
          id: "response",
          jsonrpc: "2.0",
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify({ threadId: "target" }) }],
          },
        };
      },
    });
    expect(captured).toMatchObject({
      method: "tools/call",
      params: {
        namespace: "codex_app",
        threadId: THREAD_ID,
        tool: "send_message_to_thread",
        arguments: { prompt: "secret body" },
      },
    });
    expect(result.success).toBe(true);
    expect(nativeToolTextJson(result, (value): value is { threadId: string } =>
      typeof value === "object" && value !== null && "threadId" in value
    )).toEqual({ threadId: "target" });
  });
});
