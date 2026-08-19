// party up（#837）：幂等分支判定 + 目标解析 + run() 各环节只补缺的部分。
// serve 拉起全部走 deps 注入的 mock —— 单测绝不真起 daemon。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, writeState } from "../src/config";
import { needsBind, parseUpTarget, planUp, run, type UpDeps, type UpStep } from "../src/commands/up";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-up-test-"));
  for (const k of ["AGENTPARTY_HOME", "AGENTPARTY_CONFIG", "AGENTPARTY_TOKEN"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AGENTPARTY_HOME = home;
  process.env.AGENTPARTY_CONFIG = join(home, "agents", "up-test.json");
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("parseUpTarget", () => {
  test("无参数 → 全 null", () => {
    expect(parseUpTarget(undefined)).toEqual({ server: null, channel: null, token: null });
  });
  test("join URL 带 token", () => {
    expect(parseUpTarget("https://ap.example.com/c/dev-room?t=ap_secret")).toEqual({
      server: "https://ap.example.com",
      channel: "dev-room",
      token: "ap_secret",
    });
  });
  test("频道 URL 不带 token", () => {
    expect(parseUpTarget("https://ap.example.com/c/dev-room")).toEqual({
      server: "https://ap.example.com",
      channel: "dev-room",
      token: null,
    });
  });
  test("裸 slug", () => {
    expect(parseUpTarget("dev-room")).toEqual({ server: null, channel: "dev-room", token: null });
  });
  test("非频道 URL → error", () => {
    expect(parseUpTarget("https://ap.example.com/about")).toHaveProperty("error");
  });
  test("非法 slug → error", () => {
    expect(parseUpTarget("Not A Slug!")).toHaveProperty("error");
  });
});

describe("planUp 幂等分支矩阵", () => {
  const cases: Array<[boolean, boolean, boolean, UpStep[]]> = [
    // [hasToken, needBind, runnerHealthy] → steps
    [true, false, true, []],
    [true, false, false, ["serve"]],
    [true, true, true, ["bind"]],
    [true, true, false, ["bind", "serve"]],
    [false, true, false, ["auth", "bind", "serve"]],
    [false, false, true, ["auth"]],
    [false, false, false, ["auth", "serve"]],
    [false, true, true, ["auth", "bind"]],
  ];
  for (const [hasToken, needBind, runnerHealthy, expected] of cases) {
    test(`token=${hasToken} bind=${needBind} healthy=${runnerHealthy} → [${expected.join(",")}]`, () => {
      expect(planUp({ hasToken, needBind, runnerHealthy })).toEqual(expected);
    });
  }
});

describe("needsBind", () => {
  const base = {
    cfgServer: "https://s",
    cfgToken: "t1",
    boundChannel: "c1",
    server: "https://s",
    token: "t1",
    channel: "c1",
  };
  test("全一致 → false", () => expect(needsBind(base)).toBe(false));
  test("token 漂移 → true", () => expect(needsBind({ ...base, token: "t2" })).toBe(true));
  test("server 漂移 → true", () => expect(needsBind({ ...base, server: "https://s2" })).toBe(true));
  test("频道未绑 → true", () => expect(needsBind({ ...base, boundChannel: undefined })).toBe(true));
  test("换频道 → true", () => expect(needsBind({ ...base, channel: "c2" })).toBe(true));
});

interface CallLog {
  initArgv: string[][];
  initEnvToken: Array<string | undefined>;
  spawned: Array<{ channel: string; runner: string }>;
}

function mockDeps(opts: { healthy: boolean; pid?: number; initCode?: number; spawnPid?: number | null }): {
  deps: UpDeps;
  calls: CallLog;
} {
  const calls: CallLog = { initArgv: [], initEnvToken: [], spawned: [] };
  return {
    calls,
    deps: {
      readHealth: () => ({ healthy: opts.healthy, pid: opts.pid }),
      runInit: async (argv) => {
        calls.initArgv.push(argv);
        calls.initEnvToken.push(process.env.AGENTPARTY_TOKEN);
        return opts.initCode ?? 0;
      },
      spawnServe: (channel, runner) => {
        calls.spawned.push({ channel, runner });
        return opts.spawnPid === undefined ? 4242 : opts.spawnPid;
      },
    },
  };
}

function readyConfig(): void {
  writeConfig({
    server: "https://ap.example.com",
    token: "ap_secret",
    identity: {
      name: "leo-claude",
      email: null,
      kind: "agent",
      role: "agent",
      owner: "leo",
      owner_handle: null,
      owner_display_name: null,
      channel_scope: "dev-room",
      verified_at: 1,
    },
  } as Parameters<typeof writeConfig>[0]);
  writeState({ channel: "dev-room", cursor: 7 });
}

describe("run — 幂等只补缺的环节", () => {
  test("全部就绪：不 init、不 spawn，exit 0", async () => {
    readyConfig();
    const { deps, calls } = mockDeps({ healthy: true, pid: 123 });
    expect(await run([], deps)).toBe(0);
    expect(calls.initArgv).toEqual([]);
    expect(calls.spawned).toEqual([]);
  });

  test("runner 挂了：只重拉 serve，不重新 init", async () => {
    readyConfig();
    const { deps, calls } = mockDeps({ healthy: false });
    expect(await run([], deps)).toBe(0);
    expect(calls.initArgv).toEqual([]);
    expect(calls.spawned).toEqual([{ channel: "dev-room", runner: "claude" }]);
  });

  test("全新机器 + join URL：init（token 走 env 不进 argv）+ 拉 serve", async () => {
    const { deps, calls } = mockDeps({ healthy: false });
    expect(await run(["https://ap.example.com/c/dev-room?t=ap_new"], deps)).toBe(0);
    expect(calls.initArgv).toEqual([["--server", "https://ap.example.com", "--channel", "dev-room"]]);
    expect(calls.initEnvToken).toEqual(["ap_new"]);
    // init 期间临时注入的 env token 不泄漏到后续进程环境
    expect(process.env.AGENTPARTY_TOKEN).toBeUndefined();
    expect(calls.spawned).toEqual([{ channel: "dev-room", runner: "claude" }]);
  });

  test("token 漂移（URL 给了新 token）：重新 init", async () => {
    readyConfig();
    const { deps, calls } = mockDeps({ healthy: true, pid: 9 });
    expect(await run(["https://ap.example.com/c/dev-room?t=ap_rotated"], deps)).toBe(0);
    expect(calls.initArgv.length).toBe(1);
    expect(calls.initEnvToken).toEqual(["ap_rotated"]);
    expect(calls.spawned).toEqual([]);
  });

  test("无 token 任何来源：auth 环节缺失，exit 1，不 init 不 spawn", async () => {
    const { deps, calls } = mockDeps({ healthy: false });
    expect(await run(["dev-room", "--server", "https://ap.example.com"], deps)).toBe(1);
    expect(calls.initArgv).toEqual([]);
    expect(calls.spawned).toEqual([]);
  });

  test("不知道频道：exit 1", async () => {
    const { deps } = mockDeps({ healthy: false });
    process.env.AGENTPARTY_TOKEN = "ap_x";
    expect(await run(["--server", "https://ap.example.com"], deps)).toBe(1);
  });

  test("init 失败：透传退出码，不再拉 serve", async () => {
    const { deps, calls } = mockDeps({ healthy: false, initCode: 3 });
    expect(await run(["https://ap.example.com/c/dev-room?t=ap_bad"], deps)).toBe(3);
    expect(calls.spawned).toEqual([]);
  });

  test("serve 拉起失败：exit 1", async () => {
    readyConfig();
    const { deps } = mockDeps({ healthy: false, spawnPid: null });
    expect(await run([], deps)).toBe(1);
  });

  test("--runner codex 透传给 spawnServe", async () => {
    readyConfig();
    const { deps, calls } = mockDeps({ healthy: false });
    expect(await run(["--runner", "codex"], deps)).toBe(0);
    expect(calls.spawned).toEqual([{ channel: "dev-room", runner: "codex" }]);
  });

  test("非法 runner：exit 1", async () => {
    const { deps } = mockDeps({ healthy: true });
    expect(await run(["--runner", "bash"], deps)).toBe(1);
  });
});
