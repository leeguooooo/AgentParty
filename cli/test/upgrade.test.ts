import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { compareVersions, downloadPartyUpgrade, maybeReexecUpgrade, pendingUpgrade } from "../src/upgrade";
import { run as runUpgrade, type UpgradeCommandDeps } from "../src/commands/upgrade";

function sha256(bytes: Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

describe("upgrade", () => {
  test("compareVersions orders by numeric segments", () => {
    expect(compareVersions("0.2.61", "0.2.60")).toBe(1);
    expect(compareVersions("0.2.60", "0.2.61")).toBe(-1);
    expect(compareVersions("0.2.61", "0.2.61")).toBe(0);
    expect(compareVersions("0.3.0", "0.2.99")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  test("pendingUpgrade returns the on-disk version only when it is newer", () => {
    const deps = {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.61",
    };
    expect(pendingUpgrade(deps)).toBe("0.2.61");
    expect(pendingUpgrade({ ...deps, readInstalledVersion: () => "0.2.60" })).toBeNull();
    expect(pendingUpgrade({ ...deps, readInstalledVersion: () => "0.2.59" })).toBeNull();
  });

  test("pendingUpgrade skips when execPath is not a party binary (dev / bun)", () => {
    expect(
      pendingUpgrade({ runningVersion: "0.2.60", execPath: "/opt/homebrew/bin/bun", readInstalledVersion: () => "9.9.9" }),
    ).toBeNull();
  });

  test("pendingUpgrade skips when the on-disk version is unreadable", () => {
    expect(
      pendingUpgrade({ runningVersion: "0.2.60", execPath: "/usr/local/bin/party", readInstalledVersion: () => null }),
    ).toBeNull();
  });

  test("maybeReexecUpgrade only re-execs when auto is on and a newer version exists", () => {
    const calls: Array<{ path: string; argv: string[] }> = [];
    const deps = {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      readInstalledVersion: () => "0.2.61",
      reexec: (path: string, argv: string[]) => calls.push({ path, argv }),
    };
    // auto off: reports pending, does not re-exec
    expect(maybeReexecUpgrade(false, deps)).toEqual({ pending: "0.2.61", reexeced: false });
    expect(calls).toHaveLength(0);
    // auto on: re-execs
    expect(maybeReexecUpgrade(true, deps)).toEqual({ pending: "0.2.61", reexeced: true });
    expect(calls[0]!.path).toBe("/usr/local/bin/party");
    // no pending: nothing
    expect(maybeReexecUpgrade(true, { ...deps, readInstalledVersion: () => "0.2.60" })).toEqual({
      pending: null,
      reexeced: false,
    });
  });

  test("downloadPartyUpgrade fetches release assets, verifies sha256, and atomically installs", async () => {
    const archive = new TextEncoder().encode("fake tarball");
    const calls: Array<{ source: string; target: string }> = [];
    const result = await downloadPartyUpgrade({ version: "0.2.61" }, {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      platform: "darwin",
      arch: "arm64",
      fetchBytes: async (url) => url.endsWith(".sha256")
        ? new TextEncoder().encode(`${sha256(archive)}  party-darwin-arm64.tar.gz\n`)
        : archive,
      extractPartyBinary: async (_archivePath, outDir) => {
        const binary = `${outDir}/party`;
        writeFileSync(binary, "binary");
        return binary;
      },
      installBinary: (source, target) => calls.push({ source, target }),
    });
    expect(result).toMatchObject({
      running_version: "0.2.60",
      target_version: "0.2.61",
      target: "darwin-arm64",
      installed: true,
      install_path: "/usr/local/bin/party",
    });
    expect(result.asset_url).toContain("/v0.2.61/party-darwin-arm64.tar.gz");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe("/usr/local/bin/party");
  });

  test("downloadPartyUpgrade refuses a checksum mismatch before install", async () => {
    const archive = new TextEncoder().encode("fake tarball");
    const installs: string[] = [];
    await expect(downloadPartyUpgrade({ version: "0.2.61" }, {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      platform: "linux",
      arch: "x64",
      fetchBytes: async (url) => url.endsWith(".sha256")
        ? new TextEncoder().encode(`${"0".repeat(64)}  party-linux-x64.tar.gz\n`)
        : archive,
      installBinary: (_source, target) => installs.push(target),
    })).rejects.toThrow("sha256 mismatch");
    expect(installs).toHaveLength(0);
  });

  test("downloadPartyUpgrade refuses dev execPath and check mode never installs", async () => {
    await expect(downloadPartyUpgrade({ version: "0.2.61" }, {
      runningVersion: "0.2.60",
      execPath: "/opt/homebrew/bin/bun",
    })).rejects.toThrow("compiled party binary");

    const result = await downloadPartyUpgrade({ version: "0.2.60", checkOnly: true }, {
      runningVersion: "0.2.60",
      execPath: "/usr/local/bin/party",
      platform: "linux",
      arch: "arm64",
      installBinary: () => { throw new Error("must not install"); },
    });
    expect(result).toMatchObject({ installed: false, target: "linux-arm64", target_version: "0.2.60" });
  });
});

// #985：`party upgrade` 只升 CLI 不升 Claude 插件，升完立刻 plugin_version_mismatch。
// 桩照真机行为：`plugin update` 才换版本；对齐目标必须是**刚装上的**版本（本进程还是旧二进制）。
describe("party upgrade syncs the claude plugin (#985)", () => {
  const PLUGIN = "agentparty@agentparty";

  interface PluginBehavior {
    noClaude?: boolean;
    installed: string | null;
    failUpdate?: boolean;
    /** update 退出 0 但版本不动（marketplace 还没拿到新 tag）。 */
    updateNoop?: boolean;
  }

  function harness(behavior: PluginBehavior, target = "0.2.215", running = "0.2.214") {
    const record: string[][] = [];
    const logs: string[] = [];
    const errs: string[] = [];
    const state = { installed: behavior.installed };
    const spawn = ((cmd: string, args: readonly string[]) => {
      record.push([cmd, ...args]);
      const base = { pid: 0, output: [], stdout: "", stderr: "", signal: null };
      if (behavior.noClaude) return { ...base, status: null, error: new Error("spawn ENOENT") };
      if (cmd === "claude" && args[0] === "plugin" && args[1] === "list") {
        const rows = state.installed === null
          ? []
          : [{ id: PLUGIN, version: state.installed, enabled: true, installPath: "/nowhere/agentparty" }];
        return { ...base, status: 0, stdout: `${JSON.stringify(rows)}\n` };
      }
      if (cmd === "claude" && args[0] === "plugin" && args[1] === "update") {
        if (behavior.failUpdate) return { ...base, status: 1 };
        if (!behavior.updateNoop) state.installed = target;
        return { ...base, status: 0 };
      }
      return { ...base, status: 0 };
    }) as unknown as UpgradeCommandDeps["spawn"];
    const deps: UpgradeCommandDeps = {
      download: async () => ({
        running_version: running,
        target_version: target,
        target: "darwin-arm64",
        asset_url: `https://example.invalid/v${target}/party-darwin-arm64.tar.gz`,
        installed: target !== running,
        install_path: "/usr/local/bin/party",
        ...(target === running ? { reason: "already_current" as const } : {}),
      }),
      spawn,
      log: (line) => logs.push(line),
      errlog: (line) => errs.push(line),
    };
    return { deps, record, logs, errs, state };
  }

  const updateCalls = (record: string[][]) =>
    record.filter((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "update" && r[3] === PLUGIN);

  test("装了旧版插件 ⇒ upgrade 后跑 plugin update，结论行「插件 X → Y，需重开 Claude 会话生效」", async () => {
    const h = harness({ installed: "0.2.214" });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(updateCalls(h.record)).toHaveLength(1);
    expect(h.state.installed).toBe("0.2.215");
    const line = h.logs.find((l) => l.includes("0.2.214 → 0.2.215"));
    expect(line).toBeDefined();
    expect(line).toContain("需重开 Claude 会话");
    // CLI 自己那行照旧在前面。
    expect(h.logs[0]).toContain("installed party v0.2.215");
  });

  test("插件已与新 CLI 同版 ⇒ 不跑 update，只说明无需更新", async () => {
    const h = harness({ installed: "0.2.215" });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(updateCalls(h.record)).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("Claude 插件已是 0.2.215"))).toBe(true);
    expect(h.logs.some((l) => l.includes("重开"))).toBe(false);
  });

  test("对齐目标是刚装上的版本，不是本进程的旧版：插件==旧 CLI 版也要 update", async () => {
    // 真机场景（owner 2026-08-28）：CLI 0.2.214→0.2.215，插件 0.2.214。RUNNING_VERSION 还是 0.2.214，
    // 若拿它比对会判「已一致」、把插件甩在后面。
    const h = harness({ installed: "0.2.214" }, "0.2.215", "0.2.214");
    await runUpgrade([], h.deps);
    expect(updateCalls(h.record)).toHaveLength(1);
    expect(h.state.installed).toBe("0.2.215");
  });

  test("claude 不在 PATH ⇒ 一行说明跳过，不报错，退出码 0", async () => {
    const h = harness({ noClaude: true, installed: null });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(updateCalls(h.record)).toHaveLength(0);
    expect(h.errs).toEqual([]);
    expect(h.logs.some((l) => l.includes("claude 不在 PATH") && l.includes("跳过"))).toBe(true);
  });

  test("claude 在但插件没装 ⇒ 不替人装，一行说明跳过", async () => {
    const h = harness({ installed: null });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.record.some((r) => r[0] === "claude" && r[1] === "plugin" && r[2] === "install")).toBe(false);
    expect(updateCalls(h.record)).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("未安装 Claude 插件") && l.includes("跳过"))).toBe(true);
  });

  test("update 失败 ⇒ 印 `claude plugin update agentparty@agentparty`，upgrade 退出码仍为 0", async () => {
    const h = harness({ installed: "0.2.214", failUpdate: true });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(updateCalls(h.record)).toHaveLength(1);
    expect(h.logs.some((l) => l.includes(`claude plugin update ${PLUGIN}`))).toBe(true);
    expect(h.logs.some((l) => l.includes("仍是 0.2.214"))).toBe(true);
    expect(h.logs.some((l) => l.includes("→"))).toBe(false);
  });

  test("update 退出 0 但版本没动 ⇒ 如实说仍不一致并印修法，不假报「已更新」", async () => {
    const h = harness({ installed: "0.2.214", updateNoop: true });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.logs.some((l) => l.includes("→"))).toBe(false);
    expect(h.logs.some((l) => l.includes("仍是 0.2.214") && l.includes(`claude plugin update ${PLUGIN}`))).toBe(true);
  });

  test("CLI 已是最新（already_current）时插件落后同样顺手对齐到当前版本", async () => {
    const h = harness({ installed: "0.2.214" }, "0.2.215", "0.2.215");
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.logs[0]).toContain("already current");
    expect(updateCalls(h.record)).toHaveLength(1);
    expect(h.logs.some((l) => l.includes("0.2.214 → 0.2.215") && l.includes("重开"))).toBe(true);
  });

  test("--check 只看不装，也不碰插件", async () => {
    const h = harness({ installed: "0.2.214" });
    expect(await runUpgrade(["--check"], h.deps)).toBe(0);
    expect(h.record).toEqual([]);
    expect(h.logs.some((l) => l.startsWith("upgrade available:"))).toBe(true);
  });

  test("下载失败 ⇒ 退出 1、印 fallback，不碰插件", async () => {
    const h = harness({ installed: "0.2.214" });
    h.deps.download = async () => { throw new Error("boom"); };
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.record).toEqual([]);
    expect(h.errs[0]).toContain("party upgrade failed: boom");
    expect(h.errs[1]).toContain("fallback:");
  });
});
