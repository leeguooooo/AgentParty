// 「这台机器上这个身份其实叫不醒」——在**第一条 @ 之前**就说出来（issue #926）。
//
// 为什么是 MCP 启动时做这件事：
//   codex 0.149+ 有 hook 信任闸（版本依据见 codex-trust-gate.ts），每条 hook 要被显式批准才会执行，
//   未批准的一律**静默跳过**。
//   owner 那台机器实测：`~/.codex/config.toml` 里 26 条 hook 全是 `enabled = false`（不只我们的），
//   而同一时刻 codex 进程下活着 8 个 `party mcp` 子进程。
//   ⇒ **MCP 不受 hook 信任闸管辖**。于是我们有一条完全不依赖用户做任何事的通道：
//     MCP 本来就要在会话启动时被拉起，顺手读一次本地盘就能断定「@ 我有没有用」。
//
// 为什么要上报而不是只在本机打印：需要修的那个人**不会**去看日志、不会跑 doctor。
// 但 @ 他的那个人当场就在等回应——把结论挂到 presence 上，发送方当场看见，人会替人解决。
//
// 三条硬约束（全部体现在下面的代码形状里）：
//   1. 上报失败绝不能影响 MCP 本身：全程 fire-and-forget，任何异常吞掉，绝不阻断 stdio。
//   2. 判定要带 server 维度（#865：本机两台生产实例都有同名频道），绝不跨实例误判。
//   3. 老版本 codex 没有信任闸时判 `ok`，不喊狼来了（#925 已确立的语义，由 codexStopHookStatus 保证）。
import type { WakeBlock, WakeBlockReason } from "@agentparty/shared";
import { codexStopHookStatus, type CodexStopHookStatus } from "./wake-diagnosis";
import {
  detectHarnessFromAncestry,
  findJoinBindings,
  joinBindingsPath,
  normalizeBindingServer,
  readJoinBindings,
  type BindingHarness,
  type JoinBinding,
} from "./join-binding";
import { agentpartyHome, readConfig, resolveChannel } from "./config";
import { resolveAuth } from "./oidc-cli";
import { reportWakeBlock } from "./rest";

/**
 * 自检要上报什么。
 *  - `block`：叫不醒，连同人话与一条可执行命令一起挂到 presence 上。
 *  - `clear`：这条通道通了，清掉之前挂的判定（修好后新开一次会话就走到这里——这是自愈的正路）。
 *  - `skip`：我们对这个身份的唤醒层一无所知，**什么都不报**。
 *
 * `skip` 必须是一个显式的档，而不是「报个空的」：一条错误的「一切正常」比沉默更坏，
 * 而我们对非 codex 身份确实没有本机可自检的断点。
 */
export type WakeSelfCheck =
  | { report: "skip"; why: string }
  | { report: "clear" }
  | { report: "block"; block: WakeBlock };

/** 每一档的人话 + 一条可执行命令。fix 恒为 `party wake check`——一条命令说清「还差几步、差哪一步」。 */
const WAKE_CHECK_COMMAND = "party wake check";

const CODEX_HOOK_DETAIL: Record<Exclude<CodexStopHookStatus, "ok">, { reason: WakeBlockReason; detail: string }> = {
  // 措辞刻意不带主语（不写「这台机器」「对方」）：同一句既要出现在**发送方**的 warn 行里，
  // 也要出现在**本机自己**的 who 行里。带了主语，总有一边读起来是错的。
  missing: {
    reason: "codex_hook_missing",
    detail:
      "它所在机器的 codex 没装 AgentParty 的 Stop hook：codex 会话结束时不会来取欠账，@ 不会有任何反应，也不会有任何报错。",
  },
  "needs-review": {
    reason: "codex_hook_needs_review",
    detail:
      "它所在机器的 codex 还没批准 AgentParty 的 Stop hook：未获批准的 hook 会被 codex【静默跳过】，@ 不会有任何反应，也不会有任何报错。",
  },
  disabled: {
    reason: "codex_hook_disabled",
    detail:
      "它所在机器的 codex 把 AgentParty 的 Stop hook 标成了 enabled=false：codex 会【静默跳过】它，@ 不会有任何反应，也不会有任何报错。",
  },
};

/** 纯函数：一个 codex hook 四态判定 → 要不要挂「叫不醒」。`ok` ⇒ null（通了）。 */
export function wakeBlockForCodexHook(status: CodexStopHookStatus, now: number): WakeBlock | null {
  if (status === "ok") return null;
  const spec = CODEX_HOOK_DETAIL[status];
  return { reason: spec.reason, detail: spec.detail, fix: WAKE_CHECK_COMMAND, ts: now };
}

