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
  CODEX_AUTO_WAKE_FLAP_SHORT_LIFE_MS,
  CODEX_AUTO_WAKE_FLAP_WINDOW_MS,
  CODEX_AUTO_WAKE_MARKER_ENV,
  readCodexAutoWakeMarker,
  recentCodexAutoWakeFlap,
  recordCodexAutoWakeReap,
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
  defaultCodexAutoWakeDeps,
  handleCodexHookRecord,
  maybeStartCodexAutoWake,
  runCodexAutoWakeSupervise,
  type CodexAutoWakeSpawnDeps,
} from "../src/commands/hook";
import { currentProcessStartedAt, instanceLockTarget } from "../src/instance-lock";
import { writeJoinBinding, joinBindingsPath, type BindingHarness } from "../src/join-binding";
import { writeState, writeWorkspaceConfigOnly, type Config } from "../src/config";

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

  test("ChatGPT Desktop 有第二个同身份 task → 自动拉原生 bridge，不另起 runner", () => {
    const targetThreadId = CODEX_SESSION_ID;
    const sourceThreadId = "01a0499f-2ce2-76e1-8734-733f8f169c28";
    expect(decideCodexAutoWake({
      mode: "serve",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: null,
      hasAgentToken: true,
      nativeDesktop: true,
      nativeRoute: { targetThreadId, sourceThreadId },
    })).toEqual({
      action: "start",
      channel: "dev",
      cwd: "/tmp/project",
      args: [
        "hook", "codex-autowake", "--supervise", "--channel", "dev",
        "--target-thread", targetThreadId,
        "--source-thread", sourceThreadId,
      ],
    });
  });

  test("Desktop IPC 可用但还没有第二个 task → 等待，不退回后台新 runner", () => {
    expect(decideCodexAutoWake({
      mode: "serve",
      channel: "dev",
      cwd: "/tmp/project",
      serveHolderPid: null,
      hasAgentToken: true,
      nativeDesktop: true,
      nativeRoute: null,
    })).toMatchObject({ action: "skip", reason: "native-source-missing" });
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

  test("native bridge 子进程继承身份解析器选中的精确 config，不回落全局身份", () => {
    const d = deps({
      readConfigAt: () => ({
        server: "https://party.example.com",
        token: "agent-token",
        configPath: "/tmp/exact-agentparty-config.json",
      }),
      nativeDesktop: () => true,
      nativeRoute: () => ({
        targetThreadId: CODEX_SESSION_ID,
        sourceThreadId: "01a0499f-2ce2-76e1-8734-733f8f169c28",
      }),
    });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start" });
    expect(d.calls[0]?.env.AGENTPARTY_CONFIG).toBe("/tmp/exact-agentparty-config.json");
    expect(d.calls[0]?.args).toContain("--target-thread");
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

  test("supervise 有 native route 时只运行 ChatGPT bridge", async () => {
    const calls: unknown[] = [];
    const result = await runCodexAutoWakeSupervise("dev", {
      env: {},
      liveOwners: () => 1,
      nativeRoute: {
        targetThreadId: CODEX_SESSION_ID,
        sourceThreadId: "01a0499f-2ce2-76e1-8734-733f8f169c28",
      },
      nativeBridge: async (options) => { calls.push(options); return 0; },
      serve: async () => { throw new Error("native route must not start serve runner"); },
    });
    expect(result).toBe(0);
    expect(calls).toEqual([{
      channel: "dev",
      targetThreadId: CODEX_SESSION_ID,
      sourceThreadId: "01a0499f-2ce2-76e1-8734-733f8f169c28",
      env: {},
    }]);
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

// ---- #959 / #960：一次性 codex 反复拉起、codex 抢走 claude 绑定的身份 ----

describe("pins #959：一次性 codex 不拉唤醒层（启动前判定，不是 60 秒后再回收）", () => {
  test("事故场景：别的 Claude 委托的一次性 codex ⇒ skip(non-interactive)，一个进程都不起、身份都不去解析", () => {
    let identityLookups = 0;
    const d = deps({
      sessionKind: () => ({ kind: "non-interactive", detail: "这个 codex 是被另一个 claude 会话委托拉起的" }),
      readConfigAt: () => { identityLookups += 1; return { server: "https://party.example.com", token: "agent-token" }; },
    });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "non-interactive" });
    expect(d.calls).toHaveLength(0);
    expect(identityLookups).toBe(0);
    expect(d.lines.join("\n")).toContain("skip(non-interactive)");
    expect(d.lines.join("\n")).toContain("委托拉起");
  });

  test("#976：探测不出形态（unknown）⇒ 不拉，记 skip(session-kind-unknown)，身份也不去解析", () => {
    let identityLookups = 0;
    const d = deps({
      sessionKind: () => ({ kind: "unknown", detail: "进程表里找不到 hook 的父进程 50439" }),
      readConfigAt: () => { identityLookups += 1; return { server: "https://party.example.com", token: "agent-token" }; },
    });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "session-kind-unknown" });
    expect(d.calls).toHaveLength(0);
    expect(identityLookups).toBe(0);
    const log = d.lines.join("\n");
    expect(log).toContain("skip(session-kind-unknown)");
    expect(log).toContain("kind=unknown detail=进程表里找不到 hook 的父进程 50439");
  });

  test("#976：纯决策层——unknown 在身份拒绝 / 无 token 之前就拦下", () => {
    expect(decideCodexAutoWake({
      mode: "serve", channel: "dev", cwd: "/tmp/p", serveHolderPid: null, hasAgentToken: true,
      sessionKind: { kind: "unknown", detail: "ps 挂了" },
      identityRefusal: { reason: "harness-mismatch", detail: "x" },
    })).toMatchObject({ action: "skip", reason: "session-kind-unknown" });
  });

  test("交互式 codex ⇒ 照拉（人在终端里等着被 @）；started 行带 kind/detail", () => {
    const d = deps({ sessionKind: () => ({ kind: "interactive", detail: "codex TUI（pid 7）" }) });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start" });
    expect(d.calls).toHaveLength(1);
    const started = d.lines.find((line) => line.startsWith("started:"))!;
    expect(started).toContain("kind=interactive detail=codex TUI（pid 7）");
  });

  test("#976：每条决策日志都带探测结论——skip(non-interactive) 也写 kind=/detail=", () => {
    const d = deps({ sessionKind: () => ({ kind: "non-interactive", detail: "rollout 头：originator=Claude Code source=vscode——被 Claude 委托的 codex，跑完即走" }) });
    maybeStartCodexAutoWake(sessionStart(), d);
    expect(d.lines[0]).toMatch(/^skip\(non-interactive\): .* kind=non-interactive detail=rollout 头：originator=Claude Code/);
  });

  test("#976：没探测（没绑频道时探测器根本不跑）⇒ 日志写 kind=not-probed，不假装探过", () => {
    let probed = 0;
    const d = deps({ channelAt: () => null, sessionKind: () => { probed += 1; return { kind: "interactive", detail: "x" }; } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "no-channel" });
    expect(probed).toBe(0);
    expect(d.lines[0]).toContain("kind=not-probed");
  });

  test("显式关掉时连形态都不探测（disabled 仍是第一道门，不刷日志）", () => {
    writeCodexAutoWakeSetting(home, "off");
    let probed = 0;
    const d = deps({ sessionKind: () => { probed += 1; return { kind: "non-interactive", detail: "x" }; } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "disabled" });
    expect(probed).toBe(0);
    expect(d.lines).toHaveLength(0);
  });

  test("真实接线：默认 deps 的 sessionKind 就是进程形态探测（不是恒 interactive 的桩）", () => {
    const real = defaultCodexAutoWakeDeps({ AGENTPARTY_HOME: home }, 1);
    expect(typeof real.sessionKind).toBe("function");
    // pid 1 不合法 ⇒ unknown：探测器真的被接上了，且失败时不误判。
    expect(real.sessionKind!().kind).toBe("unknown");
  });

  test("#976 真实接线：session_id 定位到的 rollout 头说 originator=Claude Code ⇒ 非交互式，连 pid 1 那条 unknown 都不走", () => {
    const codexHome = join(home, "codex-home");
    const day = join(codexHome, "sessions", "2026", "08", "28");
    mkdirSync(day, { recursive: true });
    const sid = "01a046e8-89f6-7ba2-a792-4d0342522e7f";
    writeFileSync(join(day, `rollout-2026-08-28T14-47-19-${sid}.jsonl`), `${JSON.stringify({
      timestamp: "2026-08-28T05:47:19.944Z", type: "session_meta",
      payload: { session_id: sid, id: sid, cwd: "/tmp/project", originator: "Claude Code", cli_version: "0.149.1", source: "vscode", base_instructions: "<omitted>" },
    })}\n`);
    const real = defaultCodexAutoWakeDeps({ AGENTPARTY_HOME: home, CODEX_HOME: codexHome }, 1, sid);
    const probe = real.sessionKind!();
    expect(probe.kind).toBe("non-interactive");
    expect(probe.detail).toContain("rollout");
  });
});

describe("pins #959：退避——刚被短命回收过的 (身份, 频道) 不再拉起", () => {
  const auth = codexAutoWakeAuth({ server: "https://party.example.com", token: "agent-token" })!;
  const marker = () => codexAutoWakeMarkerPath(home, codexAutoWakeTarget(auth, "dev"));

  test("事故场景：唤醒层 60 秒前刚被回收（只活了 61 秒）⇒ skip(flapping)，不拉", () => {
    mkdirSync(join(home, "codex-auto-wake"), { recursive: true });
    writeCodexAutoWakeMarker(marker(), { pid: 999_999, started_at: null, claimed_at: 0, channel: "dev" });
    recordCodexAutoWakeReap(marker(), 1_000 - 60_000, 61_000);
    const d = deps({ processAlive: () => false });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "flapping" });
    expect(d.calls).toHaveLength(0);
    expect(d.lines.join("\n")).toContain("skip(flapping)");
  });

  test("回收已经是很久以前的事 ⇒ 窗口过了，照拉", () => {
    mkdirSync(join(home, "codex-auto-wake"), { recursive: true });
    writeCodexAutoWakeMarker(marker(), { pid: 999_999, started_at: null, claimed_at: 0, channel: "dev" });
    recordCodexAutoWakeReap(marker(), 1_000 - CODEX_AUTO_WAKE_FLAP_WINDOW_MS - 1, 61_000);
    const d = deps({ processAlive: () => false });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start" });
  });

  test("上一层活得够久（人真的用过它）再被回收 ⇒ 不算 flapping，关掉重开立刻能回来", () => {
    mkdirSync(join(home, "codex-auto-wake"), { recursive: true });
    writeCodexAutoWakeMarker(marker(), { pid: 999_999, started_at: null, claimed_at: 0, channel: "dev" });
    recordCodexAutoWakeReap(marker(), 1_000 - 30_000, CODEX_AUTO_WAKE_FLAP_SHORT_LIFE_MS + 1);
    const d = deps({ processAlive: () => false });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start" });
  });

  test("拉起时把标记路径交给子进程，回收时它才写得回来", () => {
    const d = deps({ env: { [CODEX_AUTO_WAKE_ENV]: "1" } });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "start" });
    expect(d.calls[0]!.env[CODEX_AUTO_WAKE_MARKER_ENV]).toBe(marker());
  });

  test("回收记录保留 pid/claimed_at，只补 reaped_at/lived_ms；老标记没有这两个字段 ⇒ 不算 flapping", () => {
    mkdirSync(join(home, "codex-auto-wake"), { recursive: true });
    writeCodexAutoWakeMarker(marker(), { pid: 4242, started_at: 77, claimed_at: 5, channel: "dev" });
    expect(recentCodexAutoWakeFlap(marker(), 1_000)).toBeNull();
    recordCodexAutoWakeReap(marker(), 900, 61_000);
    expect(readCodexAutoWakeMarker(marker())).toMatchObject({ pid: 4242, started_at: 77, claimed_at: 5, reaped_at: 900, lived_ms: 61_000 });
    expect(recentCodexAutoWakeFlap(marker(), 1_000)).toEqual({ reaped_at: 900, lived_ms: 61_000 });
  });

  test("端到端：supervise 回收 → 标记落下退避证据 → 下一个 SessionStart 不再拉起（死循环就断在这）", async () => {
    let terminated = 0;
    let resolveServe: (code: number) => void = () => {};
    const served = new Promise<number>((resolve) => { resolveServe = resolve; });
    let clock = 10_000;
    const run = runCodexAutoWakeSupervise("dev", {
      env: {},
      pollMs: 1,
      graceMs: 0,
      now: () => clock,
      liveOwners: () => 0,
      log: () => {},
      markerPath: marker(),
      terminate: () => { terminated += 1; resolveServe(0); },
      serve: () => served,
    });
    clock = 10_000 + 61_000;
    expect(await run).toBe(0);
    expect(terminated).toBe(1);
    expect(readCodexAutoWakeMarker(marker())).toMatchObject({ reaped_at: 71_000, lived_ms: 61_000 });
    // 下一个一次性 codex 紧接着来了（20 秒后）——修复前这里会再拉一层。
    const d = deps({ now: () => 71_000 + 20_000, processAlive: () => false });
    expect(maybeStartCodexAutoWake(sessionStart(), d)).toMatchObject({ action: "skip", reason: "flapping" });
    expect(d.calls).toHaveLength(0);
  });

  test("supervise 没拿到标记路径（老拉起方）⇒ 回收照常，只是不留退避证据", async () => {
    let resolveServe: (code: number) => void = () => {};
    const served = new Promise<number>((resolve) => { resolveServe = resolve; });
    const run = runCodexAutoWakeSupervise("dev", {
      env: {},
      pollMs: 1,
      graceMs: 0,
      liveOwners: () => 0,
      log: () => {},
      markerPath: null,
      terminate: () => resolveServe(0),
      serve: () => served,
    });
    expect(await run).toBe(0);
    expect(existsSync(marker())).toBe(false);
  });
});

