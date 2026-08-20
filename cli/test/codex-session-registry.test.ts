// #851 P2：codex 会话入册。
//
// 这里的核心不是「codex 能写进去」，而是三条隔离不变量：
//   ① codex 条目永远不出现在 listClaudeSessions()——那是 claude 专用 PID→cc-socks
//      UDS 寻址（resolveSessionSocketByPid / nativeSessionName）的输入，codex 没有
//      那套收件箱，混进去就是把消息投到不存在的地方；
//   ② claude 条目同样不出现在 listCodexSessions()；
//   ③ 旧条目（#841 写的、无 harness 字段）仍按 claude 读得出来。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SESSION_REGISTRY_CAPACITY,
  CLAUDE_SESSION_REGISTRY_DIR_ENV,
  CODEX_SESSION_REGISTRY_DIR_ENV,
  claudeSessionAlive,
  listClaudeSessions,
  listCodexSessions,
  registerClaudeSession,
  registerCodexSession,
  sessionAnnounceName,
  sessionEntryHarness,
  unregisterCodexSession,
} from "../src/claude-session-registry";
import { recordCodexSessionLifecycle } from "../src/commands/hook";
import { resolveSessionSocketByPid } from "../src/claude-inbox-inject";

// 本机实测的 codex session id 形如 019f95e8-2c0b-7903-8779-cd102c5ecd4c（UUIDv7）。
const CODEX_SESSION_ID = "019f95e8-2c0b-7903-8779-cd102c5ecd4c";
const CLAUDE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** codex 0.145 的真实 SessionStart payload（字段取自二进制内嵌 JSON schema 的 required）。 */
function codexSessionStartPayload(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/tmp/project",
    hook_event_name: "SessionStart",
    model: "gpt-5.1-codex",
    permission_mode: "default",
    session_id: CODEX_SESSION_ID,
    source: "startup",
    transcript_path: null,
    ...overrides,
  };
}

let claudeDir: string;
let codexDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "agentparty-claude-sessions-"));
  codexDir = mkdtempSync(join(tmpdir(), "agentparty-codex-sessions-"));
  chmodSync(claudeDir, 0o700);
  chmodSync(codexDir, 0o700);
  env = {
    [CLAUDE_SESSION_REGISTRY_DIR_ENV]: claudeDir,
    [CODEX_SESSION_REGISTRY_DIR_ENV]: codexDir,
  };
});

afterEach(() => {
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
});

describe("codex session registry", () => {
  test("register / list / unregister round-trip，harness 落盘为 codex", () => {
    expect(registerCodexSession({
      session_id: CODEX_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
      registered_at: 1_000,
    }, env)).toBe(true);
    const listed = listCodexSessions(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      version: 1,
      harness: "codex",
      session_id: CODEX_SESSION_ID,
      pid: process.pid,
      channel: "dev",
    });
    // 落进 codex 目录，claude 目录里一个文件都没有。
    expect(readdirSync(codexDir)).toContain(`${CODEX_SESSION_ID}.json`);
    expect(readdirSync(claudeDir)).toHaveLength(0);
    expect(unregisterCodexSession(CODEX_SESSION_ID, env)).toBe(true);
    expect(listCodexSessions(env)).toHaveLength(0);
  });

  test("不变量①②：两个 harness 的条目互不可见，claudeSessionAlive 也不认 codex", () => {
    expect(registerCodexSession({
      session_id: CODEX_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
    }, env)).toBe(true);
    expect(registerClaudeSession({
      session_id: CLAUDE_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
    }, env)).toBe(true);

    expect(listClaudeSessions(env).map((e) => e.session_id)).toEqual([CLAUDE_SESSION_ID]);
    expect(listCodexSessions(env).map((e) => e.session_id)).toEqual([CODEX_SESSION_ID]);
    // claudeSessionAlive 是 claude 侧寻址前的存在性闸门——它对 codex session 必须为 false。
    expect(claudeSessionAlive(CODEX_SESSION_ID, env)).toBe(false);
    expect(claudeSessionAlive(CLAUDE_SESSION_ID, env)).toBe(true);
  });

  test("不变量①（防误用取证）：codex 条目喂不进 claude 的 PID→UDS 寻址", () => {
    expect(registerCodexSession({
      session_id: CODEX_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
    }, env)).toBe(true);
    // claude 侧唤醒代理的取数只有这一条路径。它拿不到 codex 条目，
    // 所以根本不会有人把一个 codex pid 交给 resolveSessionSocketByPid。
    const claudePids = listClaudeSessions(env).map((entry) => entry.pid);
    expect(claudePids).toHaveLength(0);
    // 二道防线：即便有人硬把 codex 条目塞进 claude 目录，读取也按坏行丢弃。
    writeFileSync(
      join(claudeDir, `${CODEX_SESSION_ID}.json`),
      JSON.stringify({
        version: 1,
        harness: "codex",
        session_id: CODEX_SESSION_ID,
        pid: process.pid,
        display_name: null,
        channel: "dev",
        cwd: "/tmp/project",
        registered_at: 1_000,
      }),
      { mode: 0o600 },
    );
    expect(listClaudeSessions(env)).toHaveLength(0);
    // 坏行被现场清除，不留残渣。
    expect(readdirSync(claudeDir)).toHaveLength(0);
    // 反向同理：claude 条目塞进 codex 目录也不认。
    writeFileSync(
      join(codexDir, `${CLAUDE_SESSION_ID}.json`),
      JSON.stringify({
        version: 1,
        harness: "claude",
        session_id: CLAUDE_SESSION_ID,
        pid: process.pid,
        display_name: null,
        channel: "dev",
        cwd: "/tmp/project",
        registered_at: 1_000,
      }),
      { mode: 0o600 },
    );
    expect(listCodexSessions(env).map((e) => e.session_id)).toEqual([CODEX_SESSION_ID]);
    // resolveSessionSocketByPid 本身仍是 claude 专用寻址：给一个没有 cc-socks 的
    // pid（本进程）必须解析不出收件箱。
    expect(resolveSessionSocketByPid(process.pid, { env: { HOME: codexDir } }))
      .toMatchObject({ ok: false });
  });

  test("不变量③：#841 时期的旧条目（无 harness 字段）仍按 claude 读得出来", () => {
    writeFileSync(
      join(claudeDir, `${CLAUDE_SESSION_ID}.json`),
      JSON.stringify({
        version: 1,
        session_id: CLAUDE_SESSION_ID,
        pid: process.pid,
        display_name: null,
        channel: "dev",
        cwd: "/tmp/project",
        registered_at: 1_000,
      }),
      { mode: 0o600 },
    );
    const listed = listClaudeSessions(env);
    expect(listed).toHaveLength(1);
    expect(sessionEntryHarness(listed[0]!)).toBe("claude");
    // 旧条目的宣告名逐字不变（#841 契约）。
    expect(sessionAnnounceName(listed[0]!)).toBe("claude-111111111111");
  });

  test("宣告名：codex 条目回退 codex-<12hex>，display_name 优先", () => {
    expect(sessionAnnounceName({
      version: 1,
      harness: "codex",
      session_id: CODEX_SESSION_ID,
      pid: 1,
      display_name: null,
      channel: "dev",
      cwd: "/tmp",
      registered_at: 0,
    })).toBe("codex-019f95e82c0b");
    expect(sessionAnnounceName({
      version: 1,
      harness: "codex",
      session_id: CODEX_SESSION_ID,
      pid: 1,
      display_name: "my-codex",
      channel: "dev",
      cwd: "/tmp",
      registered_at: 0,
    })).toBe("my-codex");
  });

  test("容量按 harness 目录各自独立：codex 刷满挤不掉 claude", () => {
    for (let n = 0; n < CLAUDE_SESSION_REGISTRY_CAPACITY; n += 1) {
      expect(registerCodexSession({
        session_id: `019f95e8-2c0b-7903-8779-${String(n).padStart(12, "0")}`,
        pid: process.pid,
        display_name: null,
        channel: "dev",
        cwd: "/tmp/project",
      }, env)).toBe(true);
    }
    // codex 满了，新的 codex 会话被拒。
    expect(registerCodexSession({
      session_id: CODEX_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
    }, env)).toBe(false);
    // claude 目录不受影响。
    expect(registerClaudeSession({
      session_id: CLAUDE_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
    }, env)).toBe(true);
  });
});

