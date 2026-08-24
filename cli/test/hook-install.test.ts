// #615：hook install 的幂等合并 / 交互 lane 直报的节流与 push 端到端。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeActivityFile } from "../src/activity";
import type { DirectedDelivery, MsgFrame } from "@agentparty/shared";
import {
  mergeHookSettings,
  removeHookSettings,
  readLastPushTs,
  shouldBlockAgentPartyStop,
  shouldForceActivityPush,
  shouldPushActivity,
  PUSH_INTERVAL_MS,
  PUSH_INTERVAL_URGENT_MS,
} from "../src/commands/hook";
import { claudeHookSettingsJson } from "../src/commands/serve";
import { DeliveryRecoveryJournal, deliveryRecoveryJournalPath } from "../src/delivery-recovery-journal";
import { startRestMock, type RestMock } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");
const NOW = 1_700_000_000_000;

let home: string;
let mock: RestMock | null = null;

/**
 * 这几条会真的 spawn 外部 codex 二进制来读版本（#942）——本机 PATH 上那个 cmux shim 是个
 * 包装脚本，一次 `--version` 就要 2.6 秒，再叠上 bun 冷启动，5 秒的默认预算不够。
 * 结果的正确性与这个数无关，它只是给「确实很慢的外部进程」留出余量。
 */
const SLOW_SUBPROCESS_TIMEOUT_MS = 30_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-hook615-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  mock?.stop();
  mock = null;
});

describe("mergeHookSettings / removeHookSettings (#615)", () => {
  const ours = claudeHookSettingsJson("/usr/local/bin/party");

  test("installs into an empty file and is idempotent", () => {
    const once = mergeHookSettings(null, ours);
    const twice = mergeHookSettings(once, ours);
    expect(twice).toBe(once);
    const parsed = JSON.parse(once) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(parsed.hooks.PreToolUse![0]!.hooks[0]!.command).toContain("hook report");
    expect(parsed.hooks.Stop![0]!.hooks[0]!.command).toContain("hook stop-guard");
    expect(Object.keys(parsed.hooks).length).toBe(14);
  });

  test("preserves foreign hooks and unknown settings keys", () => {
    const existing = JSON.stringify({
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter --check" }] }],
      },
    });
    const merged = mergeHookSettings(existing, ours);
    const parsed = JSON.parse(merged) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.model).toBe("opus");
    expect(parsed.hooks.PreToolUse!.some((e) => e.hooks.some((h) => h.command === "my-linter --check"))).toBe(true);
    expect(parsed.hooks.PreToolUse!.some((e) => e.hooks.some((h) => h.command.includes("hook report")))).toBe(true);

    // uninstall 只摘我们的条目，外来 hooks 原样保留
    const removed = JSON.parse(removeHookSettings(merged)) as {
      model: string;
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(removed.model).toBe("opus");
    expect(removed.hooks?.PreToolUse!.every((e) => e.hooks.every((h) => !h.command.includes("hook report")))).toBe(true);
    expect(removed.hooks?.PreToolUse!.length).toBe(1);
    // 我们独占的事件（如 Stop）被摘空后连键一起清掉
    expect(removed.hooks?.Stop).toBeUndefined();
  });

  test("refuses to touch a broken settings file", () => {
    expect(() => mergeHookSettings("{not json", ours)).toThrow();
    expect(() => removeHookSettings("[1,2,3]")).toThrow();
    // hooks 键或某个事件值不是期望形状：拒改，绝不静默吞掉用户内容
    expect(() => mergeHookSettings(JSON.stringify({ hooks: "broken" }), ours)).toThrow();
    expect(() => mergeHookSettings(JSON.stringify({ hooks: { Stop: { not: "array" } } }), ours)).toThrow();
  });
});

describe("interactive activity boundary push (#615)", () => {
  const working = { phase: "working", ts: NOW } as const;
  const tool = { phase: "tool", tool: "Bash", ts: NOW } as const;
  const permission = { phase: "waiting_permission", tool: "Bash", ts: NOW } as const;
  const input = { phase: "waiting_input", ts: NOW } as const;
  const idle = { phase: "idle", ts: NOW } as const;

  test("immediately publishes entering/leaving a wait and ending a turn", () => {
    expect(shouldForceActivityPush(tool, permission, "PermissionRequest")).toBe(true);
    expect(shouldForceActivityPush(permission, working, "PostToolUse")).toBe(true);
    expect(shouldForceActivityPush(working, input, "Elicitation")).toBe(true);
    expect(shouldForceActivityPush(input, working, "ElicitationResult")).toBe(true);
    expect(shouldForceActivityPush(working, idle, "Stop")).toBe(true);
  });

  test("keeps repeated waits and ordinary tool churn throttled, but failures bypass it", () => {
    expect(shouldForceActivityPush(permission, permission, "Notification")).toBe(false);
    expect(shouldForceActivityPush(working, tool, "PreToolUse")).toBe(false);
    expect(shouldForceActivityPush(tool, working, "PostToolUse")).toBe(false);
    expect(shouldForceActivityPush(tool, working, "PostToolUseFailure")).toBe(true);
    expect(shouldForceActivityPush(working, idle, "StopFailure")).toBe(true);
  });
});