describe("pins #960：codex hook 不认领绑给 claude 的身份", () => {
  const SERVER = "https://party.example.com";
  const CHANNEL = "ludo";
  let cwd: string;
  let savedConfigEnv: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "agentparty-autowake-cwd-"));
    savedConfigEnv = process.env.AGENTPARTY_CONFIG;
    delete process.env.AGENTPARTY_CONFIG;
  });
  afterEach(() => {
    if (savedConfigEnv === undefined) delete process.env.AGENTPARTY_CONFIG;
    else process.env.AGENTPARTY_CONFIG = savedConfigEnv;
    rmSync(cwd, { recursive: true, force: true });
  });

  function agentConfig(name: string, token: string): Config {
    return {
      server: SERVER,
      token,
      identity: { name, email: null, kind: "agent", role: "member", owner: "leo", channel_scope: CHANNEL, verified_at: 1 },
    };
  }
  /** 照真机：身份 config 落在 ~/.agentparty/agents/，cwd 绑着它，join-bindings 记着是谁加入的。 */
  function joinAs(name: string, token: string, harness: BindingHarness, bindToCwd = true): string {
    const agents = join(home, "agents");
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    const path = join(agents, `agentparty-${name}-${CHANNEL}.json`);
    writeFileSync(path, JSON.stringify(agentConfig(name, token)), { mode: 0o600 });
    if (bindToCwd) {
      writeWorkspaceConfigOnly(agentConfig(name, token), cwd);
      writeState({ channel: CHANNEL, cursor: 0 }, cwd);
    }
    writeJoinBinding(joinBindingsPath(home), {
      harness, server: SERVER, channel: CHANNEL, owner: "leo", identity: name, config_path: path, cwd, created_at: Date.now(),
    });
    return path;
  }
  /** 真实的身份解析接线（defaultCodexAutoWakeDeps.readConfigAt），其余照旧打桩。 */
  function realDeps(): ReturnType<typeof deps> {
    const real = defaultCodexAutoWakeDeps({ AGENTPARTY_HOME: home }, 1);
    return deps({
      readConfigAt: real.readConfigAt,
      channelAt: real.channelAt,
      sessionKind: () => ({ kind: "interactive", detail: "codex TUI" }),
    });
  }

  test("事故场景：`party join --harness claude --as leo-server` 之后，同 cwd 的 codex ⇒ skip(harness-mismatch)", () => {
    joinAs("leo-server", "tok-claude", "claude");
    const d = realDeps();
    const outcome = maybeStartCodexAutoWake(sessionStart({ cwd }), d);
    expect(outcome).toMatchObject({ action: "skip", reason: "harness-mismatch" });
    expect(d.calls).toHaveLength(0);
    const log = d.lines.join("\n");
    expect(log).toContain("skip(harness-mismatch)");
    expect(log).toContain("leo-server");
    expect(log).toContain("--harness claude");
    // 不是「没有 agent token」那种含糊的跳过——原因以自己的名字出现。
    expect(log).not.toContain("no-agent-token");
  });

  test("#971 piggo 现场：同 cwd 一旧一新两个 claude 绑定、零个 codex 绑定 ⇒ 一条 skip(no-codex-binding)，没有 ambiguous 长文", () => {
    // 旧身份：老版本记的绑定没有 owner，自成一组、不被新绑定替换；config 按设计保留。
    const oldPath = joinAs("leo-server", "tok-old", "claude", false);
    writeJoinBinding(joinBindingsPath(home), {
      harness: "claude", server: SERVER, channel: CHANNEL, owner: null, identity: "leo-server", config_path: oldPath, cwd, created_at: 1,
    });
    joinAs("server", "tok-new", "claude");
    const d = realDeps();
    const outcome = maybeStartCodexAutoWake(sessionStart({ cwd }), d);
    expect(outcome).toMatchObject({ action: "skip", reason: "no-codex-binding" });
    expect(d.calls).toHaveLength(0);
    const skips = d.lines.filter((line) => line.startsWith("skip("));
    expect(skips).toHaveLength(1);
    expect(skips[0]).toContain("skip(no-codex-binding)");
    const log = d.lines.join("\n");
    expect(log).not.toContain("ambiguous");
    expect(log).not.toContain("只能猜出其中一个");
    expect(log).not.toContain("重新跑一遍");
    expect(log).not.toContain("no-agent-token");
    // 唤醒层自己的「解析不出会话身份」那行也不该再出现——预期状态只留决策层这一条痕。
    expect(log).not.toContain("解析不出会话身份");
  });

  test("同一个身份也用 codex 接入包加入过 ⇒ codex 可以认领，照拉", () => {
    joinAs("leo-server", "tok-shared", "claude");
    joinAs("leo-server", "tok-shared", "codex");
    const d = realDeps();
    expect(maybeStartCodexAutoWake(sessionStart({ cwd }), d)).toMatchObject({ action: "start", channel: CHANNEL });
    expect(d.calls).toHaveLength(1);
  });

  test("同 cwd 同时有 claude 与 codex 两条绑定（各自的身份）⇒ 各走各的：codex 拉的是 codex 那个身份，不是最新的一条", () => {
    joinAs("leo-codex", "tok-codex", "codex");
    // claude 的身份**后**加入且绑在 cwd 上——「最新一条赢」会选中它，那正是要根除的。
    joinAs("leo-server", "tok-claude", "claude");
    const d = realDeps();
    expect(maybeStartCodexAutoWake(sessionStart({ cwd }), d)).toMatchObject({ action: "start", channel: CHANNEL });
    const codexAuth = codexAutoWakeAuth({ server: SERVER, token: "tok-codex" })!;
    expect(d.calls[0]!.env[CODEX_AUTO_WAKE_MARKER_ENV]).toBe(codexAutoWakeMarkerPath(home, codexAutoWakeTarget(codexAuth, CHANNEL)));
  });

  test("没有任何绑定的老机器：单身份 cwd 照旧可用（行为不变）", () => {
    const agents = join(home, "agents");
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    writeFileSync(join(agents, "agentparty-solo-ludo.json"), JSON.stringify(agentConfig("solo", "tok-solo")), { mode: 0o600 });
    writeWorkspaceConfigOnly(agentConfig("solo", "tok-solo"), cwd);
    writeState({ channel: CHANNEL, cursor: 0 }, cwd);
    const d = realDeps();
    expect(maybeStartCodexAutoWake(sessionStart({ cwd }), d)).toMatchObject({ action: "start", channel: CHANNEL });
  });
});
