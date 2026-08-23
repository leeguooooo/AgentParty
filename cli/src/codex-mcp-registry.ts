// codex 侧的 MCP 注册表（issue #923）。
//
// 为什么必须补上：`party mcp identities` / `party mcp prune` 此前只读 `~/.claude.json`。
// owner 那台机器上，同一个频道的三条注册里有两条在 **codex** 的注册表里——治理命令对它们
// 说「没有注册可删」，而收敛 codex 侧注册恰恰是那台机器上唯一可行的修复路径。看不见就治不了。
//
// codex 的注册表是 TOML，且不止一份：
//   - 全局：`$CODEX_HOME/config.toml`（缺省 `~/.codex/config.toml`）
//   - 项目级：某个目录下的 `.codex/config.toml`（用 `CODEX_HOME=<repo>/.codex` 跑 codex 时生效）
// owner 那台正是两处各有一条。所以扫描必须覆盖「全局 + 从 cwd 一路往上找到的每一份」。
//
// 硬约束（与 #898 的 claude 侧同一套安全模式）：
//  - 只认命令本体是 party 且第一个参数是 `mcp` 的注册；别人的 MCP server 永远不看不碰。
//  - 删除走 codex 自己的 `codex mcp remove`（带对 CODEX_HOME），绝不手改用户的 TOML——
//    那份文件里有大量用户手写的配置，我们没有安全重写它的能力。
//  - 读不出 / 解析失败一律当「这份注册表没有我们的注册」，绝不猜。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { McpRegistration } from "./mcp-registry";

/** 一份 codex 注册表。`configPath` 同时是 McpRegistration.scope（展示 + 删除定位）。 */
export interface CodexRegistryScope {
  /** 该注册表的 CODEX_HOME 目录。删除时必须带上它。 */
  codexHome: string;
  configPath: string;
  kind: "global" | "project";
}

/** 从 cwd 往上最多找几层 `.codex/config.toml`。深目录也够用，且绝不越过 $HOME。 */
const MAX_PROJECT_SCOPE_HOPS = 24;

/**
 * 本机可见的 codex 注册表。
 *
 * 全局那份永远在列（即使文件不存在也列出来——`codex mcp add` 会创建它，报告里说清「还没有」
 * 比悄悄跳过有用）。项目级只列**真的存在**的：`.codex/` 目录到处都是，凭空推测等于噪音。
 */
export function codexRegistryScopes(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  userHome: string = homedir(),
): CodexRegistryScope[] {
  const out: CodexRegistryScope[] = [];
  const seen = new Set<string>();
  const push = (codexHome: string, kind: CodexRegistryScope["kind"]): void => {
    const configPath = join(codexHome, "config.toml");
    if (seen.has(configPath)) return;
    seen.add(configPath);
    out.push({ codexHome, configPath, kind });
  };
  const explicitHome = env.CODEX_HOME?.trim();
  push(
    explicitHome !== undefined && explicitHome !== "" ? resolve(explicitHome) : join(userHome, ".codex"),
    "global",
  );
  // 项目级只在**用户自己的 home 之内**往上找。两个理由：
  //  - 语义上，项目级 CODEX_HOME 就长在用户的工作区里，越过 home 往 `/` 走只会捞到别人的东西；
  //  - 工程上，这让「给一个临时 home 就能完全离线跑」成立——治理命令的测试必须能钉住
  //    「只碰给定 home 下的注册表」，否则单测会顺着真机目录一路往上读到 owner 的真配置。
  const home = resolve(userHome);
  let dir = resolve(cwd);
  if (dir === home || dir.startsWith(`${home}/`)) {
    for (let hop = 0; hop < MAX_PROJECT_SCOPE_HOPS; hop += 1) {
      const candidate = join(dir, ".codex");
      if (existsSync(join(candidate, "config.toml"))) push(candidate, "project");
      if (dir === home) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return out;
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * 从一份 codex config.toml 的文本里解出全部 MCP 注册。
 *
 * TOML 解析交给 Bun 内置的 `Bun.TOML.parse`——手写 TOML 子集解析器在删除路径上是不可接受的
 * 风险（少认一条只是漏治，多认一条就可能去删别人的 server）。解析失败返回空数组。
 */
export function parseCodexMcpRegistrations(scope: CodexRegistryScope, toml: string): McpRegistration[] {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(toml);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const servers = (parsed as Record<string, unknown>).mcp_servers;
  if (servers === null || servers === undefined || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  const out: McpRegistration[] = [];
  for (const [name, spec] of Object.entries(servers as Record<string, unknown>)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) continue;
    const s = spec as Record<string, unknown>;
    out.push({
      scope: scope.configPath,
      name,
      command: typeof s.command === "string" ? s.command : "",
      args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === "string") : [],
      env: asStringRecord(s.env),
      harness: "codex",
      codexHome: scope.codexHome,
    });
  }
  return out;
}

/** 读并解析本机全部 codex 注册表。读不到的那一份静默跳过（文件不存在是常态）。 */
export function readCodexMcpRegistrations(scopes: readonly CodexRegistryScope[]): McpRegistration[] {
  const out: McpRegistration[] = [];
  for (const scope of scopes) {
    let text: string;
    try {
      text = readFileSync(scope.configPath, "utf8");
    } catch {
      continue;
    }
    out.push(...parseCodexMcpRegistrations(scope, text));
  }
  return out;
}

/**
 * 删一条 codex 注册。必须带对 CODEX_HOME，否则删的是全局那一份（或者报「不存在」）——
 * owner 那台的项目级注册就是这样一直删不掉的。
 */
export function codexMcpRemove(reg: McpRegistration): { ok: boolean; detail: string } {
  const codexHome = reg.codexHome;
  if (codexHome === undefined || codexHome === "") {
    return { ok: false, detail: "missing CODEX_HOME for this registration — refusing to guess which registry to edit" };
  }
  const res = spawnSync("codex", ["mcp", "remove", reg.name], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  if (res.error !== undefined && res.error !== null) return { ok: false, detail: res.error.message };
  if (res.status !== 0) {
    return { ok: false, detail: (res.stderr ?? "").trim() || `exit ${String(res.status)}` };
  }
  return { ok: true, detail: (res.stdout ?? "").trim() };
}
