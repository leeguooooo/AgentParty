// #1072：部署后 smoke 的统一「先等 + 退避重试」。三次发版被三种瞬时症状卡住，全在上传完成后
// 几十秒内、事后复跑都过。这里钉住：首次前等 settle、失败按 5/10/20/40s 退避、全败时把每次原因都带出。
import { describe, expect, test } from "bun:test";
import { retryDelaysMs, runSmokeWithRetry } from "../worker/scripts/smoke-retry.mjs";

function harness() {
  const sleeps: number[] = [];
  const logs: string[] = [];
  return {
    sleeps,
    logs,
    opts: { sleep: async (ms: number) => void sleeps.push(ms), log: (l: string) => void logs.push(l) },
  };
}

describe("retryDelaysMs", () => {
  test("5 次尝试 ⇒ 4 段退避：5s 10s 20s 40s", () => {
    expect(retryDelaysMs(5)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(retryDelaysMs(1)).toEqual([]);
  });
});

describe("runSmokeWithRetry", () => {
  test("首次就过 ⇒ 不睡、不打重试日志", async () => {
    const h = harness();
    let calls = 0;
    await runSmokeWithRetry("x", () => void (calls += 1), h.opts);
    expect(calls).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  test("settleMs ⇒ 首次尝试前先等一次，且只等这一次", async () => {
    const h = harness();
    await runSmokeWithRetry("x", () => undefined, { ...h.opts, settleMs: 10_000 });
    expect(h.sleeps).toEqual([10_000]);
    expect(h.logs[0]).toContain("waiting 10s");
  });

  test("前两次失败第三次过 ⇒ 睡 5s、10s，最后一条日志带上前几次的症状", async () => {
    const h = harness();
    let calls = 0;
    await runSmokeWithRetry(
      "pairing",
      () => {
        calls += 1;
        if (calls < 3) throw new Error(`500 #${calls}`);
      },
      h.opts,
    );
    expect(calls).toBe(3);
    expect(h.sleeps).toEqual([5_000, 10_000]);
    expect(h.logs.at(-1)).toContain("passed on attempt 3");
    expect(h.logs.at(-1)).toContain("500 #1");
  });

  test("全部失败 ⇒ 抛错，信息里每次的原因都在（rerun 的人要看得见前几次是什么症状）", async () => {
    const h = harness();
    let calls = 0;
    await expect(
      runSmokeWithRetry("peers", () => {
        calls += 1;
        throw new Error(`matches=${calls}`);
      }, { ...h.opts, attempts: 3 }),
    ).rejects.toThrow(/failed 3 attempts — #1 matches=1 \| #2 matches=2 \| #3 matches=3/);
    expect(h.sleeps).toEqual([5_000, 10_000]); // 最后一次失败后不再睡
  });

  test("异步 smoke 同样适用", async () => {
    const h = harness();
    let calls = 0;
    await runSmokeWithRetry("async", async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    }, h.opts);
    expect(calls).toBe(2);
  });
});