/**
 * 这个身份在本机是不是一条 codex 拉取式唤醒通道。
 *
 * 两个独立判据，任一成立即算：
 *   ① 进程祖先链上跑着 codex（`party mcp` 是 codex 的后代进程）——最直接的事实；
 *   ② 本机为 (codex, 这台 server, 这个频道, 这个身份) 记过加入绑定（#924）——祖先链探测
 *      在 Windows / `ps` 不可用时会返回 null，绑定是那时唯一还站得住的判据。
 *
 * #865：绑定必须比对 server。本机两台生产实例都有 `#agentparty`，只按频道名匹配会把隔壁实例的
 * 同名身份认成本机的 codex 身份，然后往错的那台上报一条错的判定。
 */
export function isLocalCodexIdentity(input: {
  /** 惰性：只有绑定答不上来时才会被调用（见下方注释）。 */
  harness: () => BindingHarness | null;
  bindings: readonly JoinBinding[];
  server: string;
  channel: string;
  identity: string;
}): boolean {
  // 顺序刻意是「先绑定、后祖先链」：绑定是一次纯文件读，而祖先链探测要 spawnSync 一次 `ps`
  // （最多 1.5s **阻塞事件循环**）。这条自检挂在 MCP 启动路径上，绝不能为了一条附赠的诊断
  // 去堵住 stdio。绑定能答上来的场合（接入包跑过 = 绝大多数）就一次 ps 都不花。
  //
  // 两边都归一：readJoinBindings 读出来的行已经归一过，但直接构造的绑定（单测/未来的调用方）
  // 不一定。少归一一边，`https://x/` 与 `https://x` 就会被判成两台机器。
  const server = normalizeBindingServer(input.server);
  const bound = findJoinBindings(input.bindings, { harness: "codex", channel: input.channel }).some(
    (row) => normalizeBindingServer(row.server) === server && row.identity === input.identity,
  );
  return bound || input.harness() === "codex";
}

/**
 * 纯决策：给定本机事实，这次 MCP 启动该上报什么。所有 I/O 都由调用方注入，便于逐条钉死。
 */
export function decideWakeSelfCheck(input: {
  harness: () => BindingHarness | null;
  bindings: readonly JoinBinding[];
  server: string;
  channel: string;
  identity: string;
  hookStatus: () => CodexStopHookStatus;
  now: number;
}): WakeSelfCheck {
  if (!isLocalCodexIdentity(input)) {
    return { report: "skip", why: "not a codex identity on this machine" };
  }
  const block = wakeBlockForCodexHook(input.hookStatus(), input.now);
  return block === null ? { report: "clear" } : { report: "block", block };
}

/**
 * MCP 启动时跑一次。**永不抛**、永不阻断——这条上报要么帮上忙，要么什么都没发生。
 *
 * 刻意不做的事（issue #926 明确划的界）：
 *   - 不改用户的 `~/.codex/config.toml` 把 hook 置为 enabled —— 等于替用户点信任确认，越权；
 *   - 不建议、不写入 `--dangerously-bypass-hook-trust` —— 那是拿关掉一个安全控制换我们的功能；
 *   - 不轮询、不常驻额外进程 —— 成本挂在本来就要启动的这个进程上，只跑这一次。
 */
export async function reportWakeSelfCheck(
  defaultChannel: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WakeSelfCheck | null> {
  try {
    const channel = resolveChannel(defaultChannel);
    if (channel === null || channel === "") return null;
    // 身份名只认本地 config 缓存。**刻意不回落到 fetchMe**：MCP 启动路径上不该为一条附赠的
    // 诊断多打一次网络——拿不到名字就安静放弃，代价只是少一条提示。
    const identity = readConfig()?.identity?.name ?? null;
    if (identity === null || identity === "") return null;
    // resolveAuth 只读本地 config / account 文件，不发网络。
    const auth = await resolveAuth();
    if (auth === null) return null;
    // 决策先于任何网络：skip 是绝大多数进程的归宿（非 codex 身份），它们一个字节都不该发出去。
    const decision = decideWakeSelfCheck({
      harness: () => detectHarnessFromAncestry(process.pid),
      bindings: readJoinBindings(joinBindingsPath(agentpartyHome(env))),
      server: auth.server,
      channel,
      identity,
      hookStatus: () => codexStopHookStatus(env),
      now: Date.now(),
    });
    if (decision.report === "skip") return decision;
    await reportWakeBlock(
      auth.server,
      auth.token,
      channel,
      identity,
      decision.report === "block" ? decision.block : null,
    );
    return decision;
  } catch {
    // 静默降级：拿不到状态就不报。诊断绝不能变成新的单点故障。
    return null;
  }
}
