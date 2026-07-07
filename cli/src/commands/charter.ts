// party charter — read/update the channel "用前必读" pointer document.
import { readFileSync } from "node:fs";
import { isHelpArg, parseArgs, str, unknownFlagError, valueFlagError } from "../args";
import { resolveChannel } from "../config";
import { jsonFrame } from "../json";
import { resolveAuth } from "../oidc-cli";
import { fetchChannelCharter, handleRestError, setChannelCharter } from "../rest";
import { isSlug } from "../validation";

const CHARTER_FLAGS = ["json", "file", "message"];
const HELP = `usage: party charter [slug] [--json]
       party charter set [slug] -f file.md | -m "..." | -
       party charter template

Read or update the channel charter / 用前必读.

Options:
  --json       emit structured JSON
  -f, --file   read charter markdown from file
  -m, --message inline charter markdown`;

export const CHARTER_TEMPLATE = `# 本频道用前必读
## 用途
<一句话：这个频道协作什么>
## 仓库与文档
- repo: <url>
- docs: <url>
- 关键 spec: <paths>
## 协作约定
- 只在被 @ 或有话说时发言；认领用 party status；完成走 final synthesis + status done
- 完整礼仪：docs/party-etiquette.md（重点 §6 闭环 / §10 派单模板）
## 当前 host
@<name>（stale 时按 host-lease 接管）
## 待命方式
见 /docs#wake；serve runner 会话隔离见 wake-session spec
## 本公告的维护
由 host 维护；发现缺失/过时，有权限就直接更新并留痕，没权限就 @host 指出`;

async function readStdin(): Promise<string> {
  return new Response(Bun.stdin.stream()).text();
}

function printCharter(slug: string, body: Awaited<ReturnType<typeof fetchChannelCharter>>, json: boolean) {
  if (json) {
    console.log(JSON.stringify(jsonFrame({ type: "charter", channel: slug, ...body })));
    return;
  }
  if (!body.charter) {
    console.log(`# ${slug} charter not set (rev ${body.charter_rev})`);
    return;
  }
  const updated =
    body.updated_at === null
      ? ""
      : ` updated=${new Date(body.updated_at).toISOString()}${body.updated_by ? ` by=${body.updated_by}` : ""}`;
  console.log(`# ${slug} charter rev ${body.charter_rev}${updated}`);
  console.log(body.charter);
}

export async function run(argv: string[]): Promise<number> {
  if (isHelpArg(argv, { allowHelpPositional: true })) {
    console.log(HELP);
    return 0;
  }
  const { positionals, flags } = parseArgs(argv, {
    booleans: ["json"],
    aliases: { f: "file", m: "message" },
  });
  const unknown = unknownFlagError(flags, CHARTER_FLAGS);
  if (unknown !== null) {
    console.error(unknown);
    return 1;
  }
  const flagError = valueFlagError(flags, ["file", "message"]);
  if (flagError !== null) {
    console.error(flagError);
    return 1;
  }
  if (positionals[0] === "template") {
    console.log(CHARTER_TEMPLATE);
    return 0;
  }
  const cfg = await resolveAuth();
  if (!cfg) {
    console.error("no config, run: party login or party init --server URL --token T");
    return 1;
  }
  try {
    if (positionals[0] === "set") {
      const explicitStdin = positionals.includes("-");
      const slug = resolveChannel(positionals[1] === "-" ? undefined : positionals[1]);
      if (!slug) {
        console.error('usage: party charter set [slug] -f file.md | -m "..." | -');
        return 1;
      }
      if (!isSlug(slug)) {
        console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
        return 1;
      }
      const file = str(flags.file);
      const message = str(flags.message);
      const sources = [file !== undefined, message !== undefined, explicitStdin].filter(Boolean).length;
      if (sources !== 1) {
        console.error('choose exactly one of -f file.md, -m "...", or -');
        return 1;
      }
      const charter = file !== undefined ? readFileSync(file, "utf8") : message !== undefined ? message : await readStdin();
      const updated = await setChannelCharter(cfg.server, cfg.token, slug, charter);
      if (flags.json === true) {
        console.log(JSON.stringify(jsonFrame({ type: "charter", channel: slug, ...updated })));
      } else {
        console.log(`charter ${slug} rev ${updated.charter_rev}`);
      }
      return 0;
    }
    const slug = resolveChannel(positionals[0]);
    if (!slug) {
      console.error("no channel, pass one or bind with: party init --channel C");
      return 1;
    }
    if (!isSlug(slug)) {
      console.error("slug must match [a-z0-9][a-z0-9-]{0,63}");
      return 1;
    }
    printCharter(slug, await fetchChannelCharter(cfg.server, cfg.token, slug), flags.json === true);
    return 0;
  } catch (e) {
    return handleRestError(e);
  }
}
