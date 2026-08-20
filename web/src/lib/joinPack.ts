// 完整接入包的唯一 builder：「＋ 让 agent 加入」（AgentJoin）与 vault「复制接入包」
// （AgentTokens）都调这一份，两个入口的产物从结构上逐字节同构，杜绝再漂移（#584 复盘）。
// 独立成模块而不放 agentTokenVault：AgentJoin 的测试整体 mock 了 vault 模块，
// builder 放那边会让组件测试拿到假实现。
import { AGENT_NAME_RE, BEHAVIOR_CONTRACT_BODY_LINES, channelDecisionSnapshotBodyLines, charterSnapshotBodyLines, mcpServerName } from "@agentparty/shared/onboarding";
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

// 完整接入脚本：init 只写配置不发消息，必须带「报到发言」，否则网页上看不到 agent。
export function buildFullJoinPack(input: FullJoinPackInput): string {
  const { slug, agentName, agentToken, server, charter, t } = input;
  // #597：邀请人的「频道身份」可能是 account id（lark:on_xxx / github:xxx），不满足 mention
  // 的 name 正则——渲染出的 --mention 会被 CLI 直接拒绝，新 agent 第一条报到就报错。
  // 校验不过就整体降级为不 @：报到照发，blocked 指引改教它用 party who 反查 handle。
  const inviterName = AGENT_NAME_RE.test(input.inviterName) ? input.inviterName : null;
  // #845 第 4 点：按目标 harness 只渲染对应分支。"other" 恒全量（兜底＝旧行为逐字节不变）。
  const harness = input.harness ?? "other";
  return [
    t("AgentJoin.cmd.header", { slug }),
    t("AgentJoin.cmd.intro1"),
    t("AgentJoin.cmd.intro2"),
    ``,
    t("AgentJoin.cmd.scope1", { slug }),
    t("AgentJoin.cmd.scope2"),
    ``,
    ...charterSnapshotLines(charter, t),
    t("AgentJoin.cmd.step1"),
    // PATH 必须先于版本检查：install.sh 装到 ~/.local/bin，若检查时查的是系统 PATH 里
    // 另一个够新的 party、后续命令却用回 ~/.local/bin 的旧版，版本闸就被绕过了。
    `export PATH="\$HOME/.local/bin:\$PATH"`,
    VERSION_GE_SNIPPET,
    `need=${MIN_CLI}; have="$(party --version 2>/dev/null || echo 0)"; version_ge "$have" "$need" || curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh`,
    t("AgentJoin.cmd.pathNote1"),
    t("AgentJoin.cmd.pathNote2"),
    `command -v party >/dev/null || alias party="\$HOME/.local/bin/party"`,
    ``,
    t("AgentJoin.cmd.step2"),
    `mkdir -p "$HOME/.agentparty/agents"`,
    `export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${agentName}-${slug}.json"`,
    t("AgentJoin.cmd.turnWarn1"),
    t("AgentJoin.cmd.turnWarn2"),
    t("AgentJoin.cmd.turnWarn3"),
    t("AgentJoin.cmd.turnWarn4", { agentName, slug }),
    ``,
    // #845 层 2：行为契约落盘成 rules 文件（与 AGENTPARTY_CONFIG 同目录同命名风格），
    // 上下文被压缩/丢失后可重读。正文是 shared 的静态常量（BEHAVIOR_CONTRACT_BODY_LINES），
    // 绝不掺 charter 等管理员可控文本（那有注释化防 RCE 的约束）；heredoc delimiter 带引号防变量展开。
    t("AgentJoin.cmd.rulesNote"),
    `cat > "$HOME/.agentparty/agents/agentparty-${agentName}-${slug}.rules.md" <<'AGENTPARTY_RULES_EOF'`,
    ...BEHAVIOR_CONTRACT_BODY_LINES,
    `AGENTPARTY_RULES_EOF`,
    ``,
    t("AgentJoin.cmd.step3"),
    // #676：token 走 AGENTPARTY_TOKEN 环境变量传入，不写进 argv——同机任意用户 `ps -axww` 看不到它，
    // 也不触发 party init 自身「--token 会进 argv/history」的告警（最严格可改 `--token -` 从 stdin 读）。
    `AGENTPARTY_TOKEN='${agentToken}' party init --server ${server} --channel ${slug}`,
    inviterName === null ? t("AgentJoin.cmd.step3noteNoMention", { slug }) : t("AgentJoin.cmd.step3note"),
    inviterName === null
      ? `party send "${t("AgentJoin.cmd.checkinMessage", { agentName })}" --channel ${slug}`
      : `party send "${t("AgentJoin.cmd.checkinMessage", { agentName })}" --channel ${slug} --mention ${inviterName}`,
    ``,
    t("AgentJoin.cmd.step4"),
    // claude mcp add 是 Claude Code 专属注册命令；codex 档去掉，免得 codex 机器上直接执行报错。
    ...(harness !== "codex"
      ? [`claude mcp add ${mcpServerName(agentName)} --env AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${agentName}-${slug}.json" -- party mcp --channel ${slug}`]
      : []),
    // #848：claude 档补装 marketplace 插件——SessionStart/SessionEnd hook→会话注册表 + idle 可发现/被唤醒 +
    // 跨会话协作（#841）都由插件承载，裸 MCP 拿不到。`|| true` 保证装不上不阻断接入主流程（降级=只少这些能力）。
    // codex/other 档不加：插件是 Claude Code 专属；other 档必须与旧全量逐字节一致（joinPack.test.ts 有断言）。
    ...(harness === "claude"
      ? [
          t("AgentJoin.cmd.pluginNote1"),
          `claude plugin marketplace add leeguooooo/AgentParty || true`,
          `claude plugin install agentparty@agentparty || true`,
          // 装上未必启用——doctor.ts 的 fix 提示就是 install && enable 两连，这里对齐。
          `claude plugin enable agentparty@agentparty || true`,
          t("AgentJoin.cmd.pluginNote2"),
          // #844：把 ~/.claude/settings.json 的 crossSessionInbound 设为 accept——频道 @ 消息
          // 才能直接进对话流并唤醒你，不用每条手动点 Deliver。幂等（重复跑结果一致）、
          // 失败不阻断（全 `|| true`）、写前先备份 .agentparty.bak。
          // 不依赖 jq（未必存在）：jq → node → python3 三级兜底，都没有就跳过。
          t("AgentJoin.cmd.inboxNote1"),
          t("AgentJoin.cmd.inboxNote2"),
          t("AgentJoin.cmd.inboxNote3"),
          `AGENTPARTY_CC_SETTINGS="$HOME/.claude/settings.json"`,
          `mkdir -p "$HOME/.claude" || true`,
          `[ -f "$AGENTPARTY_CC_SETTINGS" ] || printf '{}\\n' > "$AGENTPARTY_CC_SETTINGS" || true`,
          // 备份首次写入即定：重复跑接入包时不能把备份覆盖成「已改过」的版本，
          // 否则真正的原始设置就永远找不回来了。
          `[ -f "$AGENTPARTY_CC_SETTINGS.agentparty.bak" ] || cp "$AGENTPARTY_CC_SETTINGS" "$AGENTPARTY_CC_SETTINGS.agentparty.bak" || true`,
          `if command -v jq >/dev/null 2>&1; then`,
          `  jq '.crossSessionInbound = "accept"' "$AGENTPARTY_CC_SETTINGS" > "$AGENTPARTY_CC_SETTINGS.agentparty.tmp" && mv "$AGENTPARTY_CC_SETTINGS.agentparty.tmp" "$AGENTPARTY_CC_SETTINGS" || true`,
          `elif command -v node >/dev/null 2>&1; then`,
          `  node -e 'const fs=require("fs"),f=process.argv[1];let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))||{}}catch(e){j={}};j.crossSessionInbound="accept";fs.writeFileSync(f,JSON.stringify(j,null,2)+"\\n")' "$AGENTPARTY_CC_SETTINGS" || true`,
          `elif command -v python3 >/dev/null 2>&1; then`,
          `  python3 -c 'import json,sys;f=sys.argv[1];d=json.load(open(f)) if open(f).read().strip() else {};d["crossSessionInbound"]="accept";json.dump(d,open(f,"w"),indent=2)' "$AGENTPARTY_CC_SETTINGS" || true`,
          `fi`,
          t("AgentJoin.cmd.inboxNote4"),
        ]
      : []),
    // step4codex 是 codex mcp add 指引；claude 档去掉（目标 harness 只走一条，其余是噪音）。
    ...(harness !== "claude"
      ? [t("AgentJoin.cmd.step4codex", { mcpName: mcpServerName(agentName), agentName, slug })]
      : []),
    // #850：codex 档补装 codex 插件——与 #848 的 claude 档对等；命令已真机验证（codex CLI 0.2.187）。
    // codex 无独立 enable 步骤，装完重启 codex 生效。`|| true` 保证装不上不阻断接入主流程。
    // other 档不加：必须与旧全量逐字节一致（joinPack.test.ts 有断言）；claude 档也不含 codex plugin 行。
    ...(harness === "codex"
      ? [
          t("AgentJoin.cmd.codexPluginNote1"),
          `codex plugin marketplace add leeguooooo/AgentParty || true`,
          `codex plugin add agentparty@agentparty || true`,
          t("AgentJoin.cmd.codexPluginNote2"),
        ]
      : []),
    t("AgentJoin.cmd.step4fallback"),
    ``,
    t("AgentJoin.cmd.step5"),
    t("AgentJoin.cmd.step5reply", { slug }),
    t("AgentJoin.cmd.step5more", { slug }),
    t("AgentJoin.cmd.contextAnchor1", { slug }),
    t("AgentJoin.cmd.contextAnchor2", { agentName, slug }),
    t("AgentJoin.cmd.contextAnchor3"),
    t("AgentJoin.cmd.blocked1", { slug }),
    inviterName === null
      ? t("AgentJoin.cmd.blocked2NoMention", { slug })
      : t("AgentJoin.cmd.blocked2", { slug, inviterName }),
    t("AgentJoin.cmd.stayReachable"),
    t("AgentJoin.cmd.mcpWakeNote"),
    // claudeMode 三行是 Claude Code 的 watch --once 待命指引；codex 档去掉。
    ...(harness !== "codex"
      ? [t("AgentJoin.cmd.claudeMode1"), t("AgentJoin.cmd.claudeMode2", { slug }), t("AgentJoin.cmd.claudeMode3")]
      : []),
    // otherMode 四行是常驻 serve supervisor 指引（Codex 唤醒模板挂在它下面）；claude 档去掉。
    ...(harness !== "claude"
      ? [
          t("AgentJoin.cmd.otherMode1"),
          t("AgentJoin.cmd.otherMode2"),
          t("AgentJoin.cmd.otherMode3", { slug }),
          t("AgentJoin.cmd.otherMode4"),
        ]
      : []),
    // 唤醒命令模板按 harness 各留各的：claude 档不需要 codex exec，codex 档不需要 claude -p。
    ...(harness !== "claude"
      ? [
          `#        Codex:  OUT=$(mktemp); codex exec resume --last --skip-git-repo-check -o "$OUT" "$(cat {file})" || codex exec --skip-git-repo-check -o "$OUT" "$(cat {file})"; party send - --channel "$AP_CHANNEL" --reply-to "$AP_REPLY_TO" < "$OUT"`,
        ]
      : []),
    ...(harness !== "codex" ? [`#        Claude: claude -p -c "$(cat {file})" || claude -p "$(cat {file})"`] : []),
    t("AgentJoin.cmd.sandboxWarn1"),
    t("AgentJoin.cmd.sandboxWarn2"),
    t("AgentJoin.cmd.sandboxWarn3"),
    t("AgentJoin.cmd.sandboxWarn4"),
    t("AgentJoin.cmd.watchNote", { slug }),
    // #822/#828：给按轮执行的 harness 一条诚实的路，而不是让它在 watch/serve 里二选一地硬装常驻。
    t("AgentJoin.cmd.episodic1"),
    t("AgentJoin.cmd.episodic2", { slug }),
    t("AgentJoin.cmd.episodic3"),
    t("AgentJoin.cmd.codefence"),
    t("AgentJoin.cmd.etiquette"),
    // #845：包尾提醒——本包是瞬态文本，规则的持久拷贝在上面落盘的 rules 文件里。
    t("AgentJoin.cmd.rulesReread", { agentName, slug }),
  ].join("\n");
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
