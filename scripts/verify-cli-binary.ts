#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { DirectedDelivery, MsgFrame } from "../shared/src/protocol";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
} from "../cli/src/delivery-recovery-journal";

const SCHEMA = "agentparty.cli-binary-acceptance.v1";
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface CliBinaryOptions {
  binary: string;
  pluginRoot: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type BinaryRunner = (
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string,
) => CommandResult;

export interface CliBinaryAcceptanceReport {
  schema: typeof SCHEMA;
  status: "passed";
  artifact: string;
  artifact_sha256: string;
  version: string;
  probes: {
    claude_launcher_help: true;
    claude_busy_channel_verifier_help: true;
    claude_plugin_doctor_help: true;
    claude_channel_adapter_help: true;
    claude_cross_session_verifier_help: true;
    claude_hook_adapter_help: true;
    claude_cross_session_hook_fail_closed: true;
    plugin_runtime_hook_exec_form: true;
    plugin_activity_unarmed_isolated: true;
    /** #1025：未武装的会话连 runtime 都不该启动（不只是不写共享 presence）。 */
    plugin_hook_unarmed_does_not_spawn: true;
    plugin_activity_failed_push_rearms: true;
    plugin_activity_busy_phase: true;
    plugin_activity_waiting_phase: true;
    plugin_stop_guard_unarmed_isolated: true;
    plugin_stop_guard_armed_blocks: true;
    plugin_stop_guard_blocked_activity_working: true;
    plugin_stop_guard_continuation_allows: true;
  };
  model_calls_started: false;
}

const defaultRunner: BinaryRunner = (binary, args, env, input) => {
  const result = spawnSync(binary, [...args], {
    encoding: "utf8",
    env,
    input,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  };
};

export function parseCliBinaryArguments(argv: readonly string[]): CliBinaryOptions {
  let binary: string | undefined;
  let pluginRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--binary" && argument !== "--plugin-root") {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value) throw new Error(`${argument} requires a path`);
    if (argument === "--binary") {
      if (binary !== undefined) throw new Error("--binary may only be provided once");
      binary = value;
    } else {
      if (pluginRoot !== undefined) throw new Error("--plugin-root may only be provided once");
      pluginRoot = value;
    }
  }
  if (binary === undefined) throw new Error("--binary is required");
  if (pluginRoot === undefined) throw new Error("--plugin-root is required");
  return { binary, pluginRoot };
}

function assertArtifact(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("CLI binary must be a regular non-symlink file");
  }
  if (stat.size === 0) throw new Error("CLI binary is empty");
  if (process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    throw new Error("CLI binary is not executable");
  }
}

function pluginHookArguments(pluginRoot: string, event: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(pluginRoot, "hooks/hooks.json"), "utf8")) as unknown;
  } catch {
    throw new Error("plugin hooks configuration was not readable JSON");
  }
  const hooks = typeof parsed === "object" && parsed !== null
    ? (parsed as { hooks?: unknown }).hooks
    : undefined;
  const entries = typeof hooks === "object" && hooks !== null
    ? (hooks as Record<string, unknown>)[event]
    : undefined;
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error(`plugin hook ${event} did not have one matcher entry`);
  }
  const handlers = typeof entries[0] === "object" && entries[0] !== null
    ? (entries[0] as { hooks?: unknown }).hooks
    : undefined;
  if (!Array.isArray(handlers) || handlers.length !== 1) {
    throw new Error(`plugin hook ${event} did not have one command handler`);
  }
  const handler = handlers[0];
  const expectedArgs = ["hook", event === "Stop" ? "stop-guard" : "report"];
  if (
    typeof handler !== "object" || handler === null ||
    (handler as { type?: unknown }).type !== "command" ||
    (handler as { command?: unknown }).command !== "${CLAUDE_PLUGIN_ROOT}/bin/agentparty-runtime" ||
    JSON.stringify((handler as { args?: unknown }).args) !== JSON.stringify(expectedArgs)
  ) {
    throw new Error(`plugin hook ${event} did not use the expected exec-form runtime command`);
  }
  return expectedArgs;
}

