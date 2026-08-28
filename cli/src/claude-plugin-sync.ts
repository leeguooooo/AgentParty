// claude 插件版本对齐（#961 / #967 / #985）：`party join --harness claude` 和 `party upgrade` 都要
// 把本机装的 agentparty 插件拉到和 CLI 同版，判据、动作、修法只写这一份。
//
// 为什么非对齐不可：插件版本 ≠ CLI 版本时 doctor 判 plugin_version_mismatch，SessionStart 唤醒
// 根本不布上（#961）。而 `claude plugin install` 对已装的只回 "already installed"（exit 0），
// **永远不会升级**，只有 `claude plugin update` 才换版本。
import type { spawnSync } from "node:child_process";
import { parseClaudePluginList } from "./commands/doctor";
import { compareVersions } from "./upgrade";

export const CLAUDE_PLUGIN = "agentparty@agentparty";
export const CLAUDE_PLUGIN_MARKETPLACE = "leeguooooo/AgentParty";
export const CLAUDE_PLUGIN_UPDATE_COMMAND = `claude plugin update ${CLAUDE_PLUGIN}`;

export type PluginSpawn = typeof spawnSync;

/** `claude plugin list --json` 的探测结果：先分「claude 起不起得来」，再分「读没读出版本」。 */
export type ClaudePluginProbe =
  | { available: false }
  /** version：`undefined`＝清单读不出 / 解析不了；`null`＝没装；字符串＝已装版本。 */
  | { available: true; version: string | null | undefined };

/**
 * 读本机已装的 agentparty 插件版本。走的是 doctor 同一个解析器（parseClaudePluginList），
 * 判据不另写一份。
 */
export function probeInstalledClaudePlugin(spawn: PluginSpawn): ClaudePluginProbe {
  const r = spawn("claude", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 30_000 });
  if (r.error !== undefined) return { available: false };
  if (r.status !== 0 || typeof r.stdout !== "string") return { available: true, version: undefined };
  const list = parseClaudePluginList(r.stdout);
  if (list === null) return { available: true, version: undefined };
  return { available: true, version: list.find((p) => p.id === CLAUDE_PLUGIN)?.version ?? null };
}

/** 同 probeInstalledClaudePlugin，但把「claude 不可用」和「读不出」都折成 `undefined`。 */
export function installedClaudePluginVersion(spawn: PluginSpawn): string | null | undefined {
  const probe = probeInstalledClaudePlugin(spawn);
  return probe.available ? probe.version : undefined;
}

/** 跑一次 `claude plugin update agentparty@agentparty`。true＝exit 0。 */
export function runClaudePluginUpdate(spawn: PluginSpawn): boolean {
  const r = spawn("claude", ["plugin", "update", CLAUDE_PLUGIN], { encoding: "utf8", timeout: 60_000 });
  return r.error === undefined && r.status === 0;
}

/**
 * 插件与 CLI 版本不一致时的对症修法：插件比 CLI 新 ⇒ 升 CLI（不是降插件）；插件旧 ⇒ update
 * （install 原地踏步）。
 */
export function claudePluginMismatchFix(pluginVersion: string, cliVersion: string): string {
  return compareVersions(pluginVersion, cliVersion) > 0 ? "party upgrade" : CLAUDE_PLUGIN_UPDATE_COMMAND;
}

export type ClaudePluginSyncKind =
  /** `claude plugin list` 起不来（二进制不在 PATH）。 */
  | "claude_unavailable"
  /** claude 在，但插件清单读不出 / 解析不了。 */
  | "unreadable"
  /** 没装 agentparty 插件——不替人做主装；join 才装。 */
  | "not_installed"
  /** 已经和 CLI 同版，什么都没做。 */
  | "current"
  /** 跑了 update 且之后读到的版本 == CLI。 */
  | "updated"
  /** update 命令退出非 0。 */
  | "update_failed"
  /** update 命令退出 0，但之后读到的版本仍 ≠ CLI（marketplace 还没拿到新 tag、缓存……）。 */
  | "still_mismatched";

export interface ClaudePluginSyncResult {
  kind: ClaudePluginSyncKind;
  /** 对齐前读到的版本（语义同 installedClaudePluginVersion）。 */
  before: string | null | undefined;
  /** 对齐后读到的版本；没跑 update 时等于 before。 */
  after: string | null | undefined;
  /** 还需要人手做的那一条命令；已对齐 / 无需对齐时为 undefined。 */
  fix?: string;
}

/**
 * 把本机 claude 插件对齐到 `cliVersion`：读已装版本，≠ cliVersion 就跑 `claude plugin update`，
 * 再读一次核实。**只对齐已装的**，没装不装（那是 join 的事）。任何一步失败都不抛——调用方按
 * kind 决定怎么说，CLI 自身的升级 / 加入不因插件而失败。
 *
 * `cliVersion` 由调用方给：join 传 RUNNING_VERSION；upgrade 传刚装上的目标版本——upgrade 进程
 * 本身还是旧二进制，RUNNING_VERSION 是旧的，拿它比对会把插件对齐到旧版。
 */
export function syncClaudePluginToCli(spawn: PluginSpawn, cliVersion: string): ClaudePluginSyncResult {
  const probe = probeInstalledClaudePlugin(spawn);
  if (!probe.available) return { kind: "claude_unavailable", before: undefined, after: undefined };
  const before = probe.version;
  if (before === undefined) return { kind: "unreadable", before, after: before };
  if (before === null) return { kind: "not_installed", before, after: before };
  if (before === cliVersion) return { kind: "current", before, after: before };
  if (!runClaudePluginUpdate(spawn)) {
    return { kind: "update_failed", before, after: before, fix: claudePluginMismatchFix(before, cliVersion) };
  }
  const after = installedClaudePluginVersion(spawn);
  if (after === cliVersion) return { kind: "updated", before, after };
  return {
    kind: "still_mismatched",
    before,
    after,
    fix: typeof after === "string" ? claudePluginMismatchFix(after, cliVersion) : CLAUDE_PLUGIN_UPDATE_COMMAND,
  };
}

/**
 * `party upgrade` 收尾时给人看的那几行（#985）。CLI 已经装好了，这里只是「顺手」——所以每个分支
 * 都是说明，不是错误；调用方退出码不受它影响。
 */
export function describeClaudePluginSync(result: ClaudePluginSyncResult, cliVersion: string): string[] {
  switch (result.kind) {
    case "claude_unavailable":
      return ["claude 不在 PATH，跳过 Claude 插件对齐（不影响 CLI）"];
    case "unreadable":
      return [`读不出 Claude 插件清单，跳过插件对齐；确认方式：claude plugin list --json，需要时手动 ${CLAUDE_PLUGIN_UPDATE_COMMAND}`];
    case "not_installed":
      return ["未安装 Claude 插件，跳过插件对齐（要用 Claude 唤醒层时跑 party join --harness claude）"];
    case "current":
      return [`Claude 插件已是 ${cliVersion}，无需更新`];
    case "updated":
      return [`Claude 插件 ${result.before} → ${result.after}，需重开 Claude 会话生效（当前会话仍挂着旧插件）`];
    case "update_failed":
      return [
        `Claude 插件仍是 ${result.before}（CLI ${cliVersion}），update 失败——唤醒层会报 plugin_version_mismatch，手动：${result.fix}`,
      ];
    case "still_mismatched":
      return [
        `Claude 插件 update 跑完仍是 ${result.after ?? "读不出"}（CLI ${cliVersion}）——可能 marketplace 还没拿到新版，稍后手动：${result.fix}`,
      ];
  }
}
