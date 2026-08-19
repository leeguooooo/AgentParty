// party agents（#835）：统一可达性视图。REACH 必须是真实可达性判定，不是最后心跳——
// 重点回归「busy 全绿但 runner 挂死仍显示 online」的假在线（memory: observability-traps）。
import { describe, expect, test } from "bun:test";
import type { PresenceEntry, RuntimePeerDiscovery } from "@agentparty/shared";
import type { HealthCache } from "../src/health-cache";
import {
  buildAgentRows,
  localServeFailure,
  memberKind,
  memberReach,
  renderAgentTable,
  LOCAL_FRAME_STALE_MS,
} from "../src/commands/agents";

const NOW = 1_000_000_000;

function p(over: Partial<PresenceEntry> & { name: string }): PresenceEntry {
  return { state: "waiting", note: null, ts: NOW, last_seen: NOW, ...over };
}

function health(over: Partial<HealthCache> = {}): HealthCache {
  return {
    v: 1,
    pid: 4242,
    channel: "pwtk",
    ws_connected: true,
    last_frame_at: NOW - 10_000,
    reconnecting: false,
    reconnect_count: 0,
    last_error: null,
    connected_since: NOW - 60_000,
    current_task: null,
    task_started_at: null,
    heartbeat_at: null,
    supervisor_state: "running",
    supervisor_attempt: 1,
    restart_delay_ms: null,
    last_exit_code: null,
    last_exit_at: null,
    supervisor_error: null,
    lease_state: "held",
    serve_standbys: 0,
    updated_at: NOW,
    ...over,
  };
}

describe("memberReach", () => {
  test("live serve runner，服务端无异常信号 → online(serve)", () => {
    const r = memberReach(p({ name: "bot", live: true, wake: { kind: "serve" } }), NOW);
    expect(r.reach).toBe("online(serve)");
  });

  test("live 但 runner 连败 → stale（不是 online）——runner 挂死不许显示在线", () => {
    const r = memberReach(
      p({ name: "bot", live: true, wake: { kind: "serve" }, runner_health: { ok: false, consecutive_failures: 3 } }),
      NOW,
    );
    expect(r.reach).toBe("stale");
    expect(r.reason).toContain("runner failing x3");
  });

  test("live 但 listening=deaf（投喂了不吃）→ stale", () => {
    const r = memberReach(p({ name: "bot", live: true, wake: { kind: "serve" }, listening: "deaf" }), NOW);
    expect(r.reach).toBe("stale");
    expect(r.reason).toContain("not consuming");
  });

  test("本机交叉验证失败（pid 死了）→ stale，即使 presence 还标着 live", () => {
    const r = memberReach(p({ name: "bot", live: true, wake: { kind: "serve" } }), NOW, "local runner pid 4242 is dead");
    expect(r.reach).toBe("stale");
    expect(r.reason).toBe("local runner pid 4242 is dead");
  });

  test("offline + webhook（服务端投递，天然 verified）→ wake(webhook)", () => {
    const r = memberReach(
      p({ name: "bot", state: "offline", wake: { kind: "webhook" }, last_seen: NOW - 3_600_000 }),
      NOW,
    );
    expect(r.reach).toBe("wake(webhook)");
  });

  test("offline + 自报 serve（supervisor 已死）→ stale，不谎报可唤醒", () => {
    const r = memberReach(
      p({ name: "bot", state: "offline", wake: { kind: "serve" }, last_seen: NOW - 780_000 }),
      NOW,
    );
    expect(r.reach).toBe("stale");
  });

  test("paused → stale（人主动按了暂停，@ 不唤醒）", () => {
    const r = memberReach(p({ name: "bot", live: true, wake: { kind: "serve" }, paused: true }), NOW);
    expect(r.reach).toBe("stale");
    expect(r.reason).toContain("paused");
  });

  test("live 但没有 serve 型 wake layer → stale 并说明原因", () => {
    const r = memberReach(p({ name: "bot", live: true }), NOW);
    expect(r.reach).toBe("stale");
    expect(r.reason).toContain("no serve runner");
  });
});

describe("localServeFailure", () => {
  test("pid 死了 → 报 dead", () => {
    expect(localServeFailure({ cache: health(), pidAlive: () => false, now: NOW })).toContain("dead");
  });

  test("ws 断开 → 报 disconnected", () => {
    expect(
      localServeFailure({ cache: health({ ws_connected: false }), pidAlive: () => true, now: NOW }),
    ).toContain("disconnected");
  });

  test("帧陈旧（超过 LOCAL_FRAME_STALE_MS）→ 报 stale", () => {
    expect(
      localServeFailure({
        cache: health({ last_frame_at: NOW - LOCAL_FRAME_STALE_MS - 1 }),
        pidAlive: () => true,
        now: NOW,
      }),
    ).toContain("stale");
  });

  test("三件事都成立 → null（不否决）；无记录 → null（无从交叉验证）", () => {
    expect(localServeFailure({ cache: health(), pidAlive: () => true, now: NOW })).toBeNull();
    expect(localServeFailure({ cache: null })).toBeNull();
  });
});

