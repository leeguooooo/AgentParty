// #908 宿主存活探测的单测。
import { describe, expect, test } from "bun:test";
import type { ProcessOwner } from "../src/instance-lock";
import { hasIdentifiableHost, watchParentLiveness } from "../src/parent-liveness";

/** 手动驱动的定时器，让每个用例能精确控制「跑了几个 tick」。 */
function manualSchedule() {
  const ticks: (() => void)[] = [];
  let stopped = 0;
  return {
    schedule: (fn: () => void) => {
      ticks.push(fn);
      return { stop: () => { stopped += 1; } };
    },
    tick: () => { for (const fn of [...ticks]) fn(); },
    stops: () => stopped,
  };
}

function owner(pid: number, alive: () => boolean): ProcessOwner {
  return { pid, alive };
}

describe("watchParentLiveness (#908)", () => {
  test("宿主还活着时什么都不做", () => {
    const clock = manualSchedule();
    const logs: string[] = [];
    let terminated = 0;
    const handle = watchParentLiveness({
      label: "party claude-channel",
      owner: owner(4242, () => true),
      schedule: clock.schedule,
      log: (l) => logs.push(l),
      terminate: () => { terminated += 1; },
    });
    expect(handle.armed).toBe(true);
    expect(handle.hostPid).toBe(4242);
    clock.tick();
    clock.tick();
    expect(terminated).toBe(0);
    expect(logs).toEqual([]);
  });

  test("宿主死掉 ⇒ 打一行说明原因的日志并收尾", () => {
    const clock = manualSchedule();
    const logs: string[] = [];
    let terminated = 0;
    let alive = true;
    watchParentLiveness({
      label: "party claude-channel",
      owner: owner(4242, () => alive),
      schedule: clock.schedule,
      log: (l) => logs.push(l),
      terminate: () => { terminated += 1; },
    });
    clock.tick();
    expect(terminated).toBe(0);
    alive = false;
    clock.tick();
    expect(terminated).toBe(1);
    expect(logs).toHaveLength(1);
    // 「留一行日志说明为什么退」是 #908 明写的要求：光退不说话没法排查。
    expect(logs[0]).toContain("reaping");
    expect(logs[0]).toContain("4242");
    expect(logs[0]).toContain("party claude-channel");
  });

  test("只收尾一次，之后不再重复发信号", () => {
    const clock = manualSchedule();
    let terminated = 0;
    watchParentLiveness({
      label: "x",
      owner: owner(9, () => false),
      schedule: clock.schedule,
      log: () => undefined,
      terminate: () => { terminated += 1; },
    });
    clock.tick();
    clock.tick();
    clock.tick();
    expect(terminated).toBe(1);
  });

  test("stop() 之后宿主再死也不收尾（正常退出路径不会自伤）", () => {
    const clock = manualSchedule();
    let terminated = 0;
    let alive = true;
    const handle = watchParentLiveness({
      label: "x",
      owner: owner(9, () => alive),
      schedule: clock.schedule,
      log: () => undefined,
      terminate: () => { terminated += 1; },
    });
    handle.stop();
    alive = false;
    clock.tick();
    expect(terminated).toBe(0);
    expect(clock.stops()).toBe(1);
  });

  test("启动时就没有可辨认的宿主（ppid≤1，例如被有意 daemonize）⇒ 不接管其生命周期", () => {
    const clock = manualSchedule();
    let terminated = 0;
    for (const pid of [1, 0, -1]) {
      const handle = watchParentLiveness({
        label: "x",
        // alive() 恒 false：若闸门写错，这里会立刻误杀一个人手工起的 daemon。
        owner: owner(pid, () => false),
        schedule: clock.schedule,
        log: () => undefined,
        terminate: () => { terminated += 1; },
      });
      expect(handle.armed).toBe(false);
    }
    clock.tick();
    expect(terminated).toBe(0);
  });

  test("hasIdentifiableHost 只认 >1 的整数 pid", () => {
    expect(hasIdentifiableHost(owner(2, () => true))).toBe(true);
    expect(hasIdentifiableHost(owner(1, () => true))).toBe(false);
    expect(hasIdentifiableHost(owner(0, () => true))).toBe(false);
    expect(hasIdentifiableHost(owner(1.5, () => true))).toBe(false);
    expect(hasIdentifiableHost(owner(Number.NaN, () => true))).toBe(false);
  });
});
