// 老用户的自动迁移：一频道一注册 → 一条 `party mcp --all-channels`（#1083）。
//
// 旧模型下 `party join` 每加入一个频道就往 harness 的全局 config 里塞一条注册（各绑一个
// --channel 与一份 AGENTPARTY_CONFIG），进程数 = 频道数 × 会话数，而且只进不出。新模型是一条
// 注册服务所有频道、身份按调用的频道解析。老用户机器上躺着的那些旧注册不会自己消失——
// 得有东西替他们收掉，而且不能靠他们记得去跑一条命令。
//
// 三步，顺序不能反：
//   1. 把每条旧注册**正在用的那份身份**记为该频道的本机默认（recordChannelDefault）。
//      这一步保住老用户原来的身份：迁移后 `--all-channels` 在这些频道上零歧义，行为一字不变。
//   2. 用 harness 自己的 `codex mcp remove` / `claude mcp remove` 删旧注册（绝不手改 TOML/JSON）。
//   3. 每个涉及的 harness 加一条 `party mcp --all-channels`（已有就不重复加）。
//
// 失败关闭：第 1 步记不下来就不删那条；第 3 步加不上就把删掉的也报出来并给出手工命令——
// 绝不能让用户处在「旧的删了、新的没加上」的空档，那等于所有 agent 一起静默失联。
//
// 触发：任何交互式 `party` 命令启动时（不含 mcp/hook/serve 这些进程内路径）检查一次，
// 一次性标记；也提供 `party mcp migrate [--dry-run|--yes]` 让人先看再动。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentpartyHome } from "../config";
import { codexRegistryScopes, readCodexMcpRegistrations } from "../codex-mcp-registry";
import { harnessMcpRemove } from "./mcp-prune";
import { recordChannelDefault } from "../mcp-channel-identity";
import {
  isPartyMcpRegistration,
  parseClaudeMcpRegistrations,
  registrationChannel,
  registrationHarness,
  type McpRegistration,
  type RegistrationHarness,
} from "../mcp-registry";

export interface LegacyRegistration {
  reg: McpRegistration;
  harness: RegistrationHarness;
  channel: string;
  configPath: string;
  server: string;
}

export interface MigratePlan {
  /** 要迁走的旧式注册：有 --channel、有 AGENTPARTY_CONFIG、config 读得出 server。 */
  legacy: LegacyRegistration[];
  /** party 的注册但不动它：说明为什么。 */
  skipped: { reg: McpRegistration; reason: string }[];
  /** 已经有 --all-channels 注册的 harness。 */
  alreadySingle: Set<RegistrationHarness>;
}

export interface MigrateDeps {
  home: string;
  /** codex 的全局注册表所在 home（CODEX_HOME 或 ~/.codex）。单条注册必须加在这里，项目级不算覆盖。 */
  globalCodexHome: string;
  registrations: () => McpRegistration[];
  readServer: (configPath: string) => string | null;
  recordDefault: (server: string, channel: string, configPath: string) => void;
  remove: (reg: McpRegistration) => { ok: boolean; detail: string };
  /** 必须加到 user / global scope——local/project 只对一个目录生效，别的项目会永久没有 party。 */
  addSingle: (harness: RegistrationHarness) => { ok: boolean; detail: string };
  /** 回滚：把一条刚删掉的旧注册按原 scope / args / env 原样加回去。 */
  addBack: (reg: McpRegistration) => { ok: boolean; detail: string };
  now: () => number;
}

/** 这条旧注册与单注册同名同 scope：加新会覆盖它（codex）或被它顶住（claude），删它会连新的一起删。 */
export function collidesWithSingle(reg: McpRegistration, globalCodexHome: string): boolean {
  if (reg.name !== SINGLE_NAME) return false;
  return registrationHarness(reg) === "codex" ? reg.codexHome === globalCodexHome : reg.scope === "user";
}

export function isSingleRegistration(reg: McpRegistration): boolean {
  return isPartyMcpRegistration(reg) && reg.args.includes("--all-channels");
}

