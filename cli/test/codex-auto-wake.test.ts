// #893：codex 侧零手动唤醒层。
//
// 真机最常见的形态优先测：
//   ① **没有配置文件、没有环境变量**（绝大多数机器的常态）→ 必须解析成 off，SessionStart 不拉任何进程；
//   ② 开启后第一次 SessionStart → 拉起一个；
//   ③ 第二个 codex 会话紧接着启动（同身份同频道，锁已被占）→ 一个都不许再拉；
//   ④ spawn 失败 → 不抛、不写 stdout，原因进日志；
//   ⑤ 回收：宽限期内绝不回收（刚拉起来时注册表可能还没落稳），宽限期后没有活着的 codex 会话才退场。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_AUTO_WAKE_ENV,
  CODEX_AUTO_WAKE_CLAIM_TTL_MS,
  CODEX_AUTO_WAKE_MAX_CONSECUTIVE_FAILURES,
  createCodexAutoWakeStartupBudget,
  CODEX_AUTO_WAKE_GRACE_MS,
  appendCodexAutoWakeLog,
  codexAutoWakeAuth,
  codexAutoWakeLogPath,
  codexAutoWakeSettingPath,
  decideCodexAutoWake,
  parseCodexAutoWakeValue,
  readCodexAutoWakeSetting,
  resolveCodexAutoWakeMode,
  activeCodexAutoWakePid,
  claimCodexAutoWake,
  codexAutoWakeMarkerPath,
  codexAutoWakeTarget,
  runningServePid,
  writeCodexAutoWakeMarker,
  shouldReapCodexAutoWake,
  writeCodexAutoWakeSetting,
} from "../src/codex-auto-wake";
import {
  codexAutoWakeServeDeps,
  handleCodexHookRecord,
  maybeStartCodexAutoWake,
  runCodexAutoWakeSupervise,
  type CodexAutoWakeSpawnDeps,
} from "../src/commands/hook";
import { currentProcessStartedAt, instanceLockTarget } from "../src/instance-lock";

const CODEX_SESSION_ID = "019f95e8-2c0b-7903-8779-cd102c5ecd4c";

/** codex 0.145 实测的 SessionStart payload。 */
function sessionStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: "/tmp/project",
    hook_event_name: "SessionStart",
    model: "gpt-5.1-codex",
    permission_mode: "default",
    session_id: CODEX_SESSION_ID,
    source: "startup",
    transcript_path: null,
    ...overrides,
  };
}

let home: string;
let lockDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentparty-autowake-home-"));
  lockDir = mkdtempSync(join(tmpdir(), "agentparty-autowake-locks-"));
  chmodSync(home, 0o700);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(lockDir, { recursive: true, force: true });
});

