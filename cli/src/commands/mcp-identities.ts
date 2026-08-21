// party mcp identities —— 「同一台 server、同一个频道、同一个 owner 下我是不是已经有身份了？」（#907）
//
// 三个用途，共用同一份判定（cli/src/identity-dedupe.ts）：
//  1. 接入包 / party init 的**事前检查**：`--channel C [--server S]`，命中就把既有身份打出来，
//     退出码 3（未命中 0），让人在「替换 / 并存」之间做显式选择。
//  2. **存量盘点**：不带 --channel 时列出本机所有「同三元组多身份」的重复组。
//  3. **存量收敛**：`--keep NAME` 保留一个身份，把同组其余身份的 **Claude MCP 注册**列出来 /
//     （加 --yes 才）删掉——一条注册＝每个会话一个常驻进程，删注册就是真正的减量手段。
//
// 硬约束（与 #898 party mcp prune 同一套安全模式，测试里都有断言）：
//  - **绝不删除任何身份配置文件**。身份是凭据载体，删错＝只能重铸 token。本命令的删除面
//    仅限 Claude MCP 注册，而注册是可逆的（`claude mcp add` 一行就能加回来）。
//  - 只碰命令本体为 party 且第一个参数为 `mcp` 的注册；别人的 MCP server 永远不看不碰。
//  - 默认 dry-run，--yes 才真删。
//  - 判不准一律列出不动。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentpartyHome, readConfig } from "../config";
import {
  findExistingIdentities,
  groupIdentities,
  normalizeServerKey,
  readIdentityRecords,
  type IdentityRecord,
} from "../identity-dedupe";
import {
  isPartyMcpRegistration,
  parseClaudeMcpRegistrations,
  type McpRegistration,
} from "../mcp-registry";
import { claudeMcpRemove, type RemoveFn } from "./mcp-prune";

const HELP = `usage: party mcp identities [--channel C] [--server S] [--owner O] [--exclude NAME]
       party mcp identities --keep NAME --channel C [--server S] [--owner O] [--yes]

Answer "do I already have an identity on this (server, channel, owner)?" — the
question the name-based idempotency check never asked.

Modes:
  --channel C          check mode: list identities already bound to that channel
                       on that server. Exit 3 if any exist, 0 if none.
  (no --channel)       inventory: list every (server, channel, owner) that has
                       more than one identity on this machine.
  --keep NAME          converge: keep NAME and report the Claude MCP
                       registrations of the other identities in that group.

Options:
  --server S     server URL (defaults to the current config's server)
  --owner O      narrow by owner (default: don't narrow — better to over-report)
  --exclude N    ignore identity N (use it to exclude yourself)
  --all          inventory mode: list every identity, not just duplicated groups
  --yes          with --keep: actually remove the other identities' registrations
  --json         machine-readable output

Safety:
  - identity config files are NEVER deleted by this command; only Claude MCP
    registrations can be removed, and only with --keep plus --yes
  - MCP servers that do not belong to AgentParty are never inspected or touched
  - multiple identities on one channel are ALLOWED (different roles, different
    harnesses). This command only makes the fact visible so the choice is explicit.
`;

export interface IdentitiesOptions {
  home?: string;
  agentsDir?: string;
  server?: string | null;
  channel?: string | null;
  owner?: string | null;
  exclude?: string | null;
  keep?: string | null;
  all?: boolean;
  yes?: boolean;
  json?: boolean;
  remove?: RemoveFn;
  log?: (line: string) => void;
}

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** 一条 party MCP 注册 ↔ 一份身份配置的对应关系：靠 env AGENTPARTY_CONFIG 的路径对上。 */
export function registrationsForIdentity(
  regs: McpRegistration[],
  record: IdentityRecord,
): McpRegistration[] {
  return regs.filter((r) => isPartyMcpRegistration(r) && r.env.AGENTPARTY_CONFIG === record.path);
}