describe("AgentParty Stop guard", () => {
  test("blocks one top-level stop only for work already issued to or accepted by Claude", () => {
    const firstStop = { hook_event_name: "Stop", stop_hook_active: false, agent_id: null };
    expect(shouldBlockAgentPartyStop(firstStop, [{ phase: "harness_issued" }], true)).toBe(true);
    expect(shouldBlockAgentPartyStop(firstStop, [{ phase: "harness_accepted" }], true)).toBe(true);
    for (const phase of ["claimed", "running_authorized", "reply_posted", "waiting_owner", "failed_pending"] as const) {
      expect(shouldBlockAgentPartyStop(firstStop, [{ phase }], true)).toBe(false);
    }
  });

  test("allows ordinary sessions, the continuation stop, subagent stops, and sessions without pending work", () => {
    expect(shouldBlockAgentPartyStop(
      { hook_event_name: "Stop", stop_hook_active: false },
      [{ phase: "harness_accepted" }],
      false,
    )).toBe(false);
    expect(shouldBlockAgentPartyStop(
      { hook_event_name: "Stop", stop_hook_active: true },
      [{ phase: "harness_accepted" }],
      true,
    )).toBe(false);
    expect(shouldBlockAgentPartyStop(
      { hook_event_name: "Stop", stop_hook_active: false, agent_id: "subagent" },
      [{ phase: "harness_accepted" }],
      true,
    )).toBe(false);
    expect(shouldBlockAgentPartyStop(
      { hook_event_name: "Stop", stop_hook_active: false },
      [],
      true,
    )).toBe(false);
  });

  test("emits one structured Stop decision from the private durable journal", async () => {
    const server = "https://agentparty.example";
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      server,
      token: "ap_stop_guard",
      identity: {
        name: "mini",
        email: null,
        kind: "agent",
        role: "agent",
        owner: "o",
        channel_scope: null,
        verified_at: NOW,
      },
    }));
    const previousHome = process.env.AGENTPARTY_HOME;
    process.env.AGENTPARTY_HOME = home;
    try {
      const now = Date.now();
      const delivery: DirectedDelivery = {
        id: "delivery-stop-guard",
        message_seq: 41,
        target_name: "mini",
        cause: "mention",
        state: "claimed",
        attempt: 1,
        lease_epoch: 1,
        lease_token: "lease-token",
        lease_until: now + 90_000,
        work_id: "work-stop-guard",
        continuation_ref: "continuation-stop-guard",
        reply_seq: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      };
      const message: MsgFrame = {
        type: "msg",
        seq: 41,
        sender: { name: "owner", kind: "human" },
        kind: "message",
        body: "@mini finish the linked reply",
        mentions: ["mini"],
        reply_to: null,
        state: null,
        note: null,
        status: null,
        ts: now,
      };
      const journal = new DeliveryRecoveryJournal(
        deliveryRecoveryJournalPath("claude", server, "ap_stop_guard", "dev"),
        "dev",
        "claude",
      );
      journal.recordClaim(delivery, message);
      journal.update(delivery.id, { phase: "harness_issued" });
    } finally {
      if (previousHome === undefined) delete process.env.AGENTPARTY_HOME;
      else process.env.AGENTPARTY_HOME = previousHome;
    }

    const runGuard = async (stopHookActive: boolean, lifecycleOptedIn: boolean) => {
      const proc = Bun.spawn(["bun", "run", indexPath, "hook", "stop-guard"], {
        env: {
          ...process.env,
          AGENTPARTY_HOME: home,
          AGENTPARTY_CHANNEL: "dev",
          AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: lifecycleOptedIn ? "1" : undefined,
          AGENTPARTY_CONFIG: undefined,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(JSON.stringify({
        session_id: "stop-guard-session",
        hook_event_name: "Stop",
        stop_hook_active: stopHookActive,
        cwd: process.cwd(),
      }));
      proc.stdin.end();
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };

    const stopActivityFile = join(home, "state", "activity", "stop-guard-session.json");
    mkdirSync(join(home, "state", "activity"), { recursive: true });
    const throttledMarkerTs = Date.now();
    writeFileSync(`${stopActivityFile}.push.json`, JSON.stringify({ last_push_ts: throttledMarkerTs }));
    await Bun.sleep(5);

    const first = await runGuard(false, true);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    expect(JSON.parse(first.stdout)).toMatchObject({ decision: "block" });
    expect(first.stdout).not.toContain("ap_stop_guard");
    expect(first.stdout).not.toContain("finish the linked reply");
    expect(JSON.parse(readFileSync(stopActivityFile, "utf8"))).toMatchObject({ phase: "working" });
    expect(JSON.parse(readFileSync(`${stopActivityFile}.push.json`, "utf8")))
      .toMatchObject({ last_push_ts: expect.any(Number) });
    expect((JSON.parse(readFileSync(`${stopActivityFile}.push.json`, "utf8")) as { last_push_ts: number }).last_push_ts)
      .toBeGreaterThan(throttledMarkerTs);

    const ordinarySession = await runGuard(false, false);
    expect(ordinarySession).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(JSON.parse(readFileSync(stopActivityFile, "utf8"))).toMatchObject({ phase: "idle" });

    const continuation = await runGuard(true, true);
    expect(continuation).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(JSON.parse(readFileSync(stopActivityFile, "utf8"))).toMatchObject({ phase: "idle" });
  });
});