interface SpawnCall {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function deps(overrides: Partial<CodexAutoWakeSpawnDeps> = {}): CodexAutoWakeSpawnDeps & { calls: SpawnCall[]; lines: string[] } {
  const calls: SpawnCall[] = [];
  const lines: string[] = [];
  return {
    home,
    env: {},
    lockDir,
    readConfigAt: () => ({ server: "https://party.example.com", token: "agent-token" }),
    channelAt: () => "dev",
    spawn: (args, cwd, env) => {
      calls.push({ args, cwd, env });
      return process.pid; // 假装拉起来了；标记的存活判定要认得出这个 pid
    },
    now: () => 1_000,
    log: (line) => lines.push(line),
    processAlive: (pid) => pid === process.pid,
    recordPid: (markerPath, channel, pid, now) =>
      writeCodexAutoWakeMarker(markerPath, { pid, started_at: null, claimed_at: now, channel }),
    calls,
    lines,
    ...overrides,
  };
}

describe("codex auto-wake 开关", () => {
  test("真机常态：没有配置文件、没有环境变量 → 开（装了 hook 就能被唤醒，不用再拨开关）", () => {
    expect(existsSync(codexAutoWakeSettingPath(home))).toBe(false);
    expect(readCodexAutoWakeSetting(home)).toBeNull();
    expect(resolveCodexAutoWakeMode({}, home)).toEqual({ mode: "serve", source: "default" });
  });

  test("配置文件写 on 之后解析成 serve；写 off 又回去", () => {
    writeCodexAutoWakeSetting(home, "serve");
    expect(resolveCodexAutoWakeMode({}, home)).toEqual({ mode: "serve", source: "config" });
    writeCodexAutoWakeSetting(home, "off");
    expect(resolveCodexAutoWakeMode({}, home)).toEqual({ mode: "off", source: "config" });
  });

  test("环境变量压过配置文件——serve 给 runner 子进程设 off 才能断掉套娃", () => {
    writeCodexAutoWakeSetting(home, "serve");
    expect(resolveCodexAutoWakeMode({ [CODEX_AUTO_WAKE_ENV]: "0" }, home))
      .toEqual({ mode: "off", source: "env" });
  });

  test("认不出的值不算设过，回落到下一层而不是瞎猜", () => {
    expect(parseCodexAutoWakeValue("maybe")).toBeNull();
    expect(parseCodexAutoWakeValue("")).toBeNull();
    expect(parseCodexAutoWakeValue(undefined)).toBeNull();
    writeCodexAutoWakeSetting(home, "serve");
    expect(resolveCodexAutoWakeMode({ [CODEX_AUTO_WAKE_ENV]: "maybe" }, home))
      .toEqual({ mode: "serve", source: "config" });
  });

  test("损坏的配置文件读作「没设过」，不是崩溃——回落到默认（开）", () => {
    writeFileSync(codexAutoWakeSettingPath(home), "{ not json");
    expect(resolveCodexAutoWakeMode({}, home)).toEqual({ mode: "serve", source: "default" });
  });

  test("显式关掉必须仍然有效：配置文件 off 与环境变量 off 都压得住默认", () => {
    writeCodexAutoWakeSetting(home, "off");
    expect(resolveCodexAutoWakeMode({}, home)).toEqual({ mode: "off", source: "config" });
    expect(resolveCodexAutoWakeMode({ [CODEX_AUTO_WAKE_ENV]: "off" }, home))
      .toEqual({ mode: "off", source: "env" });
    // 配置文件关着，环境变量显式打开 → 开（环境变量优先）。
    expect(resolveCodexAutoWakeMode({ [CODEX_AUTO_WAKE_ENV]: "1" }, home))
      .toEqual({ mode: "serve", source: "env" });
  });
});

describe("拉起决策", () => {
  test("默认关闭时不拉，理由说清怎么开", () => {
    const decision = decideCodexAutoWake({
      mode: "off",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: null,
      hasAgentToken: true,
    });
    expect(decision.action).toBe("skip");
    expect(decision).toMatchObject({ reason: "disabled" });
    expect((decision as { detail: string }).detail).toContain("codex-autowake on");
  });

  test("开启且没人在 serve → 拉 serve --runner codex（绝不是 bridge：bridge 要接管 TUI）", () => {
    const decision = decideCodexAutoWake({
      mode: "serve",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: null,
      hasAgentToken: true,
    });
    expect(decision).toEqual({
      action: "start",
      channel: "dev",
      cwd: "/tmp/project",
      args: ["hook", "codex-autowake", "--supervise", "--channel", "dev"],
    });
  });

  test("已有 serve 在跑 → 不拉第二个（一条 @ 跑两次 runner ＝ 双份回帖 / 副作用跑两遍）", () => {
    const decision = decideCodexAutoWake({
      mode: "serve",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: 999,
      hasAgentToken: true,
    });
    expect(decision).toMatchObject({ action: "skip", reason: "already-serving" });
  });

  test("上一次拉起的唤醒层还活着（锁可能还没建）→ 也不拉，日志里带得出它的 pid", () => {
    const decision = decideCodexAutoWake({
      mode: "serve",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: null,
      startingPid: 4242,
      hasAgentToken: true,
    });
    expect(decision).toMatchObject({ action: "skip", reason: "already-starting" });
    expect((decision as { detail: string }).detail).toContain("4242");
  });

  test("没绑定频道 / 没有 agent token 都不拉", () => {
    expect(decideCodexAutoWake({
      mode: "serve",
      channel: null,
      cwd: "/tmp/project",
      serveHolderPid: null,
      hasAgentToken: true,
    })).toMatchObject({ action: "skip", reason: "no-channel" });
    expect(decideCodexAutoWake({
      mode: "serve",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: null,
      hasAgentToken: false,
    })).toMatchObject({ action: "skip", reason: "no-agent-token" });
  });
});

describe("锁复用：serve 的实例锁就是去重的权威", () => {
  test("同身份同频道已有活着的 serve → runningServePid 认得出来", () => {
    const auth = codexAutoWakeAuth({ server: "party.example.com", token: "agent-token" })!;
    expect(auth.server).toBe("https://party.example.com"); // 与 resolveAuthDetailed 的 heal 一致
    expect(runningServePid(auth, "dev", lockDir)).toBeNull();
    // 手工造一把与本进程匹配的 serve 锁，等价于「已有 serve 在跑」。
    const target = instanceLockTarget(auth.server, auth.token, "dev");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `serve-${target}.lock`), JSON.stringify({
      pid: process.pid,
      id: "test",
      started_at: currentProcessStartedAt(),
    }));
    expect(runningServePid(auth, "dev", lockDir)).toBe(process.pid);
    // 另一个身份不受影响：token 变了就是另一把锁。
    const other = codexAutoWakeAuth({ server: "party.example.com", token: "other-token" })!;
    expect(runningServePid(other, "dev", lockDir)).toBeNull();
  });

