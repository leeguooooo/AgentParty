// 加入即绑定（issue #924）——把「(harness, server, channel, owner) → identity」这条事实
// 在**加入的那一刻**落盘，而不是事后从 cwd / 进程树 / 环境变量里反推。
//
// 为什么要有这一层：#917 的四档解析全是**事后反推**。真机上（owner 那台 v0.2.205 实测）
// 四档同时全灭：
//   ① 桌面端 codex 是 GUI 应用，不继承启动它的 shell 的环境变量 ⇒ 拿不到 AGENTPARTY_CONFIG；
//   ② 会话注册表要先解析出身份才写得进去 ⇒ 鸡生蛋；
//   ③ 同一个 codex 进程下挂着 3 条 #agentparty 的 MCP 注册 ⇒ 判歧义放弃；
//   ④ 本机该频道 14 个身份 ⇒ cwd 不唯一。
// 而**加入频道的那一刻我们是确切知道身份的**：接入包是我们生成的、config 是我们写的、
// `party init` 是我们跑的、`fetchMe` 刚刚验过 name/owner。该记住的时候没记，事后才去猜——
// 这就是根因。本模块负责「记」。
//
// 同样重要的是：注册与身份是**累积**的。同一个 harness 反复加入同一频道会留下一串历史条目，
// 每多一条反推越不可能成功——**用得越久越叫不醒**。所以写入默认是**替换**语义：
//
//   替换只在 (harness, server, channel, owner) **四段全同**时发生。
//   少一段就并存：不同 harness（codex vs claude）、不同实例（#865 两台生产实例同名频道）、
//   不同 owner（同机多人）、不同频道，都是刻意的并存形态，绝不误伤。
//
// 硬约束：
//  - 本模块**只读写自己的绑定文件**，绝不删身份配置、绝不碰 MCP 注册（那是命令层的事，
//    且身份文件是凭据载体，删错＝只能重铸 token）。
//  - 替换掉谁必须能报出来给用户看（`applyJoinBinding` 返回 replaced 列表）。
//  - 读盘任何失败一律当「没有绑定」——绑定是加速器，不是新的单点故障。
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWriteJson } from "./atomic-json";

/** 绑定认得的 harness 形态。`other` = 非 codex / 非 claude 的 harness（没有 hook 通道）。 */
export type BindingHarness = "codex" | "claude" | "other";

export const BINDING_HARNESSES: readonly BindingHarness[] = ["codex", "claude", "other"];

export function isBindingHarness(value: unknown): value is BindingHarness {
  return typeof value === "string" && (BINDING_HARNESSES as readonly string[]).includes(value);
}

/** 一条加入即绑定的事实。绝不含 token——身份凭据永远只在 config 文件里。 */
export interface JoinBinding {
  harness: BindingHarness;
  /** 已归一（去掉末尾斜杠）的实例 URL。#865：少了它两台生产实例的同名频道会混成一个。 */
  server: string;
  channel: string;
  /** 频道身份的 owner；老配置可能没有，单独成组不与有 owner 的混判。 */
  owner: string | null;
  /** 频道身份名（`config.identity.name`）。 */
  identity: string;
  /** 该身份的 config 绝对路径——解析出身份后要靠它拿 token。 */
  config_path: string;
  /** 跑 `party init` 时的工作目录；只用于多条绑定并列时的收窄，不用于判定身份归属。 */
  cwd: string;
  created_at: number;
}

export const JOIN_BINDINGS_FILE = "join-bindings.json";
/** 绑定文件的条目上限。绑定是有界的索引，绝不无限长。 */
export const JOIN_BINDINGS_CAPACITY = 200;

export function joinBindingsPath(home: string): string {
  return join(home, JOIN_BINDINGS_FILE);
}

/** server 末尾斜杠不参与比较：`https://x/` 与 `https://x` 是同一台。 */
export function normalizeBindingServer(server: string): string {
  return server.trim().replace(/\/+$/, "");
}

/**
 * 替换键 —— **四段全同才替换**。这是「后加入替换先加入」的边界，也是「别误伤刻意并存」的边界。
 * owner 为 null 时自成一组（老配置没记 owner，与有 owner 的不混判）。
 */
