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
import { acquireTaskLease, readTaskLease, taskLeaseDir, taskLeaseKey } from "../src/task-lease";
import {
  acquireTaskLeaseAcrossMachines,
  releaseTaskLeaseAcrossMachines,
  serverLeaseUnsupported,
  type AcquireAcrossMachinesOptions,
} from "../src/task-lease-remote";
import { RestError } from "../src/rest";
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
    // 认不出执行体时连服务端租约都送不上去（#936），所以边界仍然是「另一台机器仍挡不住」。
    expect(text).toMatch(/边界:.*另一台机器.*仍挡不住/);
    expect(d.scope).toBe("local_home");
  });

  test("认得出执行体时，边界那行改说服务端租约（#936），不再谎报也不再吓人", () => {
    const d = diagnoseTaskLeaseEnforcement({ AGENTPARTY_EXECUTOR_ID: "harness:mac:1" });
    expect(d.enforced).toBe(true);
    expect(d.scope).toBe("server");
    const text = formatTaskLeaseEnforcement(d).join("\n");
    // 两侧各断一次：认得出 ⇒ 说服务端租约；不许再输出「仍挡不住」那句（否则等于没修）。
    expect(text).toMatch(/边界:.*服务端.*租约/);
    expect(text).not.toMatch(/另一台机器.*仍挡不住/);
    // 老服务端会退回本机这件事必须仍然说得出来——别让人以为升级客户端就万事大吉。
    expect(text).toMatch(/老服务端.*退回本机/);
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

describe("跨机互斥（#936）——服务端 (identity, channel, task) 租约", () => {
  // 这一组的前身是 #935 里那条「钉住缺口」的用例：两个 AGENTPARTY_HOME 下的同一身份都能认领
  // 同一个 task，注释写明「服务端租约落地后此用例必须翻红」。现在它翻红了，改成断言相反的事实。
  //
  // 服务端那半用一个**共享的租约台账**代表「两台机器看到的是同一台服务端」。台账逐字实现
  // worker 那条 upsert 的判据（同 executor 续期 / 过期可接手 / force 抢占 / 否则拒），
  // 真实服务端行为由 worker/test/task-lease.spec.ts 在真 workerd + 真 D1 上覆盖。
  interface ServerLease {
    executor_id: string;
    acquired_at: number;
    renewed_at: number;
    expires_at: number;
    taken_over_from?: string;
  }

  function makeServer() {
    const ledger = new Map<string, ServerLease>();
    const calls: { executor_id: string; force: boolean }[] = [];
    const claim: NonNullable<AcquireAcrossMachinesOptions["claim"]> = async (_server, _token, slug, id, body) => {
      calls.push({ executor_id: body.executor_id, force: body.force === true });
      const key = `${slug}#${id}`;
      const now = Date.now();
      const existing = ledger.get(key);
      const mine = existing !== undefined && existing.executor_id === body.executor_id;
      const live = existing !== undefined && existing.expires_at > now;
      if (existing !== undefined && live && !mine && body.force !== true) {
        throw new RestError(409, "task_lease_held", "held", {
          error: { code: "task_lease_held", message: "held" },
          state: "denied",
          scope: "server",
          reason: "held_by_other",
          holder: { ...existing, channel: slug, task_id: id },
          task_untouched: true,
          server_time: now,
        });
      }
      const state = mine ? "renewed" : existing !== undefined && live ? "forced" : "acquired";
      const next: ServerLease = {
        executor_id: body.executor_id,
        acquired_at: mine && existing !== undefined ? existing.acquired_at : now,
        renewed_at: now,
        expires_at: now + (body.ttl_ms ?? 600_000),
        ...(state === "forced" && existing !== undefined ? { taken_over_from: existing.executor_id } : {}),
      };
      ledger.set(key, next);
      return {
        type: "task_lease",
        state,
        scope: "server",
        holder: { ...next, channel: slug, task_id: id },
        ttl_ms: body.ttl_ms ?? 600_000,
        server_time: now,
      };
    };
    return { claim, ledger, calls };
  }

  function machine(homeDir: string, executorId: string, srv: ReturnType<typeof makeServer>): AcquireAcrossMachinesOptions {
    return {
      key: taskLeaseKey(SERVER, TOKEN, "king", 9),
      channel: "king",
      taskId: 9,
      executorId,
      server: SERVER,
      token: TOKEN,
      dir: taskLeaseDir(homeDir),
      claim: srv.claim,
    };
  }

  test("两台机器（两个 AGENTPARTY_HOME）的同一身份：第二台被拒，且说得出谁持有", async () => {
    const other = mkdtempSync(join(tmpdir(), "ap-lease-other-home-"));
    const srv = makeServer();
    try {
      const first = await acquireTaskLeaseAcrossMachines(machine(home, "runner:claude:a", srv));
      const second = await acquireTaskLeaseAcrossMachines(machine(other, "session:claude:b", srv));
      expect(first.state).toBe("acquired");
      expect(first.scope).toBe("server");
      // ← 这一行就是 #935 钉住的那个缺口，现在必须是 denied。
      expect(second.state).toBe("denied");
      expect(second.scope).toBe("server");
      expect(second.holder?.executor_id).toBe("runner:claude:a");
      // 拒绝不能吞任务：被拒方要能知道等多久（#885 红线的可执行那一半）。
      expect(second.holder?.expires_at).toBeGreaterThan(Date.now());
      // 被拒的一方不许在本机留下一张自己不用、却挡着别人的租约（#908 那类锁残留）。
      expect(readTaskLease(taskLeaseKey(SERVER, TOKEN, "king", 9), taskLeaseDir(other))).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("降级：老服务端不认这条路由 ⇒ 退回本机租约，**不放行**", async () => {
    const other = mkdtempSync(join(tmpdir(), "ap-lease-legacy-"));
    // 老服务端 = 路由没命中，Hono 回裸 404（没有 error.code）。
    const legacy: NonNullable<AcquireAcrossMachinesOptions["claim"]> = async () => {
      throw new RestError(404, null, "404 Not Found", null);
    };
    try {
      const opts: AcquireAcrossMachinesOptions = { ...machine(home, "runner:claude:a", makeServer()), claim: legacy };
      const first = await acquireTaskLeaseAcrossMachines(opts);
      expect(first.state).toBe("acquired");
      // 退回本机，并且**说出来**——scope 必须是 local_home，否则调用方会误读成跨机已互斥。
      expect(first.scope).toBe("local_home");
      expect(first.degraded).toBe("server_unsupported");

      // 「退回本机」≠「放行」：同一个 HOME 内的第二个执行体照样被拒。
      const sameHome = await acquireTaskLeaseAcrossMachines({ ...opts, executorId: "session:claude:b" });
      expect(sameHome.state).toBe("denied");
      expect(sameHome.scope).toBe("local_home");
      expect(sameHome.holder?.executor_id).toBe("runner:claude:a");

      // 另一个 HOME 仍挡不住——这是老服务端下**已知且被说出来**的边界，不是静默缺口。
      const otherHome = await acquireTaskLeaseAcrossMachines({
        ...opts,
        dir: taskLeaseDir(other),
        executorId: "session:claude:b",
      });
      expect(otherHome.state).toBe("acquired");
      expect(otherHome.degraded).toBe("server_unsupported");

      // 降级带回来的必须是**本机那次判定的真实结果**，不是一个「反正放行」的常量。
      // 逐项翻一遍本机能给出的每一种非拒绝结论：
      const renewed = await acquireTaskLeaseAcrossMachines(opts);
      expect(renewed.state).toBe("renewed");
      expect(renewed.holder?.executor_id).toBe("runner:claude:a");
      const forced = await acquireTaskLeaseAcrossMachines({ ...opts, executorId: "session:claude:b", force: true });
      expect(forced.state).toBe("forced");
      expect(forced.holder?.taken_over_from).toBe("runner:claude:a");
      // 认不出执行体时降级不许被粉饰成「拿到了」——那正是 #931 修掉的那种假象。
      const unenforced = await acquireTaskLeaseAcrossMachines({ ...opts, executorId: null });
      expect(unenforced.state).toBe("unenforced");
      expect(unenforced.reason).toBe("no_executor_identity");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("服务端在但这次没答上来（网络抖动/5xx）：同样退回本机，原因与老服务端分开", async () => {
    const flaky: NonNullable<AcquireAcrossMachinesOptions["claim"]> = async () => {
      throw new RestError(503, "unavailable", "upstream down", { error: { code: "unavailable" } });
    };
    const res = await acquireTaskLeaseAcrossMachines({
      ...machine(home, "runner:claude:a", makeServer()),
      claim: flaky,
    });
    expect(res.state).toBe("acquired");
    expect(res.scope).toBe("local_home");
    // 两档的修法完全不同：一个是升级服务端，一个是重试。塌缩成一个 boolean 就说不清了。
    expect(res.degraded).toBe("server_unavailable");
  });

  test("真 404（频道/任务不存在，带 error.code）不算「老服务端」", async () => {
    const missing: NonNullable<AcquireAcrossMachinesOptions["claim"]> = async () => {
      throw new RestError(404, "not_found", "task not found", { error: { code: "not_found" } });
    };
    const res = await acquireTaskLeaseAcrossMachines({
      ...machine(home, "runner:claude:a", makeServer()),
      claim: missing,
    });
    expect(res.degraded).toBe("server_unavailable");
    expect(serverLeaseUnsupported(new RestError(404, "not_found", "x", null))).toBe(false);
    expect(serverLeaseUnsupported(new RestError(404, null, "404 Not Found", null))).toBe(true);
  });

  test("认不出执行体：不给服务端发任何请求（没有可上送的标识），并如实报 unenforced", async () => {
    const srv = makeServer();
    const res = await acquireTaskLeaseAcrossMachines({ ...machine(home, "x", srv), executorId: null });
    expect(res.state).toBe("unenforced");
    expect(res.scope).toBe("local_home");
    expect(srv.calls).toEqual([]);
  });

  test("本机就能答「被拒」时不发网络请求（结论不会因为问服务端而改变）", async () => {
    const srv = makeServer();
    // 本机先由另一个执行体持租——注意这里**没有**经过服务端，模拟一个老 CLI 留下的本机租约。
    acquireTaskLease({
      key: taskLeaseKey(SERVER, TOKEN, "king", 9),
      channel: "king",
      taskId: 9,
      executorId: "runner:legacy",
      dir: taskLeaseDir(home),
    });
    const res = await acquireTaskLeaseAcrossMachines(machine(home, "session:new", srv));
    expect(res.state).toBe("denied");
    expect(res.scope).toBe("local_home");
    expect(srv.calls).toEqual([]);
  });

  test("--force-lease 一路传到服务端；被抢的那个记进 taken_over_from", async () => {
    const other = mkdtempSync(join(tmpdir(), "ap-lease-force-"));
    const srv = makeServer();
    try {
      await acquireTaskLeaseAcrossMachines(machine(home, "runner:incumbent", srv));
      const forced = await acquireTaskLeaseAcrossMachines({
        ...machine(other, "runner:taker", srv),
        force: true,
      });
      expect(forced.state).toBe("forced");
      expect(forced.scope).toBe("server");
      expect(forced.holder?.taken_over_from).toBe("runner:incumbent");
      expect(srv.calls.at(-1)).toEqual({ executor_id: "runner:taker", force: true });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("交还后另一台机器立刻能接手（不必等 TTL）", async () => {
    const other = mkdtempSync(join(tmpdir(), "ap-lease-release-"));
    const srv = makeServer();
    const releasedFor: string[] = [];
    try {
      await acquireTaskLeaseAcrossMachines(machine(home, "runner:a", srv));
      expect((await acquireTaskLeaseAcrossMachines(machine(other, "runner:b", srv))).state).toBe("denied");
      await releaseTaskLeaseAcrossMachines({
        server: SERVER,
        token: TOKEN,
        key: taskLeaseKey(SERVER, TOKEN, "king", 9),
        channel: "king",
        taskId: 9,
        executorId: "runner:a",
        dir: taskLeaseDir(home),
        release: async (_s, _t, slug, id, executorId) => {
          releasedFor.push(executorId);
          srv.ledger.delete(`${slug}#${id}`);
          return { type: "task_lease", state: "released", scope: "server", released: true };
        },
      });
      expect(releasedFor).toEqual(["runner:a"]);
      expect((await acquireTaskLeaseAcrossMachines(machine(other, "runner:b", srv))).state).toBe("acquired");
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
