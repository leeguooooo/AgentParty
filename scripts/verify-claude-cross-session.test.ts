import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildNativeClaudeAcceptanceFailure,
  inspectNativeClaudePreflight,
  inspectCrossSessionEvidence as inspectRawCrossSessionEvidence,
  nativeClaudePreflightFailureResult,
  parseNativeClaudeArguments,
  parseClaudeVersion,
  parseJsonLines,
  unexpectedNativeClaudeAcceptanceFailure,
} from "./verify-claude-cross-session";

const senderSessionId = "11111111-1111-4111-8111-111111111111";
const receiverSessionId = "22222222-2222-4222-8222-222222222222";
const otherSessionId = "33333333-3333-4333-8333-333333333333";
const receiverInit = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: receiverSessionId,
  messaging_socket_path: "/private/tmp/example.sock",
  tools: ["ListAgents", "SendMessage", "Bash"],
});

function senderStream(lines: readonly string[]): string[] {
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const hasInit = parsed.some((event) => event.type === "system" && event.subtype === "init");
  return [
    ...(hasInit ? [] : [JSON.stringify({ type: "system", subtype: "init", session_id: senderSessionId })]),
    ...parsed.map((event) => event.type === "system" && event.subtype === "init"
      ? JSON.stringify(event)
      : JSON.stringify({ ...event, session_id: senderSessionId })),
  ];
}

function inspectCrossSessionEvidence(
  senderLines: readonly string[],
  receiverLines: readonly string[],
  marker: string,
  expectedReceiverName: string,
  timingBarrierIntact: boolean = false,
) {
  return inspectRawCrossSessionEvidence(
    senderStream(senderLines),
    receiverLines,
    marker,
    expectedReceiverName,
    timingBarrierIntact,
  );
}