  test("config 没有 token（人类账号会话）→ 没有可用身份", () => {
    expect(codexAutoWakeAuth(null)).toBeNull();
    expect(codexAutoWakeAuth({ server: "https://party.example.com" })).toBeNull();
    expect(codexAutoWakeAuth({ server: "https://party.example.com", token: "" })).toBeNull();
  });
});

describe("SessionStart 接线", () => {
  test("真机常态（配置缺席 + 环境变量缺席）：直接就拉起来，不用用户先拨开关", () => {
    const d = deps(); // env 为空、home 里没有配置文件——绝大多数机器的样子
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start", channel: "dev" });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.args).toEqual(["hook", "codex-autowake", "--supervise", "--channel", "dev"]);
  });

  test("用户显式关掉（配置文件 off）：一个进程都不起，也不刷日志", () => {
    writeCodexAutoWakeSetting(home, "off");
    const d = deps();
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "disabled" });
    expect(d.calls).toHaveLength(0);
    expect(d.lines).toHaveLength(0);
  });

  test("用户显式关掉（环境变量 off）：同样一个进程都不起", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "off" } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "disabled" });
    expect(d.calls).toHaveLength(0);
  });

  test("拉起时给子进程关掉 auto-wake 防套娃", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start", channel: "dev" });
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]!.args).toEqual(["hook", "codex-autowake", "--supervise", "--channel", "dev"]);
    expect(d.calls[0]!.cwd).toBe("/tmp/project");
    expect(d.calls[0]!.env[CODEX_AUTO_WAKE_ENV]).toBe("off");
    expect(d.lines.join("\n")).toContain("started:");
  });

  test("已有 serve 在跑时，第二个 codex 会话一个都不再拉", () => {
    const auth = codexAutoWakeAuth({ server: "https://party.example.com", token: "agent-token" })!;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, `serve-${instanceLockTarget(auth.server, auth.token, "dev")}.lock`), JSON.stringify({
      pid: process.pid,
      id: "test",
      started_at: currentProcessStartedAt(),
    }));
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "already-serving" });
    expect(d.calls).toHaveLength(0);
  });

  // 真机实测（#893）：serve 连不上服务端时，会在它**自己的重连 supervisor** 里无限重试，
  // 根本走不到抢实例锁那一步——instances 目录压根没建。只看锁的话，断网时每开一个 codex
  // 会话就多堆一个永远重试的后台进程。这一组测的就是「锁还没建起来」这个真机常见形态。
  test("锁还没建（serve 正在重连）时，第二个会话靠标记挡住，不堆第二个进程", () => {
    const first = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    expect(maybeStartCodexAutoWake(sessionStart(), first)).toMatchObject({ action: "start" });
    expect(first.calls).toHaveLength(1);
    // 锁目录仍然是空的——正是真机断网时的样子。
    expect(runningServePid(
      codexAutoWakeAuth({ server: "https://party.example.com", token: "agent-token" })!,
      "dev",
      lockDir,
    )).toBeNull();
    const second = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    expect(maybeStartCodexAutoWake(sessionStart(), second)).toMatchObject({
      action: "skip",
      reason: "already-starting",
    });
    expect(second.calls).toHaveLength(0);
  });

  test("上一个唤醒层已经死了 → 标记失效，下一个会话重新拉起（不能被一次崩溃永久锁死）", () => {
    const target = codexAutoWakeTarget(
      codexAutoWakeAuth({ server: "https://party.example.com", token: "agent-token" })!,
      "dev",
    );
    writeCodexAutoWakeMarker(codexAutoWakeMarkerPath(home, target), {
      pid: 999_999, // 不存在的进程
      started_at: null,
      claimed_at: 1_000,
      channel: "dev",
    });
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start" });
    expect(d.calls).toHaveLength(1);
  });

  test("只占了位还没回填 pid 的标记：TTL 内挡住，过期后放行", () => {
    const target = codexAutoWakeTarget(
      codexAutoWakeAuth({ server: "https://party.example.com", token: "agent-token" })!,
      "dev",
    );
    const path = codexAutoWakeMarkerPath(home, target);
    expect(claimCodexAutoWake(path, "dev", 1_000, (pid) => pid === process.pid)).toBe(true);
    expect(activeCodexAutoWakePid(path, 1_000, () => false)).toBe(0);
    expect(claimCodexAutoWake(path, "dev", 1_000, () => false)).toBe(false);
    expect(activeCodexAutoWakePid(path, 1_000 + CODEX_AUTO_WAKE_CLAIM_TTL_MS, () => false)).toBeNull();
    expect(claimCodexAutoWake(path, "dev", 1_000 + CODEX_AUTO_WAKE_CLAIM_TTL_MS, () => false)).toBe(true);
  });

  test("拉不起来：不抛、不进 stdout，原因写进日志文件", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" }, spawn: () => null });
    const outcome = maybeStartCodexAutoWake(sessionStart(), d);
    expect(outcome.action).toBe("start-failed");
    expect(d.lines.join("\n")).toContain("start-failed:");
    expect(d.lines.join("\n")).toContain("party serve dev --runner codex");
  });

  test("日志真的落到文件里，且不写 stdout", () => {
    appendCodexAutoWakeLog(home, "start-failed: boom", 0);
    expect(readFileSync(codexAutoWakeLogPath(home), "utf8")).toContain("start-failed: boom");
  });

  test("只有 SessionStart 才拉；codex 的其它 hook 事件一律不拉", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    handleCodexHookRecord(sessionStart({ hook_event_name: "PreToolUse" }), { [CODEX_AUTO_WAKE_ENV]: "1" }, d);
    expect(d.calls).toHaveLength(0);
    handleCodexHookRecord(sessionStart(), { [CODEX_AUTO_WAKE_ENV]: "1" }, d);
    expect(d.calls).toHaveLength(1);
  });

  test("serve 托管 lane（AP_ACTIVITY_FILE 在场）绝不套娃再拉一层", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    handleCodexHookRecord(sessionStart(), {
      [CODEX_AUTO_WAKE_ENV]: "1",
      AP_ACTIVITY_FILE: "/tmp/activity.json",
    }, d);
    expect(d.calls).toHaveLength(0);
  });

  test("没绑定频道的目录：跳过原因留痕（可诊断），但不起进程", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" }, channelAt: () => null });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "no-channel" });
    expect(d.calls).toHaveLength(0);
    expect(d.lines.join("\n")).toContain("no-channel");
  });
});

