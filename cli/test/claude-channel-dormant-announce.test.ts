import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import type { ClaudeSessionRegistryEntry } from "../src/claude-session-registry";
import {
  dormantAnnounceDisplayName,
  dormantAnnounceMentionHit,
  dormantAnnounceIsReplayFrame,
  runDormantClaudeSessionAnnounce,
  selectDormantAnnounceEntry,
  type DormantAnnounceDeps,
} from "../src/commands/claude-channel";

const SERVER = "https://party.example";
const OTHER_SERVER = "https://other.example";
/** 本机 announce 腿所用的频道身份（#906）；另一身份用来钉住同机跨身份误投。 */
const SELF_IDENTITY = "lark-ad72b3f97491-agentparty";
const OTHER_IDENTITY = "lark-ad72b3f9749e-agentparty";

function entry(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  return {
    version: 1,
    session_id: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    display_name: null,
    channel: "dev",
    server: SERVER,
    identity: SELF_IDENTITY,
    cwd: "/tmp/project",
    registered_at: 1_000,
    ...overrides,
  };
}

class FakeConnection {
  connectArgs: { server: string; token: string; slug: string; since: number; opts: Record<string, unknown> };
  sent: unknown[] = [];
  acked: number[] = [];
  closed = false;
  cursor = 0;
  revCursor = 0;
  private queue: ServerFrame[] = [];
  private waiter: (() => void) | null = null;

  constructor(args: FakeConnection["connectArgs"]) {
    this.connectArgs = args;
  }

  push(frame: ServerFrame): void {
    this.queue.push(frame);
    this.waiter?.();
  }

  frames = (async function* (self: FakeConnection) {
    while (true) {
      if (self.queue.length > 0) {
        yield self.queue.shift()!;
        continue;
      }
      if (self.closed) return;
      await new Promise<void>((resolve) => {
        self.waiter = resolve;
      });
      self.waiter = null;
    }
  })(this);

  send(frame: unknown): boolean {
    this.sent.push(frame);
    return true;
  }