describe("shouldPushActivity (#615)", () => {
  test("15s throttle for ordinary phases, 3s for waiting_permission, always on first push", () => {
    const tool = { phase: "tool" as const, tool: "Bash", ts: NOW };
    const perm = { phase: "waiting_permission" as const, ts: NOW };
    expect(shouldPushActivity(tool, null, NOW)).toBe(true);
    expect(shouldPushActivity(tool, NOW - PUSH_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(shouldPushActivity(tool, NOW - PUSH_INTERVAL_MS, NOW)).toBe(true);
    expect(shouldPushActivity(perm, NOW - PUSH_INTERVAL_URGENT_MS + 1, NOW)).toBe(false);
    expect(shouldPushActivity(perm, NOW - PUSH_INTERVAL_URGENT_MS, NOW)).toBe(true);
    // 未来标记（时钟回跳残留）视为无效：立即放行，而不是永久静默到时钟追上
    expect(shouldPushActivity(tool, NOW + 60_000, NOW)).toBe(true);
  });

  test("waiting_input 与 waiting_permission 同级紧急档（#617 评审 follow-up）", () => {
    const input = { phase: "waiting_input" as const, ts: NOW };
    expect(shouldPushActivity(input, NOW - PUSH_INTERVAL_URGENT_MS + 1, NOW)).toBe(false);
    expect(shouldPushActivity(input, NOW - PUSH_INTERVAL_URGENT_MS, NOW)).toBe(true);
  });

  test("a failed detached attempt releases only its own throttle marker", () => {
    const activityFile = join(home, "activity-marker.json");
    const currentAttempt = "11111111-1111-4111-8111-111111111111";
    const olderAttempt = "22222222-2222-4222-8222-222222222222";
    writeFileSync(`${activityFile}.push.json`, JSON.stringify({
      last_push_ts: NOW,
      attempt_id: currentAttempt,
    }));
    writeFileSync(`${activityFile}.push.failed.json`, JSON.stringify({ attempt_id: olderAttempt }));
    expect(readLastPushTs(activityFile)).toBe(NOW);
    writeFileSync(`${activityFile}.push.failed.json`, JSON.stringify({ attempt_id: currentAttempt }));
    expect(readLastPushTs(activityFile)).toBeNull();
  });
});

describe("party hook install end-to-end (project scope)", () => {
  test("install writes .claude/settings.local.json in cwd; status/uninstall round-trip", async () => {
    const project = mkdtempSync(join(tmpdir(), "ap-hook-proj-"));
    const runIn = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", "run", indexPath, "hook", ...args], {
        cwd: project,
        env: { ...process.env, AGENTPARTY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      return { code, stdout };
    };

    // #904 之后 status 不带 scope 会两档都报；这条是 project 档的往返，显式限定作用域。
    expect((await runIn("status", "--project")).code).toBe(1); // 未装
    expect((await runIn("install")).code).toBe(0);
    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(settings.hooks).length).toBe(14);
    const status = await runIn("status", "--project");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("installed");
    const installAgain = await runIn("install");
    expect(installAgain.stdout).toContain("普通 Claude session 只写本地 activity");
    expect(installAgain.stdout).toContain("party claude");
    expect(installAgain.stdout).not.toContain("任何在此生效范围内");
    expect((await runIn("uninstall")).code).toBe(0);
    expect((await runIn("status", "--project")).code).toBe(1);
    rmSync(project, { recursive: true, force: true });
  });
});

describe("party hook install --codex (#851 P2)", () => {
  // 本机 ~/.codex/hooks.json 的真实形状（otty / vibe-island / superset 三方共存），
  // 结构原样保留、内容缩短。#864 事故的同类错误绝不许再犯：安装必须只增自己那条。
  const REAL_WORLD_CODEX_HOOKS = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "SUPERSET_AGENT_ID=codex \"/Users/x/.superset/hooks/notify.sh\"" }] },
        { _otty: true, hooks: [{ type: "command", command: "'/Applications/Otty.app/.../otty-hook.sh' idle \"$PPID\"" }] },
      ],
      PostToolUse: [
        { matcher: "", hooks: [{ type: "command", command: "'/Users/x/.vibe-island/bin/vibe-island-bridge' --source codex", timeout: 5 }] },
      ],
    },
  };

  async function runCodex(fakeHome: string, ...args: string[]) {
    const proc = Bun.spawn(["bun", "run", indexPath, "hook", ...args, "--codex"], {
      cwd: fakeHome,
      env: { ...process.env, HOME: fakeHome, AGENTPARTY_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test("装进 ~/.codex/hooks.json，既有第三方 hooks 一条不少；status/uninstall 往返", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-codexhome-"));
    const hooksPath = join(fakeHome, ".codex", "hooks.json");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const before = JSON.stringify(REAL_WORLD_CODEX_HOOKS, null, 2);
    writeFileSync(hooksPath, before);

    expect((await runCodex(fakeHome, "status")).code).toBe(1);
    const installed = await runCodex(fakeHome, "install");
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain("codex-sessions");

    const after = JSON.parse(readFileSync(hooksPath, "utf8")) as typeof REAL_WORLD_CODEX_HOOKS;
    // 别人的条目逐字保留（含 _otty 私有字段、matcher、timeout）。
    expect(after.hooks.PostToolUse).toEqual(REAL_WORLD_CODEX_HOOKS.hooks.PostToolUse);
    expect(after.hooks.SessionStart.slice(0, 2)).toEqual(REAL_WORLD_CODEX_HOOKS.hooks.SessionStart);
    // 只多了我们这一条。
    expect(after.hooks.SessionStart).toHaveLength(3);
    expect(JSON.stringify(after.hooks.SessionStart[2])).toContain("hook codex-report");
    // 写前备份留在旁边，人工可回退（#864）。
    expect(readFileSync(`${hooksPath}.agentparty.bak`, "utf8")).toBe(before);

    // 幂等：再装一次不重复追加。
    expect((await runCodex(fakeHome, "install")).code).toBe(0);
    expect((JSON.parse(readFileSync(hooksPath, "utf8")) as typeof REAL_WORLD_CODEX_HOOKS)
      .hooks.SessionStart).toHaveLength(3);

    expect((await runCodex(fakeHome, "status")).code).toBe(0);
    expect((await runCodex(fakeHome, "uninstall")).code).toBe(0);
    // 卸载后恢复成用户原样。
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual(REAL_WORLD_CODEX_HOOKS);
    expect((await runCodex(fakeHome, "status")).code).toBe(1);
    rmSync(fakeHome, { recursive: true, force: true });
    // 收尾清单现在会去读一次外部 codex 的版本（#942），这条也要多给点预算。
  }, SLOW_SUBPROCESS_TIMEOUT_MS);

  // #942：codex 的信任键是**位置式**的（`<hooks.json>:<event>:<组下标>:<条下标>`）。
  // 「先删后追加」会把我们的条目换到另一个下标 —— 它顶着邻居的信任行跑，邻居顶着我们的。
  // 真机实测过一次：重装之后 Stop hook 从 2:0 挪到 3:0，直接继承了 vibe-island 那行的信任状态。
  test("重装不许挪动我们条目的下标（信任键是位置式的）", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-codexpos-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const hooksPath = join(fakeHome, ".codex", "hooks.json");
    writeFileSync(hooksPath, JSON.stringify(REAL_WORLD_CODEX_HOOKS, null, 2));
    expect((await runCodex(fakeHome, "install")).code).toBe(0);

    const read = () =>
      (JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: Record<string, { hooks?: { command?: string }[] }[]>;
      }).hooks.SessionStart.map((g) => g.hooks?.[0]?.command ?? "");
    const first = read();
    const ourIndex = first.findIndex((c) => c.includes("hook codex-report"));
    expect(ourIndex).toBeGreaterThanOrEqual(0);

    // 命令本体变了（换了一个 party 路径）也必须原地替换，不许挪位——恰恰是这种情况才会重装。
    const moved = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>;
    };
    moved.hooks.SessionStart[ourIndex]!.hooks![0]!.command = "/some/other/path/party hook codex-report";
    writeFileSync(hooksPath, JSON.stringify(moved, null, 2));

    expect((await runCodex(fakeHome, "install")).code).toBe(0);
    const second = read();
    expect(second.findIndex((c) => c.includes("hook codex-report"))).toBe(ourIndex);
    // 邻居们的相对顺序一个都没变。
    expect(second.filter((c) => !c.includes("hook codex-report")))
      .toEqual(first.filter((c) => !c.includes("hook codex-report")));
    rmSync(fakeHome, { recursive: true, force: true });
  }, SLOW_SUBPROCESS_TIMEOUT_MS);

  // #942 第二轮：codex 那边**没有批准入口**了（启动 review 只对「新的或改动过的」hook 发问，
  // 带 trusted_hash 且 enabled=false 的它再也不会问；桌面版连界面都没有）。所以批准由我们收集。
  // 这一组用真进程 + 临时 CODEX_HOME 跑完整条路，fixture 照抄 owner 那台的四方共存形状。
  describe("信任开关：只翻我们自己那两条，且必须有确认（#942）", () => {
    /** 装完之后按**现状**算键——install 会把我们那条重新追加，下标会变，写死下标必然出事。 */
    function seedTrustTable(fakeHome: string, enabled: boolean): string {
      const hooksPath = join(fakeHome, ".codex", "hooks.json");
      const parsed = JSON.parse(readFileSync(hooksPath, "utf8")) as {
        hooks: Record<string, { hooks?: { command?: string }[] }[]>;
      };
      const lines = ["# 用户自己的配置", 'model = "x"   # 行内注释必须原样保留', "", "[hooks.state]"];
      const keys: string[] = [];
      for (const [event, groups] of Object.entries(parsed.hooks)) {
        const snake = event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
        groups.forEach((group, g) => {
          (group.hooks ?? []).forEach((_entry, h) => {
            const key = `${hooksPath}:${snake}:${String(g)}:${String(h)}`;
            keys.push(key);
            lines.push("", `[hooks.state."${key}"]`, `trusted_hash = "sha256:${String(keys.length)}"`,
              `enabled = ${String(enabled)}`);
          });
        });
      }
      lines.push("");
      const configPath = join(fakeHome, ".codex", "config.toml");
      writeFileSync(configPath, lines.join("\n"));
      return configPath;
    }

    function trustRows(configPath: string): Record<string, { enabled?: boolean }> {
      const parsed = Bun.TOML.parse(readFileSync(configPath, "utf8")) as {
        hooks?: { state?: Record<string, { enabled?: boolean }> };
      };
      return parsed.hooks?.state ?? {};
    }

    async function prepared(): Promise<{ fakeHome: string; configPath: string }> {
      const fakeHome = mkdtempSync(join(tmpdir(), "ap-codextrust-"));
      mkdirSync(join(fakeHome, ".codex"), { recursive: true });
      // 先放上三方 hooks，再装我们的——这样下标分布与真机一致（别人在前，我们被追加在后）。
      writeFileSync(join(fakeHome, ".codex", "hooks.json"), JSON.stringify(REAL_WORLD_CODEX_HOOKS, null, 2));
      expect((await runCodex(fakeHome, "install")).code).toBe(0);
      const configPath = seedTrustTable(fakeHome, false);
      return { fakeHome, configPath };
    }

    test("--yes ⇒ 只把我们那两条翻成 true，别人的一条不动，文件其余部分逐字节保留", async () => {
      const { fakeHome, configPath } = await prepared();
      const before = readFileSync(configPath, "utf8");
      const r = await runCodex(fakeHome, "install", "--yes");
      expect(r.code).toBe(0);

      const rows = trustRows(configPath);
      const ours = Object.keys(rows).filter((k) => k.includes(":stop:") || k.includes(":session_start:"));
      expect(ours.length).toBeGreaterThan(0);
      const enabled = Object.entries(rows).filter(([, v]) => v.enabled === true).map(([k]) => k);
      // 恰好两条：codex-stop 与 codex-report。别人的三方 hook 一条都不许被翻。
      expect(enabled.length).toBe(2);
      const hooksJson = readFileSync(join(fakeHome, ".codex", "hooks.json"), "utf8");
      expect(hooksJson).toContain("hook codex-stop");
      for (const key of enabled) {
        const idx = key.split(":").slice(-2).join(":");
        expect(["stop", "session_start"].some((e) => key.includes(`:${e}:`))).toBe(true);
        expect(idx).toMatch(/^\d+:\d+$/);
      }
      // 改动只有那两行；注释与顺序原样。
      const after = readFileSync(configPath, "utf8");
      const diff = after.split("\n").map((l, i) => (l === before.split("\n")[i] ? null : i)).filter((i) => i !== null);
      expect(diff.length).toBe(2);
      expect(after).toContain('model = "x"   # 行内注释必须原样保留');
      // 可回滚：原文件留在旁边。
      expect(readFileSync(`${configPath}.agentparty.bak`, "utf8")).toBe(before);
      rmSync(fakeHome, { recursive: true, force: true });
    }, SLOW_SUBPROCESS_TIMEOUT_MS);

    // 单闸对照：**只去掉 --yes** 这一个变量。非 TTY 下沉默绝不等于同意。
    test("不给 --yes 且非交互 ⇒ 一个字都不写，并把要粘的 TOML 原样打出来", async () => {
      const { fakeHome, configPath } = await prepared();
      const before = readFileSync(configPath, "utf8");
      const r = await runCodex(fakeHome, "install");
      expect(r.code).toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(Object.values(trustRows(configPath)).every((v) => v.enabled === false)).toBe(true);
      // 底线交付：没写就必须给得出「粘这个」。
      expect(r.stdout).toContain("enabled = true");
      expect(r.stdout).toContain("trusted_hash");
      expect(r.stdout).toContain("--yes");
      // 绝不把绕过闸的旗标摆到用户面前。
      expect(r.stdout).not.toContain("dangerously-bypass");
      rmSync(fakeHome, { recursive: true, force: true });
    }, SLOW_SUBPROCESS_TIMEOUT_MS);

    test("已经全是 true ⇒ 什么都不问、什么都不写", async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "ap-codextrust-ok-"));
      mkdirSync(join(fakeHome, ".codex"), { recursive: true });
      writeFileSync(join(fakeHome, ".codex", "hooks.json"), JSON.stringify(REAL_WORLD_CODEX_HOOKS, null, 2));
      expect((await runCodex(fakeHome, "install")).code).toBe(0);
      const configPath = seedTrustTable(fakeHome, true);
      const before = readFileSync(configPath, "utf8");
      const r = await runCodex(fakeHome, "install", "--yes");
      expect(r.code).toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(before);
      expect(r.stdout).not.toContain("已写入");
      rmSync(fakeHome, { recursive: true, force: true });
    }, SLOW_SUBPROCESS_TIMEOUT_MS);
  });

  // #904：装好了 codex hook，`party hook status` 却报 not installed——它只看 claude 那一档，
  // 给出与事实相反的结论，实测中把一轮排查引向了「hook 没装」这条错路。
  test("status 不带 scope 时两档都报，codex 档装了就必须报 installed（#904）", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-codexstatus-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", "run", indexPath, "hook", ...args], {
        cwd: fakeHome,
        env: { ...process.env, HOME: fakeHome, AGENTPARTY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      return { code, stdout };
    };

    const none = await run("status");
    expect(none.code).toBe(1);
    // 两档都报，各自打印自己实际检查的文件路径。
    expect(none.stdout).toContain("project scope:");
    expect(none.stdout).toContain(join(fakeHome, ".codex", "hooks.json"));
    expect(none.stdout).toContain("两档都没装");

    expect((await run("install", "--codex")).code).toBe(0);
    const after = await run("status");
    expect(after.code).toBe(0);
    // codex 那行必须是 installed，并列出实际检出的事件（SessionStart + Stop）。
    const codexLine = after.stdout.split("\n").find((line) => line.includes("codex scope:"))!;
    expect(codexLine).toContain("installed —");
    expect(codexLine).not.toContain("not installed");
    expect(codexLine).toContain("SessionStart");
    expect(codexLine).toContain("Stop");
    // claude 那档没装，仍然如实说没装——两档要能区分。
    expect(after.stdout.split("\n").find((line) => line.includes("project scope:"))).toContain("not installed");
    rmSync(fakeHome, { recursive: true, force: true });
    // install --codex 的收尾清单现在会去读一次外部 codex 的版本（#942），预算要放宽。
  }, SLOW_SUBPROCESS_TIMEOUT_MS);

  test("hooks.json 解析失败即中止不写——绝不覆盖看不懂的用户内容（#864）", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-codexhome-bad-"));
    const hooksPath = join(fakeHome, ".codex", "hooks.json");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    const broken = '{ "hooks": { "SessionStart": [ }';
    writeFileSync(hooksPath, broken);
    const result = await runCodex(fakeHome, "install");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("请先手工修复该文件");
    // 原文件一个字节都没动，也没留备份（根本没走到写）。
    expect(readFileSync(hooksPath, "utf8")).toBe(broken);
    expect(existsSync(`${hooksPath}.agentparty.bak`)).toBe(false);
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("hooks 键写坏成数组时同样拒写", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ap-codexhome-arr-"));
    const hooksPath = join(fakeHome, ".codex", "hooks.json");
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(hooksPath, '{"hooks": ["oops"]}');
    expect((await runCodex(fakeHome, "install")).code).toBe(1);
    expect(readFileSync(hooksPath, "utf8")).toBe('{"hooks": ["oops"]}');
    rmSync(fakeHome, { recursive: true, force: true });
  });
});

