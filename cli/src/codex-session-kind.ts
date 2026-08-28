// 「这个 codex 会话是人在用的，还是一次性/嵌入式的」（issue #959 / #976）。
//
// 为什么要在**拉起之前**判：codex auto-wake 的回收判据（#893）是「频道上还有没有活着的入册
// codex 会话」——但 SessionStart 那一刻触发它的会话必然活着，所以对一次性 codex 而言这条判据
// 恒为真：拉起 → serve 上线发一条 waiting 帧 → 60 秒后会话早已结束、探活为零 → 回收 → 下一个
// 一次性 codex 再来一遍。owner 真机 3 小时刷了 28 条一模一样的状态帧，把频道烧到 loop guard。
// 事后 60 秒再回收，本质上是把「不该拉」的判断做晚了；这里把它提前到 SessionStart。
//
// 两级信号，按可靠性排：
//
// ① **rollout 头**（#976，首要）。codex 给每个会话写 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<本地
//    时间>-<uuid>.jsonl`，第一行 `session_meta` 就带 `originator`（被 Claude Code 委托的写
//    "Claude Code"）、`source`（直接会话是字符串 "vscode"/…；subagent 派生是对象
//    `{subagent:{thread_spawn:{parent_thread_id,…}}}`）、`thread_source:"subagent"`、`parent_thread_id`。
//    进程链会断（单次 ps 快照里父进程可能已经退了），rollout 头不会。SessionStart 载荷里的
//    session_id 按文件名尾部的 uuid 定位文件；头上说是 Claude 委托 / subagent 派生 ⇒ 直接
//    non-interactive，不看进程表。头上没有这两个特征、或文件还没落盘（hook 触发时首行可能未写）
//    ⇒ 退到 ②。rollout 只当**正向**信号用：它认不出「人在用」，认得出「被委托」。
//
// ② **进程形态**，全部来自一次 `ps`，任何失败一律返回 `unknown`：
//   a. 子命令 `exec` / `mcp-server`（及其别名）——codex 自己定义的一次性 / 嵌入式形态；
//   b. 祖先链上有另一个 harness 进程（claude / codex）——这是被别的 agent 会话**委托**拉起的
//      codex（codex-rescue、stop-time review 都是这一形态），跑完即走，没有人在它前面等着被 @；
//   c. `app-server` 由脚本驱动（没有任何 GUI 祖先）——Claude 插件正是 `spawn("codex", ["app-server"])`
//      开一条 JSON-RPC 管道跑一次任务。桌面 codex（ChatGPT.app）与 IDE 扩展同样走 app-server，
//      但它们的祖先链上必有一个 `.app` 应用包，据此区分。
//   npm 版 codex 的命令行是 `node /opt/homebrew/bin/codex app-server`，真正的二进制在它的子进程
//   （`…/vendor/<triple>/bin/codex app-server`，本机实测）。子命令解析要跳过解释器 / 包裹层；
//   而这个 node 启动层是**同一个**会话的一部分，不是「另一个 codex 委托」——沿祖先链找 harness
//   之前先把它折进宿主（判据：也是 codex、子命令与宿主相同）。
//
// 其余（终端 TUI、桌面 codex、IDE codex）一律视为交互式。`unknown` 由决策层按「不拉起」处理
// （#976：一次性 codex 高频的机器上「不知道就拉」错在更贵的一侧；交互式会话下次 SessionStart 会再来）。
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { codexSessionsRoot, isCodexThreadId, listCodexRolloutFiles } from "./codex-sessions";
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
/** 宿主上方最多折进多少层「同一会话的启动层」（npm 启动层 + 可能的用户包装脚本）。 */
const MAX_LAUNCHER_FOLDS = 3;
/** 解释器：它后面那个（非选项）token 才是真正在跑的程序。 */
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "env"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
/** rollout 首行最多读多少字节；session_meta 带 base_instructions，本机实测 ~19KB。 */
const ROLLOUT_HEAD_BYTES = 256 * 1024;
/** 文件名 uuid 对不上时，按首行 `payload.id` / `payload.session_id` 兜底扫最新的几份；有上限。 */
const ROLLOUT_HEADER_SCAN_LIMIT = 24;

