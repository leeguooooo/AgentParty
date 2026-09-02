import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SESSION_REGISTRY_CAPACITY,
  CLAUDE_SESSION_REGISTRY_DIR_ENV,
  claudeSessionAlive,
  claudeSessionAnnounceName,
  claudeSessionRegistryDirectory,
  listClaudeSessions,
  registerClaudeSession,
  normalizeSessionRegistryIdentity,
  normalizeSessionRegistryServer,
  patchClaudeSessionEntry,
  readClaudeSessionEntry,
  registerSession,
  resolveSessionRegistryIdentity,
  sessionEntryMatchesIdentity,
  sessionEntryMatchesServer,
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

  test("register lock: a concurrently held lock refuses registration; a stale lock is reclaimed", () => {
    const lockPath = join(directory, ".register.lock");
    // 另一进程正持锁：有界等待后拒绝（安全侧），绝不绕开容量互斥。
    writeFileSync(lockPath, "", { mode: 0o600 });
    expect(registerClaudeSession(baseEntry(), env)).toBe(false);
    expect(listClaudeSessions(env)).toHaveLength(0);
    // 持锁进程死掉留下的孤儿锁（mtime 超过陈旧阈值）：回收后正常注册。
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    expect(registerClaudeSession(baseEntry(), env)).toBe(true);
    expect(listClaudeSessions(env)).toHaveLength(1);
    // 注册完成后锁已释放。
    expect(readdirSync(directory)).toEqual([`${SESSION_ID}.json`]);
  });
});

