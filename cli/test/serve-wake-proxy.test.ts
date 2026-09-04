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
  wakeProxyNoteFromId,
} from "../src/serve-wake-proxy";

function entry(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  return {
    version: 1,
    session_id: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    display_name: null,
    channel: "dev",
    server: SERVER_A,
    cwd: "/tmp/project",
    registered_at: 1000,
    ...overrides,
  };
}

const SERVER_A = "https://a.example.com";
const SERVER_B = "https://b.example.com";

describe("claudeSessionAnnounceName", () => {
  test("display_name 优先，缺省回退 claude-<12hex>", () => {
    expect(claudeSessionAnnounceName(entry({ display_name: "my-claude" }))).toBe("my-claude");
    expect(claudeSessionAnnounceName(entry())).toBe("claude-111111111111");
  });
});

describe("wakeProxyNote", () => {
  test("老签名（只有 channel/seq）⇒ 头行 + Reply / Thread 两行，≤5120B（含最长 channel）", () => {
    const note = wakeProxyNote({ channel: "a".repeat(64), server: SERVER_A, seq: Number.MAX_SAFE_INTEGER });
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
    expect(note).toContain(`#${"a".repeat(64)}`);
    expect(note).toContain(`seq ${Number.MAX_SAFE_INTEGER}`);
    expect(note).toContain(`Reply: party reply ${Number.MAX_SAFE_INTEGER} "<your reply>" --channel ${"a".repeat(64)}`);
    expect(note).toContain(`Thread: party history ${"a".repeat(64)} --seq ${Number.MAX_SAFE_INTEGER}`);
  });

  test("最长 channel + 最长 identity + siblings 齐上仍 ≤5120B，且 from-id 可读回（#986）", () => {
    const note = wakeProxyNote({
      channel: "a".repeat(64),
      server: SERVER_A,
      seq: Number.MAX_SAFE_INTEGER,
      siblings: 99,
      fromId: "b".repeat(64),
    });
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
    expect(wakeProxyNoteFromId(note)).toBe("b".repeat(64));
    expect(note).toContain("siblings=99");
  });
});

describe("selectWakeProxyTarget", () => {
  test("回退名命中 → 选中；serve 自己的名字不算转投目标", () => {
    const sessions = [entry()];
    expect(selectWakeProxyTarget(["claude-111111111111"], "me", "dev", sessions, SERVER_A)?.session_id)
      .toBe(sessions[0]!.session_id);
    expect(selectWakeProxyTarget(["claude-111111111111"], "claude-111111111111", "dev", sessions, SERVER_A))
      .toBeNull();
  });

  test("display_name 命中；channel 不匹配的条目排除", () => {
    const named = entry({ display_name: "pair-claude" });
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [named], SERVER_A)).toBe(named);
    expect(selectWakeProxyTarget(["pair-claude"], "me", "other", [named], SERVER_A)).toBeNull();
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
      SERVER_A,
    );
    expect(picked).toBe(newer);
  });

  /** #865：频道 slug 跨实例不唯一（两台生产实例上都有 `agentparty`）。 */
  test("#865：同 slug 不同 server 不命中；同 slug 同 server 才命中", () => {
    const onA = entry({ display_name: "pair-claude", server: SERVER_A });
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [onA], SERVER_A)).toBe(onA);
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [onA], SERVER_B)).toBeNull();
  });

  test("#865：旧条目（无 server 字段）恒不命中；server 未知时同样不命中", () => {
    const legacy = entry({ display_name: "pair-claude", server: undefined });
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [legacy], SERVER_A)).toBeNull();
    const known = entry({ display_name: "pair-claude", server: SERVER_A });
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [known], null)).toBeNull();
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [known], undefined)).toBeNull();
  });

  test("#865：server 按 origin 规范化比对（尾斜杠/大小写 host/缺协议头都等价）", () => {
    const onA = entry({ display_name: "pair-claude", server: SERVER_A });
    for (const variant of ["https://a.example.com/", "https://A.Example.com", "a.example.com"]) {
      expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [onA], variant)).toBe(onA);
    }
    // 端口不同＝不同实例。
    expect(selectWakeProxyTarget(["pair-claude"], "me", "dev", [onA], "https://a.example.com:8443"))
      .toBeNull();
  });

  test("无 mentions 或全是 self → null", () => {
    expect(selectWakeProxyTarget([], "me", "dev", [entry()], SERVER_A)).toBeNull();
  });
});

