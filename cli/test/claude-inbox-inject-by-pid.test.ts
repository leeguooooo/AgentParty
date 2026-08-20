// 真实寻址层的端到端回归（#857）：registry entry → pid → `~/.claude/sessions/<pid>.json`
// → 真实 Unix socket → 写帧成功。上一版把 inject 整个 mock 掉，寻址那层没被覆盖，结果
// 「宣告名 ≠ Claude 原生会话名」的致命错配一路漏到线上（6/6 no-match）。
// 用临时 sessions 目录（AGENTPARTY_CLAUDE_NATIVE_SESSIONS_DIR）+ 临时 socket，绝不碰真实
// `~/.claude/sessions` 或 `/tmp/cc-socks/`。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_NATIVE_SESSIONS_DIR_ENV,
  injectChannelMessage,
  nativeSessionName,
  resolveSessionSocket,
  resolveSessionSocketByPid,
} from "../src/claude-inbox-inject";
import {
  claudeSessionAnnounceName,
  type ClaudeSessionRegistryEntry,
} from "../src/claude-session-registry";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/** 与真实 registry 一致的 entry：display_name 为 null → 宣告名恒 `claude-<12hex>`。 */
function registryEntry(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  return {
    version: 1,
    session_id: SESSION_ID,
    pid: process.pid,
    display_name: null,
    channel: "dev",
    cwd: "/tmp/project",
    registered_at: 1_000,
    ...overrides,
  };
}

let dir: string;
let sockPath: string;
let server: Server;
let received: string[];

function env(): NodeJS.ProcessEnv {
  return { ...process.env, [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: dir };
}

function writeNativeSession(fields: Record<string, unknown> = {}): void {
  const pid = (fields.pid as number | undefined) ?? process.pid;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: SESSION_ID,
      // Claude 原生会话名——与 party 宣告名 `claude-111111111111` 是两个命名空间。
      name: "agentparty-d4",
      status: "idle",
      kind: "interactive",
      messagingSocketPath: sockPath,
      procStart: "Thu Aug 20 04:43:49 2026",
      ...fields,
    }),
    { mode: 0o600 },
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ap-native-sessions-"));
  sockPath = join(dir, "inbox.sock");
  received = [];
  server = createServer((socket) => {
    socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("按 pid 寻址（#857 真实寻址层）", () => {
  test("宣告名按 name 寻址恒 no-match，按 pid 寻址命中——这正是线上失效的根因", () => {
    writeNativeSession();
    const entry = registryEntry();
    const announceName = claudeSessionAnnounceName(entry);
    expect(announceName).toBe("claude-111111111111");
    // 两个命名空间：宣告名与原生 name 永不相等。
    expect(resolveSessionSocket(announceName, env())).toEqual({ ok: false, reason: "no-match" });
    const byPid = resolveSessionSocketByPid(entry.pid, { expectSessionId: entry.session_id, env: env() });
    expect(byPid.ok).toBe(true);
    expect(byPid.ok && byPid.session.messagingSocketPath).toBe(sockPath);
    expect(byPid.ok && byPid.session.name).toBe("agentparty-d4");
  });

  test("端到端：registry entry → pid → socket → 真的写进帧（宣告名与原生名不同也成功）", async () => {
    writeNativeSession();
    const entry = registryEntry();
    const result = await injectChannelMessage({
      pid: entry.pid,
      sessionId: entry.session_id,
      name: claudeSessionAnnounceName(entry),
      body: "AgentParty wake: #dev seq=42",
      fromName: "leo · agentparty (lark-ad72b3f97491-agentparty)",
      env: env(),
    });
    expect(result).toMatchObject({ ok: true, socketPath: sockPath });
    // 让 socket 数据回调跑完。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const payload = received.join("");
    expect(payload.endsWith("\n")).toBe(true);
    const frame = JSON.parse(payload.trim().split("\n").at(-1)!) as {
      type: string;
      message: { content: string };
    };
    expect(frame.type).toBe("user");
    expect(frame.message.content).toContain("AgentParty wake: #dev seq=42");
    expect(frame.message.content).toContain('from-name="leo · agentparty (lark-ad72b3f97491-agentparty)"');
  });

  test("sessionId 不匹配（pid 被复用/换了会话）→ 拒投，绝不写错会话", () => {
    writeNativeSession({ sessionId: "22222222-2222-4222-8222-222222222222" });
    expect(
      resolveSessionSocketByPid(process.pid, { expectSessionId: SESSION_ID, env: env() }),
    ).toEqual({ ok: false, reason: "no-match" });
  });

  test("pid 没有对应的原生会话文件 / pid 已死 → no-match（静默降级）", () => {
    expect(resolveSessionSocketByPid(process.pid, { env: env() })).toEqual({
      ok: false,
      reason: "no-match",
    });
    writeNativeSession({ pid: 999_999_999 });
    expect(resolveSessionSocketByPid(999_999_999, { env: env() })).toEqual({
      ok: false,
      reason: "no-match",
    });
  });

  test("nativeSessionName 供 SessionStart 入册升级 display_name；读不到就 null", () => {
    expect(nativeSessionName(process.pid, { env: env() })).toBeNull();
    writeNativeSession();
    expect(nativeSessionName(process.pid, { expectSessionId: SESSION_ID, env: env() })).toBe(
      "agentparty-d4",
    );
    // 入册后宣告名即变成原生名。
    expect(claudeSessionAnnounceName(registryEntry({ display_name: "agentparty-d4" }))).toBe(
      "agentparty-d4",
    );
  });
});
