// Agent Party 关停（2026-10-31）：交互式 party 命令在 stderr 打一条「将关停、请迁移到 open-cross-session、
// 卸载见指南」提示。
//
// 约束（照抄 #1083 自动迁移 / #703 升级提示的形态）：
//   - **只走 stderr**，绝不碰 stdout——很多命令支持 --json，stdout 被下游解析。带 --json 时干脆不打。
//   - **不进热路径 / 常驻入口**：hook / mcp / serve / daemon / watch / bridge / claude* / capture /
//     notify-when-idle / statusline 是 harness 拉起或常驻的进程，在那里打字只会刷屏或混进别人的流。
//   - **每台机器（每个 AGENTPARTY_HOME）最多每 24 小时一次**，磁盘时间戳节流（每条命令都是新进程）。
//   - 能关：AGENTPARTY_NO_DEPRECATION_NOTICE=1。
//   - 全 best-effort：读写节流文件失败也绝不挡命令本身。
// 关停日期（owner 拍板）：2026-10-31，届时 agentparty.leeguoo.com 托管服务停止；此前频道照常可用。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentpartyHome } from "./config";

export const NO_DEPRECATION_NOTICE_ENV = "AGENTPARTY_NO_DEPRECATION_NOTICE";
export const DEPRECATION_NOTICE_TTL_MS = 24 * 60 * 60 * 1000;

export const SHUTDOWN_DATE = "2026-10-31";
export const UNINSTALL_GUIDE_URL = "https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md";

export const DEPRECATION_NOTICE = [
  `party: Agent Party will shut down on ${SHUTDOWN_DATE} (the hosted service at agentparty.leeguoo.com stops then).`,
  "  Channels keep working until that date. Please move to open-cross-session (ocs):",
  "  one local binary, no server/account; Claude Code ↔ Codex ↔ Pi ↔ Hermes on one machine or a paired LAN.",
  "  install: curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh",
  "  https://github.com/leeguooooo/open-cross-session",
  `  remove the local install: ${UNINSTALL_GUIDE_URL}`,
  "  (silence this reminder: AGENTPARTY_NO_DEPRECATION_NOTICE=1)",
].join("\n");

/** harness 拉起的进程内入口 / 常驻守护：不在这里打字。 */
const NO_NOTICE_COMMANDS = new Set([
  "mcp",
  "hook",
  "serve",
  "daemon",
  "watch",
  "bridge",
  "claude",
  "claude-channel",
  "claude-cross-session-hook",
  "codex",
  "capture",
  "notify-when-idle",
  "statusline",
]);

export function deprecationNoticePath(home: string = agentpartyHome()): string {
  return join(home, "state", "deprecation-notice.json");
}

export interface DeprecationNoticeOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  home?: string;
  errlog?: (text: string) => void;
}

/** 返回是否打印了提示。 */
export function maybePrintDeprecationNotice(
  cmd: string,
  args: readonly string[],
  opts: DeprecationNoticeOptions = {},
): boolean {
  const env = opts.env ?? process.env;
  if (env[NO_DEPRECATION_NOTICE_ENV] === "1") return false;
  if (NO_NOTICE_COMMANDS.has(cmd)) return false;
  // 机器可读输出 / 帮助：stdout 被解析或只是想看用法，不插嘴（`--` 之后是透传参数，不算）。
  const terminator = args.indexOf("--");
  const own = terminator === -1 ? args : args.slice(0, terminator);
  if (own.some((a) => a === "--json" || a.startsWith("--json=") || a === "--help" || a === "-h")) return false;

  const now = opts.now ?? Date.now();
  const path = deprecationNoticePath(opts.home);
  try {
    const at = (JSON.parse(readFileSync(path, "utf8")) as { at?: unknown }).at;
    if (typeof at === "number" && now - at >= 0 && now - at < DEPRECATION_NOTICE_TTL_MS) return false;
  } catch {
    // 没记录 / 坏 JSON：该提示
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: now }));
  } catch {
    // 写不下（只读 home 等）：照样提示——宁可多提示，不可永远不提示
  }
  (opts.errlog ?? ((text: string) => console.error(text)))(DEPRECATION_NOTICE);
  return true;
}
