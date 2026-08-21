// party mcp prune —— 清理指向「已删身份 / 已失效 config」的 party MCP 注册（#898 方案 C 第 2 件）。
//
// 硬约束（测试里都有专门断言）：
//  1. 只看命令本体判定是不是我们的注册；discord-use / iphone-use-mcp 等别人的 server 永远不碰。
//  2. 只删「确证失效」的；判不准一律列出交给用户自己决定（review），绝不代删。
//  3. 默认 dry-run，加 --yes 才真删。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifyPartyRegistration,
  isPartyMcpRegistration,
  parseClaudeMcpRegistrations,
  probeFromConfigJson,
  registrationChannel,
  type ConfigProbe,
  type McpRegistration,
  type RemoteProbe,
  type Verdict,
} from "../mcp-registry";

const HELP = `usage: party mcp prune [--yes] [--check-remote] [--json]

Remove Claude Code MCP registrations that point at AgentParty identities which
no longer exist. Default is a dry run.

Safety:
  - only registrations whose command is the party binary running \`mcp\` are
    considered; every other MCP server on this machine is left untouched
  - only provably dead registrations are removed; anything ambiguous is listed
    for you to decide
  - --yes is required to actually remove anything

Options:
  --yes            actually remove the entries reported as stale
  --check-remote   also ask the server whether each identity's token still works
                   (a rejected token counts as dead; an unreachable server never does)
  --json           machine-readable report
`;

export interface PruneEntry {
  reg: McpRegistration;
  channel: string | null;
  verdict: Verdict;
}

export interface PrunePlan {
  claudeJsonPath: string;
  /** 本机全部 MCP 注册数（含别人的），用来说明「我们只碰了其中多少条」。 */
  totalRegistrations: number;
  partyEntries: PruneEntry[];
  /** 非 party 的注册名，纯展示用——证明它们被识别到了且没被动过。 */
  untouched: string[];
}

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function probeConfig(reg: McpRegistration): ConfigProbe {
  const path = reg.env.AGENTPARTY_CONFIG;
  if (path === undefined || path === "") return { kind: "no-config-env" };
  if (!existsSync(path)) return { kind: "missing", path };
  const parsed = readJson(path);
  if (parsed === undefined) return { kind: "unparseable", path };
  return probeFromConfigJson(path, parsed);
}

async function probeRemote(config: ConfigProbe, path: string): Promise<RemoteProbe> {
  if (config.kind !== "ok" || config.server === null) return "unreachable";
  const raw = readJson(path);
  const token = raw !== undefined && raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>).token
    : undefined;
  if (typeof token !== "string" || token === "") return "unreachable";
  try {
    const { fetchMe } = await import("../rest");
    await fetchMe(config.server, token);
    return "ok";
  } catch (err) {
    // 只有「服务器明确拒绝了这个身份」才算死；网络问题、5xx、超时一律 unreachable。
    const status = (err as { status?: number } | null)?.status;
    return status === 401 || status === 403 ? "revoked" : "unreachable";
  }
}

export interface PlanOptions {
  home?: string;
  checkRemote?: boolean;
}

export async function planMcpPrune(opts: PlanOptions = {}): Promise<PrunePlan> {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const claudeJsonPath = join(home, ".claude.json");
  const raw = readJson(claudeJsonPath);
  const all = parseClaudeMcpRegistrations(raw ?? null);
  const partyEntries: PruneEntry[] = [];
  const untouched: string[] = [];
  for (const reg of all) {
    if (!isPartyMcpRegistration(reg)) {
      untouched.push(reg.name);
      continue;
    }
    const config = probeConfig(reg);
    const scopeExists = reg.scope === "user" || existsSync(reg.scope);
    let remote: RemoteProbe | undefined;
    if (opts.checkRemote === true && config.kind === "ok") {
      remote = await probeRemote(config, config.path);
    }
    const verdict = classifyPartyRegistration({
      reg,
      config,
      scopeExists,
      ...(remote === undefined ? {} : { remote }),
    });
    partyEntries.push({ reg, channel: registrationChannel(reg), verdict });
  }
  return { claudeJsonPath, totalRegistrations: all.length, partyEntries, untouched };
}

