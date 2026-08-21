// party orphans —— 列出并（显式确认后）清理孤儿 party 进程 + 回收死掉的会话注册条目（#908）。
//
// 判据全在 ../orphan-scan（纯函数，可单测）；这里只负责读 ps、发信号、扫注册表。
// 默认 dry-run，和 `party mcp prune` 一条策略：--yes 才真动手。
import { spawnSync } from "node:child_process";
import {
  classifyOrphanProcess,
  parsePsOutput,
  partyLane,
  type OrphanVerdict,
  type ScannedProcess,
} from "../orphan-scan";
import { listClaudeSessions, listCodexSessions } from "../claude-session-registry";

const HELP = `usage: party orphans [--yes] [--json]

List AgentParty child processes that outlived the harness session that started
them (orphaned announce / mcp servers) and, with --yes, shut them down.

Why: a \`party claude-channel\` whose Claude session died keeps its websocket up.
It shows as online in \`party who\` and keeps receiving that identity's @ — one
such orphan was the actual source of the cross-identity misdelivery in #906.

Safety:
  - only processes whose command is the party binary are considered; every other
    process on this machine is left untouched
  - only provably orphaned session children (re-parented to init) are shut down;
    deliberately daemonized lanes (\`party serve\`, \`party watch\`) are listed for
    you to decide, never signalled
  - --yes is required to signal anything; SIGTERM only, never SIGKILL

Options:
  --yes    actually shut down the processes reported as orphaned
  --json   machine-readable report
`;

export interface OrphanEntry {
  proc: ScannedProcess;
  lane: string | null;
  verdict: OrphanVerdict;
}

export interface OrphanPlan {
  totalProcesses: number;
  entries: OrphanEntry[];
  /** 非 party 进程数——纯展示，证明它们被看见了且没被动过。 */
  untouched: number;
}

export type PsFn = () => string;

const defaultPs: PsFn = () => {
  const res = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return res.status === 0 && typeof res.stdout === "string" ? res.stdout : "";
};

/** 自己 + 整条祖先链：任何情况下都不许出现在清理列表里。 */
export function ancestorPids(self: number, procs: readonly ScannedProcess[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>([self]);
  let cursor = byPid.get(self)?.ppid;
  while (cursor !== undefined && cursor > 1 && !out.has(cursor)) {
    out.add(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }
  return out;
}

export function planOrphans(opts: { ps?: PsFn; selfPid?: number } = {}): OrphanPlan {
  const procs = parsePsOutput((opts.ps ?? defaultPs)());
  const protectedPids = ancestorPids(opts.selfPid ?? process.pid, procs);
  const entries: OrphanEntry[] = [];
  let untouched = 0;
  for (const proc of procs) {
    const verdict = classifyOrphanProcess({ proc, protectedPids });
    if (verdict.reason === "not an AgentParty process — never touched") {
      untouched += 1;
      continue;
    }
    entries.push({ proc, lane: partyLane(proc.command), verdict });
  }
  return { totalProcesses: procs.length, entries, untouched };
}

export type SignalFn = (pid: number) => { ok: boolean; detail: string };

const defaultSignal: SignalFn = (pid) => {
  try {
    process.kill(pid, "SIGTERM");
    return { ok: true, detail: "SIGTERM sent" };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
};

export interface RunOrphansOptions {
  ps?: PsFn;
  selfPid?: number;
  yes?: boolean;
  json?: boolean;
  signal?: SignalFn;
  /** 扫一遍会话注册表；listSessions 顺带把 pid 已死的条目就地删掉。返回剩余活行数。 */
  sweepRegistry?: () => number;
  log?: (line: string) => void;
}

function defaultSweepRegistry(): number {
  // listSessions 读的时候就会 rmSync 掉 pid 已死的行与坏行——这正是我们要的回收动作，
  // 不必再复制一遍删除逻辑（也就不会和 #906 正在改的选择逻辑打架）。
  return listClaudeSessions().length + listCodexSessions().length;
}

export async function runOrphans(opts: RunOrphansOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const plan = planOrphans({ ...(opts.ps === undefined ? {} : { ps: opts.ps }), ...(opts.selfPid === undefined ? {} : { selfPid: opts.selfPid }) });
  const stale = plan.entries.filter((e) => e.verdict.action === "stale");
  const review = plan.entries.filter((e) => e.verdict.action === "review");

  const signalled: number[] = [];
  const failed: { pid: number; detail: string }[] = [];
  if (opts.yes === true) {
    const signal = opts.signal ?? defaultSignal;
    for (const entry of stale) {
      // 再核一次：发信号路径上只允许出现被判定为 stale 的 party 进程。分类函数是唯一入口，
      // 这里重跑一遍是为了让「绕过分类直接发信号」在结构上不可能发生。
      if (classifyOrphanProcess({ proc: entry.proc }).action !== "stale") continue;
      const res = signal(entry.proc.pid);
      if (res.ok) signalled.push(entry.proc.pid);
      else failed.push({ pid: entry.proc.pid, detail: res.detail });
    }
  }

  const remainingSessions = (opts.sweepRegistry ?? defaultSweepRegistry)();

  if (opts.json === true) {
    log(JSON.stringify({
      total_processes: plan.totalProcesses,
      untouched_non_party: plan.untouched,
      dry_run: opts.yes !== true,
      orphans: stale.map((e) => ({ pid: e.proc.pid, lane: e.lane, command: e.proc.command, reason: e.verdict.reason })),
      review: review.map((e) => ({ pid: e.proc.pid, lane: e.lane, command: e.proc.command, reason: e.verdict.reason })),
      signalled,
      failed,
      live_session_registrations: remainingSessions,
    }, null, 2));
    return failed.length > 0 ? 1 : 0;
  }

  log(`scanned ${String(plan.totalProcesses)} processes; ${String(plan.untouched)} belong to other tools and were not inspected`);
  if (stale.length === 0) log("no orphaned AgentParty processes found");
  for (const e of stale) log(`  [orphan] pid ${String(e.proc.pid)}  ${e.proc.command}\n             ${e.verdict.reason}`);
  for (const e of review) log(`  [review] pid ${String(e.proc.pid)}  ${e.proc.command}\n             ${e.verdict.reason}`);
  if (opts.yes !== true && stale.length > 0) {
    log("");
    log(`dry run: nothing was signalled. Re-run with --yes to SIGTERM the ${String(stale.length)} orphan(s) above.`);
  }
  for (const pid of signalled) log(`SIGTERM sent to pid ${String(pid)}`);
  for (const f of failed) log(`failed to signal pid ${String(f.pid)}: ${f.detail}`);
  log(`session registry swept: ${String(remainingSessions)} live registration(s) remain (dead ones were reclaimed)`);
  return failed.length > 0 ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const known = new Set(["--yes", "--json"]);
  for (const a of argv) {
    if (!known.has(a)) {
      console.error(`unknown option: ${a}`);
      console.error(HELP);
      return 1;
    }
  }
  return runOrphans({ yes: argv.includes("--yes"), json: argv.includes("--json") });
}
