// party mcp prune —— 清理指向「已删身份 / 已失效 config」的 party MCP 注册（#898 方案 C 第 2 件）。
//
// #923 起同时覆盖 **codex** 的注册表（全局 `~/.codex/config.toml` + 项目级
// `<repo>/.codex/config.toml`）。此前只读 `~/.claude.json`，对 codex 桌面端的注册堆积完全
// 无能为力——而那正是唯一可行的修复路径所在。
//
// 硬约束（测试里都有专门断言）：
//  1. 只看命令本体判定是不是我们的注册；discord-use / iphone-use-mcp 等别人的 server 永远不碰。
//  2. 只删「确证失效」的；判不准一律列出交给用户自己决定（review），绝不代删。
//  3. **绝不删正在被活进程使用的注册**（#923/#924）：一条注册背后可能有一个正在跑的会话在用它，
//     删掉不会杀死进程，但会让那个会话下次启动时静默少一个身份——那是别人的会话。
//     扫不到进程表时一律按「可能有人在用」处理，宁可少删。
//  4. 默认 dry-run，加 --yes 才真删。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  classifyPartyRegistration,
  isPartyMcpRegistration,
  listLivePartyMcpProcesses,
  liveConfigPathUsers,
  parseClaudeMcpRegistrations,
  probeFromConfigJson,
  registrationChannel,
  registrationHarness,
  type ConfigProbe,
  type McpRegistration,
  type RemoteProbe,
  type Verdict,
} from "../mcp-registry";
import { codexMcpRemove, codexRegistryScopes, readCodexMcpRegistrations } from "../codex-mcp-registry";

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
  /** 注入点：测试用来钉住「活进程在用的注册绝不进删除路径」。 */
  liveProcesses?: () => { pid: number; configPath: string | null; command: string }[];
  /** 注入点：测试用来喂 codex 侧注册，避免碰真机 TOML。 */
  codexRegistrations?: () => McpRegistration[];
}

/** 一条注册的展示前缀：哪一侧的注册表。输出必须标明，否则用户不知道该去哪儿删。 */
export function registrationLabel(reg: McpRegistration): string {
  return `${registrationHarness(reg)}:${reg.name}`;
}

export async function planMcpPrune(opts: PlanOptions = {}): Promise<PrunePlan> {
  const home = opts.home ?? process.env.HOME ?? homedir();
  const claudeJsonPath = join(home, ".claude.json");
  const raw = readJson(claudeJsonPath);
  const all = [
    ...parseClaudeMcpRegistrations(raw ?? null),
    // #923：codex 的全局 + 项目级注册表同样在治理面内。
    // 注册表的作用域跟着 `home` 走：给一个临时 HOME 就能完全离线跑（测试硬要求）。
    ...(opts.codexRegistrations
      ?? (() => readCodexMcpRegistrations(codexRegistryScopes(process.env, process.cwd(), home))))(),
  ];
  const inUse = liveConfigPathUsers((opts.liveProcesses ?? listLivePartyMcpProcesses)());
  const partyEntries: PruneEntry[] = [];
  const untouched: string[] = [];
  for (const reg of all) {
    if (!isPartyMcpRegistration(reg)) {
      untouched.push(reg.name);
      continue;
    }
    const config = probeConfig(reg);
    // codex 侧的 scope 就是那份 config.toml 本身，而注册只可能是从它里面读出来的——
    // 所以它按定义存在。claude 侧的 local scope 是项目目录，目录没了就没法在原 scope 里
    // 安全地跑 remove（见 classifyPartyRegistration）。
    const scopeExists = registrationHarness(reg) === "codex"
      || reg.scope === "user"
      || existsSync(reg.scope);
    let remote: RemoteProbe | undefined;
    if (opts.checkRemote === true && config.kind === "ok") {
      remote = await probeRemote(config, config.path);
    }
    let verdict = classifyPartyRegistration({
      reg,
      config,
      scopeExists,
      ...(remote === undefined ? {} : { remote }),
    });
    // 活进程闸压在分类之后、删除之前：不管前面判成什么，只要还有会话在用它就只列不删。
    const users = reg.env.AGENTPARTY_CONFIG === undefined ? undefined : inUse.get(reg.env.AGENTPARTY_CONFIG);
    if (users !== undefined && users.length > 0) {
      verdict = {
        action: "review",
        reason:
          `in use by a live \`party mcp\` process (pid ${users.join(", ")}) — a session is holding this identity right now`,
      };
    }
    partyEntries.push({ reg, channel: registrationChannel(reg), verdict });
  }
  return { claudeJsonPath, totalRegistrations: all.length, partyEntries, untouched };
}

/** 删一条注册。抽成参数是为了让测试能断言「只对 stale 的那些调用过、且从没对非 party 调用过」。 */
export type RemoveFn = (reg: McpRegistration) => { ok: boolean; detail: string };

/** 按注册所属的 harness 分派到各自的 remove 路径。删除永远走 harness 自己的 CLI，不手改配置文件。 */
export const harnessMcpRemove: RemoveFn = (reg) =>
  registrationHarness(reg) === "codex" ? codexMcpRemove(reg) : claudeMcpRemove(reg);

export const claudeMcpRemove: RemoveFn = (reg) => {
  const args = ["mcp", "remove", reg.name];
  const cwd = reg.scope === "user" ? (process.env.HOME ?? homedir()) : reg.scope;
  // scope 必须显式给：user 级与项目级同名时，不带 scope 的 remove 会拒绝并打一句提示、退出码仍是 0，
  // 什么都没删（#1083 迁移实测）。projects[path].mcpServers 里的就是 local scope。
  args.push("--scope", reg.scope === "user" ? "user" : "local");
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
    const remove = opts.remove ?? harnessMcpRemove;
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
          stale: stale.map((e) => ({ name: e.reg.name, harness: registrationHarness(e.reg), scope: e.reg.scope, channel: e.channel, reason: e.verdict.reason })),
          review: review.map((e) => ({ name: e.reg.name, harness: registrationHarness(e.reg), scope: e.reg.scope, channel: e.channel, reason: e.verdict.reason })),
          keep: kept.map((e) => ({ name: e.reg.name, harness: registrationHarness(e.reg), scope: e.reg.scope, channel: e.channel })),
          removed,
          failed,
        },
        null,
        2,
      ),
    );
    return failed.length > 0 ? 1 : 0;
  }

  log(
    `scanned ${String(plan.totalRegistrations)} MCP registrations across ${plan.claudeJsonPath}` +
      ` and this machine's codex registries`,
  );
  log(
    `  ${String(plan.partyEntries.length)} are AgentParty mcp servers; ` +
      `${String(plan.untouched.length)} belong to other tools and were not inspected or touched`,
  );
  if (stale.length === 0) log("no provably dead AgentParty registrations found");
  for (const e of stale) {
    log(`  [dead]   ${registrationLabel(e.reg)}  (scope: ${e.reg.scope})  ${e.verdict.reason}`);
  }
  for (const e of review) {
    log(`  [review] ${registrationLabel(e.reg)}  (scope: ${e.reg.scope})  ${e.verdict.reason} — left in place, your call`);
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
