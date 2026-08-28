// 同身份多 runtime 的 @ 唤醒认领（#963）。
//
// 事故实录：owner 在 #ludo 发了一条 `@leo-server ping`，20 秒内收到 6 条不同的 pong——同一台机器、
// 同一个 cwd 里开着 13 个 Claude 会话，每个会话的 claude-channel MCP 都以 leo-server 身份挂在频道上，
// 各自匹配 `mentions.includes(self)`、各自往自己的宿主会话注入一次唤醒。@ 是拉模型：服务端只广播，
// 从不"投递"给某一个 runtime，所以 13 个 runtime 就是 13 次唤醒。任务认领早有租约去重
// （task-lease：concurrent claims on one task are refused），@ 唤醒却没有任何去重。
//
// 这里给 (server, identity, channel, seq) 发一次性认领：谁先把认领文件用 O_EXCL 建出来，谁唤醒模型；
// 其余 runtime 只把这条消息当已读上下文（本地 ack，不触发模型回合）。粒度与 task-lease 不同——
// 那是按 task 的可续期租约，这里是按 seq 的一次性抢占，没有 TTL 语义：一条 @ 只该唤醒一次，
// 认领成功即终局。认领人若注入失败可以显式释放，好让重连/重放时别的 runtime 有机会接手。
//
// 覆盖范围：**同一台机器、同一个 ~/.agentparty**（事故场景恰是这个）。跨机同身份仍各醒各的——
// 那需要服务端参与，本模块刻意不假装覆盖。
//
// 红线：认领存储写不了（只读盘 / 权限）时**放行**，不是拒绝——重复唤醒的代价远小于叫不醒，
// 与 dormant announce 一贯的降级方向一致；但必须把原因带回给调用方留痕，绝不静默。
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mentionMatchKey } from "@agentparty/shared";
import {
  sessionEntryMatchesIdentity,
  sessionEntryMatchesServer,
  type ClaudeSessionRegistryEntry,
} from "./claude-session-registry";
import { agentpartyHome } from "./config";

/** 本进程的 runtime 标识：认领文件里记它，释放时只许释放自己的。 */
export const PROCESS_WAKE_RUNTIME_ID = randomUUID();

/** 认领文件保留时长：超过即视为陈旧可清理。@ 的重放窗口远小于这个数。 */
export const MENTION_WAKE_CLAIM_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 同一进程内两次清扫的最小间隔，避免每条 @ 都 readdir。 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export interface MentionWakeRef {
  server: string;
  /** 频道身份（handle），不是宣告名——与 mentions 里出现的是同一个命名空间。 */
  identity: string;
  channel: string;
  seq: number;
}

export interface MentionWakeClaimHolder {
  runtime_id: string;
  channel: string;
  seq: number;
  claimed_at: number;
}

export type MentionWakeClaimResult =
  /** 本 runtime 抢到了：由它唤醒模型。 */
  | { state: "acquired"; holder: MentionWakeClaimHolder; path: string }
  /** 另一个 runtime 已先认领：本 runtime 只当已读，不唤醒。 */
  | { state: "denied"; holder: MentionWakeClaimHolder | null; path: string }
  /** 认领存储不可用：放行（宁可重复唤醒），但带原因留痕。 */
  | { state: "unenforced"; reason: "claim_store_unwritable"; path: string };

export interface MentionWakeClaimOptions {
  dir?: string;
  runtimeId?: string;
  now?: number;
}

export function mentionWakeClaimDir(home: string = agentpartyHome()): string {
  return join(home, "wake-claims");
}

/**
 * 认领键：(server, identity) 走不可逆摘要（identity 是 handle、不敏感，但与 task-lease 同款形态，
 * 且**必须带 server 维度**：同一台机器可连两台实例，两边都有同名频道（#865）），channel 与 seq 明文。
 */
