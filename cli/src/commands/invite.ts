// party invite — 一条命令建频道 + 铸 token，stdout 打印可整段复制的接入包（需 ADMIN_SECRET）
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import {
  RestError,
  createChannel,
  fetchChannelCharter,
  createToken,
  handleRestError,
  listChannels,
  revokeToken,
  type ChannelMode,
  type ChannelVisibility,
} from "../rest";
import { buildInteractiveJoinPack } from "@agentparty/shared/onboarding";
import { formatCharterSnapshotForOnboarding, formatScopeGuardForOnboarding } from "../onboarding";
import { isName, isSlug, normalizeServerUrl } from "../validation";

const USAGE =
  'usage: party invite "<title>" [--mode watch|participate] [--slug s] [--temp] [--party] [--public] [--guest-name bob] [--checkin-mention name] [--owner label]';
const HELP = `${USAGE}

Create a channel, mint a scoped guest token, and print a copy-paste join pack.
Requires ADMIN_SECRET.

Options:
  --server URL       AgentParty server URL
  --mode m           invite mode: participate (default, full agent token) or
                     watch (readonly token — can read, sending disabled)
  --slug s           channel slug
  --temp             create a temporary channel
  --party            create a party-mode channel
  --public           create a public channel
  --guest-name bob   guest agent token name
  --checkin-mention  mention this name in the check-in line
  --owner label      printable owner label`;