function partyRegistrations(home: string): McpRegistration[] {
  const raw = readJson(join(home, ".claude.json"));
  return parseClaudeMcpRegistrations(raw ?? null).filter(isPartyMcpRegistration);
}

function describe(r: IdentityRecord): string {
  return `${r.name}  (owner=${r.owner ?? "-"}, config: ${r.path})`;
}

export async function runMcpIdentities(opts: IdentitiesOptions = {}): Promise<number> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const home = opts.home ?? process.env.HOME ?? homedir();
  const agentsDir = opts.agentsDir ?? join(agentpartyHome(), "agents");
  const records = readIdentityRecords(agentsDir);
  const channel = opts.channel ?? null;

  if (channel === null) {
    return inventory(records, opts, log);
  }

  const serverRaw = opts.server ?? readConfig()?.server ?? null;
  if (serverRaw === null || serverRaw === "") {
    log("need --server (or a config with one): the same channel name exists on more than one server");
    return 1;
  }
  const server = normalizeServerKey(serverRaw);
  const existing = findExistingIdentities(records, {
    server,
    channel,
    owner: opts.owner ?? null,
    excludeName: opts.exclude ?? null,
  });

  if (opts.keep !== null && opts.keep !== undefined && opts.keep !== "") {
    return converge(records, existing, opts, log, home, server, channel);
  }

  if (opts.json === true) {
    log(
      JSON.stringify(
        {
          server,
          channel,
          owner: opts.owner ?? null,
          existing: existing.map((r) => ({ name: r.name, owner: r.owner, config: r.path })),
        },
        null,
        2,
      ),
    );
    return existing.length > 0 ? 3 : 0;
  }

  if (existing.length === 0) {
    log(`no identity is bound to ${channel} @ ${server} yet`);
    return 0;
  }
  log(`you already have ${String(existing.length)} identity(ies) on ${channel} @ ${server}:`);
  for (const r of existing) log(`  ${describe(r)}`);
  log("");
  log("Multiple identities on one channel are allowed (different roles / harnesses),");
  log("but every one of them becomes a resident MCP process in every session.");
  log("Decide explicitly:");
  log("  replace — retire the old identity first:");
  log(`             party mcp identities --keep <new-name> --channel ${channel} --server ${server}`);
  log("             (dry run; add --yes to drop the other identities' MCP registrations)");
  log("  coexist — go ahead, you now know this channel will hold more than one identity.");
  return 3;
}

