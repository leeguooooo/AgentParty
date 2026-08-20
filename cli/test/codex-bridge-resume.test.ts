import { afterEach, describe, expect, test } from "bun:test";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_RESUME_VISIBILITY_NOTICE,
  printCodexSessions,
  run as runBridge,
  selectCodexResumeThread,
  type CodexCapabilityProbe,
} from "../src/commands/bridge";
import {
  codexActiveWriterConflictMessage,
  isCodexActiveWriterConflict,
  runCodexSessionBridge,
  type CodexBridgeRuntimeOptions,
} from "../src/commands/codex-bridge";
import {
  DeliveryRecoveryJournal,
  deliveryRecoveryJournalPath,
} from "../src/delivery-recovery-journal";

const supported: CodexCapabilityProbe = {
  version: "codex-cli 0.148.0",
  rootHelp: "--remote <ADDR> ws://host unix://PATH",
  appServerHelp: "--listen <URL> --stdio",
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "agentparty-codex-resume-"));
  tempDirs.push(path);
  return path;
}

function recordCodexRecoveryDebt(journal: DeliveryRecoveryJournal, threadId: string): void {
  const now = Date.now();
  const delivery: DirectedDelivery = {
    id: "delivery-resume-0",
    message_seq: 700,
    target_name: "front",
    cause: "mention",
    state: "claimed",
    attempt: 1,
    lease_epoch: 1,
    lease_token: "lease-0",
    lease_until: now + 90_000,
    work_id: "work-0",
    continuation_ref: "continuation-0",
    reply_seq: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  const message: MsgFrame = {
    type: "msg",
    seq: delivery.message_seq,
    sender: { name: "owner", kind: "human" },
    kind: "message",
    body: "@front recover",
    mentions: ["front"],
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: now,
  };
  journal.recordClaim(delivery, message);
  journal.update(delivery.id, {
    phase: "harness_issued",
    threadId,
    delivery: { ...delivery, state: "running" },
  });
}

describe("party bridge codex --resume selects an existing thread", () => {
  const gui = "01a01e78-a24b-7c61-80e4-a78a0f52a152";
  const older = "01a01e72-8187-7d63-8e4d-9a1a9daa5451";

  /** A $CODEX_HOME whose sessions tree mirrors a real Codex install. */
  function codexHome(): string {
    const home = tempDir();
    const day = join(home, "sessions", "2026", "08", "20");
    mkdirSync(day, { recursive: true });
    const rollout = (stamp: string, threadId: string, cwd: string, prompt: string) => {
      writeFileSync(
        join(day, `rollout-${stamp}-${threadId}.jsonl`),
        `${[
          JSON.stringify({
            type: "session_meta",
            payload: {
              session_id: threadId,
              cwd,
              originator: "Codex Desktop",
              source: "vscode",
              git: { branch: "main" },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: prompt },
          }),
        ].join("\n")}\n`,
      );
    };
    rollout("2026-08-20T18-13-35", older, "/workspace/old", "an older session");
    rollout("2026-08-20T18-20-17", gui, "/workspace/watched", "the session the owner is watching");
    return home;
  }

  async function runCodexBridgeArgv(argv: string[], env: NodeJS.ProcessEnv): Promise<{
    code: number;
    calls: CodexBridgeRuntimeOptions[];
  }> {
    const calls: CodexBridgeRuntimeOptions[] = [];
    const code = await runBridge(argv, {
      probeCodexCapabilities: async () => supported,
      codexBinary: process.execPath,
      cwd: "/workspace",
      env,
      runCodexBridge: async (options) => {
        calls.push(options);
        return 0;
      },
    });
    return { code, calls };
  }

  test("--resume passes the exact thread id through with the Codex args after --", async () => {
    const { code, calls } = await runCodexBridgeArgv(
      ["codex", "dev", "--resume", gui, "--", "--model", "gpt-5.4"],
      { PATH: "/bin", CODEX_HOME: codexHome() },
    );
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({
      channel: "dev",
      initialThreadId: gui,
      codexArgs: ["--model", "gpt-5.4"],
    });
  });

  test("--resume-last resolves the newest rollout under $CODEX_HOME", async () => {
    const { code, calls } = await runCodexBridgeArgv(
      ["codex", "dev", "--resume-last"],
      { PATH: "/bin", CODEX_HOME: codexHome() },
    );
    expect(code).toBe(0);
    expect(calls[0]?.initialThreadId).toBe(gui);
  });

  test("without a resume flag the bridge still opens a new thread", async () => {
    const { code, calls } = await runCodexBridgeArgv(
      ["codex", "dev", "--", "--model", "gpt-5.4"],
      { PATH: "/bin", CODEX_HOME: codexHome() },
    );
    expect(code).toBe(0);
    expect(calls[0]?.initialThreadId).toBeNull();
    expect(calls[0]?.codexArgs).toEqual(["--model", "gpt-5.4"]);
  });

  test("resume selection rejects malformed ids and an empty session store", () => {
    const home = codexHome();
    expect(selectCodexResumeThread({ resume: gui, env: {} })).toEqual({ ok: true, threadId: gui });
    expect(selectCodexResumeThread({ resume: "../../etc/passwd", env: {} }))
      .toMatchObject({ ok: false });
    expect(selectCodexResumeThread({ resumeLast: true, env: { CODEX_HOME: home } }))
      .toMatchObject({ ok: true, threadId: gui });
    expect(selectCodexResumeThread({ resumeLast: true, env: { CODEX_HOME: tempDir() } }))
      .toMatchObject({ ok: false });
    expect(selectCodexResumeThread({ env: {} })).toEqual({ ok: true, threadId: null });
  });

  test("--resume and --resume-last cannot both select a thread", async () => {
    expect(await runBridge(["codex", "dev", "--resume", gui, "--resume-last"], {
      runCodexBridge: async () => {
        throw new Error("bridge must not start on an ambiguous resume selection");
      },
    })).toBe(1);
  });

  test("resume flags are rejected for the Claude harness", async () => {
    for (const argv of [
      ["claude", "dev", "--resume", gui],
      ["claude", "dev", "--resume-last"],
      ["claude", "dev", "--list-sessions"],
    ]) {
      expect(await runBridge(argv, {
        probeClaudeVersion: async () => {
          throw new Error("claude must not be probed for a codex-only flag");
        },
      })).toBe(1);
    }
  });

  test("--list-sessions prints resumable thread ids and never launches Codex", async () => {
    const printed: string[] = [];
    const restore = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      expect(printCodexSessions({ CODEX_HOME: codexHome() })).toBe(0);
      expect(printCodexSessions({ CODEX_HOME: tempDir() })).toBe(1);
    } finally {
      console.log = restore;
    }
    const output = printed.join("\n");
    expect(output).toContain("/workspace/watched");
    expect(output).toContain("the session the owner is watching");
    expect(output).toContain(CODEX_RESUME_VISIBILITY_NOTICE);
    const ids = printed.flatMap((line) => {
      const id = line.trim().split(/\s+/)[0] ?? "";
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? [id] : [];
    });
    expect(ids).toEqual([gui, older]);

    expect(await runBridge(["codex", "dev", "--list-sessions", "--", "--model", "x"], {
      runCodexBridge: async () => {
        throw new Error("--list-sessions must not launch Codex");
      },
    })).toBe(1);
  });

  test("an explicit resume never strands recovery debt owed by another thread", async () => {
    const previousAgentPartyHome = process.env.AGENTPARTY_HOME;
    const root = tempDir();
    process.env.AGENTPARTY_HOME = root;
    try {
      const server = "https://runtime-resume.example";
      const token = "ap_runtime_resume";
      const journal = new DeliveryRecoveryJournal(
        deliveryRecoveryJournalPath("codex", server, token, "dev"),
        "dev",
        "codex",
      );
      recordCodexRecoveryDebt(journal, "thread-journal");
      const logs: string[] = [];
      const result = await runCodexSessionBridge(
        {
          channel: "dev",
          codexBinary: process.execPath,
          initialThreadId: gui,
          cwd: root,
          env: { ...process.env },
        },
        {
          resolveAuth: async () => ({
            server,
            token,
            auth_source: "runtime_config",
            config: { kind: "none", path: null },
            account: { present: false, path: join(root, "account.json") },
          }),
          spawnAppServer: () => {
            throw new Error("app-server must not start when the resume target conflicts");
          },
          runtimeDir: () => {
            throw new Error("runtime directory must not be created when the resume conflicts");
          },
          installSignalHandlers: () => () => {},
          terminationGraceMs: 0,
          killWaitMs: 0,
          log: (line) => logs.push(line),
        },
      );
      expect(result).toBe(1);
      expect(logs.join("\n")).toContain("thread-journal");
      expect(logs.join("\n")).toContain(gui);
    } finally {
      if (previousAgentPartyHome === undefined) {
        delete process.env.AGENTPARTY_HOME;
      } else {
        process.env.AGENTPARTY_HOME = previousAgentPartyHome;
      }
    }
  });

  test("a thread another process still writes is reported as a closable conflict", () => {
    // Observed verbatim from Codex CLI 0.148.0-alpha.15 while the Codex desktop
    // app had this thread open.
    expect(isCodexActiveWriterConflict(
      `thread/resume: thread/resume failed: thread ${gui} already has an active writer (code -32600)`,
    )).toBe(true);
    expect(isCodexActiveWriterConflict(
      `thread-store conflict: thread ${gui} already has an active writer`,
    )).toBe(true);
    expect(isCodexActiveWriterConflict("thread/resume failed: no such thread")).toBe(false);
    const message = codexActiveWriterConflictMessage(gui);
    expect(message).toContain(gui);
    expect(message).toContain("Codex desktop app");
    expect(message).toContain("one writer per thread");
  });
});
