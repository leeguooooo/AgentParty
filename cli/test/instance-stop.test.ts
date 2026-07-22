// #741:同机同频道多 agent 时,要能只停「本身份」的 serve/watch,不像 `pkill -f` 那样误杀别人的。
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, instanceLockHolderPid, instanceLockTarget, stopOwnInstance } from "../src/instance-lock";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "ap-stop-"));
  dirs.push(d);
  return d;
}

const SERVER = "https://agentparty.test";
const TOKEN = "ap_tok_A";

describe("instanceLockHolderPid / stopOwnInstance (#741)", () => {
  test("有活持有者 → 返回其 pid;没锁 → null", () => {
    const d = dir();
    const target = instanceLockTarget(SERVER, TOKEN, "dev");
    expect(instanceLockHolderPid("serve", target, d)).toBeNull();
    const lock = acquireInstanceLock("serve", target, d);
    expect(lock.ok).toBe(true);
    expect(instanceLockHolderPid("serve", target, d)).toBe(process.pid);
    lock.release?.();
    expect(instanceLockHolderPid("serve", target, d)).toBeNull();
  });

  test("不同身份(token)在同频道互不影响——只停自己那把", () => {
    const d = dir();
    const a = acquireInstanceLock("serve", instanceLockTarget(SERVER, "tokA", "dev"), d);
    const b = acquireInstanceLock("serve", instanceLockTarget(SERVER, "tokB", "dev"), d);
    expect(a.ok && b.ok).toBe(true);
    // 身份 A 的 target 找不到 B 的锁(反之亦然)
    expect(instanceLockHolderPid("serve", instanceLockTarget(SERVER, "tokA", "dev"), d)).toBe(process.pid);
    expect(instanceLockHolderPid("watch", instanceLockTarget(SERVER, "tokA", "dev"), d)).toBeNull(); // kind 也隔离
    a.release?.();
    b.release?.();
  });

  test("没有在跑的 listener → 返回 0、提示 nothing to stop、不发信号", () => {
    const d = dir();
    const kill = spyOn(process, "kill");
    const lines: string[] = [];
    const code = stopOwnInstance("serve", SERVER, TOKEN, "dev", (l) => lines.push(l), d);
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("nothing to stop");
    // 只可能有 signal 0 的存活探测,绝不发 SIGTERM
    expect(kill.mock.calls.some(([, sig]) => sig === "SIGTERM")).toBe(false);
    kill.mockRestore();
  });

  test("持有者是本进程 → 自我保护:返回 0、不给自己发 SIGTERM", () => {
    const d = dir();
    const lock = acquireInstanceLock("serve", instanceLockTarget(SERVER, TOKEN, "dev"), d);
    expect(lock.ok).toBe(true);
    const kill = spyOn(process, "kill");
    const code = stopOwnInstance("serve", SERVER, TOKEN, "dev", () => {}, d);
    expect(code).toBe(0);
    expect(kill.mock.calls.some(([, sig]) => sig === "SIGTERM")).toBe(false);
    kill.mockRestore();
    lock.release?.();
  });
});