// 默认开启之后，「断网时留一个永远重试的后台进程」的影响面从「主动开开关的人」变成
// 「所有装了 codex hook 的人」。serve 自己的 supervisor 是无限自愈的（对手工挂的 serve
// 正确），自动拉起的这层必须有个尽头。
describe("放弃预算：不会在别人机器上无限重试", () => {
  test("连续短命失败到上限就用完预算", () => {
    const budget = createCodexAutoWakeStartupBudget(3, 60_000);
    budget.recordRun(5);
    budget.recordRun(5);
    expect(budget.exhausted()).toBe(false);
    budget.recordRun(5);
    expect(budget.exhausted()).toBe(true);
    expect(budget.consecutiveFailures()).toBe(3);
  });

  test("真的连上并服务过一段时间 → 预算清零（一次断线重连不该被之前的失败拖累）", () => {
    const budget = createCodexAutoWakeStartupBudget(3, 60_000);
    budget.recordRun(5);
    budget.recordRun(5);
    budget.recordRun(60_000); // 跑够久＝这轮健康
    expect(budget.consecutiveFailures()).toBe(0);
    budget.recordRun(5);
    expect(budget.exhausted()).toBe(false);
  });

  test("预算接进 serve 的 supervisor：短命失败累计到上限就被当成终局，停止自愈并说清原因", async () => {
    const lines: string[] = [];
    const budget = createCodexAutoWakeStartupBudget(3, 60_000);
    let clock = 0;
    const deps = codexAutoWakeServeDeps({
      channel: "dev",
      budget,
      log: (line) => lines.push(line),
      now: () => clock,
      // 用真 superviseServe 的行为替身：不断重跑 runOnce 直到 isTerminal 说停。
      // 真 superviseServe 的行为替身：不断重跑 runOnce 直到 isTerminal 说停。
      // 上限 50 只为「预算失效时测试立刻红，而不是挂死」——真实 supervisor 没有这个上限。
      superviseServe: async (opts) => {
        for (let i = 0; i < 50; i += 1) {
          const code = await opts.runOnce();
          if (opts.isTerminal!(code)) return code;
        }
        return -1; // 永远没停下来 = 预算没起作用
      },
      isTerminalServeExit: () => false, // 连不上不是终局——serve 本来会永远重试
    });
    let attempts = 0;
    const code = await deps.superviseServe({
      runOnce: async () => {
        attempts += 1;
        clock += 5; // 每次几毫秒就失败：连不上的样子
        return 1;
      },
    });
    expect(code).toBe(1);
    expect(attempts).toBe(3); // 用完预算就停，不是无限
    expect(lines.join("\n")).toContain("giving-up:");
  });

  test("预算接进 supervisor：中间有一次跑够久，就不该在那之后立刻放弃", async () => {
    const budget = createCodexAutoWakeStartupBudget(2, 60_000);
    let clock = 0;
    const deps = codexAutoWakeServeDeps({
      channel: "dev",
      budget,
      log: () => {},
      now: () => clock,
      superviseServe: async (opts) => {
        for (let i = 0; i < 50; i += 1) {
          const code = await opts.runOnce();
          if (opts.isTerminal!(code)) return code;
        }
        return -1;
      },
      isTerminalServeExit: () => false,
    });
    let attempts = 0;
    await deps.superviseServe({
      runOnce: async () => {
        attempts += 1;
        clock += attempts === 2 ? 120_000 : 5; // 第二次真的连上并服务了两分钟
        return 1;
      },
    });
    // 1 失败、2 健康（清零）、3、4 失败 → 第 4 次才用完
    expect(attempts).toBe(4);
  });

  test("默认预算是有限的——绝不是无限自愈", () => {
    expect(Number.isFinite(CODEX_AUTO_WAKE_MAX_CONSECUTIVE_FAILURES)).toBe(true);
    expect(CODEX_AUTO_WAKE_MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
  });
});

describe("生命周期：codex 没有 SessionEnd，靠 pid 探活收尾", () => {
  test("宽限期内一律不回收——刚拉起来时注册表可能还没落稳", () => {
    expect(shouldReapCodexAutoWake({ startedAt: 0, now: CODEX_AUTO_WAKE_GRACE_MS - 1, liveOwners: 0 })).toBe(false);
  });

  test("宽限期后：还有活着的 codex 会话就留着，一个不剩才退场", () => {
    const now = CODEX_AUTO_WAKE_GRACE_MS + 1;
    expect(shouldReapCodexAutoWake({ startedAt: 0, now, liveOwners: 1 })).toBe(false);
    expect(shouldReapCodexAutoWake({ startedAt: 0, now, liveOwners: 0 })).toBe(true);
  });

  test("supervise 跑的是 serve --runner codex，探活判定没人要了就自己收口", async () => {
    let owners = 1;
    let terminated = 0;
    const servedArgvs: string[][] = [];
    const lines: string[] = [];
    let resolveServe: (code: number) => void = () => {};
    const served = new Promise<number>((resolve) => { resolveServe = resolve; });
    const run = runCodexAutoWakeSupervise("dev", {
      env: {},
      pollMs: 1,
      graceMs: 0,
      now: () => Date.now(),
      liveOwners: () => owners,
      log: (line) => lines.push(line),
      terminate: () => { terminated += 1; resolveServe(0); },
      serve: (argv) => { servedArgvs.push(argv); return served; },
    });
    // 还有会话在：绝不回收。
    await Bun.sleep(20);
    expect(terminated).toBe(0);
    owners = 0;
    expect(await run).toBe(0);
    expect(servedArgvs).toEqual([["dev", "--runner", "codex"]]);
    expect(terminated).toBe(1);
    expect(lines.join("\n")).toContain("reaping:");
  });

  test("回收只发一次信号，不会在 serve 收口期间连发", async () => {
    let terminated = 0;
    let resolveServe: (code: number) => void = () => {};
    const served = new Promise<number>((resolve) => { resolveServe = resolve; });
    const run = runCodexAutoWakeSupervise("dev", {
      env: {},
      pollMs: 1,
      graceMs: 0,
      liveOwners: () => 0,
      log: () => {},
      terminate: () => { terminated += 1; },
      serve: () => served,
    });
    await Bun.sleep(30);
    resolveServe(0);
    await run;
    expect(terminated).toBe(1);
  });
});