export function mentionWakeClaimKey(ref: MentionWakeRef): string {
  const prefix = createHash("sha256")
    .update(ref.server.trim().replace(/\/+$/, ""))
    .update("\0")
    .update(mentionMatchKey(ref.identity))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${ref.channel.replace(/[^a-z0-9-]/g, "_")}-seq-${ref.seq}`;
}

function readHolder(path: string): MentionWakeClaimHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<MentionWakeClaimHolder>;
    if (typeof parsed.runtime_id !== "string" || parsed.runtime_id === "") return null;
    if (typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) return null;
    if (typeof parsed.claimed_at !== "number" || !Number.isFinite(parsed.claimed_at)) return null;
    return {
      runtime_id: parsed.runtime_id,
      channel: typeof parsed.channel === "string" ? parsed.channel : "",
      seq: parsed.seq,
      claimed_at: parsed.claimed_at,
    };
  } catch {
    return null;
  }
}

/**
 * 一次性认领：first-claim-wins，靠 O_EXCL 保证同机原子。
 * 同一 runtime 对同一 seq 重复认领（进程内去重表漏了、或重连重放）仍返回 denied——认领只发一次，
 * 上层的进程内 seen 表负责别再来问。
 */
export function claimMentionWake(ref: MentionWakeRef, options: MentionWakeClaimOptions = {}): MentionWakeClaimResult {
  const dir = options.dir ?? mentionWakeClaimDir();
  const runtimeId = options.runtimeId ?? PROCESS_WAKE_RUNTIME_ID;
  const now = options.now ?? Date.now();
  const path = join(dir, `${mentionWakeClaimKey(ref)}.json`);
  const holder: MentionWakeClaimHolder = { runtime_id: runtimeId, channel: ref.channel, seq: ref.seq, claimed_at: now };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return { state: "unenforced", reason: "claim_store_unwritable", path };
  }
  maybePrune(dir, now);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return { state: "denied", holder: readHolder(path), path };
    }
    return { state: "unenforced", reason: "claim_store_unwritable", path };
  }
  try {
    writeFileSync(fd, `${JSON.stringify(holder)}\n`, "utf8");
  } catch {
    // 文件已建出但内容没写全：别把一个空壳留下挡住别人，尽力回收后按不可写处理。
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
    return { state: "unenforced", reason: "claim_store_unwritable", path };
  }
  closeSync(fd);
  return { state: "acquired", holder, path };
}

/**
 * 释放自己的认领（注入连续失败时用）：只删 runtime_id 是自己的那份，别人的绝不动。
 * 返回是否真的释放了。
 */
export function releaseMentionWake(
  claim: Extract<MentionWakeClaimResult, { state: "acquired" }>,
): boolean {
  const current = readHolder(claim.path);
  if (current === null || current.runtime_id !== claim.holder.runtime_id) return false;
  try {
    unlinkSync(claim.path);
    return true;
  } catch {
    return false;
  }
}

const lastPruneByDir = new Map<string, number>();

function maybePrune(dir: string, now: number): void {
  const last = lastPruneByDir.get(dir) ?? 0;
  if (now - last < PRUNE_INTERVAL_MS) return;
  lastPruneByDir.set(dir, now);
  pruneMentionWakeClaims(dir, now);
}

/** 清掉超过保留时长的认领文件；任何一步失败都静默，清扫绝不影响认领本身。 */
export function pruneMentionWakeClaims(
  dir: string,
  now: number = Date.now(),
  maxAgeMs: number = MENTION_WAKE_CLAIM_MAX_AGE_MS,
): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * 「发信人就是被 @ 的那个身份」——那是对话里提到自己（「@leo-server 这次醒了」），不是召唤。
 * 比对沿用 mentionMatchKey（与 mention 命中同一把尺子）。发信人缺失/空串 → false（不当自 @）。
 */
export function selfAuthoredMention(
  senderName: string | null | undefined,
  identity: string | null | undefined,
): boolean {
  if (typeof senderName !== "string" || senderName === "") return false;
  if (typeof identity !== "string" || identity === "") return false;
  return mentionMatchKey(senderName) === mentionMatchKey(identity);
}

/**
 * 同身份存活 runtime 数（本机注册表视角）：同 server + 同频道 + 同频道身份的入册活会话，
 * 按 pid 去重（/clear、resume 可能让一个 pid 短暂留多条 session_id）。跨 cwd 也算——
 * 身份绑的是 cwd，但同身份挂在别的目录里照样会被同一条 @ 叫到。
 * 死行由 listSessions 的 kill(pid,0) 探活现场剔除，这里不再探。
 */
export function countIdentityRuntimes(
  entries: readonly ClaudeSessionRegistryEntry[],
  scope: { channel: string; server: string | null | undefined; identity: string | null | undefined },
): number {
  const pids = new Set<number>();
  for (const entry of entries) {
    if (entry.channel !== scope.channel) continue;
    if (!sessionEntryMatchesServer(entry, scope.server)) continue;
    if (!sessionEntryMatchesIdentity(entry, scope.identity)) continue;
    pids.add(entry.pid);
  }
  return pids.size;
}

/**
 * SessionStart 时的蛰伏判定（#963 建议 3）：同 cwd 已有同身份的**其他**存活会话（pid ≠ 宿主 pid）
 * ⇒ 新会话默认蛰伏（announce + 认领制单唤醒），不再去抢 live bridge 的锁——抢到也只会把一条 @
 * 变成两个 runtime 各处理一遍，抢不到则 MCP 直接退出、连 announce 都没有。要让这条新会话
 * 接管 live bridge，必须显式设 `AGENTPARTY_CLAUDE_CHANNEL_FORCE_ARM=1`。
 */
export const CLAUDE_CHANNEL_FORCE_ARM_ENV = "AGENTPARTY_CLAUDE_CHANNEL_FORCE_ARM";

export interface SiblingDormancyDecision {
  dormant: boolean;
  /** 同 cwd 同身份的其他存活会话 pid（去重、升序），供日志留痕。 */
  siblingPids: number[];
  forced: boolean;
}

export function claudeChannelSiblingDormancy(
  entries: readonly ClaudeSessionRegistryEntry[],
  scope: {
    channel: string;
    cwd: string;
    server: string | null | undefined;
    identity: string | null | undefined;
    hostPid: number;
  },
  env: NodeJS.ProcessEnv = process.env,
): SiblingDormancyDecision {
  const pids = new Set<number>();
  for (const entry of entries) {
    if (entry.pid === scope.hostPid) continue;
    if (entry.channel !== scope.channel || entry.cwd !== scope.cwd) continue;
    if (!sessionEntryMatchesServer(entry, scope.server)) continue;
    if (!sessionEntryMatchesIdentity(entry, scope.identity)) continue;
    pids.add(entry.pid);
  }
  const siblingPids = [...pids].sort((a, b) => a - b);
  const forced = env[CLAUDE_CHANNEL_FORCE_ARM_ENV] === "1";
  return { dormant: siblingPids.length > 0 && !forced, siblingPids, forced };
}