describe("codex hook lifecycle wiring", () => {
  test("真实 SessionStart payload 入册；payload 无展示名 → display_name 恒 null", () => {
    const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev" };
    recordCodexSessionLifecycle(codexSessionStartPayload(), hookEnv, process.pid);
    const listed = listCodexSessions(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      harness: "codex",
      session_id: CODEX_SESSION_ID,
      pid: process.pid,
      display_name: null,
      channel: "dev",
      cwd: "/tmp/project",
    });
    expect(sessionAnnounceName(listed[0]!)).toBe("codex-019f95e82c0b");
    // 入册永远只碰 codex 目录。
    expect(readdirSync(claudeDir)).toHaveLength(0);
  });

  test("resume/clear/compact 覆盖自身而不是新增", () => {
    const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev" };
    for (const source of ["startup", "resume", "clear", "compact"]) {
      recordCodexSessionLifecycle(codexSessionStartPayload({ source }), hookEnv, process.pid);
    }
    expect(listCodexSessions(env)).toHaveLength(1);
  });

  test("无频道 / serve 托管 lane / 非 SessionStart 事件都不入册", () => {
    // 无频道（cwd 不是任何已绑定频道的项目，且没有 AGENTPARTY_CHANNEL）。
    recordCodexSessionLifecycle(codexSessionStartPayload({ cwd: codexDir }), env, process.pid);
    expect(listCodexSessions(env)).toHaveLength(0);
    // serve 托管 lane 是被管理的 runner，不是人开的交互式会话。
    recordCodexSessionLifecycle(
      codexSessionStartPayload(),
      { ...env, AGENTPARTY_CHANNEL: "dev", AP_ACTIVITY_FILE: "/tmp/a.json" },
      process.pid,
    );
    expect(listCodexSessions(env)).toHaveLength(0);
    // codex 的其它事件与坏 session_id。
    const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev" };
    recordCodexSessionLifecycle(
      codexSessionStartPayload({ hook_event_name: "PreToolUse" }), hookEnv, process.pid,
    );
    recordCodexSessionLifecycle(
      codexSessionStartPayload({ session_id: "../evil" }), hookEnv, process.pid,
    );
    expect(listCodexSessions(env)).toHaveLength(0);
  });

  test("hook 铁律：注册表不可用也绝不抛", () => {
    const hookEnv = { ...env, AGENTPARTY_CHANNEL: "dev" };
    chmodSync(codexDir, 0o750);
    expect(() => recordCodexSessionLifecycle(codexSessionStartPayload(), hookEnv, process.pid))
      .not.toThrow();
    expect(listCodexSessions(env)).toHaveLength(0);
    chmodSync(codexDir, 0o700);
  });
});
