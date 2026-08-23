// 「这台机器上这个身份的任务租约到底落没落闸」——issue #931。
//
// #885 给「同一身份多执行体并发」装了一道闸（认领时刻的单活跃执行体租约）。但那道闸有两个
// 边界，实机上都会被踩到：
//   1. 它只在**本机文件级**成立（`taskLeaseDir()` 在 `$AGENTPARTY_HOME` 下）。跨机同身份、
//      甚至同机不同 AGENTPARTY_HOME，都挡不住。
//   2. 认不出执行体标识时**静默降级**成 unenforced，只往 stderr 打一行 warn；而事故里的
//      harness 那条腿恰恰最容易落进这一档（根因见 `resolveExecutorIdentity` 的注释）。
// 于是「闸看起来装了，最需要它的场景下却是开的，而且没人被告知」——本仓反复出现的那个形态。
//
// 本模块只负责第 2 条的**可见性**：把判定结果做成可主动查询的东西（`party who` / `party doctor`
// / `party status --json`），呈现口径照抄 #925/#926 的 wake-diagnosis：
//   一行结论 → 为什么 → 会怎样 → 一条能直接粘贴的命令。
// 第 1 条（跨机）不在本模块射程内，但**必须在输出里说出边界**，否则「本机互斥」会被读成
// 「全局互斥」——那比没有闸更危险。
//
// 与 wake-diagnosis 同一条纪律：判定跑的是和真实行为**完全同一份**实现
// （`resolveExecutorIdentity`），绝不写第二套「诊断专用」的解析逻辑，否则诊断说好、真跑起来坏。
// 本模块纯读本地盘 + 至多几次进程存活探测，不发网络、不写任何东西。
import {
  EXECUTOR_ID_ENV_LADDER,
  resolveExecutorIdentity,
  taskLeaseDir,
  taskLeaseIdentityPrefix,
  type ExecutorIdRefusal,
  type ExecutorIdSource,
  type ResolveExecutorEnv,
} from "./task-lease";
import { agentpartyHome } from "./config";
import { instanceLockHolderPid, instanceLockTarget, defaultInstanceLockDir } from "./instance-lock";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TaskLeaseEnforcement {
  /** 这台机器上这条腿的认领能不能被租约判定。false = 第二个执行体不会被拒。 */
  enforced: boolean;
  executor_id: string | null;
  source: ExecutorIdSource | null;
  reason: ExecutorIdRefusal | null;
  /** 为什么（人读）。 */
  detail: string;
  /** 会怎样（人读）。诊断只说事实没用，得说出后果，否则读的人不知道该不该停手。 */
  consequence: string;
  /** 一条能直接粘贴执行的命令；已落闸时为 null。 */
  fix: string | null;
  /** 互斥边界。跨机（含同机不同 AGENTPARTY_HOME）不在射程内——#931 缺口 1，尚未做服务端租约。 */
  scope: "local_home";
  home: string;
}

const SOURCE_LABEL: Record<ExecutorIdSource, string> = {
  flag: "--executor-id",
  env: "AGENTPARTY_EXECUTOR_ID",
  runner: "AP_RUNNER_WORKDIR（serve 拉起的 runner）",
  harness_session: "调用方传入的 harness 会话",
  claude_session: "CLAUDE_CODE_SESSION_ID / CLAUDE_SESSION_ID",
  codex_session: "CODEX_THREAD_ID",
};

/** 修法给的是**一条可粘贴的命令**，不是「请设置某某变量」这种无从执行的建议。 */
export const TASK_LEASE_FIX_COMMAND =
  'export AGENTPARTY_EXECUTOR_ID="harness:$(hostname -s):1"   # 每个执行体一个稳定且互不相同的值';

export function diagnoseTaskLeaseEnforcement(
  env: ResolveExecutorEnv = process.env,
  opts: {
    home?: string;
    explicit?: { executorId?: string; sessionHarness?: string; sessionId?: string };
  } = {},
): TaskLeaseEnforcement {
  const identity = resolveExecutorIdentity(env, opts.explicit);
  const home = opts.home ?? agentpartyHome(env as NodeJS.ProcessEnv);
  if (identity.id !== null && identity.source !== null) {
    return {
      enforced: true,
      executor_id: identity.id,
      source: identity.source,
      reason: null,
      detail: `执行体标识来自 ${SOURCE_LABEL[identity.source]}`,
      consequence: "同一身份的第二个执行体认领同一个 task 会被拒（任务不动，降级只读）",
      fix: null,
      scope: "local_home",
      home,
    };
  }
  const detail = identity.refusal === "malformed"
    ? `${identity.rejected.map((source) => SOURCE_LABEL[source]).join(" / ")} 设了，但值不合法` +
      "（只允许 [A-Za-z0-9][A-Za-z0-9._:@-]{0,127}），丢弃后没有别的可用标识"
    : `没有任何稳定标识在场（${EXECUTOR_ID_ENV_LADDER.join(" / ")} 一个都没设）`;
  return {
    enforced: false,
    executor_id: null,
    source: null,
    reason: identity.refusal,
    detail,
    consequence:
      "同一身份的第二个执行体认领同一个 task 时【不会被拒】——两个都会开工（#834 那次事故的形状）",
    fix: TASK_LEASE_FIX_COMMAND,
    scope: "local_home",
    home,
  };
}