describe("Claude Cross-session live acceptance evidence", () => {
  test("classifies a ready native preflight without claiming delivery", () => {
    expect(inspectNativeClaudePreflight({
      platform: "darwin",
      env: {},
      versionProbe: { stdout: "2.1.228 (Claude Code)", code: 0 },
      authProbe: { stdout: '{"loggedIn":true,"apiProvider":"firstParty"}', code: 0 },
    })).toEqual({
      exitCode: 0,
      report: {
        schema: "agentparty.claude-cross-session-native-preflight.v1",
        status: "ready",
        blockers: [],
        claude_logged_in: true,
        claude_auth_status: "logged_in",
        claude_version: "2.1.228",
        claude_api_provider: "firstParty",
        model_calls_started: false,
        delivery_verified: false,
      },
    });
  });

  test("accepts canonical logged-out auth JSON even when Claude exits nonzero", () => {
    const result = inspectNativeClaudePreflight({
      platform: "darwin",
      env: {},
      versionProbe: { stdout: "2.1.228", code: 0 },
      authProbe: { stdout: '{"loggedIn":false,"apiProvider":"firstParty"}', code: 1 },
    });
    expect(result.exitCode).toBe(2);
    expect(result.report).toMatchObject({
      status: "claude_auth_required",
      blockers: ["claude_auth_required"],
      claude_logged_in: false,
      claude_auth_status: "logged_out",
    });
  });

  test("keeps independently known native blockers while preserving status precedence", () => {
    const authAndProvider = inspectNativeClaudePreflight({
      platform: "linux",
      env: { CLAUDE_CODE_USE_BEDROCK: "true" },
      versionProbe: { stdout: "2.1.228", code: 0 },
      authProbe: { stdout: "not-json", code: 0 },
    });
    expect(authAndProvider.exitCode).toBe(5);
    expect(authAndProvider.report).toMatchObject({
      status: "claude_auth_unavailable",
      blockers: ["claude_auth_unavailable", "unsupported_provider"],
      cross_session_conflict_variables: ["CLAUDE_CODE_USE_BEDROCK"],
    });

    const oldVersion = inspectNativeClaudePreflight({
      platform: "darwin",
      env: { DISABLE_TELEMETRY: "1" },
      versionProbe: { stdout: "2.1.223", code: 0 },
      authProbe: { stdout: '{"loggedIn":false}', code: 1 },
    });
    expect(oldVersion.exitCode).toBe(10);
    expect(oldVersion.report).toMatchObject({
      status: "environment_unavailable",
      blockers: [
        "claude_version_unsupported",
        "claude_auth_required",
        "feature_flag_evaluation_disabled",
      ],
      cross_session_conflict_variables: ["DISABLE_TELEMETRY"],
    });
  });

  test("does not invent skipped probe blockers on an unsupported platform", () => {
    const result = inspectNativeClaudePreflight({
      platform: "win32",
      env: { DISABLE_TELEMETRY: "1" },
    });
    expect(result.exitCode).toBe(10);
    expect(result.report).toMatchObject({
      status: "environment_unavailable",
      blockers: ["unsupported_platform", "feature_flag_evaluation_disabled"],
      claude_auth_status: "unavailable",
      cross_session_conflict_variables: ["DISABLE_TELEMETRY"],
      model_calls_started: false,
      delivery_verified: false,
    });
  });

  test("rejects unknown or duplicate native arguments with a stable private failure", () => {
    expect(parseNativeClaudeArguments(["--keep-artifacts", "--preflight-only"])).toEqual({
      keepArtifacts: true,
      preflightOnly: true,
    });
    for (const argv of [
      ["--preflight-only", "--unknown-secret=value"],
      ["--preflight-only", "--preflight-only"],
      ["--keep-artifacts", "--keep-artifacts"],
    ]) {
      try {
        parseNativeClaudeArguments(argv);
        throw new Error("expected native argument parsing to fail");
      } catch (error) {
        const failure = nativeClaudePreflightFailureResult(error);
        expect(failure).toEqual({
          exitCode: 9,
          report: {
            schema: "agentparty.claude-cross-session-native-preflight.v1",
            status: "invalid_request",
            blockers: ["invalid_arguments"],
            error_code: "invalid_arguments",
            model_calls_started: false,
            delivery_verified: false,
          },
        });
        expect(JSON.stringify(failure)).not.toContain("unknown-secret");
      }
    }
    expect(nativeClaudePreflightFailureResult(new Error("private unexpected detail"))).toEqual({
      exitCode: 1,
      report: {
        schema: "agentparty.claude-cross-session-native-preflight.v1",
        status: "internal_error",
        blockers: ["internal_error"],
        error_code: "internal_error",
        model_calls_started: false,
        delivery_verified: false,
      },
    });
    expect(buildNativeClaudeAcceptanceFailure({
      phase: "execution",
      code: "session_execution_failed",
      exitCode: 1,
      modelCallsStarted: true,
      claudeVersion: "2.1.228",
      artifacts: "/private/verifier-owned-artifacts",
    })).toEqual({
      exitCode: 1,
      report: {
        schema: "agentparty.claude-cross-session-acceptance.v1",
        status: "failed",
        failure_phase: "execution",
        error_code: "session_execution_failed",
        model_calls_started: true,
        delivery_verified: false,
        claude_version: "2.1.228",
        artifacts: "/private/verifier-owned-artifacts",
      },
    });
    expect(unexpectedNativeClaudeAcceptanceFailure(new Error("private unexpected detail"))).toEqual({
      exitCode: 1,
      report: {
        schema: "agentparty.claude-cross-session-acceptance.v1",
        status: "failed",
        failure_phase: "internal",
        error_code: "internal_error",
        model_calls_started: "unknown",
        delivery_verified: false,
      },
    });
  });

  test("full acceptance rejects invalid arguments with JSON before probing Claude", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "verify-claude-cross-session.ts"),
      "--unknown-secret=value",
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(9);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      schema: "agentparty.claude-cross-session-acceptance.v1",
      status: "failed",
      failure_phase: "request",
      error_code: "invalid_arguments",
      model_calls_started: false,
      delivery_verified: false,
    });
    expect(stdout).not.toContain("unknown-secret");
  });

  test("full acceptance reports preflight drift without starting a model session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentparty-native-acceptance-preflight-test-"));
    const fakeClaude = join(directory, "claude");
    const invocationLog = join(directory, "invocations.txt");
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_INVOCATIONS"
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.228 (Claude Code)'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '{"loggedIn":false,"apiProvider":"firstParty"}'
  exit 1
