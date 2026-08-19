import { describe, expect, test } from "bun:test";
import type { ServerFrame } from "@agentparty/shared";
import type { ClaudeSessionRegistryEntry } from "../src/claude-session-registry";
import {
  dormantAnnounceDisplayName,
  runDormantClaudeSessionAnnounce,
  selectDormantAnnounceEntry,
  type DormantAnnounceDeps,
} from "../src/commands/claude-channel";

function entry(overrides: Partial<ClaudeSessionRegistryEntry> = {}): ClaudeSessionRegistryEntry {
  return {
    version: 1,
    session_id: "11111111-1111-4111-8111-111111111111",
    pid: process.pid,
    display_name: null,
    channel: "dev",
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
    loadCursor: () => 42,
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
  test("requires the channel, prefers same cwd, then newest registration", () => {
    const other = entry({ session_id: "22222222-2222-4222-8222-222222222222", channel: "prod" });
    expect(selectDormantAnnounceEntry([other], "dev", "/tmp/project")).toBeNull();
    const away = entry({ session_id: "33333333-3333-4333-8333-333333333333", cwd: "/elsewhere", registered_at: 9_000 });
    const here = entry({ registered_at: 1_000 });
    expect(selectDormantAnnounceEntry([away, here], "dev", "/tmp/project")).toBe(here);
    expect(selectDormantAnnounceEntry([away], "dev", "/tmp/project")).toBe(away);
    const newer = entry({ session_id: "44444444-4444-4444-8444-444444444444", registered_at: 5_000 });
    expect(selectDormantAnnounceEntry([here, newer], "dev", "/tmp/project")).toBe(newer);
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
    expect(connectArgs.since).toBe(42);
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