describe("config_path (#1052 #2)", () => {
  test("round-trips an absolute config_path and drops rows with a bad one", () => {
    expect(registerClaudeSession(baseEntry({ config_path: "/tmp/agents/a-dev.json" }), env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.config_path).toBe("/tmp/agents/a-dev.json");
    expect(readClaudeSessionEntry(SESSION_ID, env)?.config_path).toBe("/tmp/agents/a-dev.json");
    // 相对路径 / 空串不写（条目照常入册，只是没有 config_path）。
    expect(registerClaudeSession(baseEntry({ config_path: "relative.json" }), env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.config_path).toBeUndefined();
    // 盘上被写坏的 config_path 按坏行丢弃，不退化成「无 config_path」。
    writeFileSync(
      join(directory, `${SESSION_ID}.json`),
      JSON.stringify({ ...listClaudeSessions(env)[0]!, config_path: "../evil.json" }),
      { mode: 0o600 },
    );
    expect(listClaudeSessions(env)).toHaveLength(0);
  });

  test("patchClaudeSessionEntry updates only display_name / config_path of an existing entry", () => {
    expect(patchClaudeSessionEntry(SESSION_ID, { display_name: "x" }, env)).toBe(false);
    expect(registerClaudeSession(baseEntry({ server: "https://party.example", identity: "agent-a" }), env)).toBe(true);
    const before = listClaudeSessions(env)[0]!;
    expect(patchClaudeSessionEntry(SESSION_ID, { config_path: "/tmp/agents/a-dev.json" }, env)).toBe(true);
    expect(listClaudeSessions(env)[0]).toEqual({ ...before, config_path: "/tmp/agents/a-dev.json" });
    expect(patchClaudeSessionEntry(SESSION_ID, { display_name: "agentparty-83" }, env)).toBe(true);
    expect(listClaudeSessions(env)[0]).toEqual({ ...before, config_path: "/tmp/agents/a-dev.json", display_name: "agentparty-83" });
    expect(patchClaudeSessionEntry(SESSION_ID, { config_path: null }, env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.config_path).toBeUndefined();
    expect(readClaudeSessionEntry("../evil", env)).toBeNull();
  });

  test("SessionStart records the bound config path (explicit env) but never the global fallback", () => {
    const home = mkdtempSync(join(tmpdir(), "ap-registry-home-"));
    const savedHome = process.env.AGENTPARTY_HOME;
    const savedConfig = process.env.AGENTPARTY_CONFIG;
    const savedNative = process.env.AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR;
    try {
      process.env.AGENTPARTY_HOME = home;
      process.env.AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR = directory;
      const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev", AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR: directory };
      const payload = { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: "/tmp/project" };
      // 全局兜底：不记（记了会让后续命令把兜底当显式绑定，也绕过 #1018 的 MCP 闸）。
      writeFileSync(join(home, "config.json"), JSON.stringify({ server: "https://party.example", token: "t", identity: { name: "agent-g" } }));
      delete process.env.AGENTPARTY_CONFIG;
      recordClaudeSessionLifecycle(payload, hookEnv, process.pid);
      expect(listClaudeSessions(env)[0]!.config_path).toBeUndefined();
      // 显式 AGENTPARTY_CONFIG：记下来。
      const explicit = join(home, "agent-a-dev.json");
      writeFileSync(explicit, JSON.stringify({ server: "https://party.example", token: "t", identity: { name: "agent-a" } }));
      process.env.AGENTPARTY_CONFIG = explicit;
      recordClaudeSessionLifecycle(payload, hookEnv, process.pid);
      expect(listClaudeSessions(env)[0]).toMatchObject({ config_path: explicit, server: "https://party.example", identity: "agent-a" });
    } finally {
      if (savedHome === undefined) delete process.env.AGENTPARTY_HOME; else process.env.AGENTPARTY_HOME = savedHome;
      if (savedConfig === undefined) delete process.env.AGENTPARTY_CONFIG; else process.env.AGENTPARTY_CONFIG = savedConfig;
      if (savedNative === undefined) delete process.env.AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR; else process.env.AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR = savedNative;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("hook lifecycle wiring (#841 P1)", () => {
  test("SessionStart registers and SessionEnd unregisters", () => {
    // 原生会话目录指向一个空临时目录：display_name 升级路径读不到东西，保持 null。
    const hookEnv = {
      ...env,
      AGENTPARTY_CHANNEL: "dev",
      AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR: directory,
    };
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

  test("SessionStart 机会性把 display_name 升级成 Claude 原生会话名（读不到就保持 null）", () => {
    const nativeDir = mkdtempSync(join(tmpdir(), "ap-native-sessions-hook-"));
    try {
      const hookEnv = {
        ...env,
        AGENTPARTY_CHANNEL: "dev",
        AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR: nativeDir,
      };
      const payload = { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: "/tmp/project" };
      // 文件还没写出来（SessionStart 可能早于原生注册）→ null，不重试不阻塞。
      recordClaudeSessionLifecycle(payload, hookEnv, process.pid);
      expect(listClaudeSessions(env)[0]!.display_name).toBeNull();
      writeFileSync(
        join(nativeDir, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          sessionId: SESSION_ID,
          name: "agentparty-d4",
          messagingSocketPath: "/tmp/cc-socks-fake/1.sock",
        }),
        { mode: 0o600 },
      );
      recordClaudeSessionLifecycle(payload, hookEnv, process.pid);
      const listed = listClaudeSessions(env);
      expect(listed[0]!.display_name).toBe("agentparty-d4");
      expect(claudeSessionAnnounceName(listed[0]!)).toBe("agentparty-d4");
      // sessionId 对不上（pid 复用）→ 不认，保持 null。
      recordClaudeSessionLifecycle(
        { ...payload, session_id: sessionId(2) },
        hookEnv,
        process.pid,
      );
      const other = listClaudeSessions(env).find((e) => e.session_id === sessionId(2))!;
      expect(other.display_name).toBeNull();
    } finally {
      rmSync(nativeDir, { recursive: true, force: true });
    }
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

/**
 * #865：条目的实例维度。频道 slug 全局不唯一（两台生产实例上都有 `agentparty`），
 * 注册表少了 server 就会把 A 实例的 @ 注入到只属于 B 实例的会话。
 */
describe("会话注册表的 server 维度（issue #865）", () => {
  test("normalizeSessionRegistryServer 归一化到 origin，坏值给 null", () => {
    expect(normalizeSessionRegistryServer("https://a.example.com/")).toBe("https://a.example.com");
    expect(normalizeSessionRegistryServer("https://A.Example.COM/api/x?y=1")).toBe("https://a.example.com");
    // 缺协议头的手写 config 补 https://（healServerUrl 同款自愈）。
    expect(normalizeSessionRegistryServer("a.example.com")).toBe("https://a.example.com");
    expect(normalizeSessionRegistryServer("https://a.example.com:8443")).toBe("https://a.example.com:8443");
    for (const bad of ["", null, undefined, 42, "not a url", "ftp://a.example.com"]) {
      expect(normalizeSessionRegistryServer(bad)).toBeNull();
    }
  });

  test("入册写入规范化 origin，读回后同 server 命中、异 server 不命中", () => {
    expect(registerSession(baseEntry({ server: "https://a.example.com/" }), env)).toBe(true);
    const [entry] = listClaudeSessions(env);
    expect(entry!.server).toBe("https://a.example.com");
    expect(sessionEntryMatchesServer(entry!, "https://a.example.com")).toBe(true);
    expect(sessionEntryMatchesServer(entry!, "https://b.example.com")).toBe(false);
  });

  test("旧条目（无 server 字段）仍能读出，但恒不可匹配", () => {
    writeFileSync(
      join(directory, `${SESSION_ID}.json`),
      JSON.stringify({ version: 1, ...baseEntry(), harness: "claude" }),
      { mode: 0o600 },
    );
    const [entry] = listClaudeSessions(env);
    expect(entry!.server).toBeUndefined();
    expect(sessionEntryMatchesServer(entry!, "https://a.example.com")).toBe(false);
  });

  test("server 解析不出时不写该字段（条目随之不可匹配，安全侧）", () => {
    expect(registerSession(baseEntry({ server: "not a url" }), env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.server).toBeUndefined();
  });

  test("盘上写着未规范化 server 的条目按坏行丢弃，绝不退化成旧条目的宽松语义", () => {
    writeFileSync(
      join(directory, `${SESSION_ID}.json`),
      JSON.stringify({ version: 1, ...baseEntry({ server: "https://a.example.com/" }), harness: "claude" }),
      { mode: 0o600 },
    );
    expect(listClaudeSessions(env)).toHaveLength(0);
  });
});

describe("注册表的身份维度（issue #906）", () => {
  const IDENTITY = "lark-ad72b3f97491-agentparty";

  test("显式传入的身份落盘并可比对", () => {
    expect(registerSession(baseEntry({ identity: IDENTITY }), env)).toBe(true);
    const [entry] = listClaudeSessions(env);
    expect(entry!.identity).toBe(IDENTITY);
    expect(sessionEntryMatchesIdentity(entry!, IDENTITY)).toBe(true);
    expect(sessionEntryMatchesIdentity(entry!, IDENTITY.toUpperCase())).toBe(true);
    expect(sessionEntryMatchesIdentity(entry!, "lark-ad72b3f9749e-agentparty")).toBe(false);
  });

  test("旧条目（无 identity 字段）仍能读出，但恒不可匹配——宁可漏叫", () => {
    writeFileSync(
      join(directory, `${SESSION_ID}.json`),
      JSON.stringify({ version: 1, ...baseEntry(), harness: "claude" }),
      { mode: 0o600 },
    );
    const [entry] = listClaudeSessions(env);
    expect(entry!.identity).toBeUndefined();
    expect(sessionEntryMatchesIdentity(entry!, IDENTITY)).toBe(false);
  });

  test("显式 null / 解析不出的身份不写该字段（条目随之不可匹配）", () => {
    expect(registerSession(baseEntry({ identity: null }), env)).toBe(true);
    expect(listClaudeSessions(env)[0]!.identity).toBeUndefined();
  });

  test("盘上写着未规范化 identity 的条目按坏行丢弃，绝不退化成旧条目的宽松语义", () => {
    writeFileSync(
      join(directory, `${SESSION_ID}.json`),
      JSON.stringify({ version: 1, ...baseEntry({ identity: IDENTITY.toUpperCase() }), harness: "claude" }),
      { mode: 0o600 },
    );
    expect(listClaudeSessions(env)).toHaveLength(0);
  });

  test("身份归一化与 mentionMatchKey 同尺：ASCII 小写化、空/超长/非串 → null", () => {
    expect(normalizeSessionRegistryIdentity("Lark-AD72B3F97491-Agentparty")).toBe(IDENTITY);
    expect(normalizeSessionRegistryIdentity("张三")).toBe("张三");
    expect(normalizeSessionRegistryIdentity("")).toBeNull();
    expect(normalizeSessionRegistryIdentity(null)).toBeNull();
    expect(normalizeSessionRegistryIdentity("x".repeat(129))).toBeNull();
  });

  test("省略 identity 时从该会话绑定的 config 解析；channel_scope 不符不认", () => {
    const configPath = join(directory, "config.json");
    const previous = process.env.AGENTPARTY_CONFIG;
    process.env.AGENTPARTY_CONFIG = configPath;
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          server: "https://a.example.com",
          token: "t",
          identity: { name: IDENTITY, channel_scope: "dev" },
        }),
        { mode: 0o600 },
      );
      expect(resolveSessionRegistryIdentity("/tmp/project", "dev")).toBe(IDENTITY);
      // 另一个频道的缓存身份不认（那是别的频道的 handle）。
      expect(resolveSessionRegistryIdentity("/tmp/project", "prod")).toBeNull();
      expect(registerSession(baseEntry(), env)).toBe(true);
      expect(listClaudeSessions(env)[0]!.identity).toBe(IDENTITY);
    } finally {
      if (previous === undefined) delete process.env.AGENTPARTY_CONFIG;
      else process.env.AGENTPARTY_CONFIG = previous;
    }
  });
});
