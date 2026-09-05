// 被顶替的 MCP server 自己退场（#1083 的最后一块）。
//
// 真机现场（2026-09-05）：一个开了 4 小时的 codex 会话名下挂着 39 个 party MCP 子进程、597 MB——
// 同样的命令行一遍遍重复，最老 4 小时。codex / ChatGPT 桌面版每次重载 MCP 配置（`codex mcp add/remove`、
// 插件更新、会话内 reload）都会拉起一批新的 server，旧的既不 kill、也不关它们的 stdin，于是
// #908 的宿主探活（宿主还活着）和 stdin EOF（pipe 没关）两道闸都拦不住。这批孤儿才是
// 「29 个进程 / 298 MB」的大头，合并注册只解决了乘数里的一个因子。
//
// 判据只有一条，而且是确定性的：**同一宿主（ppid）下存在一个命令行完全相同、启动更晚的进程**
// ⇒ 我已被顶替，宿主只会跟最新那个说话，我退出。不同命令行（插件的 agentparty-runtime 与
// 手工注册的 party、不同 --channel）不算兄弟；同宿主起两个一模一样的 server 只在重载时发生。
// 这里绝不去 kill 别人——只管自己退，和 #908 同一纪律。
import { spawnSync } from "node:child_process";

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** 已运行秒数（ps 的 etime 解析而来）。越小越年轻。 */
  ageSeconds: number;
  command: string;
}

/** 解析 ps 的 etime：`[[dd-]hh:]mm:ss`。解析不出返回 null（宁可判不出，也不猜）。 */
export function parseEtime(raw: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (m === null) return null;
  const days = m[1] !== undefined ? Number(m[1]) : 0;
  const hours = m[2] !== undefined ? Number(m[2]) : 0;
  return ((days * 24 + hours) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

/** `ps -axo pid=,ppid=,etime=,command=` 的一行 → ProcessRow；坏行丢弃。 */
export function parsePsLine(line: string): ProcessRow | null {
  const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
  if (m === null) return null;
  const age = parseEtime(m[3]!);
  if (age === null) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), ageSeconds: age, command: m[4]!.trim() };
}

export type ListProcesses = () => ProcessRow[];

/** 真机：一次 ps 列全表。失败返回空表——判不出就当没被顶替，绝不因为 ps 抽风把自己退掉。 */
export function listProcesses(spawn: typeof spawnSync = spawnSync): ProcessRow[] {
  try {
    const res = spawn("ps", ["-axo", "pid=,ppid=,etime=,command="], { encoding: "utf8", timeout: 10_000 });
    if (res.error !== undefined || res.status !== 0 || typeof res.stdout !== "string") return [];
    return res.stdout
      .split("\n")
      .map(parsePsLine)
      .filter((row): row is ProcessRow => row !== null);
  } catch {
    return [];
  }
}

/**
 * 我（selfPid）有没有被同宿主下一个**命令行完全相同、更年轻**的进程顶替。
 * 自己那一行找不到（ps 没列出来 / 解析失败）⇒ null（判不出）；找得到才给出 true/false。
 */
export function findYoungerTwin(selfPid: number, rows: readonly ProcessRow[]): ProcessRow | null | undefined {
  const me = rows.find((r) => r.pid === selfPid);
  if (me === undefined) return undefined;
  const twins = rows.filter(
    (r) => r.pid !== me.pid && r.ppid === me.ppid && r.command === me.command && r.ageSeconds < me.ageSeconds,
  );
  if (twins.length === 0) return null;
  // 最年轻的那个就是宿主现在在用的
  return twins.reduce((a, b) => (b.ageSeconds < a.ageSeconds ? b : a));
}

export const SUPERSEDED_POLL_MS_ENV = "AGENTPARTY_SUPERSEDED_POLL_MS";
export const SUPERSEDED_POLL_MS = 60_000;

export function supersededPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SUPERSEDED_POLL_MS_ENV];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 200 ? n : SUPERSEDED_POLL_MS;
}

export interface WatchSupersededOptions {
  label: string;
  selfPid?: number;
  list?: ListProcesses;
  pollMs?: number;
  log?: (line: string) => void;
  terminate: () => void;
  schedule?: (fn: () => void, ms: number) => { stop: () => void };
}

function defaultSchedule(fn: () => void, ms: number): { stop: () => void } {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** 每 pollMs 查一次；发现被顶替就打一行说明并 terminate。返回句柄可停。 */
export function watchSuperseded(opts: WatchSupersededOptions): { stop: () => void } {
  const selfPid = opts.selfPid ?? process.pid;
  const list = opts.list ?? listProcesses;
  const log = opts.log ?? ((line: string) => console.error(line));
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  const handle = schedule(() => {
    if (stopped) return;
    const twin = findYoungerTwin(selfPid, list());
    if (twin === null || twin === undefined) return;
    stopped = true;
    handle.stop();
    log(
      `reaping: ${opts.label} 已被同宿主下更新的同名 server（pid=${String(twin.pid)}）顶替——` +
        `宿主重载 MCP 配置时不收旧进程；本进程退场，不再占内存（#1083）`,
    );
    opts.terminate();
  }, opts.pollMs ?? supersededPollMs());
  return { stop: () => { stopped = true; handle.stop(); } };
}
