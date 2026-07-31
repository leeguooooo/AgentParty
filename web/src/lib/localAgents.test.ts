// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { describe, expect, test } from "bun:test";
import type { DesktopAgentConfig, DesktopAgentStatus, DesktopDutyEntry } from "./desktopAgent";
import {
  aggregateLocalAgents,
  channelOfInstanceId,
  configIdOfInstanceId,
  filterLocalAgents,
  groupLocalAgentsByChannel,
} from "./localAgents";

function instance(over: Partial<DesktopAgentStatus>): DesktopAgentStatus {
  return {
    state: "running",
    pid: null,
    configId: "cfg",
    name: "planner",
    channel: "ops",
    runner: "codex",
    startedAt: null,
    exitCode: null,
    lastError: null,
    instanceId: "cfg:ops",
    workdir: null,
    repo: null,
    ...over,
  };
}

function duty(over: Partial<DesktopDutyEntry>): DesktopDutyEntry {
  return { label: "l", instanceId: "cfg:ops", plistPath: "/p", logPath: "/log", loaded: true, ...over };
}

function config(over: Partial<DesktopAgentConfig>): DesktopAgentConfig {
  return {
    configId: "cfg",
    name: "planner",
    serverOrigin: "https://agentparty.test",
    channel: "ops",
    kind: "agent",
    role: "worker",
    ...over,
  };
}

describe("channelOfInstanceId / configIdOfInstanceId", () => {
  test("splits at first colon", () => {
    expect(channelOfInstanceId("abc123:guessadmin")).toBe("guessadmin");
    expect(configIdOfInstanceId("abc123:guessadmin")).toBe("abc123");
  });
  test("no colon → channel unknown, whole is configId", () => {
    expect(channelOfInstanceId("abc123")).toBe("");
    expect(configIdOfInstanceId("abc123")).toBe("abc123");
  });
});

describe("aggregateLocalAgents", () => {
  test("merges instances and duties into unified rows with parsed channels", () => {
    const rows = aggregateLocalAgents(
      [instance({ name: "planner", channel: "ops", runner: "codex", state: "running", instanceId: "cfg:ops" })],
      [duty({ instanceId: "cfg2:bug001", loaded: true })],
      [config({
        configId: "cfg2",
        name: "release-bot",
        channel: "bug001",
        owner: "lark:on_luis",
        ownerDisplayName: "Luis",
      })],
    );
    expect(rows).toHaveLength(2);
    const inst = rows.find((r) => r.kind === "instance")!;
    expect(inst).toMatchObject({ channel: "ops", name: "planner", runner: "codex", state: "running" });
    const dty = rows.find((r) => r.kind === "duty")!;
    expect(dty).toMatchObject({
      channel: "bug001",
      name: "release-bot",
      configId: "cfg2",
      state: "loaded",
      runner: null,
      owner: "lark:on_luis",
      ownerLabel: "Luis",
    });
  });

  test("uses readable owner profile and never promotes an opaque account id", () => {
    const [readable] = aggregateLocalAgents(
      [],
      [duty({ instanceId: "cfg:ops" })],
      [config({ owner: "lark:on_luis", ownerHandle: "luis", ownerDisplayName: "Luis" })],
    );
    expect(readable).toMatchObject({ owner: "lark:on_luis", ownerLabel: "Luis" });

    const [opaque] = aggregateLocalAgents(
      [],
      [duty({ instanceId: "cfg:ops" })],
      [config({ owner: "lark:on_luis", ownerHandle: null, ownerDisplayName: null })],
    );
    expect(opaque).toMatchObject({ owner: "lark:on_luis", ownerLabel: null });
  });

  test("missing config never promotes an opaque config hash into the agent name", () => {
    const [row] = aggregateLocalAgents([], [duty({ instanceId: "opaque-hash:ops" })]);
    expect(row).toMatchObject({ name: null, configId: "opaque-hash" });
  });

  test("unloaded duty reports state 'unloaded'; null channel + null instanceId → empty", () => {
    const rows = aggregateLocalAgents(
      [instance({ channel: null, instanceId: null, configId: "c", name: "x" })],
      [duty({ instanceId: "c:ch", loaded: false })],
    );
    expect(rows.find((r) => r.kind === "instance")!.channel).toBe("");
    expect(rows.find((r) => r.kind === "duty")!.state).toBe("unloaded");
  });

  test("terminal-blocked duty stays abnormal even if launchd has not finished bootout", () => {
    const rows = aggregateLocalAgents(
      [],
      [duty({ instanceId: "c:ops", loaded: true, terminalBlocked: true })],
    );
    expect(rows[0]!.state).toBe("unloaded");
  });

  test("channel 为 null 但 instanceId 含 configId:channel → 从 instanceId 回退频道（#707 评审）", () => {
    const rows = aggregateLocalAgents(
      [instance({ channel: null, instanceId: "cfg:web", name: "planner" })],
      [],
    );
    // 不因 channel 字段缺失就误归「未分配」——否则频道页 scopeChannel 会过滤掉它
    expect(rows[0]!.channel).toBe("web");
  });
});

describe("filterLocalAgents", () => {
  const rows = aggregateLocalAgents(
    [
      instance({ name: "planner", channel: "ops", runner: "codex", state: "running", instanceId: "a:ops" }),
      instance({ name: "builder", channel: "web", runner: "claude", state: "failed", instanceId: "b:web" }),
    ],
    [duty({ instanceId: "c:ops", loaded: true })],
  );
  test("empty query passes all", () => {
    expect(filterLocalAgents(rows, "")).toHaveLength(3);
    expect(filterLocalAgents(rows, "   ")).toHaveLength(3);
  });
  test("matches by channel / name / runner / state, case-insensitive", () => {
    expect(filterLocalAgents(rows, "ops").map((r) => r.key).sort()).toEqual(["duty:c:ops", "instance:a:ops"]);
    expect(filterLocalAgents(rows, "PLANNER").map((r) => r.name)).toEqual(["planner"]);
    expect(filterLocalAgents(rows, "claude").map((r) => r.name)).toEqual(["builder"]);
    expect(filterLocalAgents(rows, "failed").map((r) => r.name)).toEqual(["builder"]);
  });

  test("matches by readable owner", () => {
    const owned = aggregateLocalAgents(
      [],
      [duty({ instanceId: "cfg:ops" })],
      [config({ owner: "lark:on_luis", ownerDisplayName: "Luis" })],
    );
    expect(filterLocalAgents(owned, "luis")).toHaveLength(1);
  });
});

describe("groupLocalAgentsByChannel", () => {
  test("groups by channel, sorted asc, unknown channel last; duty before instance within a group", () => {
    const rows = aggregateLocalAgents(
      [
        instance({ name: "z", channel: "web", instanceId: "z:web" }),
        instance({ name: "a", channel: "ops", instanceId: "a:ops" }),
        instance({ name: "orphan", channel: null, instanceId: null, configId: "o" }),
      ],
      [duty({ instanceId: "d:ops", loaded: true })],
    );
    const groups = groupLocalAgentsByChannel(rows);
    expect(groups.map((g) => g.channel)).toEqual(["ops", "web", ""]);
    // ops group: duty (d) before instance (a)
    expect(groups[0]!.rows.map((r) => r.kind)).toEqual(["duty", "instance"]);
  });
});