describe("memberKind", () => {
  test("agent_session.harness=codex/codex-sdk → codex", () => {
    expect(memberKind(p({ name: "c", agent_session: { harness: "codex", session_id: "s1", updated_at: NOW } }))).toBe("codex");
    expect(memberKind(p({ name: "c", agent_session: { harness: "codex-sdk", session_id: "s2", updated_at: NOW } }))).toBe("codex");
  });

  test("默认 → channel-member", () => {
    expect(memberKind(p({ name: "a" }))).toBe("channel-member");
  });
});

function discovery(over: Partial<RuntimePeerDiscovery> = {}): RuntimePeerDiscovery {
  return {
    version: 3,
    topology_evidence: "client_asserted",
    comparison: "server_derived",
    caller_binding: "live_socket",
    self: "me",
    peers: [],
    ...over,
  };
}

describe("buildAgentRows", () => {
  test("成员 + 本机 claude 会话（有 candidate_ref）→ local-direct，CHANNEL=(bridge)；排序 online 在前", () => {
    const rows = buildAgentRows(
      "pwtk",
      [p({ name: "bot", live: true, wake: { kind: "serve" } })],
      NOW,
      {
        discovery: discovery({
          peers: [{
            agent: "peer",
            same_identity: false,
            relations: [{ relation: "same_workspace", runtime_count: 1 }],
            claude_sessions: [
              { display_name: "design-review-x7", relation: "same_workspace", runtime_count: 1, candidate_ref: "candidate_abcdefghijklmnop" },
              { display_name: "dup-session", relation: "same_workspace", runtime_count: 2, candidate_ref: null },
            ],
          }],
        }),
      },
    );
    expect(rows.map((r) => [r.name, r.kind, r.reach, r.channel])).toEqual([
      ["bot", "channel-member", "online(serve)", "pwtk"],
      ["design-review-x7", "claude-session", "local-direct", "(bridge)"],
      ["dup-session", "claude-session", "stale", "(bridge)"],
    ]);
    expect(rows[2]!.reach_reason).toContain("not uniquely addressable");
  });

  test("本机 health 交叉验证只否决自己（discovery.self），不否决别人的 runner", () => {
    const presence = [
      p({ name: "me", live: true, wake: { kind: "serve" } }),
      p({ name: "other", live: true, wake: { kind: "serve" } }),
    ];
    const rows = buildAgentRows("pwtk", presence, NOW, {
      discovery: discovery({ self: "me" }),
      localHealth: { cache: health(), pidAlive: () => false, now: NOW },
    });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.get("me")!.reach).toBe("stale"); // 杀掉 runner 不解注册 → 必须离开 online
    expect(byName.get("other")!.reach).toBe("online(serve)");
  });

  test("human / system / 幽灵不列；游标落后如实带出 behind 但不否决 online", () => {
    const presence = [
      p({ name: "system" }),
      p({ name: "alice", kind: "human", live: true }),
      p({ name: "ghost", state: "offline", last_seen: NOW - 15 * 24 * 60 * 60 * 1000 }),
      p({ name: "bot", live: true, wake: { kind: "serve" } }),
    ];
    const rows = buildAgentRows("pwtk", presence, NOW, {
      cursorOf: new Map([["bot", 7]]),
      lastSeq: 10,
    });
    expect(rows.map((r) => r.name)).toEqual(["bot"]);
    expect(rows[0]!.reach).toBe("online(serve)");
    expect(rows[0]!.read_seq).toBe(7);
    expect(rows[0]!.behind).toBe(3);
  });
});

describe("renderAgentTable", () => {
  test("表头 + 对齐列 + stale 原因内联", () => {
    const lines = renderAgentTable([
      { name: "bot", kind: "channel-member", reach: "online(serve)", channel: "pwtk", age_ms: 0 },
      { name: "dead", kind: "channel-member", reach: "stale", channel: "pwtk", reach_reason: "runner failing x3", age_ms: 0 },
    ]);
    expect(lines[0]).toMatch(/^NAME\s+KIND\s+REACH\s+CHANNEL$/);
    expect(lines[1]).toContain("online(serve)");
    expect(lines[2]).toContain("stale");
    expect(lines[2]).toContain("· runner failing x3");
  });
});