export function joinBindingKey(binding: Pick<JoinBinding, "harness" | "server" | "channel" | "owner">): string {
  return JSON.stringify([
    binding.harness,
    normalizeBindingServer(binding.server),
    binding.channel,
    binding.owner ?? "",
  ]);
}

function parseBinding(raw: unknown): JoinBinding | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  if (!isBindingHarness(j.harness)) return null;
  if (typeof j.server !== "string" || j.server === "") return null;
  if (typeof j.channel !== "string" || j.channel === "") return null;
  if (typeof j.identity !== "string" || j.identity === "") return null;
  if (typeof j.config_path !== "string" || j.config_path === "") return null;
  return {
    harness: j.harness,
    server: normalizeBindingServer(j.server),
    channel: j.channel,
    owner: typeof j.owner === "string" && j.owner !== "" ? j.owner : null,
    identity: j.identity,
    config_path: j.config_path,
    cwd: typeof j.cwd === "string" ? j.cwd : "",
    created_at: typeof j.created_at === "number" && Number.isFinite(j.created_at) ? j.created_at : 0,
  };
}

/**
 * 读全部绑定。文件不存在 / 坏了 / 形状不对一律返回空数组——绑定读不到只是退回 #917 的反推，
 * 绝不能因为一个坏文件把 hook 或 init 打挂。
 */
export function readJoinBindings(path: string): JoinBinding[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const list = (parsed as Record<string, unknown>).bindings;
    if (!Array.isArray(list)) return [];
    const out: JoinBinding[] = [];
    for (const row of list.slice(0, JOIN_BINDINGS_CAPACITY * 2)) {
      const binding = parseBinding(row);
      if (binding !== null) out.push(binding);
    }
    return out;
  } catch {
    return [];
  }
}

export interface ApplyJoinBindingResult {
  bindings: JoinBinding[];
  /** 被这次加入替换掉的历史绑定（同 harness+server+channel+owner，但身份不同）。 */
  replaced: JoinBinding[];
}

/**
 * 纯函数：把一条新绑定并进已有列表。
 *
 * 默认替换（`replace: true`）：同键（harness+server+channel+owner）的历史条目全部让位，
 * 并作为 `replaced` 返回——**替换掉了谁必须说出来**，静默替换和静默放弃一样坏。
 * 同键同身份的重复加入不算替换（那是同一个身份重跑接入包），只刷新时间戳。
 *
 * `replace: false` 是刻意并存的出口：同键不同身份也一起留着，只去掉逐字重复的那条。
 */
export function applyJoinBinding(
  existing: readonly JoinBinding[],
  next: JoinBinding,
  opts: { replace?: boolean; capacity?: number } = {},
): ApplyJoinBindingResult {
  const replace = opts.replace !== false;
  const capacity = opts.capacity ?? JOIN_BINDINGS_CAPACITY;
  const key = joinBindingKey(next);
  const replaced: JoinBinding[] = [];
  const kept: JoinBinding[] = [];
  for (const row of existing) {
    if (joinBindingKey(row) !== key) {
      kept.push(row);
      continue;
    }
    // 同一个身份重跑接入包：不是替换，只是刷新。
    if (row.identity === next.identity && row.config_path === next.config_path) continue;
    if (replace) {
      replaced.push(row);
      continue;
    }
    kept.push(row);
  }
  const merged = [...kept, next];
  return {
    bindings: merged.length <= capacity ? merged : merged.slice(merged.length - capacity),
    replaced,
  };
}

/** 落盘一条绑定，返回被替换掉的历史绑定。写失败抛出——init 的调用方负责降级成一句 warning。 */
export function writeJoinBinding(
  path: string,
  next: JoinBinding,
  opts: { replace?: boolean } = {},
): JoinBinding[] {
  const result = applyJoinBinding(readJoinBindings(path), next, opts);
  atomicWriteJson(path, { version: 1, bindings: result.bindings });
  return result.replaced;
}

