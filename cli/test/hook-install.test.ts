// #615：hook install 的幂等合并 / 交互 lane 直报的节流与 push 端到端。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeActivityFile } from "../src/activity";
import { mergeHookSettings, removeHookSettings, shouldPushActivity, PUSH_INTERVAL_MS, PUSH_INTERVAL_URGENT_MS } from "../src/commands/hook";
import { claudeHookSettingsJson } from "../src/commands/serve";
import { startRestMock, type RestMock } from "./rest-mock";

const indexPath = join(import.meta.dir, "..", "src", "index.ts");
const NOW = 1_700_000_000_000;

let home: string;
let mock: RestMock | null = null;

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
    expect(Object.keys(parsed.hooks).length).toBe(8);
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

    expect((await runIn("status")).code).toBe(1); // 未装
    expect((await runIn("install")).code).toBe(0);
    const settings = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(settings.hooks).length).toBe(8);
    const status = await runIn("status");
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("installed");
    expect((await runIn("uninstall")).code).toBe(0);
    expect((await runIn("status")).code).toBe(1);
    rmSync(project, { recursive: true, force: true });
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

  test("posts the activity to the presence activity endpoint", async () => {
    let captured: unknown = null;
    mock = startRestMock((req) => {
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