function stripExecExt(name: string): string {
  return name.replace(/\.(exe|cmd|bat|js|mjs|cjs)$/i, "");
}

/** 这个 token 是不是一个叫 codex 的可执行文件 / 脚本（含 `codex-*` 包装，含路径形式）。 */
function isCodexToken(token: string): boolean {
  return /^codex(-|$)/i.test(stripExecExt(basename(token)));
}

/** 这个 token 是不是 claude 本体：`claude`、或 npm 包的入口 `…/claude(-code)/cli.js`。 */
function isClaudeToken(token: string): boolean {
  const bare = stripExecExt(token);
  return stripExecExt(basename(token)) === "claude" || /(^|[\\/])(claude|claude-code)[\\/]cli$/i.test(bare);
}

function isShellWrapper(args: string): boolean {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return SHELLS.has(basename(first));
}

/**
 * 跳过命令行开头的解释器 / shell 包裹层，返回「真正在跑的程序」那个 token 的下标。
 * `node /opt/homebrew/bin/codex app-server` → 1；`sh -c codex exec x` → 2；`codex exec` → 0；
 * `vim codex-notes.md` → 0（vim 不是包裹层，后面的 token 一概不看——#918 的教训：判据只看可执行文件本体）。
 */
function executableIndex(tokens: readonly string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const base = basename(tokens[i]!);
    if (INTERPRETERS.has(base)) {
      const isEnv = base === "env";
      i += 1;
      // 解释器自己的选项（`node --no-warnings x.js`、`env -S …`）；`env` 后面还可能跟
      // `KEY=VALUE` 赋值（`env RUST_LOG=info codex exec …`），它们不是要跑的程序。
      while (i < tokens.length && (tokens[i]!.startsWith("-") || (isEnv && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)))) i += 1;
      continue;
    }
    if (SHELLS.has(base)) {
      i += 1;
      while (i < tokens.length && /^-[a-z]*c[a-z]*$/i.test(tokens[i]!)) i += 1;
      continue;
    }
    return i;
  }
  return tokens.length;
}

