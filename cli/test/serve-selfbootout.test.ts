// #744:launchd 常驻下,终局不该重启的退出(熔断/撤销)要 serve 自 bootout,别被 KeepAlive 绕过安全停机。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_AUTH, EXIT_STREAM_ENDED } from "@agentparty/shared";
import {
  dutyBlockedMarkerPath,
  dutyGenerationFromPlist,
  dutyLockOwnerIsStale,
  dutyLockPath,
  dutyQuarantinedPlistPath,
  EXIT_WAKE_ABANDON_CIRCUIT,
  selfBootoutTerminalDuty,
} from "../src/commands/serve";

const LABEL = "com.agentparty.duty.abc.dev";

function recorder() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const lines: string[] = [];
  const spawn = ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return { status: 0 } as never; }) as never;
  const out = (l: string) => lines.push(l);
  return { calls, lines, spawn, out };
}
const base = (over: Record<string, unknown> = {}) => ({
  platform: "darwin",
  uid: 501,
  label: LABEL,
  writeMarker: () => {},
  acquireLock: () => () => {},
  ...over,
});

describe("selfBootoutTerminalDuty (#744)", () => {
  test("熔断(11)在 macOS + 有 label:bootout 自身 job", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base(), spawn: r.spawn } as never);
    expect(did).toBe(true);
    expect(r.calls).toEqual([{ cmd: "launchctl", args: ["bootout", `gui/501/${LABEL}`] }]);
  });

  test("终局先原子留停机标记再 bootout，供 desktop reconcile 避免误复活", () => {
    const events: string[] = [];
    const bodies: string[] = [];
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, () => {}, {
      ...base({
        acquireLock: () => {
          events.push("lock:acquired");
          return () => events.push("lock:released");
        },
        markerPath: "/tmp/duty-blocked.json",
        now: () => new Date("2026-07-24T00:00:00.000Z"),
        generation: "install-42",
        writeMarker: (path: string, body: string) => {
          events.push(`marker:${path}`);
          bodies.push(body);
        },
        spawn: ((cmd: string, args: string[]) => {
          events.push(`${cmd}:${args.join(" ")}`);
          return { status: 0 } as never;
        }) as never,
      }),
    } as never);

    expect(did).toBe(true);
    expect(events).toEqual([
      "lock:acquired",
      "marker:/tmp/duty-blocked.json",
      `launchctl:bootout gui/501/${LABEL}`,
      "lock:released",
    ]);
    expect(JSON.parse(bodies[0]!)).toEqual({
      schema: "agentparty.duty-blocked.v1",
      label: LABEL,
      reason: "circuit-breaker",
      code: EXIT_WAKE_ABANDON_CIRCUIT,
      generation: "install-42",
      created_at: "2026-07-24T00:00:00.000Z",
    });
  });

  test("终局标记写失败先 disable 再 bootout，避免 reconcile 误复活", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_AUTH, r.out, {
      ...base({
        writeMarker: () => {
          throw new Error("disk full");
        },
      }),
      spawn: r.spawn,
    } as never);

    expect(did).toBe(true);
    expect(r.calls).toEqual([
      { cmd: "launchctl", args: ["disable", `gui/501/${LABEL}`] },
      { cmd: "launchctl", args: ["bootout", `gui/501/${LABEL}`] },
    ]);
    expect(r.lines.some((line) => line.includes("disable") && line.includes("持久"))).toBe(true);
  });

  test("终局标记与 disable 都失败时隔离 plist 后再 bootout", () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const quarantined: string[][] = [];
    const did = selfBootoutTerminalDuty(EXIT_AUTH, (line) => lines.push(line), {
      ...base({
        writeMarker: () => {
          throw new Error("disk full");
        },
        plistPath: "/tmp/duty.plist",
        quarantinePath: "/tmp/duty.plist.terminal-disabled",
        quarantinePlist: (source: string, target: string) => quarantined.push([source, target]),
        spawn: ((_cmd: string, args: string[]) => {
          calls.push(args);
          return { status: args[0] === "disable" ? 1 : 0 } as never;
        }) as never,
      }),
    } as never);

    expect(did).toBe(true);
    expect(calls).toEqual([
      ["disable", `gui/501/${LABEL}`],
      ["bootout", `gui/501/${LABEL}`],
    ]);
    expect(quarantined).toEqual([["/tmp/duty.plist", "/tmp/duty.plist.terminal-disabled"]]);
    expect(lines.some((line) => line.includes("隔离 duty plist"))).toBe(true);
  });

  test("marker、disable、plist 隔离全失败时不 bootout，并准确告警会立即 KeepAlive", () => {
    const calls: string[][] = [];
    const lines: string[] = [];
    const did = selfBootoutTerminalDuty(EXIT_AUTH, (line) => lines.push(line), {
      ...base({
        writeMarker: () => {
          throw new Error("disk full");
        },
        quarantinePlist: () => {
          throw new Error("read only");
        },
        spawn: ((_cmd: string, args: string[]) => {
          calls.push(args);
          return { status: 1 } as never;
        }) as never,
      }),
    } as never);

    expect(did).toBe(false);
    expect(calls).toEqual([["disable", `gui/501/${LABEL}`]]);
    expect(lines.some((line) => line.includes("KeepAlive 重启"))).toBe(true);
  });

  test("终局标记路径与 desktop 约定一致", () => {
    expect(dutyBlockedMarkerPath(LABEL, "/Users/leo")).toBe(
      `/Users/leo/.agentparty/desktop/duty-blocked/${LABEL}.json`,
    );
    expect(dutyQuarantinedPlistPath(LABEL, "/Users/leo")).toBe(
      `/Users/leo/Library/LaunchAgents/${LABEL}.plist.terminal-disabled`,
    );
    expect(dutyLockPath(LABEL, "/Users/leo")).toBe(
      `/Users/leo/.agentparty/desktop/duty-locks/${LABEL}.lock`,
    );
  });

  test("duty 锁只在确认进程已死或 PID 已复用时判 stale，探测未知则失败关闭", () => {
    const owner = "42|Fri Jul 24 12:34:56 2026|nonce";
    expect(dutyLockOwnerIsStale(owner, () => ({ state: "dead" }))).toBe(true);
    expect(dutyLockOwnerIsStale(owner, () => ({
      state: "alive",
      startedAt: "Fri Jul 24 12:34:56 2026",
    }))).toBe(false);
    expect(dutyLockOwnerIsStale(owner, () => ({
      state: "alive",
      startedAt: "Fri Jul 24 12:35:01 2026",
    }))).toBe(true);
    expect(dutyLockOwnerIsStale(owner, () => ({ state: "unknown" }))).toBe(false);
    expect(dutyLockOwnerIsStale("partial-owner", () => ({ state: "dead" }))).toBeNull();
  });

  test("plist generation 解析与旧 serve 防误伤新安装", () => {
    expect(dutyGenerationFromPlist(
      "<key>AP_DUTY_GENERATION</key>\n<string>install-42</string>",
    )).toBe("install-42");
    expect(dutyGenerationFromPlist("<plist/>")).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "agentparty-duty-generation-"));
    const plistPath = join(dir, `${LABEL}.plist`);
    writeFileSync(
      plistPath,
      "<key>AP_DUTY_GENERATION</key><string>new-install</string>",
    );
    const r = recorder();
    let markerWrites = 0;
    try {
      const did = selfBootoutTerminalDuty(EXIT_AUTH, r.out, {
        ...base({
          generation: "old-install",
          plistPath,
          writeMarker: () => {
            markerWrites += 1;
          },
        }),
        spawn: r.spawn,
      } as never);
      expect(did).toBe(false);
      expect(markerWrites).toBe(0);
      expect(r.calls).toEqual([]);
      expect(r.lines.some((line) => line.includes("另一安装代次"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("token 撤销(auth)同样自卸载(重启也没用)", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_AUTH, r.out, { ...base(), spawn: r.spawn } as never);
    expect(did).toBe(true);
    expect(r.calls[0]!.args).toEqual(["bootout", `gui/501/${LABEL}`]);
  });

  test("普通可重启退出(stream-ended)不 bootout——留给 KeepAlive 自愈", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_STREAM_ENDED, r.out, { ...base(), spawn: r.spawn } as never);
    expect(did).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("没跑在 launchd duty 下(无 AP_DUTY_LABEL):什么都不做", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { platform: "darwin", uid: 501, label: undefined, spawn: r.spawn } as never);
    expect(did).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("label 非法(非 duty 前缀 / 含非法字符)→ 拒绝,绝不 bootout(@macmini 评审)", () => {
    for (const bad of ["com.other.job", "com.agentparty.duty.x dev", "com.agentparty.duty.x;rm", "system/"]) {
      const r = recorder();
      const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base({ label: bad }), spawn: r.spawn } as never);
      expect(did).toBe(false);
      expect(r.calls).toEqual([]);
    }
  });

  test("非 macOS 不碰 launchctl", () => {
    const r = recorder();
    const did = selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base({ platform: "linux" }), spawn: r.spawn } as never);
    expect(did).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("bootout 抛错也不炸(best-effort,退出码仍对)", () => {
    const throwing = (() => { throw new Error("launchctl gone"); }) as never;
    const r = recorder();
    expect(() => selfBootoutTerminalDuty(EXIT_WAKE_ABANDON_CIRCUIT, r.out, { ...base(), spawn: throwing } as never)).not.toThrow();
  });

  test("spawnSync 返回非零/error(不抛)→ 记警告,不静默当成功(#745)", () => {
    for (const bad of [{ status: 1 }, { error: new Error("ENOENT") }, { signal: "SIGTERM", status: null }]) {
      const lines: string[] = [];
      const failSpawn = (() => bad) as never;
      const did = selfBootoutTerminalDuty(EXIT_AUTH, (l) => lines.push(l), { ...base(), spawn: failSpawn } as never);
      expect(did).toBe(true);
      expect(lines.some((l) => l.includes("bootout") && l.includes("失败"))).toBe(true);
    }
  });
});