fi
exit 97
`, "utf8");
    chmodSync(fakeClaude, 0o700);
    try {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "verify-claude-cross-session.ts"),
      ], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          FAKE_CLAUDE_INVOCATIONS: invocationLog,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(2);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        schema: "agentparty.claude-cross-session-acceptance.v1",
        status: "failed",
        failure_phase: "preflight",
        error_code: "claude_auth_required",
        model_calls_started: false,
        delivery_verified: false,
        claude_version: "2.1.228",
        preflight: {
          schema: "agentparty.claude-cross-session-native-preflight.v1",
          status: "claude_auth_required",
          blockers: ["claude_auth_required"],
          model_calls_started: false,
          delivery_verified: false,
        },
      });
      expect(readFileSync(invocationLog, "utf8").trim().split("\n").sort()).toEqual([
        "--version",
        "auth status",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("receiver startup failure is structured and keeps raw diagnostics in artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentparty-native-acceptance-startup-test-"));
    const fakeClaude = join(directory, "claude");
    writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.228 (Claude Code)'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '{"loggedIn":true,"apiProvider":"firstParty"}'
  exit 0
fi
printf '%s\\n' 'PRIVATE_RECEIVER_DIAGNOSTIC' >&2
exit 42
`, "utf8");
    chmodSync(fakeClaude, 0o700);
    let artifacts: string | undefined;
    try {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "verify-claude-cross-session.ts"),
      ], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("PRIVATE_RECEIVER_DIAGNOSTIC");
      const report = JSON.parse(stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        schema: "agentparty.claude-cross-session-acceptance.v1",
        status: "failed",
        failure_phase: "receiver_startup",
        error_code: "receiver_startup_failed",
        model_calls_started: true,
        delivery_verified: false,
        claude_version: "2.1.228",
      });
      artifacts = typeof report.artifacts === "string" ? report.artifacts : undefined;
      expect(artifacts).toBeDefined();
      expect(readFileSync(join(artifacts!, "receiver.partial.stderr.txt"), "utf8"))
        .toContain("PRIVATE_RECEIVER_DIAGNOSTIC");
    } finally {
      if (artifacts !== undefined) rmSync(artifacts, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("full acceptance stops an oversized session stream with a stable private report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentparty-native-acceptance-output-limit-test-"));
    const fakeClaude = join(directory, "claude");
    writeFileSync(fakeClaude, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' '2.1.228 (Claude Code)'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\n' '{"loggedIn":true,"apiProvider":"firstParty"}'
  exit 0
fi
head -c 1048577 /dev/zero | tr '\\000' X
sleep 30
`, "utf8");
    chmodSync(fakeClaude, 0o700);
    let artifacts: string | undefined;
    try {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "verify-claude-cross-session.ts"),
      ], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(stderr).toBe("");
      expect(stdout).not.toContain("XXXXX");
      const report = JSON.parse(stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        schema: "agentparty.claude-cross-session-acceptance.v1",
        status: "failed",
        failure_phase: "receiver_startup",
        error_code: "session_output_limit_exceeded",
        model_calls_started: true,
        delivery_verified: false,
        session_output_limit: {
          stream: "receiver_stdout",
          kind: "line_bytes",
          limit: 1048576,
        },
      });
      artifacts = typeof report.artifacts === "string" ? report.artifacts : undefined;
      expect(artifacts).toBeDefined();
    } finally {
      if (artifacts !== undefined) rmSync(artifacts, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("invalid preflight arguments emit JSON before any Claude probe", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentparty-native-preflight-invalid-test-"));
    const fakeClaude = join(directory, "claude");
    const invocationLog = join(directory, "invocations.txt");
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_INVOCATIONS"
exit 97
`, "utf8");
    chmodSync(fakeClaude, 0o700);
    try {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "verify-claude-cross-session.ts"),
        "--preflight-only",
        "--unknown-secret=value",
      ], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          FAKE_CLAUDE_INVOCATIONS: invocationLog,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(9);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({
        schema: "agentparty.claude-cross-session-native-preflight.v1",
        status: "invalid_request",
        blockers: ["invalid_arguments"],
        error_code: "invalid_arguments",
        model_calls_started: false,
        delivery_verified: false,
      });
      expect(stdout).not.toContain("unknown-secret");
      expect(existsSync(invocationLog)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preflight-only invokes probes but never starts a Claude model session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentparty-native-preflight-test-"));
    const fakeClaude = join(directory, "claude");
    const invocationLog = join(directory, "invocations.txt");
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CLAUDE_INVOCATIONS"
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.228 (Claude Code)'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '{"loggedIn":true,"apiProvider":"firstParty"}'
  exit 0
fi
exit 97
`, "utf8");
    chmodSync(fakeClaude, 0o700);
    try {
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "verify-claude-cross-session.ts"),
        "--preflight-only",
      ], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          FAKE_CLAUDE_INVOCATIONS: invocationLog,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({
        schema: "agentparty.claude-cross-session-native-preflight.v1",
        status: "ready",
        blockers: [],
        model_calls_started: false,
        delivery_verified: false,
      });
      expect(readFileSync(invocationLog, "utf8").trim().split("\n").sort()).toEqual([
        "--version",
        "auth status",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("parses decorated versions and ignores malformed JSONL", () => {
    expect(parseClaudeVersion("2.1.228 (Claude Code)")).toEqual([2, 1, 228]);
    expect(parseClaudeVersion("unknown")).toBeNull();
    expect(parseJsonLines(["not json", JSON.stringify({ type: "result" })])).toEqual([
      { type: "result" },
    ]);
  });

  test("requires initialization, both sender tool calls, and receiver observation", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_fixture";
    const sender = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "send-1",
            name: "SendMessage",
            input: { recipient: "receiver [ref-a]", message: marker },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "send-1", content: "delivered" }] },
      }),
    ];
    const receiver = [
      receiverInit,
      JSON.stringify({
        type: "assistant",
        session_id: receiverSessionId,
        message: { content: [{ type: "tool_use", id: "wait-1", name: "Bash", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        session_id: receiverSessionId,
        message: { content: [{ type: "tool_result", tool_use_id: "wait-1", content: "released" }] },
      }),
      JSON.stringify({
        type: "user",
        session_id: receiverSessionId,
        message: { content: `message from sender: ${marker}` },
      }),
    ];
    expect(inspectCrossSessionEvidence(sender, receiver, marker, "receiver", true)).toEqual({
      receiver_initialized: true,
      distinct_claude_session_ids: true,
      sender_used_list_agents: true,
      sender_used_send_message_with_marker: true,
      sender_send_message_result_observed: true,
      receiver_observed_marker: true,
      receiver_wait_boundary_before_marker: true,
      timing_barrier_intact: true,
    });
  });

  test("requires distinct sessions, a successful send result, and the completed receiver wait", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_causal";
    const sender = senderStream([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "list-causal", name: "ListAgents", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "list-causal", content: "receiver [ref-a]" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          id: "send-causal",
          name: "SendMessage",
          input: { to: "receiver [ref-a]", message: marker },
        }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "send-causal", content: "delivered" }] },
      }),
    ]);
    const receiver = [
      receiverInit,
      JSON.stringify({
        type: "assistant",
        session_id: receiverSessionId,
        message: { content: [{ type: "tool_use", id: "wait-causal", name: "Bash", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        session_id: receiverSessionId,
        message: { content: [{ type: "tool_result", tool_use_id: "wait-causal", content: "released" }] },
      }),
      JSON.stringify({
        type: "user",
        session_id: receiverSessionId,
        message: { content: marker },
      }),
    ];
    const inspect = (
      senderLines: readonly string[] = sender,
      receiverLines: readonly string[] = receiver,
      timingBarrierIntact = true,
    ) => inspectRawCrossSessionEvidence(
      senderLines,
      receiverLines,
      marker,
      "receiver",
      timingBarrierIntact,
    );
    expect(inspect()).toMatchObject({
      distinct_claude_session_ids: true,
      sender_send_message_result_observed: true,
      receiver_wait_boundary_before_marker: true,
      timing_barrier_intact: true,
    });

    const sameSessionReceiver = receiver.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      return JSON.stringify({ ...event, session_id: senderSessionId });
    });
    expect(inspect(sender, sameSessionReceiver).distinct_claude_session_ids).toBe(false);

    const failedSend = sender.map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (!line.includes('"tool_use_id":"send-causal"')) return line;
      const message = event.message as Record<string, unknown>;
      const content = (message.content as Record<string, unknown>[]).map((block) => ({
        ...block,
        is_error: true,
      }));
      return JSON.stringify({ ...event, message: { ...message, content } });
    });
    expect(inspect(failedSend).sender_send_message_result_observed).toBe(false);

    const earlyMarker = [receiver[0]!, receiver[1]!, receiver[3]!, receiver[2]!];
    expect(inspect(sender, earlyMarker).receiver_wait_boundary_before_marker).toBe(false);
    expect(inspect(sender, receiver, false).timing_barrier_intact).toBe(false);
  });

  test("binds the sender tool chain to one unique init session", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_sender_binding";
    const valid = senderStream([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          name: "SendMessage",
          input: { to: "receiver [ref-a]", message: marker },
        }] },
      }),
    ]);
    const inspect = (lines: readonly string[]) =>
      inspectRawCrossSessionEvidence(lines, [], marker, "receiver");
    expect(inspect(valid)).toMatchObject({
      sender_used_list_agents: true,
      sender_used_send_message_with_marker: true,
    });

    const rewrite = (
      lines: readonly string[],
      index: number,
      update: (event: Record<string, unknown>) => Record<string, unknown>,
    ) => lines.map((line, current) => current === index
      ? JSON.stringify(update(JSON.parse(line) as Record<string, unknown>))
      : line);
    const withoutSession = rewrite(valid, 1, (event) => {
      const { session_id: _ignored, ...rest } = event;
      return rest;
    });
    expect(inspect(withoutSession).sender_used_list_agents).toBe(false);
    expect(inspect(rewrite(valid, 2, (event) => ({ ...event, session_id: otherSessionId })))
      .sender_used_list_agents).toBe(false);
    expect(inspect([valid[1]!, valid[0]!, ...valid.slice(2)]).sender_used_list_agents).toBe(false);
    expect(inspect([valid[0]!, valid[0]!, ...valid.slice(1)]).sender_used_list_agents).toBe(false);
    const failedListResult = rewrite(valid, 2, (event) => {
      const message = event.message as Record<string, unknown>;
      const content = (message.content as Record<string, unknown>[]).map((block) => ({
        ...block,
        is_error: true,
      }));
      return { ...event, message: { ...message, content } };
    });
    expect(inspect(failedListResult).sender_used_list_agents).toBe(false);
    const foreignDuplicateListResult = JSON.stringify({
      type: "user",
      session_id: otherSessionId,
      message: { content: [{
        type: "tool_result",
        tool_use_id: "list-1",
        content: "receiver [ref-a]",
      }] },
    });
    expect(inspect([...valid, foreignDuplicateListResult]).sender_used_list_agents).toBe(false);
    const foreignDuplicateSend = JSON.stringify({
      type: "assistant",
      session_id: otherSessionId,
      message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver", message: marker } }] },
    });
    expect(inspect([...valid, foreignDuplicateSend]).sender_used_send_message_with_marker).toBe(false);
  });

  test("requires direct top-level singleton tool envelopes with no intervening tool", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_strict_envelope";
    const list = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] },
    });
    const result = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] },
    });
    const send = JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        name: "SendMessage",
        input: { to: "receiver [ref-a]", message: marker },
      }] },
    });
    const inspect = (lines: readonly string[]) =>
      inspectCrossSessionEvidence(lines, [], marker, "receiver");

    const nestedResult = JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "text",
        text: "decoy",
        nested: { type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" },
      }] },
    });
    expect(inspect([list, nestedResult, send]).sender_used_list_agents).toBe(false);

    const childResult = JSON.stringify({
      type: "user",
      parent_tool_use_id: "subagent-1",
      message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] },
    });
    expect(inspect([list, childResult, send]).sender_used_list_agents).toBe(false);

    const siblingResult = JSON.stringify({
      type: "user",
      message: { content: [
        { type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" },
        { type: "tool_result", tool_use_id: "bash-1", content: "unrelated" },
      ] },
    });
    expect(inspect([list, siblingResult, send]).sender_used_list_agents).toBe(false);

    const bash = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: {} }] },
    });
    expect(inspect([list, result, bash, send]).sender_used_send_message_with_marker).toBe(false);

    const parallelList = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "tool_use", id: "list-1", name: "ListAgents", input: {} },
        { type: "tool_use", id: "bash-1", name: "Bash", input: {} },
      ] },
    });
    expect(inspect([parallelList, result, send]).sender_used_list_agents).toBe(false);
  });

  test("does not accept prompt echo or a SendMessage without the random marker", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_fixture";
    const sender = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver", message: "wrong" } }] },
      }),
    ];
    const receiver = [receiverInit];
    expect(inspectCrossSessionEvidence(sender, receiver, marker, "receiver")).toEqual({
      receiver_initialized: true,
      distinct_claude_session_ids: true,
      sender_used_list_agents: true,
      sender_used_send_message_with_marker: false,
      sender_send_message_result_observed: false,
      receiver_observed_marker: false,
      receiver_wait_boundary_before_marker: false,
      timing_barrier_intact: false,
    });
  });

  test("requires the actual SendMessage fields and actual inbound user content", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_fixture";
    const sender = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "SendMessage",
            input: {
              to: "wrong [ref-z]",
              message: "wrong-marker",
              decoy: { to: "receiver [ref-a]", message: marker },
            },
          }],
        },
      }),
    ];
    const receiver = [JSON.stringify({ type: "user", diagnostic: marker, message: { content: "unrelated" } })];
    const evidence = inspectCrossSessionEvidence(sender, receiver, marker, "receiver");
    expect(evidence.sender_used_send_message_with_marker).toBe(false);
    expect(evidence.receiver_observed_marker).toBe(false);

    const inboundText = [
      receiverInit,
      JSON.stringify({
        type: "user",
        session_id: receiverSessionId,
        isReplay: false,
        message: { content: [{ type: "text", text: `peer: ${marker}` }] },
      }),
    ];
    expect(inspectCrossSessionEvidence([], inboundText, marker, "receiver")
      .receiver_observed_marker).toBe(true);

    for (const event of [
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: marker }] } },
      {
        type: "user",
        message: { content: [{ type: "text", text: marker }, { type: "tool_result", content: "mixed" }] },
      },
      { type: "user", isReplay: true, message: { content: marker } },
      { type: "user", isReplay: "true", message: { content: marker } },
      { type: "user", isReplay: 1, message: { content: marker } },
      { type: "user", isReplay: null, message: { content: marker } },
      { type: "user", tool_use_result: { stdout: marker }, message: { content: marker } },
      { type: "user", parent_tool_use_id: "subagent-1", message: { content: marker } },
      { type: "user", agent_id: "subagent-1", message: { content: marker } },
    ]) {
      expect(inspectCrossSessionEvidence(
        [],
        [receiverInit, JSON.stringify({ ...event, session_id: receiverSessionId })],
        marker,
        "receiver",
      )
        .receiver_observed_marker).toBe(false);
    }

    const matching = {
      type: "user",
      session_id: receiverSessionId,
      message: { content: marker },
    };
    for (const receiverEvents of [
      [receiverInit, JSON.stringify({ type: "user", message: { content: marker } })],
      [receiverInit, JSON.stringify({ ...matching, session_id: otherSessionId })],
      [JSON.stringify(matching), receiverInit],
      [receiverInit, JSON.stringify(matching), JSON.stringify(matching)],
      [receiverInit, receiverInit, JSON.stringify(matching)],
    ]) {
      expect(inspectCrossSessionEvidence([], receiverEvents, marker, "receiver")
        .receiver_observed_marker).toBe(false);
    }

    const decoratedTarget = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-2", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-2", content: "receiver [ref-a]" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver [ref-a] ", message: marker } }] },
      }),
    ];
    expect(inspectCrossSessionEvidence(decoratedTarget, [], marker, "receiver")
      .sender_used_send_message_with_marker).toBe(false);
  });

  test("does not use a ListAgents-looking result from another tool call", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_fixture";
    const sender = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "other-call", content: "receiver [ref-a]" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver [ref-a]", message: marker } }] },
      }),
    ];
    expect(inspectCrossSessionEvidence(sender, [], marker, "receiver")).toMatchObject({
      sender_used_list_agents: false,
      sender_used_send_message_with_marker: false,
    });
  });

  test("requires a fresh unique ListAgents address and exactly one ordered send", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_fixture";
    const duplicateList = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-2", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver [ref-a]", message: marker } }] },
      }),
    ];
    const evidence = inspectCrossSessionEvidence(duplicateList, [], marker, "receiver");
    expect(evidence.sender_used_list_agents).toBe(false);
    expect(evidence.sender_used_send_message_with_marker).toBe(false);

    const guessedSend = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver", message: marker } }] },
      }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] } }),
    ];
    expect(inspectCrossSessionEvidence(guessedSend, [], marker, "receiver")
      .sender_used_send_message_with_marker).toBe(false);

    const duplicateAddress = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]\nreceiver [ref-a]" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver [ref-a]", message: marker } }] },
      }),
    ];
    expect(inspectCrossSessionEvidence(duplicateAddress, [], marker, "receiver"))
      .toMatchObject({ sender_used_list_agents: false, sender_used_send_message_with_marker: false });

    const overlongRef = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "list-1", name: "ListAgents", input: {} }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: `receiver [${"x".repeat(65)}]` }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver", message: marker } }] },
      }),
    ];
    expect(inspectCrossSessionEvidence(overlongRef, [], marker, "receiver"))
      .toMatchObject({ sender_used_list_agents: false, sender_used_send_message_with_marker: false });
  });

  test("counts duplicate tool blocks even when Claude emits them in one event", () => {
    const marker = "AGENTPARTY_CROSS_SESSION_fixture";
    const sender = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "list-1", name: "ListAgents", input: {} },
            { type: "tool_use", id: "list-2", name: "ListAgents", input: {} },
          ],
        },
      }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "list-1", content: "receiver [ref-a]" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "SendMessage", input: { to: "receiver [ref-a]", message: marker } }] },
      }),
    ];
    expect(inspectCrossSessionEvidence(sender, [], marker, "receiver")).toMatchObject({
      sender_used_list_agents: false,
      sender_used_send_message_with_marker: false,
    });
  });
});
