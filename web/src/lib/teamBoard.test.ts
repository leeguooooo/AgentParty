import { describe, expect, test } from "bun:test";
import type { ChannelRoleAssignment, ChannelSquad, HostBoard, PresenceEntry, PublicDirectedDelivery, Sender, TaskRecord } from "@agentparty/shared";
import { buildTeamBoard, teamLaneOf } from "./teamBoard";

const NOW = 1_700_000_000_000;

function presence(name: string, over: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    type: "presence",
    name,
    kind: "agent",
    state: "waiting",
    ts: NOW - 1000,
    last_seen: NOW - 1000,
    live: true,
    ...over,
  } as PresenceEntry;
}
function sender(name: string, kind: Sender["kind"] = "agent", over: Partial<Sender> = {}): Sender {
  return { name, kind, ...over } as Sender;
}
function role(name: string, r: ChannelRoleAssignment["role"], over: Partial<ChannelRoleAssignment> = {}): ChannelRoleAssignment {
  return { name, role: r, responsibility: null, assigned_by: "leo", assigned_at: NOW - 5000, ...over };
}
function task(id: number, assignee: string | null, state: TaskRecord["state"], over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `task ${id}`,
    state,
    assignee: assignee ? { name: assignee, kind: "agent" } : null,
    created_at: NOW - 10_000,
    updated_at: NOW - 1000,
    ...over,
  } as TaskRecord;
}
function delivery(id: string, target: string, state: PublicDirectedDelivery["state"]): PublicDirectedDelivery {
  return { id, message_seq: 1, target_name: target, state, reply_seq: null, created_at: NOW - 2000, updated_at: NOW - 1000 };
}

describe("teamLaneOf：泳道判定顺序", () => {
  test("离线 > 受阻 > 处理中 > 等待 > 空闲", () => {
    expect(teamLaneOf(null, [], [])).toBe("offline");
    expect(teamLaneOf(presence("a", { state: "offline", busy: true }), [], [])).toBe("offline");
    expect(teamLaneOf(presence("a", { state: "working" }), [delivery("d", "a", "waiting_owner")], [])).toBe("blocked");
    expect(teamLaneOf(presence("a", { state: "waiting" }), [], [task(1, "a", "blocked")])).toBe("blocked");
    expect(teamLaneOf(presence("a", { state: "waiting", busy: true }), [], [])).toBe("working");
    expect(teamLaneOf(presence("a", { state: "waiting" }), [delivery("d", "a", "running")], [])).toBe("working");
    expect(teamLaneOf(presence("a", { state: "waiting" }), [], [task(1, "a", "needs_review")])).toBe("waiting");
    expect(teamLaneOf(presence("a", { state: "done" }), [], [])).toBe("idle");
  });
});

