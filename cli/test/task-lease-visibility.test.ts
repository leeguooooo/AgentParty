// #931：闸装了 ≠ 闸会落下。
//
// #885 的租约有两个自己写在注释里的边界，实机上都会被踩到：认不出执行体标识时**静默**降级成
// unenforced（只有一行 stderr warn），以及互斥只在本机文件级成立。本文件钉住的是「这件事必须
// 可被看见」——`party who` 那行不许再断言「会被拒」、`party doctor` 要在真有第二个执行体时把它
// 报为问题、JSON 里要能程序化读到。跨机那半仍是缺口，最后一组用例把缺口本身钉住。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskLeaseDoctorLines } from "../src/commands/doctor";
import { annotateTaskLeaseEnforcement, topologyNote, type Row } from "../src/commands/who";
import {
  diagnoseTaskLeaseEnforcement,
  formatTaskLeaseEnforcement,
  localExecutorEvidence,
  shouldSurfaceTaskLeaseEnforcement,
} from "../src/task-lease-diagnosis";
import { acquireTaskLease, taskLeaseDir, taskLeaseKey } from "../src/task-lease";
import { processStartedAt } from "../src/instance-lock";

const NOW = 1_786_000_000_000;
const SERVER = "https://party.example";
const TOKEN = "ap_tok";
const SAVED_ENV = { ...process.env };
let home: string;

/** 梯子上每一级都清干净：漏一个（#931 前漏的正是 CLAUDE_CODE_SESSION_ID）就会在真实 harness
 *  里悄悄走到「认得出」那条分支，把被测的闸整个遮住，退回旧实现照样全绿。 */
function clearExecutorEnv(): void {
  for (const key of ["AGENTPARTY_EXECUTOR_ID", "AP_RUNNER_WORKDIR", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID"]) {
    delete process.env[key];
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-lease-vis-"));
  process.env.AGENTPARTY_HOME = home;
  clearExecutorEnv();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in SAVED_ENV)) delete process.env[key];
  Object.assign(process.env, SAVED_ENV);
  rmSync(home, { recursive: true, force: true });
});