function inventory(
  records: IdentityRecord[],
  opts: IdentitiesOptions,
  log: (line: string) => void,
): number {
  const groups = groupIdentities(records, opts.all === true ? 1 : 2);
  if (opts.json === true) {
    log(
      JSON.stringify(
        {
          agents_scanned: records.length,
          groups: groups.map((g) => ({
            server: g.scope.server,
            channel: g.scope.channel,
            owner: g.scope.owner,
            identities: g.records.map((r) => ({ name: r.name, config: r.path })),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  log(`scanned ${String(records.length)} identity configs`);
  if (groups.length === 0) {
    log("no (server, channel, owner) holds more than one identity");
    return 0;
  }
  log(`${String(groups.length)} (server, channel, owner) group(s) hold more than one identity:`);
  for (const g of groups) {
    log("");
    log(`  ${g.scope.channel} @ ${g.scope.server} (owner=${g.scope.owner ?? "-"}) — ${String(g.records.length)} identities`);
    for (const r of g.records) log(`    ${describe(r)}`);
  }
  log("");
  log("This is allowed — different roles and harnesses legitimately share a channel.");
  log("To converge one group (dry run; identity configs are never deleted):");
  const first = groups[0];
  if (first !== undefined && first.records[0] !== undefined) {
    log(
      `  party mcp identities --keep ${first.records[0].name} --channel ${first.scope.channel} --server ${first.scope.server}`,
    );
  }
  return 0;
}

function converge(
  records: IdentityRecord[],
  existing: IdentityRecord[],
  opts: IdentitiesOptions,
  log: (line: string) => void,
  home: string,
  server: string,
  channel: string,
): number {
  const keep = opts.keep ?? "";
  // existing 已按 --exclude / --owner 收窄过，但 --keep 的语义是「组内保留它」，所以这里
  // 重新取整组（不排除 keep 自己），再把 keep 划出去。
  const group = findExistingIdentities(records, { server, channel, owner: opts.owner ?? null });
  const kept = group.filter((r) => r.name === keep);
  if (kept.length === 0) {
    log(`no identity named ${keep} is bound to ${channel} @ ${server} — refusing to touch anything`);
    return 1;
  }
  const others = group.filter((r) => r.name !== keep);
  const regs = partyRegistrations(home);
  const targets: { record: IdentityRecord; reg: McpRegistration }[] = [];
  const noReg: IdentityRecord[] = [];
  for (const r of others) {
    const matched = registrationsForIdentity(regs, r);
    if (matched.length === 0) noReg.push(r);
    for (const reg of matched) targets.push({ record: r, reg });
  }

  const removed: string[] = [];
  const failed: { name: string; detail: string }[] = [];
  if (opts.yes === true) {
    const remove = opts.remove ?? claudeMcpRemove;
    for (const t of targets) {
      // 再核一次：删除路径上只允许出现 party mcp 注册。
      if (!isPartyMcpRegistration(t.reg)) continue;
      const res = remove(t.reg);
      if (res.ok) removed.push(t.reg.name);
      else failed.push({ name: t.reg.name, detail: res.detail });
    }
  }

  if (opts.json === true) {
    log(
      JSON.stringify(
        {
          server,
          channel,
          keep,
          dry_run: opts.yes !== true,
          registrations: targets.map((t) => ({ name: t.reg.name, scope: t.reg.scope, identity: t.record.name })),
          identities_without_registration: noReg.map((r) => r.name),
          removed,
          failed,
          configs_deleted: [],
        },
        null,
        2,
      ),
    );
    return failed.length > 0 ? 1 : 0;
  }

  log(`keeping ${keep} on ${channel} @ ${server}`);
  if (others.length === 0) {
    log("no other identity is bound to that channel — nothing to converge");
    return 0;
  }
  for (const t of targets) {
    log(`  [drop registration] ${t.reg.name}  (scope: ${t.reg.scope})  identity ${t.record.name}`);
  }
  for (const r of noReg) {
    log(`  [no registration]   ${r.name} — nothing to remove for it`);
  }
  log("");
  log("Identity config files are NOT deleted — their tokens stay valid and you can");
  log("re-register any of them with `claude mcp add` at any time.");
  if (opts.yes !== true && targets.length > 0) {
    log("");
    log(`dry run: nothing was removed. Re-run with --yes to drop the ${String(targets.length)} registration(s) above.`);
  }
  for (const name of removed) log(`removed ${name}`);
  for (const f of failed) log(`failed to remove ${f.name}: ${f.detail}`);
  return failed.length > 0 ? 1 : 0;
}

const VALUE_FLAGS = new Set(["--channel", "--server", "--owner", "--exclude", "--keep"]);
const BOOL_FLAGS = new Set(["--all", "--yes", "--json"]);

export async function runIdentitiesCli(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const opts: IdentitiesOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) {
        console.error(`${a} needs a value`);
        return 1;
      }
      i += 1;
      if (a === "--channel") opts.channel = v;
      else if (a === "--server") opts.server = v;
      else if (a === "--owner") opts.owner = v;
      else if (a === "--exclude") opts.exclude = v;
      else opts.keep = v;
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      if (a === "--all") opts.all = true;
      else if (a === "--yes") opts.yes = true;
      else opts.json = true;
      continue;
    }
    console.error(`unknown option: ${a}`);
    console.error(HELP);
    return 1;
  }
  if (opts.keep !== undefined && (opts.channel === undefined || opts.channel === null)) {
    console.error("--keep needs --channel (a group is a (server, channel, owner) triple)");
    return 1;
  }
  return runMcpIdentities(opts);
}
