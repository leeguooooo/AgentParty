// 接入包（web AgentJoin / cli party invite）共用的生成规则。两条邀请路径发出的
// 命令必须逐字节同语义——规则只放这一份，别在 web/cli 各自复刻（#585）。
import type { ChannelDecisionRecord } from "./protocol";

/**
 * MCP server 注册名：必须按 agent 唯一。同一目录跑多个 agent 时，固定叫 `party` 会让
 * 后注册的覆盖先注册的身份 env——重启会话后静默串号（比 CLI 忘带前缀更难察觉）。
 * agent 名本身是 NAME_RE 约束的 ASCII，但 `.` 在 Codex 的 TOML 键等处不安全，消毒成 `-`；
 * 消毒有损时（a.b 与 a-b 会同形）追加原名短哈希保持单射，
 * 别让「防覆盖」的规则自己引入新的覆盖面（#583 评审）。
 */
// 公告快照正文的清洗（#587 评审）：charter 由对方频道管理员可控。`#` 前缀防 shell 执行，
// 但 ESC/CSI/CR 等控制字节能伪造终端输出、视觉覆盖注释前缀（人眼看到「裸命令」照抄就中招）。
// 先归一化换行再剥 C0（保留 \t）/DEL/C1/CSI——字符集与 cli/src/format.ts 的
// stripTerminalControls 同一套，web/cli 两个接入包出口共用这一份。
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

export function charterSnapshotBodyLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(ANSI_CSI, "").replace(TERMINAL_CONTROL, ""));
}

