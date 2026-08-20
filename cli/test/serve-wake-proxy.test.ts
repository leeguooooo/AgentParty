import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { ClaudeSessionRegistryEntry } from "../src/claude-session-registry";
import { claudeSessionAnnounceName } from "../src/claude-session-registry";
import {
  attemptWakeProxy,
  noWakeProxyForwarder,
  selectWakeProxyTarget,
  injectFromName,
  socketWakeProxyForwarder,
  WAKE_PROXY_NOTE_MAX_BYTES,
  wakeProxyNote,
} from "../src/serve-wake-proxy";

function entry(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  return {
    version: 1,
    session_id: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    display_name: null,
    channel: "dev",
    cwd: "/tmp/project",
    registered_at: 1000,
    ...overrides,
  };
}

describe("claudeSessionAnnounceName", () => {
  test("display_name 优先，缺省回退 claude-<12hex>", () => {
    expect(claudeSessionAnnounceName(entry({ display_name: "my-claude" }))).toBe("my-claude");
    expect(claudeSessionAnnounceName(entry())).toBe("claude-111111111111");
  });
});

describe("wakeProxyNote", () => {
  test("只带 channel+seq 指针且 ≤512B（含最长 channel）", () => {
    const note = wakeProxyNote({ channel: "a".repeat(64), seq: Number.MAX_SAFE_INTEGER });
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
    expect(note).toContain(`#${"a".repeat(64)}`);
    expect(note).toContain(`seq=${Number.MAX_SAFE_INTEGER}`);
  });
});

describe("selectWakeProxyTarget", () => {
  test("回退名命中 → 选中；serve 自己的名字不算转投目标", () => {
    const sessions = [entry()];
    expect(selectWakeProxyTarget(["claude-111111111111"], "me", "dev", sessions)?.session_id)
      .toBe(sessions[0]!.session_id);
    expect(selectWakeProxyTarget(["claude-111111111111"], "claude-111111111111", "dev", sessions))
      .toBeNull();
  });

  test("display_name 命中；channel 不匹配的条目排除", () => {
    const named = entry({ display_name: "pair-claude" });
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [named])).toBe(named);
    expect(selectWakeProxyTarget(["pair-claude"], "me", "other", [named])).toBeNull();
  });

  test("多候选取最新入册", () => {
    const older = entry({ registered_at: 1 });
    const newer = entry({
      session_id: "22222222-2222-4222-8222-222222222222",
      display_name: null,
      registered_at: 2,
    });
    const picked = selectWakeProxyTarget(
      ["claude-111111111111", "claude-222222222222"],
      "me",
      "dev",
      [older, newer],
    );
    expect(picked).toBe(newer);
  });

  test("无 mentions 或全是 self → null", () => {
    expect(selectWakeProxyTarget([], "me", "dev", [entry()])).toBeNull();
  });
});

describe("attemptWakeProxy", () => {
  test("默认载体（无传输）：命中目标但 forwarded=false，降级为现行为", async () => {
    const lines: string[] = [];
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", seq: 7 }, {
      listSessions: () => [entry()],
      log: (line) => lines.push(line),
    });
    expect(result).toEqual({ forwarded: false, target: "claude-111111111111" });
    expect(lines.some((line) => line.includes("降级为现行为"))).toBe(true);
  });

  test("死会话已被注册表剔除（列表为空）→ 无目标，回落现行为", async () => {
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", seq: 7 }, {
      listSessions: () => [],
    });
    expect(result).toEqual({ forwarded: false, target: null });
  });

  test("载体成功 → forwarded=true 且拿到 ≤512B 指针", async () => {
    let sent = "";
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", seq: 42 }, {
      listSessions: () => [entry()],
      forward: async (_target, ref) => {
        sent = wakeProxyNote(ref);
        return true;
      },
    });
    expect(result.forwarded).toBe(true);
    expect(sent).toContain("seq=42");
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
  });

  test("载体抛错 → 绝不上抛，降级为现行为", async () => {
    const lines: string[] = [];
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", seq: 7 }, {
      listSessions: () => [entry()],
      forward: async () => {
        throw new Error("transport boom");
      },
      log: (line) => lines.push(line),
    });
    expect(result).toEqual({ forwarded: false, target: "claude-111111111111" });
    expect(lines.some((line) => line.includes("失败") && line.includes("不丢"))).toBe(true);
  });

  test("注册表读取抛错 → 降级为现行为", async () => {
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", seq: 7 }, {
      listSessions: () => {
        throw new Error("registry boom");
      },
    });
    expect(result).toEqual({ forwarded: false, target: null });
  });

  test("noWakeProxyForwarder 恒 false", async () => {
    expect(await noWakeProxyForwarder(entry(), { channel: "dev", seq: 1 })).toBe(false);
  });
});

describe("socketWakeProxyForwarder（#844 socket 优先载体）", () => {
  test("注入成功 → true；用宣告名寻址、from-name 带友好名+技术 ID、正文≤512B 指针", async () => {
    let seen: { name: string; body: string; fromName: string; pid?: number; sessionId?: string | null } | null = null;
    const forward = socketWakeProxyForwarder({
      inject: async ({ name, body, fromName, pid, sessionId }) => {
        seen = { name, body, fromName, pid, sessionId };
        return { ok: true, socketPath: "/tmp/x.sock", usedAuth: false, target: name };
      },
      // 默认 from-name 走 injectFromName（读本机 identity）；测试固定成确定值保持隔离。
      fromName: (ref) => injectFromName(ref.channel, {
        name: "lark-ad72b3f97491-agentparty",
        email: null,
        kind: "agent",
        role: "agent",
        owner: null,
        owner_display_name: "leo",
        channel_scope: "pwtk",
        verified_at: 0,
      }),
    });
    const ok = await forward(entry({ display_name: "pair-claude" }), { channel: "pwtk", seq: 42 });
    expect(ok).toBe(true);
    expect(seen!.name).toBe("pair-claude");
    // 寻址走 pid + sessionId（宣告名恒不等于 Claude 原生会话名，#857）。
    expect(seen!.pid).toBe(entry().pid);
    expect(seen!.sessionId).toBe(entry().session_id);
    expect(seen!.fromName).toBe("leo · agentparty (lark-ad72b3f97491-agentparty)");
    expect(seen!.body).toContain("seq=42");
    expect(Buffer.byteLength(seen!.body, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
  });

  test("注入失败（结构化 reason）→ false，触发 attemptWakeProxy 降级", async () => {
    const forward = socketWakeProxyForwarder({
      inject: async () => ({ ok: false, reason: "no-match" }),
    });
    expect(await forward(entry(), { channel: "dev", seq: 1 })).toBe(false);
  });
});
