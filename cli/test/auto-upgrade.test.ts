// #1030：owner「执行命令时候自动升级」。此前 CLI 发现有新版只打提示，等人自己去跑 party upgrade
// ——于是真机上反复出现「照着引导跑命令 → 撞上早就修好的 bug → 修法是先升级」。
//
// 这里钉住三条硬约束：能关、失败不挡本次命令、任何「没结论」都不动手。
// 「热路径不打网络」由另一条用例从入口侧证明（hook/mcp 的 run 里根本没有这次调用）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_AUTO_UPGRADE_ENV,
  NO_AUTO_UPGRADE_FLAG,
  autoUpgradeDisabled,
  maybeAutoUpgrade,
  stripNoAutoUpgradeFlag,
  type AutoUpgradeDeps,
} from "../src/auto-upgrade";

function deps(over: Partial<AutoUpgradeDeps> = {}): AutoUpgradeDeps & { logs: string[]; calls: string[] } {
  const logs: string[] = [];
  const calls: string[] = [];
  return {
    logs,
    calls,
    latestVersion: async () => {
      calls.push("probe");
      return "9.9.9";
    },
    upgrade: async () => {
      calls.push("upgrade");
      return 0;
    },
    reexec: () => {
      calls.push("reexec");
      return 0;
    },
    now: () => 1_800_000_000_000,
    cwd: () => "/tmp/x",
    log: (line) => void logs.push(line),
    runningVersion: "0.1.0",
    shouldProbe: () => true,
    ...over,
  };
}

describe("交互式入口的自动升级（#1030）", () => {
  test("有新版 ⇒ 升级并用新版本重跑本次命令", async () => {
    const d = deps();
    const out = await maybeAutoUpgrade(d, {}, false);
    expect(out).toMatchObject({ kind: "upgraded", from: "0.1.0", to: "9.9.9", reexecCode: 0 });
    expect(d.calls).toEqual(["probe", "upgrade", "reexec"]);
    expect(d.logs.join("\n")).toContain("正在自动升级");
  });

  test("已是最新 ⇒ 一步不动", async () => {
    const d = deps({ latestVersion: async () => "0.1.0" });
    expect(await maybeAutoUpgrade(d, {}, false)).toEqual({ kind: "current" });
    expect(d.calls).not.toContain("upgrade");
    expect(d.calls).not.toContain("reexec");
  });

  test("--no-auto-upgrade / 环境变量 ⇒ 连探测都不做", async () => {
    const byFlag = deps();
    expect(await maybeAutoUpgrade(byFlag, {}, true)).toEqual({ kind: "disabled" });
    expect(byFlag.calls).toEqual([]);
    const byEnv = deps();
    expect(await maybeAutoUpgrade(byEnv, { [NO_AUTO_UPGRADE_ENV]: "1" }, false)).toEqual({ kind: "disabled" });
    expect(byEnv.calls).toEqual([]);
    expect(autoUpgradeDisabled({ [NO_AUTO_UPGRADE_ENV]: "0" }, false)).toBe(false);
  });

  test("还在 TTL 窗口内 ⇒ 不打网络（每条命令都探会把延迟压回热路径）", async () => {
    const d = deps({ shouldProbe: () => false });
    expect(await maybeAutoUpgrade(d, {}, false)).toEqual({ kind: "throttled" });
    expect(d.calls).toEqual([]);
  });

  test("探不到版本 / 探测抛异常 ⇒ 当作没结论，绝不动手", async () => {
    for (const latest of [async () => null, async () => "", async () => { throw new Error("net"); }]) {
      const d = deps({ latestVersion: latest as AutoUpgradeDeps["latestVersion"] });
      expect(await maybeAutoUpgrade(d, {}, false)).toEqual({ kind: "unknown" });
      expect(d.calls).not.toContain("upgrade");
      expect(d.calls).not.toContain("reexec");
    }
  });

  test("升级失败 ⇒ 说清楚并继续用当前版本跑，绝不挡住本次命令", async () => {
    for (const upgrade of [async () => 1, async () => { throw new Error("boom"); }]) {
      const d = deps({ upgrade: upgrade as AutoUpgradeDeps["upgrade"] });
      expect(await maybeAutoUpgrade(d, {}, false)).toEqual({ kind: "failed" });
      expect(d.calls).not.toContain("reexec");
      expect(d.logs.join("\n")).toContain("自动升级没成功");
    }
  });

  test("重跑不了 ⇒ 本次仍用旧进程跑完，并说明下次生效", async () => {
    const d = deps({ reexec: () => null });
    const out = await maybeAutoUpgrade(d, {}, false);
    expect(out).toMatchObject({ kind: "upgraded", reexecCode: null });
    expect(d.logs.join("\n")).toContain("下次起就是新版");
  });

  test("--no-auto-upgrade 从 argv 里摘干净（不流进下游参数校验）", () => {
    expect(stripNoAutoUpgradeFlag(["dev", NO_AUTO_UPGRADE_FLAG])).toEqual({ argv: ["dev"], disabled: true });
    expect(stripNoAutoUpgradeFlag(["dev"])).toEqual({ argv: ["dev"], disabled: false });
  });

  test("热路径不接这套：hook / mcp / claude-channel 的源码里没有自动升级的调用", () => {
    // #602 的 50ms 预算 + 明令不等网络；#1025 那笔每次启动 ~130ms 的账还没还完。
    // 这条断言直接读源码——比任何 mock 都难糊弄。
    const root = join(import.meta.dir, "..", "src", "commands");
    for (const file of ["hook.ts", "mcp.ts", "claude-channel.ts"]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source).not.toContain("maybeAutoUpgrade");
      expect(source).not.toContain("auto-upgrade");
    }
  });
});

// CodeRabbit on #1036：`party claude dev -- --no-auto-upgrade` 里那个是给 claude 的参数，
// 既不该被当成我们的开关，也不该被摘掉。
test("`--` 之后的同名参数原样保留，也不算开关", () => {
  expect(stripNoAutoUpgradeFlag(["dev", "--", NO_AUTO_UPGRADE_FLAG])).toEqual({
    argv: ["dev", "--", NO_AUTO_UPGRADE_FLAG],
    disabled: false,
  });
  // `--` 之前的才算我们的
  expect(stripNoAutoUpgradeFlag(["dev", NO_AUTO_UPGRADE_FLAG, "--", "--model", "sonnet"])).toEqual({
    argv: ["dev", "--", "--model", "sonnet"],
    disabled: true,
  });
  // 终止符本身必须保留：摘掉它会让后面的参数被当成我们的位置参数
  expect(stripNoAutoUpgradeFlag(["dev", "--"])).toEqual({ argv: ["dev", "--"], disabled: false });
});