describe("attemptWakeProxy", () => {
  test("默认载体（无传输）：命中目标但 forwarded=false，降级为现行为", async () => {
    const lines: string[] = [];
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 7 }, {
      listSessions: () => [entry()],
      log: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ forwarded: false, target: "claude-111111111111", reason: "no-carrier" });
    expect(lines.some((line) => line.includes("降级为现行为"))).toBe(true);
    // #867 ①：这句 #841 时代的文案必须已经消失——今天它是反话。
    expect(lines.some((line) => line.includes("当前无可用转投载体"))).toBe(false);
  });

  test("死会话已被注册表剔除（列表为空）→ 无目标，回落现行为", async () => {
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 7 }, {
      listSessions: () => [],
    });
    expect(result).toMatchObject({ forwarded: false, target: null });
  });

  test("载体成功 → forwarded=true 且拿到带 Reply 行的通知", async () => {
    let sent = "";
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 42 }, {
      listSessions: () => [entry()],
      forward: async (_target, ref) => {
        sent = wakeProxyNote(ref);
        return true;
      },
    });
    expect(result.forwarded).toBe(true);
    expect(sent).toContain("seq 42");
    expect(sent).toContain('party reply 42 "<your reply>"');
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
  });

  test("载体抛错 → 绝不上抛，降级为现行为", async () => {
    const lines: string[] = [];
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 7 }, {
      listSessions: () => [entry()],
      forward: async () => {
        throw new Error("transport boom");
      },
      log: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ forwarded: false, target: "claude-111111111111", reason: "threw" });
    expect(result.detail).toContain("transport boom");
    expect(lines.some((line) => line.includes("失败") && line.includes("不丢"))).toBe(true);
  });

  test("注册表读取抛错 → 降级为现行为", async () => {
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 7 }, {
      listSessions: () => {
        throw new Error("registry boom");
      },
    });
    expect(result).toMatchObject({ forwarded: false, target: null });
  });

  test("noWakeProxyForwarder 恒 false（且这条才是真正的「无载体」）", async () => {
    expect(await noWakeProxyForwarder(entry(), { channel: "dev", server: SERVER_A, seq: 1 })).toMatchObject({
      ok: false,
      reason: "no-carrier",
    });
  });
});

describe("socketWakeProxyForwarder（#844 socket 优先载体）", () => {
  test("注入成功 → true；用宣告名寻址、from-name 只带友好名、技术 ID 在正文 from-id、正文≤5120B", async () => {
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
      fromId: () => "lark-ad72b3f97491-agentparty",
    });
    const ok = await forward(entry({ display_name: "pair-claude" }), { channel: "pwtk", server: SERVER_A, seq: 42 });
    expect(ok).toMatchObject({ ok: true });
    expect(seen!.name).toBe("pair-claude");
    // 寻址走 pid + sessionId（宣告名恒不等于 Claude 原生会话名，#857）。
    expect(seen!.pid).toBe(entry().pid);
    expect(seen!.sessionId).toBe(entry().session_id);
    // #986：主名只放友好名；技术 ID 挪到正文 from-id 行，仍可读回。
    expect(seen!.fromName).toBe("leo · agentparty");
    expect(wakeProxyNoteFromId(seen!.body)).toBe("lark-ad72b3f97491-agentparty");
    expect(seen!.body).toContain("seq 42");
    expect(Buffer.byteLength(seen!.body, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
  });

  test("注入失败（结构化 reason）→ false，触发 attemptWakeProxy 降级", async () => {
    const forward = socketWakeProxyForwarder({
      inject: async () => ({ ok: false, reason: "no-match" }),
    });
    expect(await forward(entry(), { channel: "dev", server: SERVER_A, seq: 1 })).toMatchObject({ ok: false, reason: "no-match" });
  });
});

describe("#867 ①：结构化失败原因必须一路透出到降级日志", () => {
  // injectChannelMessage 构造的全部失败原因。以前 socketWakeProxyForwarder 一句
  // `return result.ok;` 把它们全丢了，「目标会话已死 / socket 陈旧残留 / 同名多会话」
  // 在日志里长得一模一样，而且打的是**错误的**原因（「当前无可用转投载体」）。
  const reasons = [
    ["no-match", "目标会话已死或 pid 复用"],
    ["ambiguous", "同名多会话"],
    ["unavailable", "寻址目录不可用"],
    ["probe-failed", "socket 陈旧残留（ECONNREFUSED）"],
    ["socket-untrusted", "socket path is a symlink"],
    ["body-too-large", "单行超 1MiB"],
    ["write-failed", "Error: socket write timeout"],
  ] as const;

  for (const [reason, detail] of reasons) {
    test(`reason=${reason} 透出到 forwarder、attempt 与日志`, async () => {
      const forward = socketWakeProxyForwarder({
        inject: async () => ({ ok: false, reason, detail }),
      });
      expect(await forward(entry(), { channel: "dev", server: SERVER_A, seq: 5 })).toEqual({ ok: false, reason, detail });

      const lines: string[] = [];
      const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 5 }, {
        listSessions: () => [entry()],
        forward,
        log: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ forwarded: false, target: "claude-111111111111", reason, detail });
      const line = lines.find((l) => l.includes("claude-111111111111"));
      expect(line).toBeDefined();
      expect(line!).toContain(`reason=${reason}`);
      expect(line!).toContain(`detail=${detail}`);
      // 过时文案已删除：日志绝不能再说「没有载体」——真载体在，只是这次失败了。
      expect(line!).not.toContain("当前无可用转投载体");
      expect(line!).not.toContain("#841 P3");
    });
  }

  test("两种不同失败打出的是两条不同的日志（以前恒同一句）", async () => {
    const lines: string[] = [];
    for (const reason of ["no-match", "probe-failed"] as const) {
      await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 5 }, {
        listSessions: () => [entry()],
        forward: socketWakeProxyForwarder({ inject: async () => ({ ok: false, reason }) }),
        log: (line) => lines.push(line),
      });
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
  });

  test("载体只返回裸 boolean false → 明说「未上报原因」，绝不编一个", async () => {
    const lines: string[] = [];
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 5 }, {
      listSessions: () => [entry()],
      forward: async () => false,
      log: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ forwarded: false, reason: null });
    expect(lines[0]).toContain("reason=unreported");
  });

  test("成功路径不带 reason/detail", async () => {
    const result = await attemptWakeProxy(["claude-111111111111"], "me", { channel: "dev", server: SERVER_A, seq: 5 }, {
      listSessions: () => [entry()],
      forward: async () => true,
    });
    expect(result).toMatchObject({ forwarded: true, reason: null, detail: null });
  });
});

