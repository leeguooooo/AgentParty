import { spawnSync } from "node:child_process";
import { INSTALL_LINE, compareVersions, downloadPartyUpgrade, type PartyUpgradeOptions, type PartyUpgradeResult } from "../upgrade";
import { describeClaudePluginSync, syncClaudePluginToCli, type PluginSpawn } from "../claude-plugin-sync";

function help(): string {
  return [
    "usage: party upgrade [--version X.Y.Z] [--check]",
    "",
    "Download the GitHub Release binary, verify sha256, and atomically replace the running party binary.",
    "Falls back to the installer when the current executable is not a compiled party binary.",
    "After the CLI lands, an installed Claude plugin (agentparty@agentparty) is updated to the same version.",
  ].join("\n");
}

/** 注入点：测试喂假下载 / 假 spawn（不碰网络、不碰真机 claude）。 */
export interface UpgradeCommandDeps {
  download: (options: PartyUpgradeOptions) => Promise<PartyUpgradeResult>;
  spawn: PluginSpawn;
  log: (line: string) => void;
  errlog: (line: string) => void;
}

const defaultDeps: UpgradeCommandDeps = {
  download: (options) => downloadPartyUpgrade(options),
  spawn: spawnSync,
  log: (line) => console.log(line),
  errlog: (line) => console.error(line),
};

/**
 * CLI 落地后顺手把 Claude 插件对齐到同一版本（#985）——否则 `party claude` 立刻 plugin_version_mismatch，
 * 每次升级都把插件甩在后面。对齐目标是**刚装上的版本**，不是 RUNNING_VERSION（本进程还是旧二进制）。
 * 只是「顺手」：任何分支都不改 upgrade 的退出码，CLI 已经升好了。
 */
function syncClaudePluginAfterUpgrade(deps: UpgradeCommandDeps, cliVersion: string): void {
  const result = syncClaudePluginToCli(deps.spawn, cliVersion);
  for (const line of describeClaudePluginSync(result, cliVersion)) deps.log(line);
}

export async function run(argv: string[], deps: UpgradeCommandDeps = defaultDeps): Promise<number> {
  let version = "latest";
  let checkOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      deps.log(help());
      return 0;
    }
    if (arg === "--check") {
      checkOnly = true;
      continue;
    }
    if (arg === "--version") {
      const next = argv[++i];
      if (next === undefined || next.startsWith("-")) {
        deps.errlog("--version requires X.Y.Z");
        return 1;
      }
      version = next;
      continue;
    }
    deps.errlog(`unknown option: ${arg}`);
    deps.log(help());
    return 1;
  }

  let result: PartyUpgradeResult;
  try {
    result = await deps.download({ version, checkOnly });
  } catch (error) {
    deps.errlog(`party upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
    deps.errlog(`fallback: ${INSTALL_LINE}`);
    return 1;
  }
  if (checkOnly) {
    deps.log(`running: ${result.running_version}`);
    deps.log(`target:  ${result.target_version} (${result.target})`);
    if (compareVersions(result.target_version, result.running_version) > 0) {
      deps.log(`upgrade available: ${result.asset_url}`);
    } else {
      deps.log("already current");
    }
    return 0;
  }
  if (result.reason === "already_current") {
    deps.log(`party is already current: v${result.running_version}`);
    // CLI 没动，插件仍可能落后（上次升级时 claude 不在 / update 没成）——同样顺手对齐到当前版本。
    syncClaudePluginAfterUpgrade(deps, result.running_version);
    return 0;
  }
  deps.log(`installed party v${result.target_version} -> ${result.install_path}`);
  deps.log("restart running serve/watch processes to use the new binary; serve --auto-upgrade will re-exec at the next safe point.");
  syncClaudePluginAfterUpgrade(deps, result.target_version);
  return 0;
}