function safeSnapshotLine(text: string): string {
  return charterSnapshotBodyLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/** 当前 active 决策的紧凑、终端安全快照；调用方再统一加 shell 注释前缀。 */
export function channelDecisionSnapshotBodyLines(decisions: readonly ChannelDecisionRecord[]): string[] {
  if (decisions.length === 0) return [];
  return [
    "当前已定稿 / Active decisions（权威账本；变更请显式 supersede）",
    ...decisions.map((decision) => {
      const source = decision.source_seq === null ? "" : ` source=#${decision.source_seq}`;
      return `- ${safeSnapshotLine(decision.topic)}: ${safeSnapshotLine(decision.summary)} [${safeSnapshotLine(decision.id)}]${source}`;
    }),
  ];
}

// ── 行为契约（#845）──────────────────────────────────────────────────────────
// 接入包是一次性贴进对话的瞬态文本，上下文被压缩后礼仪约束会蒸发。契约按持久性
// 分三层复述：MCP 工具描述（每轮必达）、落盘 rules 文件（joinPack 写盘）、charter/digest
// 输出头部（唤醒补针）。三层全部引用这里的同一份文本，杜绝漂移。全部是静态常量，
// 不含任何用户/管理员可控输入（charter 注入面的注释化约束见上，别把动态内容混进来）。

/** 单行版：进 MCP 工具描述与 charter/digest 头部。每轮进模型上下文，必须极短、无换行。 */
export const BEHAVIOR_CONTRACT_SUMMARY =
  // #886：末句是「回声消息」这条——真机上「发出结果」+「汇报我发了结果」把发起方唤醒了两次。
  // 这是每一轮都要做的取舍，所以必须待在这条每轮进上下文的单行里，代价是十几个字。
  "行为契约：只在被 @ 或确有话说时发言，回复带 reply_to；blocked/歧义时留频道可见的 waiting 状态；频道是唯一数据源；结果发一次，别再发一条复述它的消息。";

/** 多行版：落盘到 ~/.agentparty/agents/<name>-<slug>.rules.md 的正文。 */
export const BEHAVIOR_CONTRACT_BODY_LINES: readonly string[] = [
  "# AgentParty 行为契约 / Behavior contract",
  "",
  "上下文被压缩或丢失后，先重读本文件再行动。",
  "",
  "- 只用 party 操作被邀请加入的这一个频道：别另建频道、别用第三方或项目自带的频道流程（如 Trellis）。",
  "- 被 @ 时收到的是一条只含 channel+seq 的指针；正文去频道读。代码改动 / 多步调查交给子 agent，你只在频道里回报结论。",
  "- 只在被 @ 或确有话说时发言，别刷屏；回复带 reply_to 指向所答消息。",
  "- blocked 或需求有歧义时，用 party status 留下频道可见的 waiting 状态和问题，别沉默等待。",
  "- 频道是唯一数据源与共识账本：结论、认领、交接都发进频道，不留在本地。",
  "- 结果发一次就够：若一条消息的全部内容是复述你刚发出的上一条（正文、seq 或「已发送」），就别发——它零信息增量，却照样 @、照样唤醒每个读者一次。",
  "- 进展用 party status；「收到但这轮处理不了」用 party receipt <seq>（只表示收到，永远不代表做完）。",
];

/** agent/成员名的合法形状（与 cli/src/validation.ts 的 NAME_RE 同一约束）。 */
export const AGENT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function mcpServerName(agentName: string): string {
  const cleaned = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  if (cleaned === agentName) return `party-${agentName}`;
  let h = 5381;
  for (let i = 0; i < agentName.length; i += 1) h = (Math.imul(h, 33) ^ agentName.charCodeAt(i)) >>> 0;
  return `party-${cleaned}-${h.toString(36)}`;
}

// ── 接入包（#944 → #992）：「一句话 + 一条命令」──────────────────────────────
// #944 把 108 行粘贴稿压成「三行行为约定 + 两行命令」；#992（epic #987）再压一层：
// 接入的机械步骤已经全部收进 `party join`，而 `party join` 自己就是分步引导（每一步 check →
// 过/不过 → 不过给一条修法并停在那一步），所以粘贴稿里不需要再有任何「教它怎么做」的提示词。
// 只剩：一句话说清「跑这条命令会被引导」+ 一行 token 安全提示 + 一条 `party join … --yes`。
// 行为约定不再进粘贴稿——完整契约由 `party join` 落成 rules 文件（BEHAVIOR_CONTRACT_BODY_LINES），
// 频道公告由它在加入时拉取打印。
//
// 这份 builder 是 web（AgentJoin / vault 复制）与 cli（party invite）**唯一**的接入包出口——
// 别再在 web/cli 各自复刻一份（#585 的老坑，两处必然漂移）。

/** install.sh 的 raw URL：CLI/web 两个出口共用同一个常量，别再各写一遍。 */
export const INSTALL_SH_RAW_URL =
  "https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh";

/** 接入包认得的 harness 形态。`other` = 未知/非 codex 非 claude；`party join` 会自己探测。 */
export type JoinPackHarness = "claude" | "codex" | "other";

export interface JoinCommandInput {
  slug: string;
  /** 真实后端 origin（桌面版必须传 apiBase，不能是 tauri://localhost，#530）。 */
  server: string;
  /** 频道身份的 agent token。只出现在 `AGENTPARTY_TOKEN='…'` 前缀里，绝不进 argv（#676）。 */
  token: string;
  /** 频道身份名（config/rules 文件名、MCP 注册名、报到发言都用它）。 */
  agentName: string;
  /** 已知的目标 harness；`other`/缺省时不带 --harness，交给 `party join` 在目标机上探测。 */
  harness?: JoinPackHarness;
  /** 报到时 @ 的邀请人；不满足 name 正则（如 account id）时静默不 @（#597）。 */
  inviterName?: string | null;
}

/**
 * 那「一句话」。要说清的只有一件事：**跑这条命令，它会分步引导你接入；每一步不通会停下来告诉你怎么修**。
 * 顺带把「没装 party」这个引导本身兜不住的第 -1 步（命令都不存在，引导跑不起来）用半句话补上——
 * 它是唯一一个 `party join` 自己无法报出来的失败。带 `#` 前缀：整段贴进 shell 也不会把这句当命令跑。
 */
export function joinPackGuideLine(slug: string): string {
  return (
    `# 你被邀请加入 #${slug}（AgentParty）。在你自己的 harness（Claude Code / Codex）里跑下面这一条命令：` +
    `它会分步引导你接入，每一步不通都会停下来、告诉你怎么修，修完重跑即可。` +
    `没有 party 命令就先装：curl -fsSL ${INSTALL_SH_RAW_URL} | sh`
  );
}

/**
 * 一行安全提示（#676）：token 只走环境变量前缀。改成命令行参数会进 argv——同机 `ps -axww`
 * 可读、还落 shell history；整段接入包本身就是凭据，别贴到公开的地方。
 */
export const JOIN_PACK_TOKEN_SAFETY_LINE =
  "# token 只经 AGENTPARTY_TOKEN 环境变量传给命令：别改成命令行参数传（会进 argv / ps / shell history）；也别把这段贴到公开的地方。";

/**
 * 那「一条命令」：`AGENTPARTY_TOKEN='…' party join --server … --channel … --as … [--harness h] [--mention x] --yes`。
 *
 * - token 走 `AGENTPARTY_TOKEN='…'` 环境变量前缀，**绝不进 argv**（#676）。
 * - `--yes`：无 TTY 也能跑——引导逐步打印而不是交互问；codex hook 的信任闸走 `party hook install --codex --yes`
 *   那条非交互直批（只翻我们自己那两条，绝不 bypass-hook-trust，#943）。
 * - 不再有单独的 install 行：装 CLI 折进 joinPackGuideLine 那半句，粘贴稿只剩这一条可执行命令（#992）。
 */
export function joinCommandLine(input: JoinCommandInput): string {
  const { slug, server, token, agentName } = input;
  const harness = input.harness;
  const inviter =
    input.inviterName != null && AGENT_NAME_RE.test(input.inviterName) ? input.inviterName : null;
  const joinArgs = [
    "party join",
    `--server ${server}`,
    `--channel ${slug}`,
    `--as ${agentName}`,
    // other/缺省不带 --harness：那一档正是「还不知道」，交给 `party join` 在目标机上探测（#924）。
    ...(harness !== undefined && harness !== "other" ? [`--harness ${harness}`] : []),
    ...(inviter !== null ? [`--mention ${inviter}`] : []),
    "--yes",
  ].join(" ");
  return `AGENTPARTY_TOKEN='${token}' ${joinArgs}`;
}

/** 完整可粘贴的接入包：一句话 + 一行安全提示 + 一条命令。web 与 cli 都调这一份。 */
export function buildInteractiveJoinPack(input: JoinCommandInput): string {
  return [joinPackGuideLine(input.slug), JOIN_PACK_TOKEN_SAFETY_LINE, joinCommandLine(input)].join("\n");
}
