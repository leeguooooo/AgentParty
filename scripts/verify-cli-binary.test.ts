import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  parseCliBinaryArguments,
  verifyCliBinary,
  type BinaryRunner,
} from "./verify-cli-binary";

const temporaryDirectories: string[] = [];
const pluginRoot = resolve(import.meta.dir, "../plugins/agentparty");

function artifact(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentparty-cli-binary-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, process.platform === "win32" ? "party.exe" : "party");
  writeFileSync(path, "compiled artifact fixture");
  chmodSync(path, 0o755);
  return path;
}

function successfulRunner(overrides: Map<string, { status: number; stdout: string; stderr: string }> = new Map()): BinaryRunner {
  return (_binary, args, env, input) => {
    const key = args.join(" ");
    const overridden = overrides.get(key);
    if (overridden !== undefined) return overridden;
    if (args[0] === "hook" && args[1] === "push") {
      const activityFile = args[2];
      const attemptIndex = args.indexOf("--attempt-id");
      const attemptId = attemptIndex >= 0 ? args[attemptIndex + 1] : undefined;
      expect(typeof activityFile).toBe("string");
      expect(typeof attemptId).toBe("string");
      writeFileSync(`${activityFile}.push.failed.json`, JSON.stringify({ attempt_id: attemptId }));
      return { status: 0, stdout: "", stderr: "" };
    }
    switch (key) {
      case "--version":
        return { status: 0, stdout: "1.2.3\n", stderr: "" };
      case "claude --help":
        return { status: 0, stdout: "Marketplace Channel explicitly armed; use party bridge claude separately\n", stderr: "" };
      case "claude --verify --help":
        return {
          status: 0,
          stdout: "party claude --verify; --preflight-only performs no model call; --live explicitly authorizes one real model session; party_channel_claim -> party_channel_accept -> party_channel_reply\n",
          stderr: "",
        };
      case "doctor claude-plugin --help":
        return { status: 0, stdout: "party doctor claude-plugin performs a read-only, no-model audit\n", stderr: "" };
      case "claude-channel --help":
        return { status: 0, stdout: "--require-launch-opt-in declares claude/channel\n", stderr: "" };
      case "bridge claude --verify --help":
        return {
          status: 0,
          stdout: "party bridge claude --verify: Marketplace lifecycle; This makes real model calls; --preflight-only makes no model calls\n",
          stderr: "",
        };
      case "hook --help":
        return { status: 0, stdout: "hook stop-guard or push\n", stderr: "" };
      case "claude-cross-session-hook":
        expect(input).toBe("{}");
        return { status: 2, stdout: "", stderr: "malformed event envelope\n" };
      case "hook report": {
        // #1025：出厂时 hook 走的是插件 wrapper，未被 AgentParty 启动器武装过的会话在
        // exec 之前就退出。桩必须忠实反映这一点——否则它会让「早退被改坏」的代码全绿。
        // （真产物那一侧由 scripts/verify-cli-binary.ts 对真二进制、真 wrapper 验，
        // 并做过变异自检：去掉早退 → 验收失败。）
        if (!unarmedHookSpawns && env.AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN !== "1" && !env.AP_ACTIVITY_FILE) {
          return { status: 0, stdout: "", stderr: "" };
        }
        const payload = JSON.parse(input ?? "") as {
          session_id: string;
          hook_event_name: string;
          tool_name?: string;
        };
        const activityFile = env.AP_ACTIVITY_FILE ?? join(
          env.AGENTPARTY_HOME!,
          "state",
          "activity",
          `${payload.session_id}.json`,
        );
        mkdirSync(resolve(activityFile, ".."), { recursive: true });
        const phase = payload.hook_event_name === "SessionStart"
          ? "starting"
          : payload.hook_event_name === "PreToolUse"
            ? "tool"
            : "waiting_permission";
        writeFileSync(activityFile!, JSON.stringify({
          phase,
          ...(payload.tool_name === undefined ? {} : { tool: payload.tool_name }),
          ts: Date.now(),
        }));
        return { status: 0, stdout: "", stderr: "" };
      }
      case "hook stop-guard": {
        // 同 `hook report`：Stop 也走插件 wrapper，未武装的会话在 exec 之前就退出。
        // wrapper 的判据是 argv[1]==="hook"，两个子命令共用同一道闸——桩必须两边都模拟，
        // 否则「只有 report 被挡住、stop-guard 漏了」这种缺陷会全绿。
        if (!unarmedHookSpawns && env.AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN !== "1" && !env.AP_ACTIVITY_FILE) {
          return { status: 0, stdout: "", stderr: "" };
        }
        const activityFile = env.AP_ACTIVITY_FILE ?? join(
          env.AGENTPARTY_HOME!,
          "state",
          "activity",
          `${(JSON.parse(input ?? "{}") as { session_id?: string }).session_id ?? "unknown"}.json`,
        );
        mkdirSync(resolve(activityFile, ".."), { recursive: true });
        const payload = JSON.parse(input ?? "") as { stop_hook_active?: boolean };
        const armed = env.AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN === "1";
        writeFileSync(activityFile!, JSON.stringify({
          phase: armed && payload.stop_hook_active === false ? "working" : "idle",
          ts: Date.now(),
        }));
        return {
          status: 0,
          stdout: armed && payload.stop_hook_active === false
            ? `${JSON.stringify({ decision: "block", reason: "unfinished delivered work" })}\n`
            : "",
          stderr: "",
        };
      }
      default:
        throw new Error(`unexpected command: ${key}`);
    }
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * #1025 负向用例用：设成 true 就模拟一个「未武装也照样启动 runtime」的坏产物。
 * 验收必须因此失败——否则那条断言等于没写。
 */
let unarmedHookSpawns = false;

describe("CLI binary acceptance", () => {
  test("parses one explicit binary and rejects ambiguous requests", () => {
    expect(parseCliBinaryArguments(["--binary", "./party", "--plugin-root", "./plugin"])).toEqual({
      binary: "./party",
      pluginRoot: "./plugin",
    });
    expect(() => parseCliBinaryArguments([])).toThrow("--binary is required");
    expect(() => parseCliBinaryArguments(["--binary"])).toThrow("--binary requires a path");
    expect(() => parseCliBinaryArguments(["--binary", "a"])).toThrow("--plugin-root is required");
    expect(() => parseCliBinaryArguments(["--binary", "a", "--binary", "b"]))
      .toThrow("--binary may only be provided once");
    expect(() => parseCliBinaryArguments(["--unknown"])).toThrow("unknown argument: --unknown");
  });

  test("proves every released Claude entrypoint without starting a model call", () => {
    const report = verifyCliBinary(artifact(), pluginRoot, successfulRunner());
    expect(report).toMatchObject({
      schema: "agentparty.cli-binary-acceptance.v1",
      status: "passed",
      version: "1.2.3",
      probes: {
        claude_launcher_help: true,
        claude_busy_channel_verifier_help: true,
        claude_plugin_doctor_help: true,
        claude_channel_adapter_help: true,
        claude_cross_session_verifier_help: true,
        claude_hook_adapter_help: true,
        claude_cross_session_hook_fail_closed: true,
        plugin_runtime_hook_exec_form: true,
        plugin_activity_unarmed_isolated: true,
        plugin_activity_failed_push_rearms: true,
        plugin_activity_busy_phase: true,
        plugin_activity_waiting_phase: true,
        plugin_stop_guard_unarmed_isolated: true,
        plugin_stop_guard_armed_blocks: true,
        plugin_stop_guard_blocked_activity_working: true,
        plugin_stop_guard_continuation_allows: true,
      },
      model_calls_started: false,
    });
    expect(report.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fails closed when a compiled dynamic entrypoint is absent", () => {
    const runner = successfulRunner(new Map([
      ["claude-channel --help", { status: 1, stdout: "", stderr: "module not found\n" }],
    ]));
    expect(() => verifyCliBinary(artifact(), pluginRoot, runner)).toThrow(
      "party claude-channel --help exited 1; expected 0",
    );
  });

  test("accepts a full semantic version with prerelease and build metadata", () => {
    const runner = successfulRunner(new Map([
      ["--version", { status: 0, stdout: "1.2.3-rc.1+build.7\n", stderr: "" }],
    ]));
    expect(verifyCliBinary(artifact(), pluginRoot, runner).version).toBe("1.2.3-rc.1+build.7");
  });

  test("fails closed when the private Cross-session hook stops rejecting malformed input", () => {
    const runner = successfulRunner(new Map([
      ["claude-cross-session-hook", { status: 0, stdout: "", stderr: "" }],
    ]));
    expect(() => verifyCliBinary(artifact(), pluginRoot, runner)).toThrow(
      "party claude-cross-session-hook exited 0; expected 2",
    );
  });

  test("未武装的会话若仍然启动 runtime，验收必须失败（#1025 回归门禁）", () => {
    // 直接钉住那条断言的**存在**：把它从 verify-cli-binary.ts 里删掉，本用例就会红。
    unarmedHookSpawns = true;
    try {
      expect(() => verifyCliBinary(artifact(), pluginRoot, successfulRunner()))
        .toThrow(/unarmed plugin lifecycle hook still wrote/);
    } finally {
      unarmedHookSpawns = false;
    }
  });
});