/** 命令行里紧跟 codex 可执行文件（跳过解释器 / 包裹层）之后的第一个非选项 token。 */
export function codexSubcommand(args: string): string | null {
  const tokens = args.trim().split(/\s+/);
  const tokensAfterExec = tokens.slice(executableIndex(tokens) + 1);
  for (let i = 0; i < tokensAfterExec.length; i += 1) {
    const token = tokensAfterExec[i]!;
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

/**
 * 祖先链上的「另一个 harness」：claude 本体（含 `node …/claude/cli.js`），或任何以 codex 命名的
 * 可执行文件 / 脚本（含 `node /opt/homebrew/bin/codex …`、`node …/codex-companion.mjs …`）。
 * 只看跳过包裹层之后的**可执行文件本体**，不看命令行里任意位置的 token——`vim codex-notes.md`、
 * `git commit -m claude` 都不算（#918）。
 */
export function harnessAncestor(args: string): BindingHarness | null {
  const known = harnessFromCommand(args);
  if (known !== null) return known;
  const tokens = args.trim().split(/\s+/);
  const exec = tokens[executableIndex(tokens)];
  if (exec === undefined) return null;
  if (isCodexToken(exec)) return "codex";
  if (isClaudeToken(exec)) return "claude";
  return null;
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
  // 同一会话的启动层（npm 版 `node /opt/homebrew/bin/codex <同一子命令>`）折进宿主，
  // 不然每个 npm 装的交互式 codex 都会被当成「被另一个 codex 委托」。
  for (let fold = 0; fold < MAX_LAUNCHER_FOLDS; fold += 1) {
    const row = pid > 1 ? table.get(pid) : undefined;
    if (row === undefined || harnessAncestor(row.args) !== "codex" || codexSubcommand(row.args) !== sub) break;
    if (isGuiBundle(row.args)) gui = true;
    if (row.ppid === pid) break;
    pid = row.ppid;
  }
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

// ---- rollout 头（#976）----

/** rollout 首行 `session_meta` 里与「谁开的这个会话」有关的字段；正文一个字都不进这里。 */
export interface CodexRolloutMeta {
  /** `payload.id`：本线程 id（＝文件名尾部 uuid）。 */
  id: string | null;
  /** `payload.session_id`：直接会话时＝id；subagent 派生时是**父**线程 id。 */
  sessionId: string | null;
  originator: string | null;
  /** `payload.source` 是字符串时原样；是对象时压成一行摘要（`subagent`）。 */
  source: string | null;
  threadSource: string | null;
  parentThreadId: string | null;
  /** `source.subagent` / `thread_source==="subagent"` / 有 `parent_thread_id` 任一成立。 */
  subagent: boolean;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 只解析首行。首行不是完整的 `session_meta`（文件刚建、首行还没写完）⇒ null＝读不到，
 * 调用方退回进程探测，绝不据此判死。
 */
export function parseCodexRolloutMeta(head: string): CodexRolloutMeta | null {
  const newline = head.indexOf("\n");
  if (newline < 0) return null;
  let record: unknown;
  try {
    record = JSON.parse(head.slice(0, newline));
  } catch {
    return null;
  }
  if (typeof record !== "object" || record === null) return null;
  const { type, payload } = record as { type?: unknown; payload?: unknown };
  if (type !== "session_meta" || typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  const rawSource = fields.source;
  const sourceObject = typeof rawSource === "object" && rawSource !== null ? (rawSource as Record<string, unknown>) : null;
  const threadSource = stringOrNull(fields.thread_source);
  const parentThreadId = stringOrNull(fields.parent_thread_id);
  const spawn = sourceObject?.subagent;
  const subagent = spawn !== undefined || threadSource === "subagent" || parentThreadId !== null;
  return {
    id: stringOrNull(fields.id),
    sessionId: stringOrNull(fields.session_id),
    originator: stringOrNull(fields.originator),
    source: sourceObject === null ? stringOrNull(rawSource) : Object.keys(sourceObject).join(","),
    threadSource,
    parentThreadId,
    subagent,
  };
}

/** 被 Claude Code 委托的会话在 rollout 头里的 originator（codex 0.149 实测）。 */
const DELEGATED_ORIGINATORS = new Set(["Claude Code"]);

/**
 * rollout 头能不能一票定成「不是人在用的」。只给正向结论：认不出「人在用」就返回 null，
 * 由进程形态接着判（ChatGPT.app 里人开的 codex 其 originator 不是 Claude Code，正是靠这一步保住 #966）。
 */
export function classifyCodexRolloutMeta(meta: CodexRolloutMeta): CodexSessionKindProbe | null {
  const origin = `originator=${meta.originator ?? "?"} source=${meta.source ?? "?"}`;
  if (meta.subagent) {
    return {
      kind: "non-interactive",
      detail:
        `rollout 头：subagent 派生的子线程（${origin}` +
        `${meta.parentThreadId === null ? "" : ` parent_thread_id=${meta.parentThreadId}`}）——被别的会话派生，跑完即走`,
    };
  }
  if (meta.originator !== null && DELEGATED_ORIGINATORS.has(meta.originator)) {
    return { kind: "non-interactive", detail: `rollout 头：${origin}——被 Claude 委托的 codex，跑完即走` };
  }
  return null;
}

function readRolloutHead(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(ROLLOUT_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, ROLLOUT_HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 同一进程内的查找结果缓存（hook 与 join 可能各探一次）；键是 `${root}\n${sessionId}`。 */
const rolloutMetaCache = new Map<string, CodexRolloutMeta | null>();

/**
 * 按 SessionStart 载荷里的 session_id 找到本会话的 rollout 并解析首行。
 * 先按文件名尾部 uuid 匹配（不读任何文件）；对不上再按首行 `payload.id` / `payload.session_id`
 * 兜底扫最新的 ROLLOUT_HEADER_SCAN_LIMIT 份。找不到 / 首行没落盘 ⇒ null。
 */
export function readCodexRolloutMeta(sessionId: string, root: string): CodexRolloutMeta | null {
  const key = `${root}\n${sessionId}`;
  const cached = rolloutMetaCache.get(key);
  if (cached !== undefined) return cached;
  const meta = locateCodexRolloutMeta(sessionId, root);
  // 只缓存拿到的结论：首行还没落盘那种「暂时读不到」下次还该再试。
  if (meta !== null) rolloutMetaCache.set(key, meta);
  return meta;
}

function locateCodexRolloutMeta(sessionId: string, root: string): CodexRolloutMeta | null {
  if (!isCodexThreadId(sessionId)) return null;
  const wanted = sessionId.toLowerCase();
  let files: ReturnType<typeof listCodexRolloutFiles>;
  try {
    files = listCodexRolloutFiles(root);
  } catch {
    return null;
  }
  const byName = files.find((file) => file.threadId === wanted);
  if (byName !== undefined) {
    const head = readRolloutHead(byName.path);
    return head === null ? null : parseCodexRolloutMeta(head);
  }
  for (const file of files.slice(0, ROLLOUT_HEADER_SCAN_LIMIT)) {
    const head = readRolloutHead(file.path);
    const meta = head === null ? null : parseCodexRolloutMeta(head);
    if (meta === null) continue;
    if (meta.id?.toLowerCase() === wanted || meta.sessionId?.toLowerCase() === wanted) return meta;
  }
  return null;
}

/** 测试用：清掉进程内缓存。 */
export function resetCodexRolloutMetaCache(): void {
  rolloutMetaCache.clear();
}

export interface ProbeCodexSessionKindOptions {
  /** hook 的父进程 pid（＝codex 本体或它的 shell）；缺省 process.ppid。 */
  hookParentPid?: number;
  /** SessionStart 载荷里的 session_id；null ⇒ 不查 rollout，直接进程探测。 */
  sessionId?: string | null;
  /** `$CODEX_HOME/sessions` 的位置；缺省按 env / home 推。 */
  rolloutRoot?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  spawn?: typeof spawnSync;
}

/**
 * 真机探测：先 rollout 头，再一次 `ps`；两者都没结论 → 进程探测的结果（含 unknown）。
 * 旧签名 `probeCodexSessionKind(pid, spawn)` 仍然可用。
 */
export function probeCodexSessionKind(
  options: ProbeCodexSessionKindOptions | number = {},
  legacySpawn?: typeof spawnSync,
): CodexSessionKindProbe {
  const opts: ProbeCodexSessionKindOptions = typeof options === "number"
    ? { hookParentPid: options, spawn: legacySpawn }
    : options;
  const hookParentPid = opts.hookParentPid ?? process.ppid;
  const spawn = opts.spawn ?? spawnSync;
  const sessionId = opts.sessionId ?? null;
  let rolloutNote = "";
  if (sessionId !== null) {
    const root = opts.rolloutRoot ?? codexSessionsRoot(opts.env ?? process.env, opts.home ?? homedir());
    const meta = readCodexRolloutMeta(sessionId, root);
    if (meta !== null) {
      const verdict = classifyCodexRolloutMeta(meta);
      if (verdict !== null) return verdict;
      rolloutNote = `；rollout 头 originator=${meta.originator ?? "?"} source=${meta.source ?? "?"} 无结论，按进程形态判`;
    } else {
      rolloutNote = "；rollout 头读不到，按进程形态判";
    }
  }
  const probe = probeByProcessShape(hookParentPid, spawn);
  return rolloutNote === "" ? probe : { kind: probe.kind, detail: `${probe.detail}${rolloutNote}` };
}

function probeByProcessShape(hookParentPid: number, spawn: typeof spawnSync): CodexSessionKindProbe {
  if (!Number.isInteger(hookParentPid) || hookParentPid <= 1) return { kind: "unknown", detail: "父进程 pid 不合法" };
  if (process.platform === "win32") return { kind: "unknown", detail: "win32 不探测进程形态" };
  return classifyCodexSession(readProcessTable(spawn), hookParentPid);
}