describe("wakeProxyNote 内容与语言（#1003 / #1052 wake protocol v2）", () => {
  const NOW = Date.parse("2026-08-28T10:02:00Z");
  const ZH_BODY = "我们的展示信息是不是有点太少了，语言应该根据 ai 使用的语言或者其他的方式，自动改成对应的语言";

  test("带 sender/body/ts/lang=zh ⇒ v2 中文骨架：头行 + 正文逐字 + 回复 / 线程 / from-id", () => {
    const note = wakeProxyNote({
      channel: "pwtk",
      server: "https://party.example",
      seq: 42,
      sender: { name: "lark-ad72b3f9749e", kind: "human", display_name: "leo" },
      body: ZH_BODY,
      ts: NOW - 2 * 60_000,
      now: NOW,
      lang: "zh",
      fromId: "lark-ad72b3f9749e",
    });
    expect(note).toBe(
      "[AgentParty 唤醒] leo 在 #pwtk 提到了你（seq 42，2 分钟前）\n" +
        "\n" +
        `${ZH_BODY}\n` +
        "\n" +
        '回复：party reply 42 "<你的回复>" --channel pwtk\n' +
        "线程：party history pwtk --seq 42\n" +
        "from-id: lark-ad72b3f9749e",
    );
    expect(wakeProxyNoteFromId(note)).toBe("lark-ad72b3f9749e");
  });

  test("replyTo / configPath 透传：头行「reply to seq M」，Reply 行带 AGENTPARTY_CONFIG 前缀", () => {
    const note = wakeProxyNote({
      channel: "pwtk",
      server: "https://party.example",
      seq: 42,
      sender: { name: "lark-ad72b3f9749e", kind: "human", display_name: "leo" },
      body: "ok",
      lang: "en",
      replyTo: 40,
      configPath: "/tmp/agents/me.json",
      now: NOW,
    });
    expect(note.split("\n")[0]).toBe("[AgentParty wake] leo mentioned you in #pwtk (seq 42, reply to seq 40)");
    expect(note).toContain('Reply: AGENTPARTY_CONFIG=/tmp/agents/me.json party reply 42 "<your reply>" --channel pwtk');
  });

  test("老签名（只有 channel/seq/fromId）⇒ 英文短版：无正文块，Reply / Thread / from-id 都在", () => {
    const note = wakeProxyNote({ channel: "pwtk", server: "https://party.example", seq: 42, fromId: "lark-ad72b3f9749e" });
    expect(note).toBe(
      "[AgentParty wake] you were mentioned in #pwtk (seq 42)\n" +
        "\n" +
        'Reply: party reply 42 "<your reply>" --channel pwtk\n' +
        "Thread: party history pwtk --seq 42\n" +
        "from-id: lark-ad72b3f9749e",
    );
    expect(wakeProxyNoteFromId(note)).toBe("lark-ad72b3f9749e");
  });

  test("超长正文（中/英）都只内联前 512B + 总字节数，整条 ≤5120B、from-id 不丢", () => {
    for (const [lang, body] of [["zh", "很长的中文正文。".repeat(800)], ["en", "long english body ".repeat(600)]] as const) {
      const note = wakeProxyNote({
        channel: "a".repeat(64),
        server: "https://party.example",
        seq: Number.MAX_SAFE_INTEGER,
        sender: { name: "lark-ad72b3f9749e", kind: "human", display_name: "leo" },
        body,
        ts: NOW - 60_000,
        now: NOW,
        lang,
        siblings: 3,
        fromId: "b".repeat(64),
      });
      expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_PROXY_NOTE_MAX_BYTES);
      expect(note).toContain(`… (${Buffer.byteLength(body, "utf8")} bytes total; full text: party history ${"a".repeat(64)} --seq ${Number.MAX_SAFE_INTEGER})`);
      expect(note).toContain("siblings=3");
      expect(wakeProxyNoteFromId(note)).toBe("b".repeat(64));
    }
  });
});
