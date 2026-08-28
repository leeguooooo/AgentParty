// 完整接入包的唯一 builder：「＋ 让 agent 加入」（AgentJoin）与 vault「复制接入包」
// （AgentTokens）都调这一份，两个入口的产物从结构上逐字节同构，杜绝再漂移（#584 复盘）。
// 独立成模块而不放 agentTokenVault：AgentJoin 的测试整体 mock 了 vault 模块，
// builder 放那边会让组件测试拿到假实现。
import { AGENT_NAME_RE, buildInteractiveJoinPack, channelDecisionSnapshotBodyLines, charterSnapshotBodyLines } from "@agentparty/shared/onboarding";
import type { ChannelCharter } from "./api";
import type { DesktopAgentRunner } from "./desktopAgent";
import type { TFunc } from "../i18n/useT";
import { RELEASE_CLI_VERSION } from "./releaseVersion";
import "../i18n/strings/AgentJoin";

// snippet 里 need= 的 CLI 版本：低于它就强制重装（旧版会把「需升级」误报成 token 失效，见 issue #2）。
// 跟随刚发布的 CLI（RELEASE_CLI_VERSION 源自 cli/package.json，构建时注入）——不再手改常量、不再漂移。
// 接入包 MCP-first，依赖 party mcp 的 party_decision_ask 与 party_send attach（0.2.124 起提供），
// 而每次发布的 CLI 天然都在其上，所以用「刚发布版」当闸既满足依赖、又永远新鲜。
export const MIN_CLI = RELEASE_CLI_VERSION;

// 与桌面最小接入包共用同一份 awk 三段版本比较；只查 command -v 会放过装着旧版、缺 MCP 工具的机器。
export const VERSION_GE_SNIPPET =
  `version_ge(){ awk -v a="$1" -v b="$2" 'BEGIN{split(a,A,".");split(b,B,".");for(i=1;i<=3;i++){A[i]+=0;B[i]+=0;if(A[i]>B[i])exit 0;if(A[i]<B[i])exit 1}exit 0}'; }`;

// 公告正文必须整体注释化：接入包的约定是「不带 # 的行是要执行的命令」，而 charter 由频道
// 管理员可控——逐字插入等于让对方频道的管理员向接入方的终端注入任意命令（跨公司信任边界上
// 的 RCE）。每行加 "# " 前缀让内容只可读、不可执行；空行补 "#" 防止段落断开处漏出裸行；
// 正文先过 charterSnapshotBodyLines 剥控制字节（ESC/CSI/CR 能视觉覆盖注释前缀，见 shared 注释）。
function charterSnapshotLines(charter: ChannelCharter | null, t: TFunc): string[] {
  const charterLines = charter?.charter
    ? [
        t("AgentJoin.cmd.charterBegin"),
        ...charterSnapshotBodyLines(charter.charter).map((line) => (line === "" ? "#" : `# ${line}`)),
        t("AgentJoin.cmd.charterEnd"),
      ]
    : [];
  const decisionLines = channelDecisionSnapshotBodyLines(charter?.active_decisions ?? [])
    .map((line) => `# ${line}`);
  if (charterLines.length === 0 && decisionLines.length === 0) return [];
  return [
    t("AgentJoin.cmd.charterHeader"),
    ...charterLines,
    ...(charterLines.length > 0 && decisionLines.length > 0 ? ["#"] : []),
    ...decisionLines,
    ``,
  ];
}

// #845 第 4 点：interactive 包按目标 harness 拆分——包里同时塞所有 harness 的分支时，
// 目标 agent 只走一条，其余全是噪音。"other" 是兜底＝现行全量输出（不选择时行为不变）。
// 安全硬行（charter 注释化 / PATH 先于版本闸 / token 环境变量 / rules.md 落盘）三档全保留。
export type JoinPackHarness = "claude" | "codex" | "other";

// #895：#847 之前建的 vault 记录没有 harness 字段，回落 other＝全量档——而全量档会把
// Claude 的 watch --once 指引也发给 codex 身份（#879：codex 不靠 watch 唤醒），是错的操作指引。
// 名字后缀是唯一的现成线索（`…-codex1` / `…-claude`），拿它当【可见的预选值】：UI 必须把
// 猜出来的档位显示出来并可改，绝不静默当事实——名字里带 codex 的身份也可能跑在别的 harness 上。
export function guessJoinPackHarness(agentName: string): JoinPackHarness {
  const lower = agentName.toLocaleLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude";
  return "other";
}

export interface FullJoinPackInput {
  slug: string;
  agentName: string;
  agentToken: string;
  /** 真实后端 origin（#530：桌面版必须传 apiBase，不能是 tauri://localhost）。 */
  server: string;
  inviterName: string;
  /** 生成时刻的频道公告快照；null 则整段省略（包里已指引用 party charter 看最新）。 */
  charter: ChannelCharter | null;
  /** 无人值守脚本里 `party serve --runner <?>` 的取值；缺省 codex（与桌面「转为常驻」面板默认一致，#749）。
   *  仅影响 unattended 包；interactive 包贴给 agent 自己的 harness，与 runner 无关。 */
  runner?: DesktopAgentRunner;
  /** interactive 包的目标 harness（#845 第 4 点）：只渲染对应分支把包砍薄；缺省 "other" 全量。
   *  仅影响 interactive 包；unattended 包给人跑，与它无关。 */
  harness?: JoinPackHarness;
  t: TFunc;
}