/** 本机能看见的「另一个执行体」证据。纯本地，不发网络。 */
export interface LocalExecutorEvidence {
  /** 本机存在另一个执行体在服务这条 (server, token, channel)。 */
  present: boolean;
  /** 证据来源，供人读输出说清「凭什么这么判」。 */
  kinds: ("serve" | "watch" | "task_lease")[];
}

function liveLeaseHolders(dir: string, prefix: string, now: number): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const holders: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${prefix}-`) || !entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as {
        executor_id?: unknown;
        expires_at?: unknown;
      };
      if (typeof parsed.executor_id !== "string") continue;
      if (typeof parsed.expires_at !== "number" || parsed.expires_at <= now) continue;
      holders.push(parsed.executor_id);
    } catch {
      /* 半写/手改的租约文件不作为证据。 */
    }
  }
  return holders;
}

/**
 * 本机是否还有**另一个**执行体在这条 (server, token, channel) 上活着。
 *
 * 判定带 server 维度：`instanceLockTarget` / `taskLeaseIdentityPrefix` 都把 server 摁进摘要，
 * 本机同时连两台生产实例、两边同名频道时不会互相误判（#865）。
 *
 * 证据本身是保守的：`instanceLockHolderPid` 只在**正向确认**持有者进程还活着（且 pid 没被
 * 复用）时才返回 pid，租约只认未过期的那些。拿不准一律当作「没有」——诊断宁可少说一句，
 * 也不能凭一个陈旧的锁文件把用户吓停手（#908 的教训）。
 */
export function localExecutorEvidence(opts: {
  server: string;
  token: string;
  channel: string;
  /** 本执行体自己的标识；同名的租约不算「另一个」。null（认不出）时任何活租约都算证据。 */
  executorId: string | null;
  lockDir?: string;
  leaseDir?: string;
  now?: number;
  selfPid?: number;
}): LocalExecutorEvidence {
  const target = instanceLockTarget(opts.server, opts.token, opts.channel);
  const lockDir = opts.lockDir ?? defaultInstanceLockDir();
  const selfPid = opts.selfPid ?? process.pid;
  const kinds: LocalExecutorEvidence["kinds"] = [];
  for (const kind of ["serve", "watch"] as const) {
    let pid: number | null = null;
    try {
      pid = instanceLockHolderPid(kind, target, lockDir);
    } catch {
      pid = null;
    }
    if (pid !== null && pid !== selfPid) kinds.push(kind);
  }
  const holders = liveLeaseHolders(
    opts.leaseDir ?? taskLeaseDir(),
    taskLeaseIdentityPrefix(opts.server, opts.token),
    opts.now ?? Date.now(),
  );
  if (holders.some((holder) => holder !== opts.executorId)) kinds.push("task_lease");
  return { present: kinds.length > 0, kinds };
}

/**
 * 该不该主动把这段说出来。
 *
 * 判据是「**没落闸** 且 本机确实存在另一个执行体」——两个条件缺一不可：
 *  - 落了闸就不用喊（enforced 时 who 仍可显示，但不作为问题上报）；
 *  - 没有第二个执行体时喊，就是给每一次 `party doctor` 加一条与当下无关的噪音，
 *    噪音多了真问题就被淹没——那是另一种静默。
 */
export function shouldSurfaceTaskLeaseEnforcement(
  d: TaskLeaseEnforcement,
  otherExecutorPresent: boolean,
): boolean {
  return !d.enforced && otherExecutorPresent;
}

/**
 * 渲染成给人看的几行。照抄 wake-diagnosis 的口径：一行结论、为什么、会怎样、一条可执行命令。
 * 最后一行永远说清**边界**——本机互斥不是全局互斥，别让人读成「跨机也拦得住」。
 */
export function formatTaskLeaseEnforcement(
  d: TaskLeaseEnforcement,
  ctx: { evidence?: LocalExecutorEvidence } = {},
): string[] {
  const out: string[] = [];
  if (d.enforced) {
    out.push(`task-lease: 这台机器上这个身份的任务认领【已落闸】（执行体 ${d.executor_id ?? ""}）`);
    out.push(`  依据: ${d.detail}`);
  } else {
    out.push("task-lease: 这台机器上这个身份的任务认领【没落闸】");
    out.push(`  为什么: ${d.detail}`);
    out.push(`  会怎样: ${d.consequence}`);
    out.push(`  怎么修: ${d.fix ?? ""}`);
  }
  const kinds = ctx.evidence?.kinds ?? [];
  if (kinds.length > 0) {
    const label = kinds
      .map((kind) => (kind === "task_lease" ? "本机另有执行体持着这个身份的任务租约" : `本机有一个 party ${kind} 在跑`))
      .join("；");
    out.push(`  证据: ${label}——这个身份此刻确实不止一个执行体`);
  }
  out.push(
    `  边界: 这把闸只在本机 ${d.home} 内互斥；另一台机器（或另一个 AGENTPARTY_HOME）上的同一身份仍挡不住（#931 跨机缺口，需服务端租约）`,
  );
  return out;
}