function otherExecutorHoldsLease(taskId = 9, holder = "runner:claude:reception"): void {
  const dir = taskLeaseDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${taskLeaseKey(SERVER, TOKEN, "king", taskId)}.json`),
    JSON.stringify({
      executor_id: holder,
      channel: "king",
      task_id: taskId,
      acquired_at: Date.now(),
      renewed_at: Date.now(),
      expires_at: Date.now() + 600_000,
    }),
  );
}

describe("认不出执行体这件事必须可见（不只是 stderr 一行 warn）", () => {
  test("说得出结论、为什么、会怎样、一条可执行命令，并且说清只在本机成立", () => {
    const d = diagnoseTaskLeaseEnforcement({});
    expect(d.enforced).toBe(false);
    expect(d.reason).toBe("no_signal");
    const text = formatTaskLeaseEnforcement(d).join("\n");
    expect(text).toContain("没落闸");
    expect(text).toMatch(/为什么:/);
    expect(text).toMatch(/会怎样:.*不会被拒/);
    expect(text).toMatch(/怎么修:.*AGENTPARTY_EXECUTOR_ID/);
    // 边界那行是硬要求：「本机互斥」被读成「全局互斥」比没有闸更危险。
    expect(text).toMatch(/边界:.*跨机缺口/);
  });

  test("设了但值不合法与一个都没设，给的是不同的原因（修法不同）", () => {
    expect(diagnoseTaskLeaseEnforcement({ AGENTPARTY_EXECUTOR_ID: "bad id" }).reason).toBe("malformed");
    expect(formatTaskLeaseEnforcement(diagnoseTaskLeaseEnforcement({ AGENTPARTY_EXECUTOR_ID: "bad id" })).join("\n"))
      .toMatch(/值不合法/);
    expect(diagnoseTaskLeaseEnforcement({}).reason).toBe("no_signal");
  });

  test("认得出时不喊狼来了，且说得出凭什么认得出", () => {
    const d = diagnoseTaskLeaseEnforcement({ CLAUDE_CODE_SESSION_ID: "sess-1" });
    expect(d.enforced).toBe(true);
    expect(d.source).toBe("claude_session");
    expect(formatTaskLeaseEnforcement(d).join("\n")).toContain("已落闸");
    expect(shouldSurfaceTaskLeaseEnforcement(d, true)).toBe(false);
  });
});

describe("party who：不许再断言「会被拒」", () => {
  const blockingRow = (): Row => ({
    name: "king-claude",
    kind: "agent",
    tier: "online",
    topology_conflicts: [
      { kind: "same_local_installation", with: [], runtime_count: 1, same_identity: true, severity: "blocking" },
    ],
  } as unknown as Row);
  const advisoryRow = (): Row => ({
    name: "other",
    kind: "agent",
    tier: "online",
    topology_conflicts: [
      { kind: "same_local_installation", with: ["caller"], runtime_count: 1, same_identity: false, severity: "advisory" },
    ],
  } as unknown as Row);

  // 同一个 fixture、同一行冲突，只有 enforcement 一个变量在动——这样「refused / NOT refused」
  // 只可能由被测的那道闸决定，不会有别的分支替它满足条件。
  test("没落闸时那行说的是 NOT refused，落了闸才是 refused", () => {
    const unenforced = annotateTaskLeaseEnforcement([blockingRow()], diagnoseTaskLeaseEnforcement({}))[0]!;
    expect(unenforced.task_lease).toMatchObject({ enforced: false, scope: "local_home", reason: "no_signal" });
    expect(topologyNote(unenforced)).toContain("NOT refused");
    expect(topologyNote(unenforced)).not.toMatch(/claims on one task are refused/);

    const enforced = annotateTaskLeaseEnforcement(
      [blockingRow()],
      diagnoseTaskLeaseEnforcement({ AGENTPARTY_EXECUTOR_ID: "runner:claude:reception" }),
    )[0]!;
    expect(enforced.task_lease).toMatchObject({ enforced: true, executor_id: "runner:claude:reception" });
    expect(topologyNote(enforced)).toContain("concurrent claims on one task are refused");
    expect(topologyNote(enforced)).not.toContain("NOT refused");
  });

  test("只贴在 blocking 的那些行上：别人家的 runtime 不背这口锅", () => {
    const rows = annotateTaskLeaseEnforcement([blockingRow(), advisoryRow()], diagnoseTaskLeaseEnforcement({}));
    expect(rows[0]!.task_lease).toBeDefined();
    expect(rows[1]!.task_lease).toBeUndefined();
    expect(topologyNote(rows[1]!)).not.toContain("NOT refused");
  });

  test("拿不到判定时行为不变（老调用方不受影响）", () => {
    const rows = annotateTaskLeaseEnforcement([blockingRow()], undefined);
    expect(rows[0]!.task_lease).toBeUndefined();
    expect(topologyNote(rows[0]!)).toContain("concurrent claims on one task are refused");
  });
});

describe("本机「另一个执行体」的证据（带 server 维度，#865）", () => {
  test("别的执行体持着这个身份的活租约 = 有证据", () => {
    otherExecutorHoldsLease();
    const evidence = localExecutorEvidence({ server: SERVER, token: TOKEN, channel: "king", executorId: null });
    expect(evidence.present).toBe(true);
    expect(evidence.kinds).toContain("task_lease");
  });

  test("只有自己那张租约不算「另一个」", () => {
    otherExecutorHoldsLease(9, "runner:claude:me");
    const evidence = localExecutorEvidence({ server: SERVER, token: TOKEN, channel: "king", executorId: "runner:claude:me" });
    expect(evidence.present).toBe(false);
  });

  test("过期的租约不作数（陈旧文件不许把用户吓停手）", () => {
    const dir = taskLeaseDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${taskLeaseKey(SERVER, TOKEN, "king", 9)}.json`),
      JSON.stringify({ executor_id: "runner:claude:dead", channel: "king", task_id: 9, acquired_at: 1, renewed_at: 1, expires_at: NOW }),
    );
    expect(localExecutorEvidence({ server: SERVER, token: TOKEN, channel: "king", executorId: null, now: NOW + 1 }).present)
      .toBe(false);
  });

  test("另一台 server 上的同名频道不算数（本机两台生产实例）", () => {
    otherExecutorHoldsLease();
    const evidence = localExecutorEvidence({
      server: "https://other.example",
      token: TOKEN,
      channel: "king",
      executorId: null,
    });
    expect(evidence.present).toBe(false);
  });

  test("活着的 serve 实例锁也是证据", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      const lockDir = mkdtempSync(join(tmpdir(), "ap-lock-"));
      const startedAt = processStartedAt(child.pid);
      expect(startedAt).toBeDefined();
      const { instanceLockTarget } = await import("../src/instance-lock");
      writeFileSync(
        join(lockDir, `serve-${instanceLockTarget(SERVER, TOKEN, "king")}.lock`),
        JSON.stringify({ pid: child.pid, id: "x", started_at: startedAt, kind: "serve", channel: "king" }),
      );
      const evidence = localExecutorEvidence({ server: SERVER, token: TOKEN, channel: "king", executorId: null, lockDir });
      expect(evidence.kinds).toContain("serve");
      rmSync(lockDir, { recursive: true, force: true });
    } finally {
      child.kill();
    }
  });
});