// unattended 脚本的默认 runner：与 DesktopAgentPanel 的 picker 默认一致（codex），
// 不再写死 claude——#749：AgentJoin 曾无条件 --runner claude，用户选 codex 被静默忽略。
export const DEFAULT_JOIN_RUNNER: DesktopAgentRunner = "codex";

// #944 把 108 行粘贴稿压成「三行约定 + 两行命令」；#992（epic #987）再压成「一句话 + 一条命令」：
// 机械步骤（写 config/rules、判重#907、绑定#924、注册 MCP#898、装+批准 codex hook#901/#942/#943、
// 报到#597、自检#926）早已全收进 `party join`，而 `party join` 本身就是分步引导（每步 check →
// 过/不过 → 不过给一条修法并停在那一步），粘贴稿里不再需要任何提示词。builder 与 cli（party invite）
// 同源（shared/onboarding），别再在 web/cli 各写一份（#585）。charter 不再快照进包——`party join`
// 加入时拉取并终端安全地打印最新公告（比粘贴时的快照更新鲜，也消掉了 charter 注入面）。
export function buildFullJoinPack(input: FullJoinPackInput): string {
  return buildInteractiveJoinPack({
    slug: input.slug,
    server: input.server,
    token: input.agentToken,
    agentName: input.agentName,
    // #845 第 4 点保留 harness 分档：已知就带进 `party join --harness`，让目标机少探一步；
    // "other"/缺省不带，交给 `party join` 在对方机器上探测（#924）。校验不过的 inviter 见 shared。
    harness: input.harness ?? "other",
    inviterName: AGENT_NAME_RE.test(input.inviterName) ? input.inviterName : null,
  });
}

// 无人值守值守包（#612 公司大群）：serve --runner <codex|claude|codex-sdk> 的一键预设（#749：runner 可选,
// 缺省 codex）。serve 的 builtin runner 默认走角色裁剪的 party MCP 工具协议（#581 Phase 2，0.2.127 起提供）；
// 同样以「刚发布版」当闸,一键预设永远落到最新的 serve/runner，不再手改。
export const MIN_CLI_UNATTENDED = RELEASE_CLI_VERSION;

export type JoinPackMode = "interactive" | "unattended";

export function buildJoinPack(mode: JoinPackMode, input: FullJoinPackInput): string {
  return mode === "unattended" ? buildUnattendedJoinPack(input) : buildFullJoinPack(input);
}

// 无人值守包给「人」跑而不是贴给 agent：装 CLI → 写身份配置 → party serve --runner <选中的>
// 常驻（缺省 codex，#749），被 @ 即自动唤醒一次 headless runner 处理。与完整接入包同源共享 charter 快照
// 注释化（管理员可控文本绝不落成可执行行）与版本闸三段比较。
export function buildUnattendedJoinPack(input: FullJoinPackInput): string {
  const { slug, agentName, agentToken, server, charter, t } = input;
  const runner = input.runner ?? DEFAULT_JOIN_RUNNER;
  const inviterName = AGENT_NAME_RE.test(input.inviterName) ? input.inviterName : null;
  return [
    t("AgentJoin.ua.header", { slug }),
    t("AgentJoin.ua.intro1"),
    t("AgentJoin.ua.intro2"),
    ``,
    ...charterSnapshotLines(charter, t),
    t("AgentJoin.ua.step1", { min: MIN_CLI_UNATTENDED }),
    `export PATH="\$HOME/.local/bin:\$PATH"`,
    VERSION_GE_SNIPPET,
    `need=${MIN_CLI_UNATTENDED}; have="$(party --version 2>/dev/null || echo 0)"; version_ge "$have" "$need" || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
    `command -v party >/dev/null || alias party="\$HOME/.local/bin/party"`,
    ``,
    t("AgentJoin.ua.step2"),
    `mkdir -p "$HOME/.agentparty/agents"`,
    `export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${agentName}-${slug}.json"`,
    // #907：同 (server, channel, owner) 已有身份时先说出来，让「替换 / 并存」成为显式选择。
    t("AgentJoin.cmd.channelDedupeNote1"),
    t("AgentJoin.cmd.channelDedupeNote2"),
    `party mcp identities --channel ${slug} --server ${server} --exclude ${agentName} || true`,
    // #676：token 走 AGENTPARTY_TOKEN 环境变量传入，不写进 argv（同机 `ps -axww` 看不到），也不触发 CLI 自身告警。
    `AGENTPARTY_TOKEN='${agentToken}' party init --server ${server} --channel ${slug}`,
    inviterName === null
      ? `party send "${t("AgentJoin.ua.checkinMessage", { agentName })}" --channel ${slug}`
      : `party send "${t("AgentJoin.ua.checkinMessage", { agentName })}" --channel ${slug} --mention ${inviterName}`,
    ``,
    t("AgentJoin.ua.step3"),
    t("AgentJoin.ua.step3a"),
    t("AgentJoin.ua.step3b"),
    t("AgentJoin.ua.step3c", { agentName }),
    `party serve --channel ${slug} --runner ${runner}`,
    ``,
    t("AgentJoin.ua.note1"),
    t("AgentJoin.ua.note2"),
    t("AgentJoin.ua.note3"),
    t("AgentJoin.ua.note4"),
  ].join("\n");
}
