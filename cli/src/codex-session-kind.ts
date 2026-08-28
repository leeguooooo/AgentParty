// 「这个 codex 会话是人在用的，还是一次性/嵌入式的」（issue #959）。
//
// 为什么要在**拉起之前**判：codex auto-wake 的回收判据（#893）是「频道上还有没有活着的入册
// codex 会话」——但 SessionStart 那一刻触发它的会话必然活着，所以对一次性 codex 而言这条判据
// 恒为真：拉起 → serve 上线发一条 waiting 帧 → 60 秒后会话早已结束、探活为零 → 回收 → 下一个
// 一次性 codex 再来一遍。owner 真机 3 小时刷了 28 条一模一样的状态帧，把频道烧到 loop guard。
// 事后 60 秒再回收，本质上是把「不该拉」的判断做晚了；这里把它提前到 SessionStart。
//
// 判据只看**进程形态**，全部来自一次 `ps`，任何失败一律返回 `unknown`（＝不知道，沿用既有行为，
// 绝不因为探测失败就把交互式会话判成一次性的而让它叫不醒）：
//   ① 子命令 `exec` / `mcp-server`（及其别名）——codex 自己定义的一次性 / 嵌入式形态；
//   ② 祖先链上有另一个 harness 进程（claude / codex）——这是被别的 agent 会话**委托**拉起的
//      codex（codex-rescue、stop-time review 都是这一形态），跑完即走，没有人在它前面等着被 @；
//   ③ `app-server` 由脚本驱动（没有任何 GUI 祖先）——Claude 插件正是 `spawn("codex", ["app-server"])`
//      开一条 JSON-RPC 管道跑一次任务。桌面 codex（ChatGPT.app）与 IDE 扩展同样走 app-server，
//      但它们的祖先链上必有一个 `.app` 应用包，据此区分。
// 其余（终端 TUI、桌面 codex、IDE codex）一律视为交互式，行为与本修复之前逐字相同。
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import { harnessFromCommand, readProcessTable, type BindingHarness, type ProcessRow } from "./join-binding";

export type CodexSessionKind = "interactive" | "non-interactive" | "unknown";

export interface CodexSessionKindProbe {
  kind: CodexSessionKind;
  /** 人读的判定依据；进日志用。 */
  detail: string;
}

/** codex 自己定义的一次性 / 嵌入式子命令。`e` 是 `exec` 的官方别名。 */
const ONE_SHOT_SUBCOMMANDS = new Set(["exec", "e", "mcp-server", "mcp"]);
/** 取值的全局选项：它后面那个 token 是参数，不是子命令。 */
const VALUE_OPTIONS = new Set([
  "-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s", "--sandbox",
  "-a", "--ask-for-approval", "-i", "--image",
]);
/** 祖先链最多往上走多少层（GUI 应用的链路可能很长）。 */
const MAX_ANCESTRY_HOPS = 24;

function isShellWrapper(args: string): boolean {
  const first = args.trim().split(/\s+/)[0] ?? "";
  const base = basename(first);
  return ["sh", "bash", "zsh", "dash", "fish"].includes(base);
}

/** 命令行里紧跟可执行文件之后的第一个非选项 token。 */
export function codexSubcommand(args: string): string | null {
  const tokens = args.trim().split(/\s+/).slice(1);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (VALUE_OPTIONS.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return null;
}

/**
 * 这行命令是不是从 macOS 应用包里跑出来的。看整行而不是第一个 token：`ps` 打出来的路径带空格
 * （`/Applications/Visual Studio Code.app/Contents/…`），按空白切第一个 token 会把它切碎。
 */
function isGuiBundle(args: string): boolean {
  return /\.app\/Contents\//.test(args);
}

/** 祖先链上的「另一个 harness」：claude 本体，或任何以 codex 命名的可执行文件（含 `codex-*` 包装）。 */
function harnessAncestor(args: string): BindingHarness | null {
  const known = harnessFromCommand(args);
  if (known !== null) return known;
  const first = args.trim().split(/\s+/)[0] ?? "";
  return /^codex(-|$)/.test(basename(first)) ? "codex" : null;
}

/**
 * 纯判定：给定进程表与 hook 的父 pid，判这个 codex 会话是哪种形态。
 * hook 是 codex 的子进程；codex 可能通过 `sh -c` 跑 hook，所以起点若是 shell 就再上一层。
 */
export function classifyCodexSession(
  table: ReadonlyMap<number, ProcessRow>,
  hookParentPid: number,
): CodexSessionKindProbe {
  if (table.size === 0) return { kind: "unknown", detail: "读不到进程表" };
  let hostPid = hookParentPid;
  let host = table.get(hostPid);
  for (let hop = 0; hop < 2 && host !== undefined && isShellWrapper(host.args); hop += 1) {
    hostPid = host.ppid;
    host = table.get(hostPid);
  }
  if (host === undefined) return { kind: "unknown", detail: `进程表里找不到 hook 的父进程 ${hookParentPid}` };
  const sub = codexSubcommand(host.args);
  if (sub !== null && ONE_SHOT_SUBCOMMANDS.has(sub)) {
    return { kind: "non-interactive", detail: `codex ${sub} 是一次性/嵌入式会话（pid ${hostPid}）` };
  }
  let gui = isGuiBundle(host.args);
  let pid = host.ppid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop += 1) {
    if (pid <= 1) break;
    const row = table.get(pid);
    if (row === undefined) break;
    const harness = harnessAncestor(row.args);
    if (harness !== null) {
      return {
        kind: "non-interactive",
        detail: `这个 codex（pid ${hostPid}）是被另一个 ${harness} 会话（pid ${pid}）委托拉起的，跑完即走`,
      };
    }
    if (isGuiBundle(row.args)) gui = true;
    if (row.ppid === pid) break;
    pid = row.ppid;
  }
  if (sub === "app-server" && !gui) {
    return {
      kind: "non-interactive",
      detail: `codex app-server（pid ${hostPid}）由脚本驱动、祖先链上没有任何 GUI 应用——不是人在用的会话`,
    };
  }
  return { kind: "interactive", detail: sub === null ? `codex TUI（pid ${hostPid}）` : `codex ${sub}（pid ${hostPid}）` };
}

/** 真机探测：一次 `ps`，失败 → unknown。 */
export function probeCodexSessionKind(
  hookParentPid: number = process.ppid,
  spawn: typeof spawnSync = spawnSync,
): CodexSessionKindProbe {
  if (!Number.isInteger(hookParentPid) || hookParentPid <= 1) return { kind: "unknown", detail: "父进程 pid 不合法" };
  if (process.platform === "win32") return { kind: "unknown", detail: "win32 不探测进程形态" };
  return classifyCodexSession(readProcessTable(spawn), hookParentPid);
}