describe("party doctor：真有第二个执行体时报为问题，没有时不制造噪音", () => {
  const auth = async () => ({ server: SERVER, token: TOKEN });
  const channel = () => "king";

  test("没落闸 + 本机确有另一个执行体 → 报出来，并给一条可执行命令", async () => {
    otherExecutorHoldsLease();
    const lines = await taskLeaseDoctorLines({ auth, channel });
    expect(lines.join("\n")).toContain("没落闸");
    expect(lines.join("\n")).toMatch(/怎么修:.*AGENTPARTY_EXECUTOR_ID/);
    expect(lines.join("\n")).toMatch(/证据:/);
  });

  // 下面两条各只翻转 AND 门的一侧。任一侧单独满足就输出，等于闸失效。
  test("没落闸但本机只有自己 → 不报（无冲突不制造噪音）", async () => {
    const lines = await taskLeaseDoctorLines({ auth, channel });
    expect(lines).toEqual([]);
  });

  test("有另一个执行体但已落闸 → 不报（闸落下来了就不是问题）", async () => {
    otherExecutorHoldsLease();
    process.env.AGENTPARTY_EXECUTOR_ID = "session:claude:harness";
    const lines = await taskLeaseDoctorLines({ auth, channel });
    expect(lines).toEqual([]);
  });

  test("没登录 / 没绑频道时 doctor 照常跑，不抛不报", async () => {
    otherExecutorHoldsLease();
    expect(await taskLeaseDoctorLines({ auth: async () => ({}), channel })).toEqual([]);
    expect(await taskLeaseDoctorLines({ auth, channel: () => null })).toEqual([]);
  });
});

describe("跨机缺口（#931 缺口 1）——尚未做服务端租约，这里钉住现状", () => {
  // ⚠️ 这不是「期望的行为」，是**已知缺口的现状**。服务端 (identity, channel, task) 租约落地后，
  // 这条用例必须翻红并改成「第二个被拒」——它存在的意义就是不让人误以为跨机已经拦得住。
  test("两个 AGENTPARTY_HOME 的同一身份都能认领同一个 task（本机文件锁挡不住）", () => {
    const other = mkdtempSync(join(tmpdir(), "ap-lease-other-home-"));
    try {
      const key = taskLeaseKey(SERVER, TOKEN, "king", 9);
      const first = acquireTaskLease({ key, channel: "king", taskId: 9, executorId: "runner:claude:a", dir: taskLeaseDir(home) });
      const second = acquireTaskLease({ key, channel: "king", taskId: 9, executorId: "session:claude:b", dir: taskLeaseDir(other) });
      expect(first.state).toBe("acquired");
      expect(second.state).toBe("acquired"); // ← 缺口：互斥只在同一个 home 内成立
      // 缺口不许被静默：任何一次「没落闸/落闸」的呈现都必须带上这句边界。
      expect(formatTaskLeaseEnforcement(diagnoseTaskLeaseEnforcement({})).join("\n")).toMatch(/另一台机器.*仍挡不住/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("同一个 home 内，反向用例照旧：不同 task、不同身份都不许被拒", () => {
    const dir = taskLeaseDir(home);
    acquireTaskLease({ key: taskLeaseKey(SERVER, TOKEN, "king", 9), channel: "king", taskId: 9, executorId: "runner:a", dir });
    // 不同 task
    expect(acquireTaskLease({ key: taskLeaseKey(SERVER, TOKEN, "king", 10), channel: "king", taskId: 10, executorId: "session:b", dir }).state)
      .toBe("acquired");
    // 不同身份（token 不同）
    expect(acquireTaskLease({ key: taskLeaseKey(SERVER, "ap_other", "king", 9), channel: "king", taskId: 9, executorId: "session:b", dir }).state)
      .toBe("acquired");
    // 不同 server 上的同名频道 + 同 task 号（#865：本机两台生产实例）
    expect(acquireTaskLease({ key: taskLeaseKey("https://other.example", TOKEN, "king", 9), channel: "king", taskId: 9, executorId: "session:b", dir }).state)
      .toBe("acquired");
  });
});