const INVITE_FLAGS = ["server", "mode", "slug", "guest-name", "checkin-mention", "owner", "temp", "party", "public"];
const INVITE_MODES = ["participate", "watch"] as const;
type InviteMode = (typeof INVITE_MODES)[number];
const OWNER_MAX = 128;
const OWNER_RE = /^[\x20-\x7e]{1,128}$/;

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party", "public"] });
  const unknown = unknownFlagError(flags, INVITE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "mode", "slug", "guest-name", "checkin-mention", "owner"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  const inviteMode = (str(flags.mode) ?? "participate") as InviteMode;
  if (!INVITE_MODES.includes(inviteMode)) {
    console.error(`--mode must be one of: ${INVITE_MODES.join(", ")}`);
    return 1;
  }
  const title = positionals.join(" ");
  if (!title) {
    console.error(USAGE);
    return 1;
  }
  const cfg = readConfig();
  const server = normalizeServerUrl(str(flags.server) ?? cfg?.server ?? "");
  if (!server) {
    console.error("no valid server, run party init or pass --server");
    return 1;
  }
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) {
    console.error("ADMIN_SECRET env var required");
    return 1;
  }

  const slug = str(flags.slug) ?? (slugifyTitle(title) || `party-${Date.now().toString(36)}`);
  const guestName = str(flags["guest-name"]) ?? `${slug}-guest`;
  const checkinMention = str(flags["checkin-mention"]);
  const shareName = `${slug}-share`;
  if (!isSlug(slug)) {
    console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  if (!isName(guestName) || !isName(shareName)) {
    console.error("guest token name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  if (checkinMention !== undefined && !isName(checkinMention)) {
    console.error("--checkin-mention must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  // 所属人：--owner 优先；否则用 ASCII 标题当可辨识标签，CJK 等非 ASCII 标题退回 slug（header-safe）
  const owner = str(flags.owner) ?? (OWNER_RE.test(title) ? title : slug);
  if (owner.length > OWNER_MAX || !OWNER_RE.test(owner)) {
    console.error(`--owner must be printable ascii, <= ${OWNER_MAX} chars`);
    return 1;
  }
  const kind = flags.temp === true ? "temp" : "standing";
  const mode: ChannelMode = flags.party === true ? "party" : "normal";
  const visibility: ChannelVisibility = flags.public === true ? "public" : "private";
  let guestCreated = false;

  try {
    // 1. guest agent token —— 重名不静默顶掉现有 guest，让人换名
    let guest: { token: string };
    try {
      // channel-scoped agent token：只开这一个频道，递给外部/B 公司也越不了权（spec §5.3）
      guest = await createToken(server, adminSecret, guestName, "agent", owner, slug);
    } catch (e) {
      if (e instanceof RestError && e.status === 409) {
        console.error(`token ${guestName} 已存在，用 --guest-name 指定其他名字`);
        return 1;
      }
      throw e;
    }
    guestCreated = true;

    // 2. 建频道（409 = 已存在，复用）
    let channelReused = false;
    try {
      await createChannel(server, guest.token, { slug, title, kind, mode, visibility });
    } catch (e) {
      if (e instanceof RestError && e.status === 409) channelReused = true;
      else throw e;
    }

    // 打印用的 kind/mode/visibility：复用频道时以服务器真实值为准，别拿本地 flag 谎报
    let displayKind: string = kind;
    let displayMode: ChannelMode | null = mode;
    let displayVisibility: ChannelVisibility = visibility;
    if (channelReused) {
      displayMode = null;
      displayVisibility = "private"; // 复用：拉取失败则不拿本地 --public 谎报公开
      try {
        const channels = await listChannels(server, guest.token);
        const found = channels.find((ch) => ch.slug === slug);
        if (found) {
          displayKind = found.kind;
          displayMode = found.mode ?? "normal";
          displayVisibility = found.visibility ?? "private";
        }
      } catch {
        // 拉取失败：displayMode 保持 null → 打印 (existing channel)，不谎报本地 flag
      }
    }

    // 3. share readonly token —— 只在全新频道铸；已存在（409）就【不碰它】，绝不撤销/作废已分发链接
    let shareToken: string | null = null;
    try {
      // channel-scoped readonly 分享 token：分享链接只暴露这一个频道
      shareToken = (await createToken(server, adminSecret, shareName, "readonly", owner, slug)).token;
    } catch (e) {
      if (!(e instanceof RestError && e.status === 409)) throw e;
      // 409 = 已存在，沿用旧只读链接，不重铸也不撤销
    }

    const line = "─".repeat(60);
    const publicTag = displayVisibility === "public" ? " · public" : "";
    const channelDesc =
      displayMode === null
        ? `(existing channel${publicTag})`
        : `(${displayKind}${displayMode === "party" ? " · party" : ""}${publicTag})`;
    const webLines =
      shareToken !== null
        ? `网页只读围观（无需安装，直接开）：\n  ${server}/c/${slug}?t=${shareToken}`
        : `网页只读围观：沿用已分发的 ${shareName} 链接（如需新链接先手动撤销）`;
    const charter = await fetchChannelCharter(server, guest.token, slug).catch(() => null);
    const scopeGuardLines = formatScopeGuardForOnboarding(slug).join("\n");
    const charterLines = formatCharterSnapshotForOnboarding(charter).join("\n");

    // #383：watch / participate 两个 pack 的抬头（标题栏 + server/channel/scope/charter）完全相同，
    // 只有模式标签不同——抽成一处，去掉重复。输出字节不变（m3 快照守护）。
    const packHeader = (modeLabel: string): string =>
      `${line}\nAgentParty 接入包 — ${title}  · ${modeLabel}\n${line}\nserver:   ${server}\nchannel:  ${slug}  ${channelDesc}\n\n${scopeGuardLines}${charterLines ? `\n\n${charterLines}` : ""}`;

    // 观看模式（#186）：接入包锚到 readonly 分享 token——只读围观、发送已禁用（readonly 在服务端所有 seam 被硬挡）。
    // shareToken 为 null 只发生在【复用已存在频道且 share token 已存在】——明文取不回，退回沿用旧链接的提示。
    if (inviteMode === "watch") {
      const watchToken = shareToken;
      const initLine =
        watchToken !== null
          ? `AGENTPARTY_TOKEN='${watchToken}' party init --server ${server} --channel ${slug}`
          : `# 该频道的只读分享 token 已存在，明文无法重现——沿用已分发的 ${shareName} 链接，或先手动撤销再重发邀请`;
      console.log(`${packHeader("观看模式 (watch · readonly)")}

把下面整段发给对方的 agent（Claude Code / Codex）——【观看模式】：只读围观，发送已禁用。
带 # 的是给它读的说明，不带 # 的是要执行的命令：

# ── 围观频道 #${slug}（只读，不能发言）──

# 1) 装 party CLI（已装则跳过）
curl -fsSL https://raw.githubusercontent.com/leeguooooo/agentparty/main/install.sh | sh
export PATH="\$HOME/.local/bin:\$PATH"

# 2) 隔离本地配置（同机多身份不串号；必须放持久目录，TMPDIR 清理会抹掉身份和 cursor）
export AGENTPARTY_CONFIG="$HOME/.agentparty/agents/agentparty-${shareName}-${slug}.json"

# 3) 绑定频道（readonly token，只出现这一次；走 AGENTPARTY_TOKEN 环境变量传入，不进 argv/ps）
${initLine}

# 4) 怎么围观（观看模式只读，不能 send）：
#   实时跟读：party watch ${slug} --follow
#   补历史：  party history ${slug}
#   ⚠ 观看模式发送被禁用：party send 会被服务端以 "readonly token cannot send" 拒绝。
#     想要全程参与？让邀请人改用【参与模式】重发邀请（party invite ... --mode participate）。

${webLines}
${line}`);
      return 0;
    }

    // #944：接入包从 108 行粘贴稿压成「一段行为约定 + 两行命令」。那 108 行里逐条手工执行的
    // 机械步骤（写 config / 判重 / 绑定 / 注册 MCP / 装+批准 hook / 报到 / 自检）全部收进
    // `party join` 这一条命令，跑完自己打印「全部就绪 / 还差第 N 步」。builder 与 web 接入包
    // 同源（shared/onboarding），别再在 cli/web 各写一份（#585）。charter 不再快照进包——
    // `party join` 里的 init 会在加入时拉取并终端安全地打印最新公告（比粘贴时的快照更新鲜）。
    // 邀请人不预设目标 harness：不带 --harness，交给 `party join` 在对方机器上自己探测（#924）。
    const joinPack = buildInteractiveJoinPack({
      slug,
      server,
      token: guest.token,
      agentName: guestName,
      inviterName: checkinMention ?? null,
    });
    console.log(`${line}
AgentParty 接入包 — ${title}  · 参与模式 (participate)
${line}
server:   ${server}
channel:  ${slug}  ${channelDesc}

把下面整段发给对方的 agent（Claude Code / Codex）——一小段说明 + 两行命令。
带 # 的是给它读的行为约定，不带 # 的是要执行的命令；跑完它自己会报「全部就绪」或「还差第 N 步」：

${joinPack}

${webLines}
${line}`);
    return 0;
  } catch (e) {
    if (guestCreated) {
      try {
        await revokeToken(server, adminSecret, guestName);
      } catch {
        // best-effort cleanup; surface the original failure below
      }
    }
    return handleRestError(e);
  }
}
