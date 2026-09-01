// 交互式入口的自动升级（issue #1030）。
//
// owner：「执行命令时候自动升级」。此前 CLI 发现有新版只打一句提示，等人自己去跑 `party upgrade`
// ——于是真机上反复出现「照着 web 引导跑命令 → 撞上一个早就修好的 bug → 修法是先升级」。
// #1014 已经给**插件**做了自愈（party claude 撞到插件落后就自己更新再启动），CLI 自身却没有。
//
// 三条硬约束（issue 里写死的）：
//   1. **绝不进热路径**。`party hook report` 每个模型工具边界都会跑，#602 的预算是 50ms 且明令
//      不等网络；#1025 那笔「每次启动恒烧 ~130ms CPU」的账还没还完。所以这个模块只被交互式命令
//      显式调用，hook / mcp / claude-channel 一个都不接——它们的入口里根本没有这次调用。
//   2. **必须能关**，且每次动手都要在终端说清楚做了什么（照抄 #1014 插件自愈的形态）。
//   3. **升级失败不挡本次命令**——降级成一句提示继续跑。
//
// 版本探测复用既有的 TTL 缓存（默认 6h 一次），不是每条命令都打网络。
import { RUNNING_VERSION, compareVersions } from "./upgrade";
import { shouldProbeUpgrade } from "./upgrade-hint-cache";

export const NO_AUTO_UPGRADE_FLAG = "--no-auto-upgrade";
export const NO_AUTO_UPGRADE_ENV = "AGENTPARTY_NO_AUTO_UPGRADE";

export interface AutoUpgradeDeps {
  /** 服务端认为的最新 CLI 版本；读不到返回 null（当作「没结论」，不动手）。 */
  latestVersion: () => Promise<string | null>;
  /** 真正执行升级；返回 0 表示成功。 */
  upgrade: () => Promise<number>;
  /** 升级后用新二进制重跑本次命令；返回它的退出码，null 表示没能重跑。 */
  reexec: () => number | null;
  now: () => number;
  cwd: () => string;
  log: (line: string) => void;
  runningVersion?: string;
  /** 探测节流：缺省走磁盘 TTL 缓存。 */
  shouldProbe?: (now: number, cwd: string) => boolean;
}

export type AutoUpgradeOutcome =
  | { kind: "disabled" }          // 显式关掉
  | { kind: "throttled" }         // 还在 TTL 窗口内，这次不探
  | { kind: "current" }           // 已是最新
  | { kind: "unknown" }           // 探不到版本（网络/服务端），当作没结论
  | { kind: "failed" }            // 升级动过手但没成功——不挡本次命令
  | { kind: "upgraded"; from: string; to: string; reexecCode: number | null };

/** `--no-auto-upgrade` 从 argv 里摘掉（它不该流进下游命令的参数校验）。 */
export function stripNoAutoUpgradeFlag(argv: readonly string[]): { argv: string[]; disabled: boolean } {
  const disabled = argv.includes(NO_AUTO_UPGRADE_FLAG);
  return { argv: argv.filter((a) => a !== NO_AUTO_UPGRADE_FLAG), disabled };
}

export function autoUpgradeDisabled(env: NodeJS.ProcessEnv, flagDisabled: boolean): boolean {
  return flagDisabled || env[NO_AUTO_UPGRADE_ENV] === "1";
}

/**
 * 有新版就先升级、再用新二进制重跑本次命令。
 *
 * 任何一步不确定都**什么都不做**：探不到版本、比不出大小、升级失败——一律让本次命令照常执行。
 * 这个模块唯一有权做的破坏性动作是「替换二进制并重跑」，只在拿到明确的「服务端版本 > 运行版本」时才做。
 */
export async function maybeAutoUpgrade(
  deps: AutoUpgradeDeps,
  env: NodeJS.ProcessEnv,
  flagDisabled: boolean,
): Promise<AutoUpgradeOutcome> {
  if (autoUpgradeDisabled(env, flagDisabled)) return { kind: "disabled" };
  const now = deps.now();
  const probe = deps.shouldProbe ?? ((at: number, cwd: string) => shouldProbeUpgrade("auto-upgrade", cwd, at));
  if (!probe(now, deps.cwd())) return { kind: "throttled" };

  let latest: string | null;
  try {
    latest = await deps.latestVersion();
  } catch {
    latest = null;
  }
  if (latest === null || latest === "") return { kind: "unknown" };

  const running = deps.runningVersion ?? RUNNING_VERSION;
  let newer: boolean;
  try {
    newer = compareVersions(latest, running) > 0;
  } catch {
    return { kind: "unknown" };
  }
  if (!newer) return { kind: "current" };

  deps.log(
    `party ${running} 落后于已发布的 ${latest}，正在自动升级（不想让它自己升：加 ${NO_AUTO_UPGRADE_FLAG}` +
      ` 或设 ${NO_AUTO_UPGRADE_ENV}=1）……`,
  );
  let code: number;
  try {
    code = await deps.upgrade();
  } catch {
    code = 1;
  }
  if (code !== 0) {
    // 升级失败绝不挡住本次命令：说清楚，然后用当前版本继续。
    deps.log(`自动升级没成功（exit ${code}），本次继续用 ${running} 跑；手动升级：party upgrade`);
    return { kind: "failed" };
  }
  const reexecCode = deps.reexec();
  deps.log(
    reexecCode === null
      ? `已升级到 ${latest}；本次命令仍在 ${running} 的进程里跑完，下次起就是新版`
      : `已升级到 ${latest}，正在用新版本重跑本次命令……`,
  );
  return { kind: "upgraded", from: running, to: latest, reexecCode };
}
