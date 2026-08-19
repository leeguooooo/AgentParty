import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SESSION_REGISTRY_CAPACITY,
  CLAUDE_SESSION_REGISTRY_DIR_ENV,
  claudeSessionAlive,
  claudeSessionRegistryDirectory,
  listClaudeSessions,
  registerClaudeSession,
  unregisterClaudeSession,
} from "../src/claude-session-registry";
import {
  claudeSessionDisplayNameFromHookPayload,
  recordClaudeSessionLifecycle,
} from "../src/commands/hook";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function sessionId(n: number): string {
  return `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["sleep", "0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    session_id: SESSION_ID,
    pid: process.pid,
    display_name: null,
    channel: "dev",
    cwd: "/tmp/project",
    registered_at: 1_000,
    ...overrides,
  };
}

let directory: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agentparty-claude-session-registry-"));
  chmodSync(directory, 0o700);
  env = { [CLAUDE_SESSION_REGISTRY_DIR_ENV]: directory };
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("claude session registry", () => {
  test("register / list / unregister round-trip", () => {
    expect(registerClaudeSession(baseEntry(), env)).toBe(true);
    const listed = listClaudeSessions(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      version: 1,
      session_id: SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
      registered_at: 1_000,
    });
    expect(claudeSessionAlive(SESSION_ID, env)).toBe(true);
    expect(unregisterClaudeSession(SESSION_ID, env)).toBe(true);
    expect(listClaudeSessions(env)).toHaveLength(0);
    expect(claudeSessionAlive(SESSION_ID, env)).toBe(false);
  });

  test("rejects malformed inputs", () => {
    expect(registerClaudeSession(baseEntry({ session_id: "../../etc/passwd" }), env)).toBe(false);
    expect(registerClaudeSession(baseEntry({ session_id: "not-a-uuid" }), env)).toBe(false);
    expect(registerClaudeSession(baseEntry({ channel: "Bad_Channel!" }), env)).toBe(false);
    expect(registerClaudeSession(baseEntry({ cwd: "relative/path" }), env)).toBe(false);
    expect(registerClaudeSession(baseEntry({ pid: 0 }), env)).toBe(false);
    expect(unregisterClaudeSession("not-a-uuid", env)).toBe(false);
    expect(listClaudeSessions(env)).toHaveLength(0);
  });

  test("invalid display_name is stored as null, valid one is kept", () => {
    expect(registerClaudeSession(baseEntry({ display_name: "bad name!" }), env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
    expect(registerClaudeSession(baseEntry({ display_name: "my-session_1" }), env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.display_name).toBe("my-session_1");
  });

  test("directory permission checks: group-readable and symlink directories are rejected", () => {
    chmodSync(directory, 0o750);
    expect(claudeSessionRegistryDirectory(env)).toBeNull();
    expect(registerClaudeSession(baseEntry(), env)).toBe(false);
    expect(listClaudeSessions(env)).toHaveLength(0);
    chmodSync(directory, 0o700);

    const outer = mkdtempSync(join(tmpdir(), "agentparty-claude-session-link-"));
    try {
      const link = join(outer, "link");
      symlinkSync(directory, link);
      expect(claudeSessionRegistryDirectory({
        [CLAUDE_SESSION_REGISTRY_DIR_ENV]: link,
      })).toBeNull();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
    expect(claudeSessionRegistryDirectory({
      [CLAUDE_SESSION_REGISTRY_DIR_ENV]: "relative/dir",
    })).toBeNull();
  });

  test("group-readable entry files are ignored and pruned", () => {
    expect(registerClaudeSession(baseEntry(), env)).toBe(true);
    chmodSync(join(directory, `${SESSION_ID}.json`), 0o644);
    expect(listClaudeSessions(env)).toHaveLength(0);
    expect(readdirSync(directory)).toHaveLength(0);
  });

  test("dead and corrupt rows are pruned on list", async () => {
    expect(registerClaudeSession(baseEntry(), env)).toBe(true);
    expect(registerClaudeSession(baseEntry({
      session_id: sessionId(2),
      pid: await deadPid(),
    }), env)).toBe(true);
    writeFileSync(join(directory, `${sessionId(3)}.json`), "{not json", { mode: 0o600 });
    // 文件名与内容 session_id 不一致 = 坏行
    writeFileSync(
      join(directory, `${sessionId(4)}.json`),
      JSON.stringify(baseEntry({ version: 1, session_id: sessionId(5) })),
      { mode: 0o600 },
    );
    const listed = listClaudeSessions(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.session_id).toBe(SESSION_ID);
    expect(readdirSync(directory).sort()).toEqual([`${SESSION_ID}.json`]);
  });

  test("list sorts by registered_at ascending", () => {
    expect(registerClaudeSession(baseEntry({ session_id: sessionId(2), registered_at: 3_000 }), env)).toBe(true);
    expect(registerClaudeSession(baseEntry({ registered_at: 1_000 }), env)).toBe(true);
    expect(listClaudeSessions(env).map((entry) => entry.registered_at)).toEqual([1_000, 3_000]);
  });

  test("capacity: prunes dead rows first, refuses when full of live rows, allows self-overwrite", async () => {
    for (let index = 1; index <= CLAUDE_SESSION_REGISTRY_CAPACITY; index += 1) {
      expect(registerClaudeSession(baseEntry({ session_id: sessionId(index) }), env)).toBe(true);
    }
    // 全是活行且已满：拒新，绝不覆盖活行。
    expect(registerClaudeSession(baseEntry({ session_id: sessionId(999) }), env)).toBe(false);
    // 同一 session 重复注册（resume）不受容量限制。
    expect(registerClaudeSession(baseEntry({ session_id: sessionId(1), registered_at: 9_000 }), env)).toBe(true);
    // 一行死了：新行顶上。
    writeFileSync(
      join(directory, `${sessionId(2)}.json`),
      JSON.stringify(baseEntry({ version: 1, session_id: sessionId(2), pid: await deadPid() })),
      { mode: 0o600 },
    );
    expect(registerClaudeSession(baseEntry({ session_id: sessionId(999) }), env)).toBe(true);
    expect(listClaudeSessions(env)).toHaveLength(CLAUDE_SESSION_REGISTRY_CAPACITY);
  });
});

describe("hook lifecycle wiring (#841 P1)", () => {
  test("SessionStart registers and SessionEnd unregisters", () => {
    const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev" };
    recordClaudeSessionLifecycle({
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      cwd: "/tmp/project",
    }, hookEnv, process.pid);
    const listed = listClaudeSessions(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      session_id: SESSION_ID,
      pid: process.pid,
      channel: "dev",
      cwd: "/tmp/project",
      display_name: null,
    });
    recordClaudeSessionLifecycle({
      hook_event_name: "SessionEnd",
      session_id: SESSION_ID,
    }, hookEnv, process.pid);
    expect(listClaudeSessions(env)).toHaveLength(0);
  });

  test("serve-managed lanes and channel-less sessions are not registered", () => {
    recordClaudeSessionLifecycle({
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      cwd: "/tmp/project",
    }, { ...env, AGENTPARTY_CHANNEL: "dev", AP_ACTIVITY_FILE: "/tmp/activity.json" }, process.pid);
    expect(listClaudeSessions(env)).toHaveLength(0);
    recordClaudeSessionLifecycle({
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      cwd: join(tmpdir(), "agentparty-definitely-no-state"),
    }, env, process.pid);
    expect(listClaudeSessions(env)).toHaveLength(0);
  });

  test("other events and invalid session ids are ignored, failures stay silent", () => {
    const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev" };
    recordClaudeSessionLifecycle({
      hook_event_name: "PreToolUse",
      session_id: SESSION_ID,
    }, hookEnv, process.pid);
    recordClaudeSessionLifecycle({
      hook_event_name: "SessionStart",
      session_id: "../evil",
      cwd: "/tmp/project",
    }, hookEnv, process.pid);
    expect(listClaudeSessions(env)).toHaveLength(0);
    // 注册表目录不可用也不许抛（hook 铁律）。
    chmodSync(directory, 0o750);
    expect(() => recordClaudeSessionLifecycle({
      hook_event_name: "SessionStart",
      session_id: SESSION_ID,
      cwd: "/tmp/project",
    }, hookEnv, process.pid)).not.toThrow();
    chmodSync(directory, 0o700);
  });

  test("display_name is taken from the payload only when present and valid", () => {
    expect(claudeSessionDisplayNameFromHookPayload({ display_name: "nice-name" })).toBe("nice-name");
    expect(claudeSessionDisplayNameFromHookPayload({ session_name: "s1" })).toBe("s1");
    expect(claudeSessionDisplayNameFromHookPayload({ display_name: "bad name!" })).toBeNull();
    expect(claudeSessionDisplayNameFromHookPayload({})).toBeNull();
  });
});