function runExpected(
  runner: BinaryRunner,
  binary: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  expectedStatus: number,
  stdoutIncludes: readonly string[],
  stderrIncludes: readonly string[] = [],
  input?: string,
): CommandResult {
  const result = runner(binary, args, env, input);
  const label = `party ${args.join(" ")}`;
  if (result.error !== undefined) throw new Error(`${label} failed to start: ${result.error.message}`);
  if (result.status !== expectedStatus) {
    throw new Error(`${label} exited ${result.status ?? "without a status"}; expected ${expectedStatus}`);
  }
  for (const expected of stdoutIncludes) {
    if (!result.stdout.includes(expected)) throw new Error(`${label} stdout omitted: ${expected}`);
  }
  for (const expected of stderrIncludes) {
    if (!result.stderr.includes(expected)) throw new Error(`${label} stderr omitted: ${expected}`);
  }
  if (expectedStatus === 0 && result.stderr !== "") {
    throw new Error(`${label} wrote unexpected stderr`);
  }
  return result;
}

export function verifyCliBinary(
  requestedPath: string,
  requestedPluginRoot: string,
  runner: BinaryRunner = defaultRunner,
): CliBinaryAcceptanceReport {
  const binary = resolve(requestedPath);
  assertArtifact(binary);
  const pluginRuntime = resolve(requestedPluginRoot, "bin/agentparty-runtime");
  assertArtifact(pluginRuntime);
  const isolatedHome = mkdtempSync(join(tmpdir(), "agentparty-cli-binary-acceptance-"));
  try {
    const env = { ...process.env, AGENTPARTY_HOME: isolatedHome };
    const versionResult = runExpected(runner, binary, env, ["--version"], 0, []);
    const version = versionResult.stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error("party --version did not return a semantic version");
    }

    runExpected(runner, binary, env, ["claude", "--help"], 0, [
      "Marketplace Channel explicitly armed",
      "party bridge claude",
    ]);
    runExpected(runner, binary, env, ["claude", "--verify", "--help"], 0, [
      "party claude --verify",
      "--preflight-only performs no model call",
      "--live explicitly authorizes one real model session",
      "party_channel_claim ->",
    ]);
    runExpected(runner, binary, env, ["doctor", "claude-plugin", "--help"], 0, [
      "read-only, no-model audit",
      "party doctor claude-plugin",
    ]);
    runExpected(runner, binary, env, ["claude-channel", "--help"], 0, [
      "--require-launch-opt-in",
      "claude/channel",
    ]);
    runExpected(runner, binary, env, ["bridge", "claude", "--verify", "--help"], 0, [
      "This makes real model calls",
      "--preflight-only makes no model calls",
      "party bridge claude --verify",
      "Marketplace lifecycle",
    ]);
    runExpected(runner, binary, env, ["hook", "--help"], 0, ["stop-guard", "push"]);
    const hookResult = runExpected(
      runner,
      binary,
      env,
      ["claude-cross-session-hook"],
      2,
      [],
      ["malformed event envelope"],
      "{}",
    );
    if (hookResult.stdout !== "") {
      throw new Error("party claude-cross-session-hook wrote unexpected stdout on rejection");
    }

    // A detached publish failure must release exactly its own optimistic
    // throttle marker. Use an isolated home with no auth so the compiled push
    // helper takes the failure path without network or model work.
    const failedPushActivityFile = join(isolatedHome, "failed-push-activity.json");
    const failedPushAttempt = "33333333-3333-4333-8333-333333333333";
    writeFileSync(failedPushActivityFile, JSON.stringify({ phase: "working", ts: Date.now() }));
    writeFileSync(`${failedPushActivityFile}.push.json`, JSON.stringify({
      last_push_ts: Date.now(),
      attempt_id: failedPushAttempt,
    }));
    runExpected(
      runner,
      binary,
      env,
      [
        "hook",
        "push",
        failedPushActivityFile,
        "--channel",
        "release-failed-push",
        "--attempt-id",
        failedPushAttempt,
      ],
      0,
      [],
    );
    let failedPushMarker: unknown;
    try {
      failedPushMarker = JSON.parse(
        readFileSync(`${failedPushActivityFile}.push.failed.json`, "utf8"),
      ) as unknown;
    } catch {
      throw new Error("compiled failed activity push did not release its throttle marker");
    }
    if (
      typeof failedPushMarker !== "object" || failedPushMarker === null ||
      (failedPushMarker as { attempt_id?: unknown }).attempt_id !== failedPushAttempt
    ) {
      throw new Error("compiled failed activity push released the wrong throttle attempt");
    }

    // Enabled Marketplace hooks are initialized in ordinary Claude sessions
    // too. The guarantee has always been "an unarmed session must not touch a
    // real listener's shared presence"; since #1025 it is strictly stronger:
    // such a session does no work at all. The plugin wrapper returns before it
    // ever execs the runtime, because loading the CLI costs ~130ms of CPU per
    // event no matter what the event is, and an unarmed session cannot use
    // AgentParty anyway (#1018 gates its tools).
    //
    // This probe runs against the real release binary through the real cached
    // wrapper — the unit tests use a stub, so this is the only place the shipped
    // artifact's per-event cost contract is actually enforced.
    const ordinarySessionId = "release-plugin-hook-ordinary";
    const ordinaryActivityFile = join(
      isolatedHome,
      "state",
      "activity",
      `${ordinarySessionId}.json`,
    );
    const ordinaryHookEnv = {
      ...env,
      AGENTPARTY_RUNTIME_BIN: binary,
      AGENTPARTY_CHANNEL: "release-plugin-ordinary",
      AGENTPARTY_CLAUDE_CHANNEL_OPT_IN: undefined,
      AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: undefined,
      AP_ACTIVITY_FILE: undefined,
    };
    runExpected(
      runner,
      pluginRuntime,
      ordinaryHookEnv,
      pluginHookArguments(requestedPluginRoot, "SessionStart"),
      0,
      [],
      [],
      JSON.stringify({
        session_id: ordinarySessionId,
        hook_event_name: "SessionStart",
        cwd: process.cwd(),
      }),
    );
    // No local snapshot: nothing ran. (The previous contract accepted a private
    // snapshot here; nothing ever read it except that same session's next hook,
    // which now also does not run.)
    if (existsSync(ordinaryActivityFile)) {
      throw new Error("unarmed plugin lifecycle hook still wrote a local activity snapshot");
    }
    // The original guarantee, unchanged: never the shared-presence push marker.
    if (existsSync(`${ordinaryActivityFile}.push.json`)) {
      throw new Error("unarmed plugin lifecycle hook attempted to publish shared presence activity");
    }
    // And the armed session must still work — otherwise "does nothing" would be
    // trivially satisfied by a hook that is simply broken.
    const armedSessionId = "release-plugin-hook-armed";
    const armedActivityFile = join(isolatedHome, "state", "activity", `${armedSessionId}.json`);
    runExpected(
      runner,
      pluginRuntime,
      { ...ordinaryHookEnv, AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "1" },
      pluginHookArguments(requestedPluginRoot, "SessionStart"),
      0,
      [],
      [],
      JSON.stringify({
        session_id: armedSessionId,
        hook_event_name: "SessionStart",
        cwd: process.cwd(),
      }),
    );
    let armedActivity: unknown;
    try {
      armedActivity = JSON.parse(readFileSync(armedActivityFile, "utf8")) as unknown;
    } catch {
      throw new Error("armed plugin lifecycle hook did not write its local activity snapshot");
    }
    if (
      typeof armedActivity !== "object" || armedActivity === null ||
      (armedActivity as { phase?: unknown }).phase !== "starting"
    ) {
      throw new Error("armed plugin lifecycle hook wrote the wrong local activity snapshot");
    }

    // This is the exact exec-form composition Claude uses for plugin hooks:
    // cached wrapper path as command, hooks.json args, release binary as the
    // resolved runtime. AP_ACTIVITY_FILE keeps the probes local and proves the
    // lifecycle snapshots without spawning a REST helper.
    const pluginActivityFile = join(isolatedHome, "plugin-hook-activity.json");
    const pluginHookEnv = {
      ...env,
      AGENTPARTY_RUNTIME_BIN: binary,
      AGENTPARTY_CLAUDE_CHANNEL_OPT_IN: undefined,
      AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: undefined,
      AP_ACTIVITY_FILE: pluginActivityFile,
    };
    const runPluginHook = (
      event: "SessionStart" | "PreToolUse" | "Notification" | "Stop",
      payload: Record<string, unknown>,
      expectedPhase: "starting" | "tool" | "waiting_permission" | "idle",
      expectedTool?: string,
    ): CommandResult => {
      const result = runExpected(
        runner,
        pluginRuntime,
        pluginHookEnv,
        pluginHookArguments(requestedPluginRoot, event),
        0,
        [],
        [],
        JSON.stringify({
          session_id: "release-plugin-hook-probe",
          hook_event_name: event,
          cwd: process.cwd(),
          ...payload,
        }),
      );
      let activity: unknown;
      try {
        activity = JSON.parse(readFileSync(pluginActivityFile, "utf8")) as unknown;
      } catch {
        throw new Error(`plugin runtime ${event} hook did not write a readable activity snapshot`);
      }
      if (
        typeof activity !== "object" || activity === null ||
        (activity as { phase?: unknown }).phase !== expectedPhase ||
        typeof (activity as { ts?: unknown }).ts !== "number" ||
        (expectedTool !== undefined && (activity as { tool?: unknown }).tool !== expectedTool)
      ) {
        throw new Error(`plugin runtime ${event} hook wrote the wrong activity snapshot`);
      }
      return result;
    };
    runPluginHook("SessionStart", {}, "starting");
    runPluginHook("PreToolUse", { tool_name: "Bash" }, "tool", "Bash");
    runPluginHook(
      "Notification",
      { tool_name: "Bash", message: "Permission required for Bash" },
      "waiting_permission",
      "Bash",
    );
    const unarmedStop = runPluginHook("Stop", { stop_hook_active: false }, "idle");
    if (unarmedStop.stdout !== "") {
      throw new Error("unarmed plugin Stop hook unexpectedly blocked an ordinary Claude session");
    }

    // Prepare one private, local recovery debt using the same durable journal
    // contract as the Channel adapter. The compiled hook must block the first
    // Stop only when the explicit launcher opt-in is present, then allow the
    // continuation Stop. No server or model process is involved.
    const stopServer = "https://release-binary-stop-probe.invalid";
    const stopToken = "ap_release_binary_stop_probe";
    const stopChannel = "release-binary-stop-probe";
    writeFileSync(join(isolatedHome, "config.json"), JSON.stringify({
      server: stopServer,
      token: stopToken,
      identity: {
        name: "release-binary-probe",
        email: null,
        kind: "agent",
        role: "agent",
        owner: "release-acceptance",
        channel_scope: stopChannel,
        verified_at: Date.now(),
      },
    }), { mode: 0o600 });
    const now = Date.now();
    const delivery: DirectedDelivery = {
      id: "delivery-release-binary-stop-probe",
      message_seq: 1,
      target_name: "release-binary-probe",
      cause: "mention",
      state: "claimed",
      attempt: 1,
      lease_epoch: 1,
      lease_token: "release-binary-lease-token",
      lease_until: now + 90_000,
      work_id: "work-release-binary-stop-probe",
      continuation_ref: "continuation-release-binary-stop-probe",
      reply_seq: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    const message: MsgFrame = {
      type: "msg",
      seq: 1,
      sender: { name: "release-owner", kind: "human" },
      kind: "message",
      body: "finish the release acceptance reply",
      mentions: ["release-binary-probe"],
      reply_to: null,
      state: null,
      note: null,
      status: null,
      ts: now,
    };
    const previousAgentPartyHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = isolatedHome;
    try {
      const journal = new DeliveryRecoveryJournal(
        deliveryRecoveryJournalPath("claude", stopServer, stopToken, stopChannel),
        stopChannel,
        "claude",
      );
      journal.recordClaim(delivery, message);
      journal.update(delivery.id, { phase: "harness_issued" });
    } finally {
      if (previousAgentPartyHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = previousAgentPartyHome;
    }
    const armedStopEnv = {
      ...pluginHookEnv,
      AGENTPARTY_CHANNEL: stopChannel,
      AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: "1",
    };
    const armedStop = runExpected(
      runner,
      pluginRuntime,
      armedStopEnv,
      pluginHookArguments(requestedPluginRoot, "Stop"),
      0,
      [],
      [],
      JSON.stringify({
        session_id: "release-plugin-hook-probe",
        hook_event_name: "Stop",
        stop_hook_active: false,
        cwd: process.cwd(),
      }),
    );
    let armedDecision: unknown;
    try {
      armedDecision = JSON.parse(armedStop.stdout) as unknown;
    } catch {
      throw new Error("armed plugin Stop hook did not return a structured decision");
    }
    if (
      typeof armedDecision !== "object" || armedDecision === null ||
      (armedDecision as { decision?: unknown }).decision !== "block"
    ) {
      throw new Error("armed plugin Stop hook did not block unfinished delivered work");
    }
    if (armedStop.stdout.includes(stopToken) || armedStop.stdout.includes(message.body)) {
      throw new Error("armed plugin Stop hook leaked private recovery data");
    }
    let blockedStopActivity: unknown;
    try {
      blockedStopActivity = JSON.parse(readFileSync(pluginActivityFile, "utf8")) as unknown;
    } catch {
      throw new Error("armed plugin Stop hook did not retain a readable activity snapshot");
    }
    if (
      typeof blockedStopActivity !== "object" || blockedStopActivity === null ||
      (blockedStopActivity as { phase?: unknown }).phase !== "working"
    ) {
      throw new Error("armed plugin Stop hook published idle while its continuation was still working");
    }
    const continuationStop = runExpected(
      runner,
      pluginRuntime,
      armedStopEnv,
      pluginHookArguments(requestedPluginRoot, "Stop"),
      0,
      [],
      [],
      JSON.stringify({
        session_id: "release-plugin-hook-probe",
        hook_event_name: "Stop",
        stop_hook_active: true,
        cwd: process.cwd(),
      }),
    );
    if (continuationStop.stdout !== "") {
      throw new Error("plugin Stop hook blocked its own continuation");
    }

    return {
      schema: SCHEMA,
      status: "passed",
      artifact: basename(binary),
      artifact_sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      version,
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
        plugin_hook_unarmed_does_not_spawn: true,
        plugin_activity_failed_push_rearms: true,
        plugin_activity_busy_phase: true,
        plugin_activity_waiting_phase: true,
        plugin_stop_guard_unarmed_isolated: true,
        plugin_stop_guard_armed_blocks: true,
        plugin_stop_guard_blocked_activity_working: true,
        plugin_stop_guard_continuation_allows: true,
      },
      model_calls_started: false,
    };
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
}

function usage(): void {
  console.log("usage: bun scripts/verify-cli-binary.ts --binary PATH --plugin-root PATH");
}

if (import.meta.main) {
  try {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      usage();
      process.exit(0);
    }
    const options = parseCliBinaryArguments(process.argv.slice(2));
    console.log(JSON.stringify(verifyCliBinary(options.binary, options.pluginRoot), null, 2));
  } catch (error) {
    console.error(`verify-cli-binary: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
