import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");

async function runHook(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = [],
) {
  const proc = Bun.spawn(["bun", "run", indexPath, "claude-cross-session-hook", ...args], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("hidden Claude Cross-session hook command", () => {
  test("a real SessionStart command writes its private arm receipt without adding model context", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-command-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "44444444-4444-4444-8444-444444444444";
    try {
      const result = await runHook(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }), {
        ...process.env,
        AGENTPARTY_CLAUDE_CROSS_SESSION_GATE_DIR: "/tmp/ignored-inherited-gate",
      }, ["--gate-directory", gate]);
      expect(result).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
      expect(JSON.parse(readFileSync(join(gate, "armed.json"), "utf8"))).toMatchObject({
        version: 1,
        session_id: sessionId,
      });
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("malformed hook input exits with Claude's blocking status", async () => {
    const result = await runHook("not-json");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("malformed JSON");
  });

  test("oversized hook input exits with blocking status before parsing", async () => {
    const result = await runHook(JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "SendMessage",
      tool_input: {
        to: "researcher",
        message: "x".repeat(4 * 1024 * 1024),
      },
    }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("4 MiB safety limit");
    expect(result.stdout).toBe("");
  });

  test("valid JSON with a malformed event envelope also exits with blocking status", async () => {
    for (const input of [
      null,
      [],
      "PreToolUse",
      1,
      true,
      {},
      { hook_event_name: null },
      { hook_event_name: "UnknownHook" },
    ]) {
      const result = await runHook(JSON.stringify(input));
      expect(result.code, JSON.stringify(input)).toBe(2);
      expect(result.stderr, JSON.stringify(input)).toContain("malformed event envelope");
      expect(result.stdout, JSON.stringify(input)).toBe("");
    }
  });

  test("ambient gate state is ignored and bridge arguments are validated", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-capability-test-"));
    chmodSync(gate, 0o700);
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "77777777-7777-4777-8777-777777777777",
    });
    try {
      const ambientOnly = await runHook(input, {
        ...process.env,
        AGENTPARTY_CLAUDE_CROSS_SESSION_GATE_DIR: gate,
      });
      expect(ambientOnly.code).toBe(0);
      expect(await Bun.file(join(gate, "armed.json")).exists()).toBe(false);

      for (const args of [
        ["--gate-directory"],
        ["--gate-directory", "relative/path"],
        ["--unknown", gate],
        ["--gate-directory", gate, "extra"],
      ]) {
        const invalid = await runHook(input, process.env, args);
        expect(invalid.code, args.join(" ")).toBe(2);
        expect(invalid.stderr, args.join(" ")).toContain("invalid bridge arguments");
      }
      expect(await Bun.file(join(gate, "armed.json")).exists()).toBe(false);
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("a generated AgentParty recipient without gate state is denied with exit 2", async () => {
    for (const to of [
      "apcs-review-agent-a1b2c3d4e5f6",
      "apcs-review-agent-a1b2c3d4e5f6 ",
      " apcs-review-agent-a1b2c3d4e5f6",
      "@apcs-review-agent-a1b2c3d4e5f6",
      `apcs-review-agent-a1b2c3d4e5f6 [${"x".repeat(65)}]`,
    ]) {
      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "SendMessage",
        tool_input: { to, message: "status" },
      }), { ...process.env, AGENTPARTY_CLAUDE_CROSS_SESSION_GATE_DIR: undefined });
      expect(result.code, to).toBe(2);
      expect(result.stdout, to).toContain('"permissionDecision":"deny"');
    }
  });

  test("ordinary Claude team recipients stay outside the AgentParty gate", async () => {
    for (const to of ["researcher", "apcs-review-agent-a1b2c3d4e5f6-extra"]) {
      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "SendMessage",
        tool_input: { to, message: "status" },
      }));
      expect(result.code, to).toBe(0);
      expect(result.stdout, to).toBe("");
    }
  });

  test("an ordinary built-in SendMessage fails closed while gate state is concurrently locked", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-lock-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "66666666-6666-4666-8666-666666666666";
    const hookEnv = { ...process.env };
    const hookArgs = ["--gate-directory", gate];
    let lockFd: number | null = null;
    try {
      expect((await runHook(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }), hookEnv, hookArgs)).code).toBe(0);
      lockFd = openSync(join(gate, "consume.lock"), "wx", 0o600);
      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "SendMessage",
        tool_input: { to: "researcher", message: "status" },
      }), hookEnv, hookArgs);
      expect(result.code).toBe(2);
      expect(result.stdout).toContain("state is busy");
    } finally {
      if (lockFd !== null) closeSync(lockFd);
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("reclaims a consume lock abandoned by a crashed Hook process", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-stale-lock-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "67676767-6767-4767-8767-676767676767";
    const hookArgs = ["--gate-directory", gate];
    try {
      expect((await runHook(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }), process.env, hookArgs)).code).toBe(0);
      const lockPath = join(gate, "consume.lock");
      closeSync(openSync(lockPath, "wx", 0o600));
      utimesSync(lockPath, new Date(0), new Date(0));

      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "SendMessage",
        tool_input: { to: "researcher", message: "status" },
      }), process.env, hookArgs);

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(await Bun.file(lockPath).exists()).toBe(false);
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("a stale consume lock is not reclaimed while another Hook is already reclaiming it", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-reclaim-race-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "68686868-6868-4868-8868-686868686868";
    const hookArgs = ["--gate-directory", gate];
    let reclaimFd: number | null = null;
    try {
      expect((await runHook(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }), process.env, hookArgs)).code).toBe(0);
      const lockPath = join(gate, "consume.lock");
      closeSync(openSync(lockPath, "wx", 0o600));
      utimesSync(lockPath, new Date(0), new Date(0));
      // 另一个 Hook 已经拿着回收锁，正处在 lstat→rm→open 之间。此时本进程必须
      // 完全不碰 consume.lock：直接删会把对方回收后新建的锁删掉，两边一起进临界区。
      reclaimFd = openSync(`${lockPath}.reclaim`, "wx", 0o600);

      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "SendMessage",
        tool_input: { to: "researcher", message: "status" },
      }), process.env, hookArgs);

      expect(result.code).toBe(2);
      expect(result.stdout).toContain("state is busy");
      expect(await Bun.file(lockPath).exists()).toBe(true);
    } finally {
      if (reclaimFd !== null) closeSync(reclaimFd);
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("a reclaim lock abandoned by a crashed Hook does not wedge stale-lock recovery", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-reclaim-stale-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "69696969-6969-4969-8969-696969696969";
    const hookArgs = ["--gate-directory", gate];
    try {
      expect((await runHook(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }), process.env, hookArgs)).code).toBe(0);
      const lockPath = join(gate, "consume.lock");
      const reclaimPath = `${lockPath}.reclaim`;
      for (const path of [lockPath, reclaimPath]) {
        closeSync(openSync(path, "wx", 0o600));
        utimesSync(path, new Date(0), new Date(0));
      }

      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "SendMessage",
        tool_input: { to: "researcher", message: "status" },
      }), process.env, hookArgs);

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(await Bun.file(lockPath).exists()).toBe(false);
      expect(await Bun.file(reclaimPath).exists()).toBe(false);
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("a private gate storage failure blocks a generated recipient with exit 2", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-storage-failure-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "88888888-8888-4888-8888-888888888888";
    const hookArgs = ["--gate-directory", gate];
    try {
      expect((await runHook(JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
      }), process.env, hookArgs)).code).toBe(0);

      // Replace the atomic JSON target with a directory. readState() safely
      // treats it as empty, while the subsequent permit-consumption write
      // fails at renameSync(). The command wrapper must still return Claude's
      // blocking hook status rather than the generic CLI error status 1.
      rmSync(join(gate, "state.json"));
      mkdirSync(join(gate, "state.json"), { mode: 0o700 });
      const result = await runHook(JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "SendMessage",
        tool_input: {
          to: "apcs-review-agent-a1b2c3d4e5f6",
          message: "status",
        },
      }), process.env, hookArgs);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("could not verify private gate state");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });

  test("a losing concurrent send cannot erase the winning send's sibling barrier", async () => {
    const gate = mkdtempSync(join(tmpdir(), "agentparty-hook-race-test-"));
    chmodSync(gate, 0o700);
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const displayName = "apcs-review-agent-a1b2c3d4e5f6";
    const candidateRef = "candidate_1234567890abcdef";
    const sendTo = `${displayName} [ref-a]`;
    const hookEnv = { ...process.env };
    const hookArgs = ["--gate-directory", gate];
    const invoke = (input: Record<string, unknown>) => runHook(JSON.stringify({
      session_id: sessionId,
      ...input,
    }), hookEnv, hookArgs);
    try {
      expect((await invoke({ hook_event_name: "SessionStart" })).code).toBe(0);
      expect((await invoke({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agentparty-channel__party_channel_peers",
        tool_use_id: "toolu_command_peers",
        tool_input: {},
      })).code).toBe(0);
      expect((await invoke({
        hook_event_name: "PostToolBatch",
        tool_calls: [{
          tool_name: "mcp__agentparty-channel__party_channel_peers",
          tool_use_id: "toolu_command_peers",
          tool_response: JSON.stringify({
            version: 2,
            availability: "ready",
            peers: [{
              agent: "reviewer",
              claude_sessions: [{ display_name: displayName, candidate_ref: candidateRef }],
            }],
          }),
        }],
      })).code).toBe(0);
      expect((await invoke({
        hook_event_name: "PreToolUse",
        tool_name: "ListAgents",
        tool_use_id: "toolu_command_list",
        tool_input: {},
      })).code).toBe(0);
      expect((await invoke({
        hook_event_name: "PostToolBatch",
        tool_calls: [{
          tool_name: "ListAgents",
          tool_use_id: "toolu_command_list",
          tool_response: `- ${sendTo}`,
        }],
      })).code).toBe(0);
      expect((await invoke({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__agentparty-channel__party_channel_peer_check",
        tool_use_id: "toolu_command_check",
        tool_input: {
          agent: "reviewer",
          display_name: displayName,
          candidate_ref: candidateRef,
        },
      })).code).toBe(0);
      expect((await invoke({
        hook_event_name: "PostToolBatch",
        tool_calls: [{
          tool_name: "mcp__agentparty-channel__party_channel_peer_check",
          tool_use_id: "toolu_command_check",
          tool_response: JSON.stringify({
            version: 1,
            availability: "confirmed",
            topology_evidence: "client_asserted",
            comparison: "server_rechecked_live_topology",
            agent: "reviewer",
            display_name: displayName,
            candidate_ref: candidateRef,
            send_to: sendTo,
          }),
        }],
      })).code).toBe(0);

      // Hold the real cross-process lock until both Hook processes have passed
      // the optimistic barrier read and are waiting to consume the same permit.
      const lockPath = join(gate, "consume.lock");
      const lockFd = openSync(lockPath, "wx", 0o600);
      const sendInput = (toolUseId: string) => ({
        hook_event_name: "PreToolUse",
        tool_name: "SendMessage",
        tool_use_id: toolUseId,
        tool_input: { to: sendTo, message: "same worktree status" },
      });
      const first = invoke(sendInput("toolu_command_send_first"));
      const second = invoke(sendInput("toolu_command_send_second"));
      await Bun.sleep(80);
      closeSync(lockFd);
      rmSync(lockPath, { force: true });

      const sends = await Promise.all([first, second]);
      expect(sends.map((result) => result.code).sort()).toEqual([0, 2]);
      const sibling = await invoke({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "true" },
      });
      expect(sibling.code).toBe(2);
      expect(sibling.stdout).toContain("only allowed call in this tool batch");
    } finally {
      rmSync(gate, { recursive: true, force: true });
    }
  });
});