/**
 * 这条单注册是否覆盖整台机器。Claude Code 的 local/project scope 只对一个目录生效，codex 的项目级
 * config.toml 同理——那样的 `--all-channels` 不能当作「已迁好」：其它项目的旧注册一删就永久失联
 * （codex stop-time review on f5c7bfc 抓到的，owner 机器上实测 `party` 真落在了 local scope）。
 */
export function isMachineWideSingle(reg: McpRegistration, globalCodexHome: string): boolean {
  if (!isSingleRegistration(reg)) return false;
  return registrationHarness(reg) === "codex" ? reg.codexHome === globalCodexHome : reg.scope === "user";
}

function readServerFromConfig(configPath: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { server?: unknown; token?: unknown };
    if (typeof raw.token !== "string" || raw.token === "") return null;
    return typeof raw.server === "string" && raw.server !== "" ? raw.server : null;
  } catch {
    return null;
  }
}

function readJson(path: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** 真机依赖：两边注册表都读，删/加都走 harness 自己的 CLI。 */
export function defaultMigrateDeps(home: string = homedir()): MigrateDeps {
  const scopes = codexRegistryScopes(process.env, process.cwd(), home);
  const globalCodexHome = scopes.find((sc) => sc.kind === "global")?.codexHome ?? join(home, ".codex");
  return {
    home,
    globalCodexHome,
    registrations: () => [
      ...parseClaudeMcpRegistrations(readJson(join(home, ".claude.json")) ?? null),
      ...readCodexMcpRegistrations(scopes),
    ],
    readServer: readServerFromConfig,
    recordDefault: (server, channel, configPath) => recordChannelDefault(server, channel, configPath),
    // 删除复用 prune 的实现：它按注册所属 scope 切 cwd / 加 --scope user。不带 scope 的
    // `claude mcp remove` 在别的目录里找不到那个名字**也返回 0**——上一版就是这样把 26 条
    // 一条没删却全报了 ✓。
    remove: harnessMcpRemove,
    addSingle: (harness) => {
      const res = harness === "codex"
        ? spawnSync("codex", ["mcp", "add", SINGLE_NAME, "--", "party", "mcp", "--all-channels"], {
            encoding: "utf8",
            env: { ...process.env, CODEX_HOME: globalCodexHome },
          })
        : spawnSync("claude", ["mcp", "add", "--scope", "user", SINGLE_NAME, "--", "party", "mcp", "--all-channels"], {
            encoding: "utf8",
            cwd: home,
          });
      if (res.error) return { ok: false, detail: res.error.message };
      if (res.status !== 0) return { ok: false, detail: (res.stderr ?? "").trim() || (res.stdout ?? "").trim() || `exit ${String(res.status)}` };
      return { ok: true, detail: (res.stdout ?? "").trim() };
    },
    addBack: (reg) => {
      const envArgs = Object.entries(reg.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      const res = registrationHarness(reg) === "codex"
        ? spawnSync("codex", ["mcp", "add", reg.name, ...envArgs, "--", reg.command, ...reg.args], {
            encoding: "utf8",
            env: { ...process.env, CODEX_HOME: reg.codexHome ?? globalCodexHome },
          })
        : spawnSync(
            "claude",
            ["mcp", "add", "--scope", reg.scope === "user" ? "user" : "local", reg.name, ...envArgs, "--", reg.command, ...reg.args],
            { encoding: "utf8", cwd: reg.scope === "user" ? home : reg.scope },
          );
      if (res.error) return { ok: false, detail: res.error.message };
      if (res.status !== 0) return { ok: false, detail: (res.stderr ?? "").trim() || (res.stdout ?? "").trim() || `exit ${String(res.status)}` };
      return { ok: true, detail: (res.stdout ?? "").trim() };
    },
    now: () => Date.now(),
  };
}

/** 单条注册的名字。固定名字是刻意的：老用户 N 条各有各的名字，新的只该有一条。 */
export const SINGLE_NAME = "party";

export function planMcpMigrate(deps: MigrateDeps): MigratePlan {
  const legacy: LegacyRegistration[] = [];
  const skipped: MigratePlan["skipped"] = [];
  const alreadySingle = new Set<RegistrationHarness>();
  for (const reg of deps.registrations()) {
    if (!isPartyMcpRegistration(reg)) continue;
    const harness = registrationHarness(reg);
    if (isSingleRegistration(reg)) {
      if (isMachineWideSingle(reg, deps.globalCodexHome)) alreadySingle.add(harness);
      else skipped.push({ reg, reason: "是 --all-channels 但只在 local/project scope，覆盖不了整台机器；会另加一条 user/global 的" });
      continue;
    }
    const channel = registrationChannel(reg);
    if (channel === null) {
      // 没绑频道的旧注册（裸 `party mcp`）：它本来就靠 cwd 绑定工作，不是本次要收的形状。
      skipped.push({ reg, reason: "没有 --channel，不是一频道一注册的形状" });
      continue;
    }
    const configPath = reg.env.AGENTPARTY_CONFIG;
    if (configPath === undefined || configPath === "") {
      skipped.push({ reg, reason: "没有 AGENTPARTY_CONFIG，不知道它用的是哪份身份，不动" });
      continue;
    }
    const server = deps.readServer(configPath);
    if (server === null) {
      // config 读不出（TMPDIR 被清、token 没了）：这条注册本来就是坏的，交给 `party mcp prune`。
      skipped.push({ reg, reason: `身份配置读不出：${configPath}（交给 party mcp prune）` });
      continue;
    }
    legacy.push({ reg, harness, channel, configPath, server });
  }
  return { legacy, skipped, alreadySingle };
}

export interface MigrateResult {
  code: number;
  moved: LegacyRegistration[];
  failed: { reg: McpRegistration; step: "default" | "remove"; detail: string }[];
  added: RegistrationHarness[];
  addFailed: { harness: RegistrationHarness; detail: string }[];
}

function hasMachineWideSingle(deps: MigrateDeps, harness: RegistrationHarness): boolean {
  return deps.registrations().some((r) => registrationHarness(r) === harness && isMachineWideSingle(r, deps.globalCodexHome));
}

function stillRegistered(deps: MigrateDeps, reg: McpRegistration): boolean {
  return deps.registrations().some(
    (r) => registrationHarness(r) === registrationHarness(reg) && r.scope === reg.scope && r.name === reg.name,
  );
}

/**
 * 执行迁移。顺序是**先加后删**：单条注册加不上（或加上了但读回来不在 user/global scope）的
 * harness，一条旧注册都不删——绝不让用户处在「旧的删了、新的没加上」的空档。返回码非 0 只有
 * 这一种情况。每一步都读回注册表验证，不信 harness CLI 的退出码。
 */
export function runMcpMigrate(plan: MigratePlan, deps: MigrateDeps, log: (line: string) => void): MigrateResult {
  const moved: LegacyRegistration[] = [];
  const failed: MigrateResult["failed"] = [];
  const added: RegistrationHarness[] = [];
  const addFailed: MigrateResult["addFailed"] = [];

  // 同一 (server, channel) 有多条旧注册且指向**不同**身份时，不能默默挑一个当默认——老模型下这两个
  // 身份本来就同时在跑，迁移后按调用解析会失败关闭并列出候选：让人选，而不是替人选。
  const identitiesByChannel = new Map<string, Set<string>>();
  for (const item of plan.legacy) {
    const key = JSON.stringify([item.server, item.channel]);
    identitiesByChannel.set(key, (identitiesByChannel.get(key) ?? new Set()).add(item.configPath));
  }

  const manualAdd = (harness: RegistrationHarness): string =>
    harness === "codex"
      ? `      codex mcp add ${SINGLE_NAME} -- party mcp --all-channels`
      : `      claude mcp add --scope user ${SINGLE_NAME} -- party mcp --all-channels`;

  const recordDefaultFor = (item: LegacyRegistration): { ok: true } | { ok: false; detail: string } => {
    const key = JSON.stringify([item.server, item.channel]);
    if (identitiesByChannel.get(key)!.size > 1) return { ok: true }; // 多身份频道不设默认（下面统一提示）
    try {
      deps.recordDefault(item.server, item.channel, item.configPath);
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  };

  // 1) 每个涉及的 harness：把单条注册加到 user/global，读回确认。
  //    同名同 scope 的旧注册（早期文档就教 `claude mcp add party -- party mcp --channel X`）要先删再加：
  //    codex 的同名 add 会**覆盖**，随后按名字删旧就把新的一起删了（codex stop-time review on a998ba9）；
  //    claude 的同名 add 会被顶住（"already exists" 且退出码 0）。加不上就把旧的原样加回，绝不留空档。
  const harnesses = new Set(plan.legacy.map((l) => l.harness));
  const covered = new Set<RegistrationHarness>();
  const replaced = new Set<McpRegistration>();
  for (const harness of harnesses) {
    if (plan.alreadySingle.has(harness)) {
      covered.add(harness);
      continue;
    }
    const collisions = plan.legacy.filter((l) => l.harness === harness && collidesWithSingle(l.reg, deps.globalCodexHome));
    let collisionRemoved: LegacyRegistration | null = null;
    if (collisions.length > 0) {
      const c = collisions[0]!;
      // 同名旧注册用的身份同样要记为默认；记不下来就不动它（否则这个频道从「能用」变「歧义」）。
      const recorded = recordDefaultFor(c);
      if (!recorded.ok) {
        addFailed.push({ harness, detail: `同名旧注册 ${c.reg.name} 的默认身份记不下来（${recorded.detail}）` });
        log(`  ✗ ${harness}：同名旧注册 ${c.reg.name} 的默认身份记不下来（${recorded.detail}）——该 harness 一条都不动`);
        continue;
      }
      const removed = deps.remove(c.reg);
      if (!removed.ok || stillRegistered(deps, c.reg)) {
        const detail = removed.ok ? "命令返回 0，但读回注册表时它还在" : removed.detail;
        addFailed.push({ harness, detail: `同名旧注册 ${c.reg.name} 删不掉（${detail}），无法腾出名字` });
        log(`  ✗ ${harness}：同名旧注册 ${c.reg.name} 删不掉（${detail}）——该 harness 一条都不动`);
        continue;
      }
      collisionRemoved = c;
    }
    const res = deps.addSingle(harness);
    if (res.ok && hasMachineWideSingle(deps, harness)) {
      covered.add(harness);
      added.push(harness);
      if (collisionRemoved !== null) {
        replaced.add(collisionRemoved.reg);
        moved.push(collisionRemoved);
        log(`  ✓ ${harness}：同名旧注册 ${SINGLE_NAME} 已换成 \`party mcp --all-channels\`（读回确认）`);
      } else {
        log(`  ✓ ${harness}：已在 user/global scope 加一条 \`party mcp --all-channels\`（读回确认）`);
      }
      continue;
    }
    const detail = res.ok ? "命令返回 0，但读回注册表时它不在 user/global scope" : res.detail;
    addFailed.push({ harness, detail });
    if (collisionRemoved !== null) {
      // 旧的已删、新的没加上：立刻把旧的原样加回，并读回确认。
      const back = deps.addBack(collisionRemoved.reg);
      const restored = back.ok && stillRegistered(deps, collisionRemoved.reg);
      log(
        restored
          ? `  ✗ ${harness}：单条注册没加上（${detail}）；已把同名旧注册原样加回，一切照旧。手工加：`
          : `  ✗ ${harness}：单条注册没加上（${detail}），且旧注册加回也失败（${back.detail}）——现在没有 party，请立刻手工加：`,
      );
    } else {
      log(`  ✗ ${harness}：单条注册没加上（${detail}）——该 harness 的旧注册一条都不动。手工加：`);
    }
    log(manualAdd(harness));
  }

  // 2) 记默认 + 删旧（只对已覆盖的 harness），每条删完读回验证
  const warned = new Set<string>();
  for (const item of plan.legacy) {
    if (!covered.has(item.harness)) continue;
    if (replaced.has(item.reg)) continue; // 同名旧注册已在上一步换掉，再按名字删就是删新的
    if (collidesWithSingle(item.reg, deps.globalCodexHome)) continue; // 保险：任何情况下都不按单注册的名字删
    const key = JSON.stringify([item.server, item.channel]);
    const contenders = identitiesByChannel.get(key)!;
    if (contenders.size > 1) {
      if (!warned.has(key)) {
        warned.add(key);
        log(`  ! #${item.channel} 有 ${contenders.size} 份不同身份的旧注册，不设默认；迁移后调用时传 identity，或用 party join 重新绑定其中一个`);
      }
    } else {
      try {
        deps.recordDefault(item.server, item.channel, item.configPath);
      } catch (e) {
        failed.push({ reg: item.reg, step: "default", detail: e instanceof Error ? e.message : String(e) });
        continue; // 记不下来就不删，否则这个频道从「能用」变「歧义」
      }
    }
    const removed = deps.remove(item.reg);
    if (!removed.ok) {
      failed.push({ reg: item.reg, step: "remove", detail: removed.detail });
      continue;
    }
    if (stillRegistered(deps, item.reg)) {
      // harness CLI 返回 0 但注册还在：不带 scope 的 remove 在别的目录里就是这样。
      failed.push({ reg: item.reg, step: "remove", detail: "命令返回 0，但读回注册表时它还在（scope 没对上？）" });
      continue;
    }
    moved.push(item);
    log(
      contenders.size > 1
        ? `  ✓ #${item.channel} 的注册 ${item.reg.name} 已收进单条注册（未设默认）`
        : `  ✓ #${item.channel} 的注册 ${item.reg.name} 已收进单条注册（默认身份：${item.configPath}）`,
    );
  }
  for (const f of failed) {
    log(`  ! ${f.reg.name}：${f.step === "default" ? "记默认身份失败，未删" : "删除失败，仍保留"}（${f.detail}）`);
  }
  // 3) 收尾读回：删旧的过程中单注册若被 harness CLI 连带删掉（同名、scope 落空……），当场自愈。
  for (const harness of covered) {
    if (hasMachineWideSingle(deps, harness)) continue;
    const res = deps.addSingle(harness);
    if (res.ok && hasMachineWideSingle(deps, harness)) {
      log(`  ! ${harness}：删旧注册时单条注册被连带删掉了，已重新加回（读回确认）`);
    } else {
      addFailed.push({ harness, detail: "删旧注册后单条注册消失，重加失败" });
      log(`  ✗ ${harness}：删旧注册后单条注册消失，重加失败——现在没有 party，请立刻手工加：`);
      log(manualAdd(harness));
    }
  }
  return { code: addFailed.length > 0 ? 1 : 0, moved, failed, added, addFailed };
}

// ── 自动触发 ──────────────────────────────────────────────────────────────────

export function migrateMarkerPath(home: string = agentpartyHome()): string {
  return join(home, "state", "mcp-migrate-v1.json");
}

interface Marker {
  status: "done" | "nothing" | "failed";
  at: number;
  moved?: number;
}

function readMarker(path: string): Marker | null {
  const raw = readJson(path);
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as Partial<Marker>;
  if (m.status !== "done" && m.status !== "nothing" && m.status !== "failed") return null;
  return { status: m.status, at: typeof m.at === "number" ? m.at : 0, moved: typeof m.moved === "number" ? m.moved : undefined };
}

function writeMarker(path: string, marker: Marker): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 失败后多久再自动试一次。天天弹是骚扰，永不重试是把老用户扔在旧模型里。 */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** 这些入口不做自动迁移：它们是 harness 拉起的进程内路径 / 常驻守护，不该在那里改 harness 的配置。 */
const NO_AUTO_MIGRATE = new Set(["mcp", "hook", "serve", "daemon", "watch", "bridge", "claude", "codex", "capture", "notify-when-idle", "statusline"]);

/**
 * 交互式命令启动时调一次。有旧式注册就迁，没有就写「无事」标记，之后再也不看。
 * 迁移输出走 errlog（stderr）：不能污染命令自己的 stdout（很多命令支持 --json）。
 */
export function maybeAutoMigrate(
  cmd: string,
  opts: { deps?: MigrateDeps; agentpartyHome?: string; errlog?: (line: string) => void } = {},
): { ran: boolean; result?: MigrateResult } {
  if (NO_AUTO_MIGRATE.has(cmd)) return { ran: false };
  const home = opts.agentpartyHome ?? agentpartyHome();
  const markerPath = migrateMarkerPath(home);
  const deps = opts.deps ?? defaultMigrateDeps();
  const errlog = opts.errlog ?? ((line: string) => console.error(line));
  const marker = readMarker(markerPath);
  const now = deps.now();
  if (marker !== null && marker.status !== "failed") return { ran: false };
  if (marker !== null && marker.status === "failed" && now - marker.at < RETRY_AFTER_MS) return { ran: false };

  let plan: MigratePlan;
  try {
    plan = planMcpMigrate(deps);
  } catch {
    // 读注册表都炸了（harness 没装 / 文件坏）：不打扰，下次再看。
    return { ran: false };
  }
  if (plan.legacy.length === 0) {
    writeMarker(markerPath, { status: "nothing", at: now });
    return { ran: false };
  }
  errlog(
    `party：发现 ${plan.legacy.length} 条旧式「一频道一注册」的 MCP 注册，正在合并成一条 \`party mcp --all-channels\`` +
      `（每个会话从 ${plan.legacy.length} 个 party 进程降到 1 个；原来各频道用的身份会记为默认，行为不变）：`,
  );
  const result = runMcpMigrate(plan, deps, errlog);
  if (result.code === 0) {
    writeMarker(markerPath, { status: "done", at: now, moved: result.moved.length });
    errlog(`party：迁移完成。正在跑的会话不受影响，下次新开的会话生效。想看细节：party mcp migrate --dry-run`);
  } else {
    writeMarker(markerPath, { status: "failed", at: now, moved: result.moved.length });
  }
  return { ran: true, result };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const HELP = `usage: party mcp migrate [--dry-run] [--yes]

把旧式「一频道一注册」的 MCP 注册合并成一条 \`party mcp --all-channels\`（#1083）。
交互式 party 命令启动时会自动做一次；这里是手动入口。

  --dry-run   只列计划，不改任何东西（缺省）
  --yes       执行

做什么：
  1. 每条旧注册正在用的身份 → 记为该频道的本机默认（迁移后行为不变）
  2. 用 codex/claude 自己的 \`mcp remove\` 删旧注册（不手改配置文件）
  3. 每个涉及的 harness 加一条 \`party mcp --all-channels\``;

export async function runMigrateCli(argv: string[], deps: MigrateDeps = defaultMigrateDeps()): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const yes = argv.includes("--yes");
  const plan = planMcpMigrate(deps);
  if (plan.legacy.length === 0) {
    console.log("没有旧式「一频道一注册」的 party 注册，无需迁移。");
    for (const s of plan.skipped) console.log(`  · 跳过 ${s.reg.name}：${s.reason}`);
    return 0;
  }
  console.log(`${yes ? "迁移" : "计划迁移"} ${plan.legacy.length} 条旧注册：`);
  for (const l of plan.legacy) console.log(`  · ${l.harness}  ${l.reg.name}  #${l.channel}  ← ${l.configPath}`);
  for (const s of plan.skipped) console.log(`  · 跳过 ${s.reg.name}：${s.reason}`);
  if (!yes) {
    console.log("（未改任何东西。执行：party mcp migrate --yes）");
    return 0;
  }
  const result = runMcpMigrate(plan, deps, (line) => console.log(line));
  if (result.code === 0) {
    writeMarker(migrateMarkerPath(), { status: "done", at: deps.now(), moved: result.moved.length });
    console.log("迁移完成。正在跑的会话不受影响，下次新开的会话生效。");
  }
  return result.code;
}

/** 供 doctor 用：标记文件存在且非 failed ⇒ 已处理过。 */
export function migrationDone(home: string = agentpartyHome()): boolean {
  const m = readMarker(migrateMarkerPath(home));
  return m !== null && m.status !== "failed";
}

// 仅供测试：让用例能构造一个「已迁移」的家目录。
export function writeMigrateMarkerForTest(home: string, marker: { status: "done" | "nothing" | "failed"; at: number }): void {
  writeMarker(migrateMarkerPath(home), marker);
}

