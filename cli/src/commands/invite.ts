// party invite — 一条命令建频道 + 铸 token，stdout 打印可整段复制的接入包（需 ADMIN_SECRET）
import { parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { readConfig } from "../config";
import {
  RestError,
  createChannel,
  createToken,
  handleRestError,
  revokeToken,
  type ChannelMode,
} from "../rest";
import { isName, isSlug, normalizeServerUrl } from "../validation";

const USAGE = 'usage: party invite "<title>" [--slug s] [--temp] [--party] [--guest-name bob]';
const INVITE_FLAGS = ["server", "slug", "guest-name", "temp", "party"];

export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function run(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { booleans: ["temp", "party"] });
  const unknown = unknownFlagError(flags, INVITE_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["server", "slug", "guest-name"]);
  if (flagError !== null) {
    console.error(flagError);
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
  const shareName = `${slug}-share`;
  if (!isSlug(slug)) {
    console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
    return 1;
  }
  if (!isName(guestName) || !isName(shareName)) {
    console.error("guest token name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}");
    return 1;
  }
  const kind = flags.temp === true ? "temp" : "standing";
  const mode: ChannelMode = flags.party === true ? "party" : "normal";
  let guestCreated = false;

  try {
    // 1. guest agent token —— 重名不静默顶掉现有 guest，让人换名
    let guest: { token: string };
    try {
      guest = await createToken(server, adminSecret, guestName, "agent");
    } catch (e) {
      if (e instanceof RestError && e.status === 409) {
        console.error(`token ${guestName} 已存在，用 --guest-name 指定其他名字`);
        return 1;
      }
      throw e;
    }
    guestCreated = true;

    // 2. 建频道（409 = 已存在，复用）
    try {
      await createChannel(server, guest.token, { slug, title, kind, mode });
    } catch (e) {
      if (!(e instanceof RestError && e.status === 409)) throw e;
    }

    // 3. share readonly token —— 已存在则撤销重铸，保证打印出的链接一定可用
    let share: { token: string };
    try {
      share = await createToken(server, adminSecret, shareName, "readonly");
    } catch (e) {
      if (e instanceof RestError && e.status === 409) {
        await revokeToken(server, adminSecret, shareName);
        share = await createToken(server, adminSecret, shareName, "readonly");
      } else {
        throw e;
      }
    }

    const line = "─".repeat(60);
    console.log(`${line}
AgentParty 接入包 — ${title}
${line}
server:   ${server}
channel:  ${slug}  (${kind}${mode === "party" ? " · party" : ""})

把下面三步整段发给对方（agent 在终端里跑）：

  1. 确保已安装 party cli
  2. 接入频道（token 只出现这一次，注意保管）：
     party init --server ${server} --token ${guest.token} --channel ${slug}
  3. 开始收发：
     party watch ${slug} --follow

网页只读围观（无需安装，直接开）：
  ${server}/c/${slug}?t=${share.token}
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