/** 删一条注册。抽成参数是为了让测试能断言「只对 stale 的那些调用过、且从没对非 party 调用过」。 */
export type RemoveFn = (reg: McpRegistration) => { ok: boolean; detail: string };

export const claudeMcpRemove: RemoveFn = (reg) => {
  const args = ["mcp", "remove", reg.name];
  const cwd = reg.scope === "user" ? (process.env.HOME ?? homedir()) : reg.scope;
  if (reg.scope === "user") args.push("--scope", "user");
  const res = spawnSync("claude", args, { cwd, encoding: "utf8" });
  if (res.error !== undefined && res.error !== null) return { ok: false, detail: res.error.message };
  if (res.status !== 0) return { ok: false, detail: (res.stderr ?? "").trim() || `exit ${String(res.status)}` };
  return { ok: true, detail: (res.stdout ?? "").trim() };
};

export interface RunPruneOptions extends PlanOptions {
  yes?: boolean;
  json?: boolean;
  remove?: RemoveFn;
  log?: (line: string) => void;
}

export async function runMcpPrune(opts: RunPruneOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const plan = await planMcpPrune(opts);
  const stale = plan.partyEntries.filter((e) => e.verdict.action === "stale");
  const review = plan.partyEntries.filter((e) => e.verdict.action === "review");
  const kept = plan.partyEntries.filter((e) => e.verdict.action === "keep");

  const removed: string[] = [];
  const failed: { name: string; detail: string }[] = [];
  if (opts.yes === true && stale.length > 0) {
    const remove = opts.remove ?? claudeMcpRemove;
    for (const entry of stale) {
      // 再核一次：删除路径上只允许出现 party mcp 注册。
      if (!isPartyMcpRegistration(entry.reg)) continue;
      const res = remove(entry.reg);
      if (res.ok) removed.push(entry.reg.name);
      else failed.push({ name: entry.reg.name, detail: res.detail });
    }
  }

  if (opts.json === true) {
    log(
      JSON.stringify(
        {
          config: plan.claudeJsonPath,
          total_registrations: plan.totalRegistrations,
          untouched_non_party: plan.untouched,
          dry_run: opts.yes !== true,
          stale: stale.map((e) => ({ name: e.reg.name, scope: e.reg.scope, channel: e.channel, reason: e.verdict.reason })),
          review: review.map((e) => ({ name: e.reg.name, scope: e.reg.scope, channel: e.channel, reason: e.verdict.reason })),
          keep: kept.map((e) => ({ name: e.reg.name, scope: e.reg.scope, channel: e.channel })),
          removed,
          failed,
        },
        null,
        2,
      ),
    );
    return failed.length > 0 ? 1 : 0;
  }

  log(`scanned ${String(plan.totalRegistrations)} MCP registrations in ${plan.claudeJsonPath}`);
  log(
    `  ${String(plan.partyEntries.length)} are AgentParty mcp servers; ` +
      `${String(plan.untouched.length)} belong to other tools and were not inspected or touched`,
  );
  if (stale.length === 0) log("no provably dead AgentParty registrations found");
  for (const e of stale) {
    log(`  [dead]   ${e.reg.name}  (scope: ${e.reg.scope})  ${e.verdict.reason}`);
  }
  for (const e of review) {
    log(`  [review] ${e.reg.name}  (scope: ${e.reg.scope})  ${e.verdict.reason} — left in place, your call`);
  }
  if (opts.yes !== true && stale.length > 0) {
    log("");
    log(`dry run: nothing was removed. Re-run with --yes to remove the ${String(stale.length)} dead entries above.`);
  }
  for (const name of removed) log(`removed ${name}`);
  for (const f of failed) log(`failed to remove ${f.name}: ${f.detail}`);
  return failed.length > 0 ? 1 : 0;
}

export async function runPruneCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const known = new Set(["--yes", "--check-remote", "--json"]);
  for (const a of argv) {
    if (!known.has(a)) {
      console.error(`unknown option: ${a}`);
      console.error(HELP);
      return 1;
    }
  }
  return runMcpPrune({
    yes: argv.includes("--yes"),
    json: argv.includes("--json"),
    checkRemote: argv.includes("--check-remote"),
    log: (line) => console.log(line),
  });
}