describe("buildTeamBoard：一张卡一份事实", () => {
  const roles = [
    role("lead", "host", { reports_to: null }),
    role("worker-a", "worker", { responsibility: "写前端", reports_to: "lead" }),
    role("ghost", "reviewer"), // 不在频道里 → 未认领
  ];
  const hostBoard = {
    hosts: [{ name: "lead", lease: "active", stale_reason: null }],
  } as unknown as HostBoard;
  const squads: ChannelSquad[] = [
    { type: "squad", channel: "c", name: "fe", title: "前端", description: null, leader: "lead", members: ["worker-a"], created_by: "leo", created_by_kind: "human", created_at: NOW, updated_at: NOW },
  ];
  const model = buildTeamBoard({
    presence: [
      presence("lead", { state: "working", current_task: 7, role: "host", role_source: "assigned" }),
      presence("worker-a", { state: "waiting", owner: "lark:on_opaque", context: { repo: "leeguooooo/AgentParty", branch: "feat/x" } }),
      presence("worker-b", { state: "waiting", role: "worker", role_source: "self" }),
      presence("leo", { kind: "human", state: "online" as never, display_name: "Leo" }),
      presence("old", { state: "offline", last_seen: NOW - 60_000 }),
    ],
    participants: [sender("lead"), sender("worker-a", "agent", { owner: "lark:on_opaque" }), sender("worker-b"), sender("leo", "human"), sender("old")],
    roles,
    tasks: [task(7, "lead", "in_progress", { title: "发版" }), task(8, "worker-a", "assigned"), task(9, "old", "done")],
    deliveries: [delivery("d1", "worker-b", "waiting_owner")],
    hostBoard,
    squads,
    now: NOW,
  });

  test("泳道与排序：受阻在前、主持靠前、离线最后", () => {
    expect(model.cards.map((c) => `${c.name}:${c.lane}`)).toEqual([
      "worker-b:blocked",
      "lead:working",
      "worker-a:waiting",
      "leo:idle",
      "old:offline",
    ]);
    expect(model.counts).toMatchObject({ blocked: 1, working: 1, waiting: 1, idle: 1, offline: 1, people: 1, agents: 4 });
  });

  test("卡上带齐角色、主持、汇报、squad、正在做什么", () => {
    const lead = model.cards.find((c) => c.name === "lead")!;
    expect(lead.role).toMatchObject({ confirmation: "confirmed", role: "host" });
    expect(lead.host).toEqual({ lease: "active", staleReason: null });
    expect(lead.doing).toMatchObject({ taskId: 7, taskTitle: "发版" });
    expect(lead.work.inProgress).toBe(1);
    expect(lead.squads).toEqual(["fe"]);

    const a = model.cards.find((c) => c.name === "worker-a")!;
    expect(a.reportsTo).toBe("lead");
    expect(a.doing).toMatchObject({ repo: "leeguooooo/AgentParty", branch: "feat/x" });
    expect(a.work.queued).toBe(1);
    expect(a.squads).toEqual(["fe"]);
  });

  test("不透明归属账号不上卡；自报角色算待确认；离线成员保留但已完成任务不计入", () => {
    expect(model.cards.find((c) => c.name === "worker-a")!.owner).toBeNull();
    expect(model.cards.find((c) => c.name === "worker-b")!.role.confirmation).toBe("unconfirmed");
    expect(model.counts.pendingClaims).toBe(1);
    expect(model.cards.find((c) => c.name === "old")!.work.tasks).toHaveLength(0);
  });

  test("角色表里指向不在频道的人 → 未认领角色条带", () => {
    expect(model.unassignedRoles).toEqual([{ role: "reviewer", responsibility: null, reportsTo: null, name: "ghost" }]);
    expect(model.counts.unassignedRoles).toBe(1);
  });

  test("#1067：同一个人的多个会话/多个账号折成一张卡，agent 不受影响", () => {
    const model = buildTeamBoard({
      presence: [
        presence("leo-a", { kind: "human", state: "online" as never, handle: "leo", display_name: "Leo", account: "lark-email:leo@x.com" } as never),
        presence("leo-b", { kind: "human", state: "offline", handle: "leo", account: "lark:on_2260" } as never),
        presence("bot-1", { owner: "leo@x.com" }),
        presence("bot-2", { owner: "leo@x.com" }),
      ],
      participants: [sender("leo-a", "human"), sender("leo-b", "human"), sender("bot-1"), sender("bot-2")],
      roles: [],
      now: NOW,
    });
    const human = model.cards.filter((c) => c.kind === "human");
    expect(human).toHaveLength(1);
    expect(human[0]!.display).toBe("Leo");
    expect(human[0]!.otherSessions).toHaveLength(1);
    expect(human[0]!.accountCount).toBe(2);
    expect(model.cards.filter((c) => c.kind === "agent").map((c) => c.name).sort()).toEqual(["bot-1", "bot-2"]);
  });

  test("#1067 回归：角色指向被折叠的次级会话时，不会被误判成「无人认领」", () => {
    const model = buildTeamBoard({
      presence: [
        presence("leo-a", { kind: "human", state: "online" as never, handle: "leo", display_name: "Leo", account: "acct-leo" } as never),
        presence("leo-b", { kind: "human", state: "offline", handle: "leo", account: "acct-leo" } as never),
      ],
      participants: [sender("leo-a", "human"), sender("leo-b", "human")],
      roles: [role("leo-b", "host", { responsibility: "主持" })],
      now: NOW,
    });
    expect(model.unassignedRoles).toEqual([]);
    expect(model.counts.unassignedRoles).toBe(0);
    expect(model.cards.filter((c) => c.kind === "human")).toHaveLength(1);
  });

  test("#1067：只差大小写的两个账号仍是两个人", () => {
    const model = buildTeamBoard({
      presence: [
        presence("a", { kind: "human", state: "online" as never, account: "Acct" } as never),
        presence("b", { kind: "human", state: "online" as never, account: "acct" } as never),
      ],
      participants: [sender("a", "human"), sender("b", "human")],
      roles: [],
      now: NOW,
    });
    expect(model.cards.filter((c) => c.kind === "human")).toHaveLength(2);
  });

  test("memberNames 限定成员全集", () => {
    const limited = buildTeamBoard({
      presence: [presence("lead"), presence("stranger")],
      participants: [sender("lead"), sender("stranger")],
      roles: [],
      memberNames: new Set(["lead"]),
      now: NOW,
    });
    expect(limited.cards.map((c) => c.name)).toEqual(["lead"]);
  });
});