  ack(seq: number): void {
    this.acked.push(seq);
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  pendingFrames(): ServerFrame[] {
    return [];
  }

  replayUnacked(): number {
    return 0;
  }
}

function makeDeps(overrides: Partial<DormantAnnounceDeps> = {}): {
  deps: DormantAnnounceDeps;
  connections: FakeConnection[];
} {
  const connections: FakeConnection[] = [];
  const deps: DormantAnnounceDeps = {
    listSessions: () => [entry()],
    resolveAuth: async () => ({ server: "https://party.example", token: "tok" }),
    connect: ((server: string, token: string, slug: string, since: number, opts = {}) => {
      const connection = new FakeConnection({ server, token, slug, since, opts: opts as Record<string, unknown> });
      connections.push(connection);
      return connection;
    }) as DormantAnnounceDeps["connect"],
    buildTopology: (server, _cwd, buildDeps) => ({
      version: 1,
      node_ref: "node_x",
      runtime_ref: "runtime_x",
      workspace_ref: "workspace_x",
      worktree_ref: "worktree_x",
      peer_scope: "local_installation",
      evidence: "client_asserted",
      ...(buildDeps?.harnessSession === undefined ? {} : { harness_session: buildDeps.harnessSession }),
    }),
    // #869：起点＝频道当前最新 seq（不是持久化游标、更不是 0）。
    resolveStartCursor: async () => 1884,
    // 默认给一个确定的频道身份：绝不让测试去读真实 config / 打 /api/me。
    resolveSelfName: async () => "lark-ad72b3f97491-agentparty",
    cwd: "/tmp/project",
    pollIntervalMs: 5,
    livenessIntervalMs: 5,
    ...overrides,
  };
  return { deps, connections };
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("dormantAnnounceDisplayName", () => {
  test("prefers the registered name and falls back to a deterministic session-derived name", () => {
    expect(dormantAnnounceDisplayName(entry({ display_name: "my-claude" }))).toBe("my-claude");
    expect(dormantAnnounceDisplayName(entry())).toBe("claude-111111111111");
  });
});

describe("selectDormantAnnounceEntry", () => {
  test("requires the channel and the same cwd, then newest registration", () => {
    const other = entry({ session_id: "22222222-2222-4222-8222-222222222222", channel: "prod" });
    expect(selectDormantAnnounceEntry([other], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBeNull();
    const away = entry({ session_id: "33333333-3333-4333-8333-333333333333", cwd: "/elsewhere", registered_at: 9_000 });
    const here = entry({ registered_at: 1_000 });
    expect(selectDormantAnnounceEntry([away, here], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBe(here);
    // #906：跨 cwd 兜底已删——同身份但在别的 worktree 的会话同样是错的宿主。
    expect(selectDormantAnnounceEntry([away], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBeNull();
    const newer = entry({ session_id: "44444444-4444-4444-8444-444444444444", registered_at: 5_000 });
    expect(selectDormantAnnounceEntry([here, newer], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBe(newer);
  });
});

describe("selectDormantAnnounceEntry 的身份维度（issue #906）", () => {
  // 本次故障形态的直接钉子：同 cwd、同频道、同 server，只有身份不同。
  test("同 cwd 同频道两个不同身份：选中的必须是该身份那条，与 registered_at 新旧无关", () => {
    const mine = entry({
      session_id: "66666666-6666-4666-8666-666666666666",
      identity: SELF_IDENTITY,
      registered_at: 1_000,
    });
    const theirs = entry({
      session_id: "77777777-7777-4777-8777-777777777777",
      identity: OTHER_IDENTITY,
      // 故意更新——旧实现「取最新入册」会选中它，那正是实机误投的那条。
      registered_at: 9_000,
    });
    expect(selectDormantAnnounceEntry([mine, theirs], "dev", "/tmp/project", SERVER, SELF_IDENTITY))
      .toBe(mine);
    expect(selectDormantAnnounceEntry([mine, theirs], "dev", "/tmp/project", SERVER, OTHER_IDENTITY))
      .toBe(theirs);
    // 顺序反转也一样（防「靠数组序侥幸通过」）。
    expect(selectDormantAnnounceEntry([theirs, mine], "dev", "/tmp/project", SERVER, SELF_IDENTITY))
      .toBe(mine);
  });

  test("本机没有该身份的会话 ⇒ 一个都不选（绝不退回频道里随便挑一个）", () => {
    const theirs = entry({ identity: OTHER_IDENTITY, registered_at: 9_000 });
    expect(selectDormantAnnounceEntry([theirs], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBeNull();
  });

  test("旧条目（无 identity 字段）恒不命中，等下次 SessionStart 升级", () => {
    const legacy = entry({ identity: undefined });
    expect(selectDormantAnnounceEntry([legacy], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBeNull();
    const fresh = entry({ session_id: "88888888-8888-4888-8888-888888888888", registered_at: 9_000 });
    expect(selectDormantAnnounceEntry([legacy, fresh], "dev", "/tmp/project", SERVER, SELF_IDENTITY))
      .toBe(fresh);
  });

  test("解析不出本机身份（null/undefined/空串）时一个都不命中", () => {
    const here = entry();
    for (const identity of [null, undefined, ""]) {
      expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", SERVER, identity)).toBeNull();
    }
  });

  test("身份比对与 mention 同一把尺子：ASCII handle 大小写等价", () => {
    const here = entry();
    expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", SERVER, SELF_IDENTITY.toUpperCase()))
      .toBe(here);
  });
});

describe("selectDormantAnnounceEntry 的 server 维度（issue #865）", () => {
  test("同 slug 不同 server 不命中；同 slug 同 server 才命中", () => {
    const here = entry();
    expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBe(here);
    expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", OTHER_SERVER, SELF_IDENTITY)).toBeNull();
  });

  test("旧条目（无 server 字段）恒不命中，等下次 SessionStart 升级", () => {
    const legacy = entry({ server: undefined });
    expect(selectDormantAnnounceEntry([legacy], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBeNull();
    // 同一批里的新条目照常命中——旧条目只是被跳过，不会拖垮整批。
    const fresh = entry({ session_id: "55555555-5555-4555-8555-555555555555", registered_at: 9_000 });
    expect(selectDormantAnnounceEntry([legacy, fresh], "dev", "/tmp/project", SERVER, SELF_IDENTITY)).toBe(fresh);
  });

  test("解析不出实例身份（null/undefined/坏 URL）时一个都不命中", () => {
    const here = entry();
    for (const server of [null, undefined, "", "not a url"]) {
      expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", server, SELF_IDENTITY)).toBeNull();
    }
  });

  test("按 origin 规范化比对：尾斜杠 / host 大小写 / 缺协议头都等价，端口不同即不同实例", () => {
    const here = entry();
    for (const variant of ["https://party.example/", "https://Party.Example", "party.example"]) {
      expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", variant, SELF_IDENTITY)).toBe(here);
    }
    expect(selectDormantAnnounceEntry([here], "dev", "/tmp/project", "https://party.example:8443", SELF_IDENTITY))
      .toBeNull();
  });
});

describe("runDormantClaudeSessionAnnounce (#841 P2)", () => {
  test("announces topology + harness_session only and never claims delivery", async () => {
    const { deps, connections } = makeDeps();
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(1);
    const { connectArgs } = connections[0]!;
    expect(connectArgs.server).toBe("https://party.example");
    expect(connectArgs.slug).toBe("dev");
    // #869：起始游标＝频道当前最新 seq，announce 只收「连上之后」的消息。
    expect(connectArgs.since).toBe(1884);
    const opts = connectArgs.opts;
    // announce 档不认领 delivery：不声明任何 delivery/wake 能力，也不持久化游标。
    expect(opts.directedDelivery).toBeUndefined();
    expect(opts.deliveryRecovery).toBeUndefined();
    expect(opts.advertiseWakeKind).toBeUndefined();
    expect(opts.onCursor).toBeUndefined();
    expect((opts.runtimeTopology as { harness_session?: unknown }).harness_session).toEqual({
      harness: "claude",
      display_name: "claude-111111111111",
    });
    // 收到普通消息只本地 ack，绝不发送任何客户端帧。
    connections[0]!.push({ type: "msg", seq: 7, from: "a", body: "x", ts: 1 } as unknown as ServerFrame);
    await tick();
    expect(connections[0]!.acked).toEqual([7]);
    expect(connections[0]!.sent).toHaveLength(0);
    abort.abort();
    await done;
    expect(connections[0]!.closed).toBe(true);
  });

  test("an abort during resolveAuth never opens a connection", async () => {
    const abort = new AbortController();
    const { deps, connections } = makeDeps({
      resolveAuth: async () => {
        abort.abort();
        return { server: "https://party.example", token: "tok" };
      },
    });
    await runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    expect(connections).toHaveLength(0);
  });

  test("stays fully dormant without auth", async () => {
    const { deps, connections } = makeDeps({
      resolveAuth: async () => ({ server: null, token: null }),
    });
    const abort = new AbortController();
    await runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    expect(connections).toHaveLength(0);
  });

  test("waits for a registry entry to appear, then closes when the session dies", async () => {
    let sessions: ClaudeSessionRegistryEntry[] = [];
    const { deps, connections } = makeDeps({ listSessions: () => sessions });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(0);
    sessions = [entry()];
    await tick();
    expect(connections).toHaveLength(1);
    // 会话死亡（注册表探活失败）→ 活体检测断开 WS。
    sessions = [];
    await tick(30);
    expect(connections[0]!.closed).toBe(true);
    abort.abort();
    await done;
  });

  test("rejects an invalid channel slug without connecting", async () => {
    const { deps, connections } = makeDeps();
    const abort = new AbortController();
    await runDormantClaudeSessionAnnounce("Bad_Channel!", abort.signal, deps);
    expect(connections).toHaveLength(0);
  });
});

function msg(seq: number, mentions: string[]): ServerFrame {
  return {
    type: "msg",
    seq,
    sender: { name: "lark-ad72b3f97491-agentparty", kind: "agent", owner: "leo@example.com" },
    kind: "text",
    body: "hello",
    mentions,
    reply_to: null,
    state: null,
    note: null,
    status: null,
    ts: 1,
  } as unknown as ServerFrame;
}

const SELF = SELF_IDENTITY;

describe("announce 起始游标 (#869)", () => {
  test("按频道当前最新 seq 起，绝不是 0、也不来自持久化游标", async () => {
    const persisted = 0; // 新接入身份的持久化游标恒为 0——正是本 bug 的现场。
    const { deps, connections } = makeDeps({ resolveStartCursor: async () => 1884 });
    // announce 档根本不该有「读持久化游标」这条依赖。
    expect("loadCursor" in (deps as unknown as Record<string, unknown>)).toBe(false);
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(1);
    const { since, opts } = {
      since: connections[0]!.connectArgs.since,
      opts: connections[0]!.connectArgs.opts,
    };
    expect(since).not.toBe(0);
    expect(since).not.toBe(persisted);
    expect(since).toBe(1884);
    // 起点已是最新 seq → 历史帧（seq <= since）被客户端丢弃，live 帧立刻可达。
    connections[0]!.push(msg(1885, [SELF]));
    await tick();
    expect(connections[0]!.acked).toEqual([1885]);
    // P2 不变式不因此破坏：不推进/不持久化游标、不 claim delivery、不发任何客户端帧。
    expect(opts.onCursor).toBeUndefined();
    expect(opts.directedDelivery).toBeUndefined();
    expect(opts.deliveryRecovery).toBeUndefined();
    expect(opts.advertiseWakeKind).toBeUndefined();
    expect(connections[0]!.sent).toHaveLength(0);
    abort.abort();
    await done;
  });

  test("拿不到起点就不建连，稍候重试（绝不退回 0）", async () => {
    let cursor: number | null = null;
    const { deps, connections } = makeDeps({ resolveStartCursor: async () => cursor });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(0);
    cursor = 7;
    await tick();
    expect(connections).toHaveLength(1);
    expect(connections[0]!.connectArgs.since).toBe(7);
    abort.abort();
    await done;
  });

  test("重放帧不注入（#869 第 2 层，标记由 #861 补）", async () => {
    expect(dormantAnnounceIsReplayFrame({ type: "msg", seq: 1, replay: true })).toBe(true);
    expect(dormantAnnounceIsReplayFrame({ type: "msg", seq: 1 })).toBe(false);
    expect(dormantAnnounceIsReplayFrame(null)).toBe(false);
  });
});

describe("dormantAnnounceMentionHit", () => {
  test("matches the channel identity case-insensitively and ignores everything else", () => {
    expect(dormantAnnounceMentionHit([SELF.toUpperCase()], SELF)).toBe(true);
    expect(dormantAnnounceMentionHit(["lark-ad72b3f9749e-agentparty"], SELF)).toBe(false);
    expect(dormantAnnounceMentionHit(undefined, SELF)).toBe(false);
    expect(dormantAnnounceMentionHit([], SELF)).toBe(false);
    // 频道身份解析不出来 → 恒不触发（静默降级）。
    expect(dormantAnnounceMentionHit([SELF], null)).toBe(false);
    // 宣告名不在 mentions 命名空间里：拿它当比对键恒 false（这正是第二个阻断缺陷）。
    expect(dormantAnnounceMentionHit(["claude-111111111111"], SELF)).toBe(false);
  });
});

describe("runDormantClaudeSessionAnnounce socket inject (#857)", () => {
  function injectingDeps(
    impl?: (input: { name: string; body: string; fromName: string }) => Promise<unknown>,
  ) {
    const calls: { name: string; body: string; fromName: string; pid?: number; sessionId?: string | null }[] = [];
    const inject = (async (input: { name: string; body: string; fromName: string; pid?: number; sessionId?: string | null }) => {
      calls.push({
        name: input.name,
        body: input.body,
        fromName: input.fromName,
        pid: input.pid,
        sessionId: input.sessionId,
      });
      if (impl !== undefined) return await impl(input);
      return { ok: true, socketPath: "/tmp/x.sock", usedAuth: false, target: input.name };
    }) as DormantAnnounceDeps["inject"];
    const made = makeDeps({ inject });
    return { ...made, calls };
  }

  test("injects only when the host session is mentioned, targeting the host session", async () => {
    const { deps, connections, calls } = injectingDeps();
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    // 别人的频道身份 → 不触发。
    connections[0]!.push(msg(11, ["lark-ad72b3f9749e-agentparty"]));
    await tick();
    expect(calls).toHaveLength(0);
    // 宿主会话的宣告名（peers 命名空间）→ 不触发；它根本不是 @ 得到的东西。
    connections[0]!.push(msg(12, ["claude-111111111111"]));
    await tick();
    expect(calls).toHaveLength(0);
    // 自己的频道身份 → 触发。
    connections[0]!.push(msg(13, [SELF]));
    await tick();
    expect(calls).toHaveLength(1);
    // 寻址走 pid + sessionId（宣告名与 Claude 原生会话名是两个命名空间，#857）。
    expect(calls[0]!.pid).toBe(process.pid);
    expect(calls[0]!.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[0]!.name).toBe("claude-111111111111");
    // from-name＝友好名 + 技术 ID（接收端面板只显示这一处）。
    expect(calls[0]!.fromName).toBe("leo@example.com · agentparty (lark-ad72b3f97491-agentparty)");
    expect(calls[0]!.body).toContain("seq=13");
    expect(Buffer.byteLength(calls[0]!.body, "utf8")).toBeLessThanOrEqual(512);
    // 注入路径不改变 P2 不变式：只本地 ack，绝不发客户端帧、绝不推进持久化游标。
    expect(connections[0]!.acked).toEqual([11, 12, 13]);
    expect(connections[0]!.sent).toHaveLength(0);
    expect(connections[0]!.connectArgs.opts.onCursor).toBeUndefined();
    abort.abort();
    await done;
  });

  test("带 replay 标记的历史帧不注入（#869 第 2 层）", async () => {
    const { deps, connections, calls } = injectingDeps();
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    connections[0]!.push({ ...(msg(40, [SELF]) as object), replay: true } as unknown as ServerFrame);
    await tick();
    expect(calls).toHaveLength(0);
    // 同一条 seq 后续以 live 帧到达仍应注入（重放不该污染去重表）。
    connections[0]!.push(msg(40, [SELF]));
    await tick();
    expect(calls).toHaveLength(1);
    abort.abort();
    await done;
  });

  test("injects a given seq at most once even if the frame is replayed", async () => {
    const { deps, connections, calls } = injectingDeps();
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    connections[0]!.push(msg(20, [SELF]));
    connections[0]!.push(msg(20, [SELF]));
    await tick();
    expect(calls).toHaveLength(1);
    abort.abort();
    await done;
  });

  test("a failing inject degrades silently: acks continue and the loop survives", async () => {
    const { deps, connections, calls } = injectingDeps(async () => {
      throw new Error("socket gone");
    });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    connections[0]!.push(msg(30, [SELF]));
    await tick();
    connections[0]!.push(msg(31, [SELF]));
    await tick();
    expect(calls).toHaveLength(2);
    expect(connections[0]!.acked).toEqual([30, 31]);
    abort.abort();
    await done;
  });
});

describe("announce 注入的身份闸（issue #906）", () => {
  function identityDeps(overrides: Partial<DormantAnnounceDeps> = {}) {
    const calls: { pid?: number; sessionId?: string | null }[] = [];
    const logs: string[] = [];
    const inject = (async (input: { pid?: number; sessionId?: string | null; name: string }) => {
      calls.push({ pid: input.pid, sessionId: input.sessionId });
      return { ok: true, socketPath: "/tmp/x.sock", usedAuth: false, target: input.name };
    }) as DormantAnnounceDeps["inject"];
    const made = makeDeps({ inject, log: (line) => logs.push(line), ...overrides });
    return { ...made, calls, logs };
  }

  // 故障形态本体：同 cwd、同频道、两个不同身份的活会话。
  const MINE = entry({
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid: 111,
    identity: SELF_IDENTITY,
    registered_at: 1_000,
  });
  const THEIRS = entry({
    session_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    pid: 222,
    identity: OTHER_IDENTITY,
    registered_at: 9_000, // 更新：旧实现恒选它 ⇒ 误投。
  });

  test("@ 我 ⇒ 只注入我这条会话，绝不落到同 cwd 的另一身份会话", async () => {
    const { deps, connections, calls } = identityDeps({ listSessions: () => [MINE, THEIRS] });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(1);
    connections[0]!.push(msg(50, [SELF]));
    await tick();
    expect(calls).toEqual([{ pid: 111, sessionId: MINE.session_id }]);
    abort.abort();
    await done;
  });

  test("本机没有该身份的会话 ⇒ 不建连、不注入任何人，且留下日志（不静默）", async () => {
    const { deps, connections, calls, logs } = identityDeps({ listSessions: () => [THEIRS] });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(logs.some((line) => line.includes(SELF_IDENTITY) && line.includes("未注入"))).toBe(true);
    abort.abort();
    await done;
  });

  test("解析不出本机身份 ⇒ 不建连、不注入，且留下日志", async () => {
    const { deps, connections, calls, logs } = identityDeps({
      listSessions: () => [MINE, THEIRS],
      resolveSelfName: async () => null,
    });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick();
    expect(connections).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(logs.some((line) => line.includes("解析不出本机频道身份"))).toBe(true);
    abort.abort();
    await done;
  });

  test("漏叫日志不刷屏：同一句连续轮询只打一次", async () => {
    const { deps, logs } = identityDeps({ listSessions: () => [THEIRS] });
    const abort = new AbortController();
    const done = runDormantClaudeSessionAnnounce("dev", abort.signal, deps);
    await tick(40); // pollIntervalMs=5 → 至少轮了好几圈。
    expect(logs.filter((line) => line.includes("未注入"))).toHaveLength(1);
    abort.abort();
    await done;
  });
});