describe("party hook push end-to-end (#615)", () => {
  function writeCfg(server: string) {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        server,
        token: "ap_tok",
        identity: { name: "mini", email: null, kind: "agent", role: "agent", owner: "o", channel_scope: null, verified_at: NOW },
      }),
    );
  }

  async function runPush(file: string): Promise<number> {
    const proc = Bun.spawn(["bun", "run", indexPath, "hook", "push", file, "--channel", "dev"], {
      env: { ...process.env, AGENTPARTY_HOME: home, AGENTPARTY_CONFIG: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exited;
  }

  async function runReport(
    sessionId: string,
    lifecycleOptedIn: boolean,
    hookEventName = "PreToolUse",
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }> {
    const proc = Bun.spawn(["bun", "run", indexPath, "hook", "report"], {
      env: {
        ...process.env,
        AGENTPARTY_HOME: home,
        AGENTPARTY_CONFIG: undefined,
        AGENTPARTY_CHANNEL: "dev",
        AGENTPARTY_CLAUDE_CHANNEL_OPT_IN: undefined,
        AGENTPARTY_CLAUDE_LIFECYCLE_OPT_IN: lifecycleOptedIn ? "1" : undefined,
        AP_ACTIVITY_FILE: undefined,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({
      session_id: sessionId,
      hook_event_name: hookEventName,
      tool_name: "Bash",
      cwd: process.cwd(),
    }));
    proc.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test("ordinary plugin sessions stay local while an AgentParty-launched session publishes activity", async () => {
    let meCalls = 0;
    let posts = 0;
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") {
        meCalls += 1;
        return Response.json({
          name: "mini",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "o",
          channel_scope: "dev",
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/presence/mini/activity") {
        posts += 1;
        return Response.json({ ok: true, attached: true });
      }
      return undefined;
    });
    writeCfg(mock.url);

    expect(await runReport("ordinary-plugin-session", false)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    await Bun.sleep(250);
    expect(meCalls).toBe(0);
    expect(posts).toBe(0);
    expect(JSON.parse(readFileSync(
      join(home, "state", "activity", "ordinary-plugin-session.json"),
      "utf8",
    ))).toMatchObject({ phase: "tool", tool: "Bash" });

    expect(await runReport("agentparty-launched-session", true)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const deadline = Date.now() + 2_000;
    while (posts === 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(meCalls).toBe(1);
    expect(posts).toBe(1);
  });

  test("publishes a permission wait immediately, throttles repeats, and immediately clears the wait", async () => {
    const activities: Array<Record<string, unknown>> = [];
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") {
        return Response.json({
          name: "mini",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "o",
          channel_scope: "dev",
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/presence/mini/activity") {
        activities.push((req.body as { activity: Record<string, unknown> }).activity);
        return Response.json({ ok: true, attached: true });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const sessionId = "permission-boundary";

    expect((await runReport(sessionId, true, "PreToolUse")).code).toBe(0);
    let deadline = Date.now() + 2_000;
    while (activities.length < 1 && Date.now() < deadline) await Bun.sleep(25);

    // Still inside the ordinary 15-second window. Entering the wait must not
    // be hidden behind the immediately preceding PreToolUse push.
    expect((await runReport(sessionId, true, "PermissionRequest")).code).toBe(0);
    deadline = Date.now() + 2_000;
    while (activities.length < 2 && Date.now() < deadline) await Bun.sleep(25);
    expect(activities.map((activity) => activity.phase)).toEqual(["tool", "waiting_permission"]);

    // The same wait notification is noise, not another state boundary.
    expect((await runReport(sessionId, true, "PermissionRequest")).code).toBe(0);
    await Bun.sleep(250);
    expect(activities).toHaveLength(2);

    expect((await runReport(sessionId, true, "PostToolUse")).code).toBe(0);
    deadline = Date.now() + 2_000;
    while (activities.length < 3 && Date.now() < deadline) await Bun.sleep(25);
    expect(activities.at(-1)?.phase).toBe("working");
  });

  test("a failed detached publish releases the throttle so the next Hook retries immediately", async () => {
    let posts = 0;
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") {
        return Response.json({
          name: "mini",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "o",
          channel_scope: "dev",
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/presence/mini/activity") {
        posts += 1;
        return posts === 1
          ? Response.json({ error: "temporary" }, { status: 503 })
          : Response.json({ ok: true, attached: true });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const sessionId = "retry-after-failed-push";
    const activityFile = join(home, "state", "activity", `${sessionId}.json`);

    expect((await runReport(sessionId, true)).code).toBe(0);
    const failureDeadline = Date.now() + 2_000;
    while (readLastPushTs(activityFile) !== null && Date.now() < failureDeadline) {
      await Bun.sleep(25);
    }
    expect(posts).toBe(1);
    expect(readLastPushTs(activityFile)).toBeNull();

    // Still inside the ordinary 15-second window. This second POST proves the
    // failed attempt released its own optimistic throttle immediately.
    expect((await runReport(sessionId, true)).code).toBe(0);
    const successDeadline = Date.now() + 2_000;
    while (posts < 2 && Date.now() < successDeadline) await Bun.sleep(25);
    expect(posts).toBe(2);
    expect(readLastPushTs(activityFile)).not.toBeNull();
  });

  test("posts the activity to the presence activity endpoint", async () => {
    let captured: unknown = null;
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") {
        return Response.json({
          name: "mini",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "o",
          channel_scope: null,
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/presence/mini/activity") {
        captured = req.body;
        return Response.json({ ok: true, attached: true });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const file = join(home, "activity.json");
    writeActivityFile(file, { phase: "waiting_permission", tool: "Bash", ts: Date.now() });

    expect(await runPush(file)).toBe(0);
    expect(captured).toMatchObject({ activity: { phase: "waiting_permission", tool: "Bash" } });
  });

  test("uses the bearer identity instead of a stale local config name", async () => {
    const postedPaths: string[] = [];
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") {
        return Response.json({
          name: "server-agent",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "o",
          channel_scope: "dev",
        });
      }
      if (req.method === "POST" && req.path.endsWith("/activity")) {
        postedPaths.push(req.path);
        return Response.json({ ok: true, attached: true });
      }
      return undefined;
    });
    writeCfg(mock.url); // local cached name is "mini"
    const file = join(home, "activity.json");
    writeActivityFile(file, { phase: "working", ts: Date.now() });

    expect(await runPush(file)).toBe(0);
    expect(postedPaths).toEqual(["/api/channels/dev/presence/server-agent/activity"]);
  });

  test("retries briefly when SessionStart arrives before Channel presence", async () => {
    let posts = 0;
    mock = startRestMock((req) => {
      if (req.method === "GET" && req.path === "/api/me") {
        return Response.json({
          name: "mini",
          email: null,
          kind: "agent",
          role: "agent",
          owner: "o",
          channel_scope: "dev",
        });
      }
      if (req.method === "POST" && req.path === "/api/channels/dev/presence/mini/activity") {
        posts += 1;
        return Response.json({ ok: true, attached: posts > 1 });
      }
      return undefined;
    });
    writeCfg(mock.url);
    const file = join(home, "activity.json");
    writeActivityFile(file, { phase: "starting", ts: Date.now() });

    expect(await runPush(file)).toBe(0);
    expect(posts).toBe(2);
  });

  test("stays silent (exit 0) on server failure, stale file, or missing config", async () => {
    mock = startRestMock(() => new Response("boom", { status: 500 }));
    writeCfg(mock.url);
    const file = join(home, "activity.json");
    writeActivityFile(file, { phase: "tool", tool: "Bash", ts: Date.now() });
    expect(await runPush(file)).toBe(0); // 服务端 500 → 静默

    writeActivityFile(file, { phase: "tool", tool: "Bash", ts: Date.now() - 10 * 60_000 });
    expect(await runPush(file)).toBe(0); // 超 TTL → 不发也不炸

    // 缺配置断言前恢复新鲜活动：确保这条走的是「无配置静默」路径，而不是搭 TTL 的便车。
    writeActivityFile(file, { phase: "tool", tool: "Bash", ts: Date.now() });
    rmSync(join(home, "config.json"));
    expect(await runPush(file)).toBe(0); // 无配置 → 静默
  });
});