/**
 * 查「这个 harness 在这个频道上绑的是谁」。
 * 只按 harness+channel 收窄——hook 侧能确知的就这两样（server/owner 恰恰是要**查出来**的东西）。
 * 返回多条＝这台机器上该 harness 在该频道有多个并存身份，调用方必须继续收窄或明确放弃。
 */
export function findJoinBindings(
  bindings: readonly JoinBinding[],
  opts: { harness: BindingHarness; channel: string },
): JoinBinding[] {
  return bindings
    .filter((row) => row.harness === opts.harness && row.channel === opts.channel)
    // 新的排前面：并列时「最近一次加入」是更可能的答案（但仍然不允许据此瞎选，见解析器）。
    .sort((l, r) => r.created_at - l.created_at || l.identity.localeCompare(r.identity));
}

// ── harness 形态探测 ────────────────────────────────────────────────────────
// `party init` 是 harness 的后代进程（harness 的 shell 工具 → shell → party）。所以
// 「我现在被谁跑着」可以从进程祖先链上直接读出来，不用猜。探测失败一律返回 null——
// 接入包会显式带 `--harness`，探测只是没带 flag 时（手跑 init / 老接入包）的兜底。

/** 一次 `ps` 的上限，绝不吃满任何调用方的预算。 */
const PS_TIMEOUT_MS = 1_500;
/** 祖先链最多往上走多少层。GUI 应用的链路可能很长（app → helper → shell → wrapper → party）。 */
const MAX_ANCESTRY_HOPS = 24;

type SpawnLike = typeof spawnSync;

export interface ProcessRow {
  ppid: number;
  args: string;
}

/** 一次 `ps` 读出整张进程表（pid → 父 pid + 命令行）。失败返回空表——调用方据此「不知道，不猜」。 */
export function readProcessTable(spawn: SpawnLike = spawnSync): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  try {
    const result = spawn("ps", ["-axo", "pid=,ppid=,args="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return table;
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match === null) continue;
      table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3]! });
    }
  } catch {
    return new Map();
  }
  return table;
}

/**
 * 一行命令属于哪个 harness。判据只看**可执行文件本体**，不看命令行里出现的任意 token——
 * 否则 `vim codex-notes.md`、`git commit -m "claude"` 都会被认成 harness（这正是 #918
 * 在 party mcp 判据上踩过的坑，判据本身更不能松）。
 */
export function harnessFromCommand(command: string): BindingHarness | null {
  const first = command.trim().split(/\s+/)[0];
  if (first === undefined || first === "") return null;
  const base = basename(first).replace(/\.(exe|cmd|bat)$/i, "");
  // 桌面 codex（ChatGPT.app）的可执行文件同样叫 codex：
  // /Applications/ChatGPT.app/Contents/Resources/codex（本机实测）。
  if (base === "codex" || base === "codex-app-server") return "codex";
  if (base === "claude") return "claude";
  return null;
}

/**
 * 从给定 pid 往上走祖先链，找出跑着我们的是哪个 harness。找不到返回 null（＝不知道，不猜）。
 * 只在没有显式 `--harness` 时用；显式值永远优先。
 */
export function detectHarnessFromAncestry(
  startPid: number,
  spawn: SpawnLike = spawnSync,
): BindingHarness | null {
  return findHarnessAncestor(startPid, spawn)?.harness ?? null;
}

/**
 * 同上，但连那个 harness 进程的 pid 一起给（#957：join 要拿它去注册表里认领「跑 join 的这个
 * codex 会话」）。找不到返回 null，绝不猜。
 */
export function findHarnessAncestor(
  startPid: number,
  spawn: SpawnLike = spawnSync,
): { harness: BindingHarness; pid: number } | null {
  if (!Number.isInteger(startPid) || startPid <= 1) return null;
  if (process.platform === "win32") return null;
  const table = readProcessTable(spawn);
  if (table.size === 0) return null;
  let pid = startPid;
  for (let hop = 0; hop < MAX_ANCESTRY_HOPS; hop += 1) {
    const row = table.get(pid);
    if (row === undefined) return null;
    const harness = harnessFromCommand(row.args);
    if (harness !== null) return { harness, pid };
    if (row.ppid <= 1 || row.ppid === pid) return null;
    pid = row.ppid;
  }
  return null;
}
