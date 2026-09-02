import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inbox-inject";
import {
  announceDisplayName,
  resetAnnounceNativeNameRetries,
  syncNativeDisplayName,
} from "../src/claude-native-display-name";
import {
  CLAUDE_SESSION_REGISTRY_DIR_ENV,
  listClaudeSessions,
  registerClaudeSession,
  type ClaudeSessionRegistryEntry,
} from "../src/claude-session-registry";
import { recordClaudeSessionLifecycle } from "../src/commands/hook";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "11111111-1111-4111-8111-222222222222";

let registryDir: string;
let nativeDir: string;
let env: NodeJS.ProcessEnv;
let savedHome: string | undefined;

beforeEach(() => {
  registryDir = mkdtempSync(join(tmpdir(), "ap-native-name-registry-"));
  chmodSync(registryDir, 0o700);
  nativeDir = mkdtempSync(join(tmpdir(), "ap-native-name-sessions-"));
  env = {
    [CLAUDE_SESSION_REGISTRY_DIR_ENV]: registryDir,
    [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: nativeDir,
    AGENTPARTY_CHANNEL: "dev",
  };
  // hook 的 config 解析走 process.env：指到临时 home，绝不让测试摸到真实 ~/.agentparty / ~/.claude。
  savedHome = process.env.AGENTPARTY_HOME;
  process.env.AGENTPARTY_HOME = mkdtempSync(join(tmpdir(), "ap-native-name-home-"));
  process.env[CLAUDE_NATIVE_SESSIONS_DIR_ENV] = nativeDir;
  resetAnnounceNativeNameRetries();
});

afterEach(() => {
  rmSync(registryDir, { recursive: true, force: true });
  rmSync(nativeDir, { recursive: true, force: true });
  rmSync(process.env.AGENTPARTY_HOME!, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.AGENTPARTY_HOME;
  else process.env.AGENTPARTY_HOME = savedHome;
  delete process.env[CLAUDE_NATIVE_SESSIONS_DIR_ENV];
  resetAnnounceNativeNameRetries();
});

function writeNativeSession(name: string, fields: Record<string, unknown> = {}): void {
  writeFileSync(
    join(nativeDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: SESSION_ID,
      name,
      messagingSocketPath: join(nativeDir, "inbox.sock"),
      ...fields,
    }),
    { mode: 0o600 },
  );
}

function register(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  expect(registerClaudeSession({
    session_id: SESSION_ID,
    pid: process.pid,
    display_name: null,
    channel: "dev",
    server: "https://party.example",
    identity: "agent-a",
    cwd: "/tmp/project",
    registered_at: Date.now(),
    ...overrides,
  }, env)).toBe(true);
  return listClaudeSessions(env)[0]!;
}

describe("syncNativeDisplayName (#1052 #6)", () => {
  test("writes Claude's own session name into the registry once it is readable", () => {
    const entry = register();
    expect(syncNativeDisplayName(entry, env)).toBeNull();
    writeNativeSession("agentparty-83");
    expect(syncNativeDisplayName(entry, env)).toBe("agentparty-83");
    expect(listClaudeSessions(env)[0]!.display_name).toBe("agentparty-83");
  });

  test("ignores a sessions file that belongs to another session (pid reuse) or carries an invalid name", () => {
    const entry = register();
    writeNativeSession("agentparty-83", { sessionId: OTHER_SESSION_ID });
    expect(syncNativeDisplayName(entry, env)).toBeNull();
    writeNativeSession("bad name!");
    expect(syncNativeDisplayName(entry, env)).toBeNull();
    expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
  });

  test("follows a renamed session and leaves an already-correct entry untouched", () => {
    const entry = register({ display_name: "old-name" });
    writeNativeSession("new-name");
    expect(syncNativeDisplayName(entry, env)).toBe("new-name");
    expect(listClaudeSessions(env)[0]!.display_name).toBe("new-name");
    const before = listClaudeSessions(env)[0]!;
    expect(syncNativeDisplayName(before, env)).toBe("new-name");
    expect(listClaudeSessions(env)[0]).toEqual(before);
  });
});

describe("announceDisplayName (#1052 #6)", () => {
  test("equals the native name when readable, retries once when it appears late, and falls back otherwise", async () => {
    const entry = register();
    // 已有：直接用。
    writeNativeSession("agentparty-83");
    expect(await announceDisplayName(entry, env, { retryDelayMs: 5 })).toBe("agentparty-83");

    // 晚到：第一次读不到，重试一次后读到。
    rmSync(join(nativeDir, `${process.pid}.json`));
    resetAnnounceNativeNameRetries();
    const fresh = register();
    setTimeout(() => writeNativeSession("agentparty-84"), 10);
    expect(await announceDisplayName(fresh, env, { retryDelayMs: 40 })).toBe("agentparty-84");
    expect(listClaudeSessions(env)[0]!.display_name).toBe("agentparty-84");

    // 一直没有：回退 claude-<12hex>，且每进程对同一会话只重试一次。
    rmSync(join(nativeDir, `${process.pid}.json`));
    resetAnnounceNativeNameRetries();
    const absent = register();
    const started = Date.now();
    expect(await announceDisplayName(absent, env, { retryDelayMs: 30 })).toBe("claude-111111111111");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const again = Date.now();
    expect(await announceDisplayName(absent, env, { retryDelayMs: 30 })).toBe("claude-111111111111");
    expect(Date.now() - again).toBeLessThan(25);
  });

  test("does not wait for a session registered long ago (Claude never wrote a name)", async () => {
    const stale = register({ registered_at: 1_000 });
    const started = Date.now();
    expect(await announceDisplayName(stale, env, { retryDelayMs: 200 })).toBe("claude-111111111111");
    expect(Date.now() - started).toBeLessThan(150);
  });
});

describe("hook later rounds (#1052 #6)", () => {
  test("a PreToolUse/Stop round after the sessions file appears updates display_name", () => {
    const start = { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: "/tmp/project" };
    recordClaudeSessionLifecycle(start, env, process.pid);
    expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
    // 文件还没出现：后续轮读不到，保持 null。
    recordClaudeSessionLifecycle({ hook_event_name: "PreToolUse", session_id: SESSION_ID }, env, process.pid);
    expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
    writeNativeSession("agentparty-83");
    recordClaudeSessionLifecycle({ hook_event_name: "PreToolUse", session_id: SESSION_ID }, env, process.pid);
    expect(listClaudeSessions(env)[0]!.display_name).toBe("agentparty-83");
    // Stop 轮同样会跟进改名。
    writeNativeSession("agentparty-84");
    recordClaudeSessionLifecycle({ hook_event_name: "Stop", session_id: SESSION_ID }, env, process.pid);
    expect(listClaudeSessions(env)[0]!.display_name).toBe("agentparty-84");
  });

  test("a later round from a different pid, a serve-managed lane, or an unregistered session changes nothing", () => {
    recordClaudeSessionLifecycle({ hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: "/tmp/project" }, env, process.pid);
    writeNativeSession("agentparty-83");
    recordClaudeSessionLifecycle({ hook_event_name: "PreToolUse", session_id: SESSION_ID }, env, process.pid + 1);
    expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
    recordClaudeSessionLifecycle(
      { hook_event_name: "PreToolUse", session_id: SESSION_ID },
      { ...env, AP_ACTIVITY_FILE: "/tmp/activity.json" },
      process.pid,
    );
    expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
    expect(() => recordClaudeSessionLifecycle(
      { hook_event_name: "PreToolUse", session_id: OTHER_SESSION_ID },
      env,
      process.pid,
    )).not.toThrow();
    expect(listClaudeSessions(env)).toHaveLength(1);
  });
});
