// 存量孤儿进程盘点（issue #908 第 3 件）。
//
// #908 给运行中的进程装了宿主存活探测，但**已经在跑的老进程没有那段代码**——owner 机器上
// 那 18 个 announce 里的孤儿不会自己消失。这里提供一次性的盘点/清理判据。
//
// 硬约束（逐条都有单测，其中「绝不碰非 party 进程」这条另有专门的变异用例）：
//  1. 只按**命令本体**判定是不是我们的进程，绝不看进程名——名字可以被任何人改成 `party`；
//     词表从 mcp-registry 复用同一份（#898 的 isPartyMcpRegistration 同款严格度）。
//  2. 只把**确证的孤儿**判成 stale：宿主已被 init 收养（ppid=1）**且**属于「只该随会话活着」
//     的子进程档（claude-channel / mcp server）。判不准一律 review（列出、不动）。
//  3. 人有意 daemonize 的进程（nohup 的 `party serve`、`party watch`）永远不是孤儿——
//     它们的 ppid=1 是**设计如此**，杀掉就是弄坏用户正在用的东西。
//
// 纯函数模块：读一份 `ps` 输出 → 分类。副作用（发信号）留在命令层。
import { basename } from "node:path";
import { PARTY_COMMAND_BASENAMES } from "./mcp-registry";

export interface ScannedProcess {
  pid: number;
  ppid: number;
  /** ps 给出的完整命令行（argv 以空格连接）。 */
  command: string;
}

/** 解析 `ps -axo pid=,ppid=,command=` 的输出。形状不对的行直接跳过——宁可少认。 */
export function parsePsOutput(stdout: string): ScannedProcess[] {
  const out: ScannedProcess[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    out.push({ pid, ppid, command: m[3]! });
  }
  return out;
}

/**
 * 命令行 → argv。ps 不会把带空格的路径还原成可解析的形态，所以这里就是朴素切分：
 * 一个装在带空格目录里的 party 会切出对不上的 basename → 认不出来 → **不碰**（安全侧）。
 */
export function commandArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part !== "");
}

/**
 * 严格判定「这是不是我们自己的 party 进程」。只看 argv[0] 的 basename。
 * `npx party` / `sh -c "... party ..."` / `bun run index.ts claude-channel` 这类间接形态
 * 一律不认（＝永远不会被清理）——与 isPartyMcpRegistration 完全同一策略。
 */
export function isPartyProcess(command: string): boolean {
  const argv = commandArgv(command);
  const head = argv[0];
  if (head === undefined || head === "") return false;
  const base = basename(head).replace(/\.(exe|cmd|bat)$/i, "");
  return PARTY_COMMAND_BASENAMES.has(base);
}

/**
 * 带值的 flag。必须显式列出：只按「跳过所有 `-` 开头的 token」会把 `--channel dev` 的 `dev`
 * 当成子命令（单测第一次跑就抓到了这个），而无脑「flag 后面那个一律跳过」又会把
 * `--require-launch-opt-in claude-channel` 里真正的子命令吃掉。名单外的 flag 一律当 boolean。
 */
const VALUE_FLAGS = new Set([
  "--channel", "-c", "--identity", "--claude-session-name", "--runner",
  "--attempt-id", "--version", "--limit", "--window", "--for", "--resume-at",
]);

/** party 进程 argv[0] 之后的位置参数（已跳过 flag 及其取值）。 */
export function partyPositionals(command: string): string[] {
  const out: string[] = [];
  const argv = commandArgv(command).slice(1);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith("-")) {
      // `--channel=dev` 自带取值，不吃下一个 token。
      if (VALUE_FLAGS.has(arg) && !arg.includes("=")) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** party 进程的子命令；不是 party 进程或没有子命令 → null。 */
export function partySubcommand(command: string): string | null {
  if (!isPartyProcess(command)) return null;
  return partyPositionals(command)[0] ?? null;
}

/**
 * 进程档（lane）：
 *  - `session-child`：只由 harness 通过 stdio 拉起，**不存在**合法的 ppid=1 形态。
 *  - `daemon`：人可以有意 daemonize，ppid=1 属正常。
 *  - `oneshot` / null：短命命令或认不出来的，不参与清理。
 */
export type PartyLane = "session-child" | "daemon" | "oneshot" | null;

const SESSION_CHILD_SUBCOMMANDS = new Set(["claude-channel"]);
const DAEMON_SUBCOMMANDS = new Set(["serve", "watch", "daemon", "hook", "bridge"]);

export function partyLane(command: string): PartyLane {
  const sub = partySubcommand(command);
  if (sub === null) return null;
  if (sub === "mcp") {
    // `party mcp prune` 等子命令是短命 CLI，不是常驻 server——别把一次正在跑的清理当孤儿。
    return partyPositionals(command)[1] === undefined ? "session-child" : "oneshot";
  }
  if (SESSION_CHILD_SUBCOMMANDS.has(sub)) return "session-child";
  if (DAEMON_SUBCOMMANDS.has(sub)) return "daemon";
  return "oneshot";
}

export type OrphanAction = "stale" | "review" | "keep";

export interface OrphanVerdict {
  action: OrphanAction;
  reason: string;
}

export interface ClassifyOrphanInput {
  proc: ScannedProcess;
  /** 绝不能碰的 pid（自己、自己的祖先链、用户显式保护的）。 */
  protectedPids?: ReadonlySet<number>;
}

/**
 * 判定一个进程。默认 keep——每一条 stale 都必须由一条明确的规则写出来。
 */
export function classifyOrphanProcess(input: ClassifyOrphanInput): OrphanVerdict {
  const { proc } = input;
  // ①「绝不碰非 party 进程」：这是第一道也是唯一一道决定性闸门，任何后续分支都到不了
  // 非 party 进程头上。误杀别人的 mcp server / 编辑器 / 数据库是灾难。
  if (!isPartyProcess(proc.command)) {
    return { action: "keep", reason: "not an AgentParty process — never touched" };
  }
  if (input.protectedPids?.has(proc.pid) === true) {
    return { action: "keep", reason: "protected pid (this process or one of its ancestors)" };
  }
  const lane = partyLane(proc.command);
  if (lane === null || lane === "oneshot") {
    return { action: "keep", reason: "not a long-lived session-bound process" };
  }
  if (proc.ppid !== 1) {
    return { action: "keep", reason: `parent pid ${String(proc.ppid)} is still alive` };
  }
  if (lane === "daemon") {
    // ppid=1 的 serve/watch 绝大多数是人手工 nohup 起来的，是**正常形态**。
    return {
      action: "review",
      reason: "re-parented to init, but this lane is legitimately daemonized — left running, your call",
    };
  }
  return {
    action: "stale",
    reason: "orphaned: its harness session is gone (re-parented to init) and this lane only ever runs as a session child",
  };
}
